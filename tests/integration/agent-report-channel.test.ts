/**
 * Spec-driven integration tests for the `specwatch agent-report` channel
 * inversion (S4 — a documented BREAKING change).
 *
 * These tests are written PURELY from the acceptance criteria. The AgentEvidence
 * JSON and the human report are treated as a BLACK BOX: we only assert the
 * pinned contract the criteria describe (schema_version string, JSON-vs-not-JSON
 * on stdout, the human report heading, channel discipline for -o). We do NOT
 * reach into the serializer/formatter or the command body.
 *
 * The command is driven through the REAL `createProgram()` commander program,
 * backed by a REAL on-disk SQLite database (via SPECWATCH_HOME) that we seed
 * with real repositories and then aggregate through the real `runAggregation`
 * pipeline (agent-report requires aggregated schemas). Nothing about the
 * serializer or formatter is mocked.
 *
 * Feature under test:
 *   `agent-report` now DEFAULTS to emitting machine-readable AgentEvidence JSON
 *   on stdout for agent sessions; `--human` / `--format human` / `--pretty`
 *   restore the previous human-readable tables.
 *
 * Acceptance criteria under test:
 *   1. No format flag on an agent session -> pure AgentEvidence JSON on stdout
 *      (JSON.parse(entireStdout) succeeds; schema_version === the pinned value;
 *      zero non-JSON bytes: no ANSI, no banner).
 *   2. --human -> human report (NOT JSON) containing "Agent-Friendliness Report".
 *   3. --format human -> same as --human.
 *   4. --format json -> explicit JSON path, same as the no-flag default.
 *   5. -o <file> -> file holds valid AgentEvidence JSON; without --human stdout
 *      ALSO stays pure JSON; status/log lines land on stderr, not stdout.
 *   6. --format bogus -> errors (invalid format value).
 *   7. agent-report on a non-agent (human) session errors (requires --consumer agent).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProgram } from '../../src/cli/commands.js';
import { getDatabase } from '../../src/storage/database.js';
import { SessionRepository } from '../../src/storage/sessions.js';
import { SampleRepository } from '../../src/storage/samples.js';
import { inferSchema } from '../../src/inference/engine.js';
import { runAggregation } from '../../src/aggregation/pipeline.js';
import type { SessionConsumer } from '../../src/types/index.js';

const EXPECTED_SCHEMA_VERSION = 'specwatch.agent_evidence.v1';

// ---------------------------------------------------------------------------
// Fixture data: a small, deterministic REST API surface with real request and
// response bodies so inference + aggregation produce genuine schemas.
// ---------------------------------------------------------------------------

interface RestSample {
  method: string;
  path: string;
  normalizedPath: string;
  statusCode: number;
  requestBody?: unknown;
  responseBody?: unknown;
}

const REST_SAMPLES: RestSample[] = [
  {
    method: 'GET',
    path: '/users/1',
    normalizedPath: '/users/{userId}',
    statusCode: 200,
    responseBody: { id: 1, name: 'Alice', email: 'alice@example.com' },
  },
  {
    method: 'GET',
    path: '/users/2',
    normalizedPath: '/users/{userId}',
    statusCode: 200,
    responseBody: { id: 2, name: 'Bob', email: 'bob@example.com' },
  },
  {
    method: 'POST',
    path: '/users',
    normalizedPath: '/users',
    statusCode: 201,
    requestBody: { name: 'Carol', email: 'carol@example.com' },
    responseBody: { id: 3, name: 'Carol', email: 'carol@example.com' },
  },
  {
    method: 'POST',
    path: '/users',
    normalizedPath: '/users',
    statusCode: 201,
    requestBody: { name: 'Dave', email: 'dave@example.com' },
    responseBody: { id: 4, name: 'Dave', email: 'dave@example.com' },
  },
];

let tmpHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'specwatch-agent-report-channel-'));
  prevHome = process.env['SPECWATCH_HOME'];
  process.env['SPECWATCH_HOME'] = tmpHome;
});

afterEach(() => {
  if (prevHome === undefined) {
    delete process.env['SPECWATCH_HOME'];
  } else {
    process.env['SPECWATCH_HOME'] = prevHome;
  }
  rmSync(tmpHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/**
 * Seeds a completed session (with the given consumer type), inserts REST samples
 * carrying real inferred request/response schemas, then runs the real
 * aggregation pipeline so `agent-report` finds aggregated schemas. Returns the
 * session id. Writes are flushed by closing the connection so the command's own
 * connection observes them.
 */
function seedAggregatedSession(consumer: SessionConsumer): string {
  const db = getDatabase();
  try {
    const sessions = new SessionRepository(db);
    const samples = new SampleRepository(db);

    const session = sessions.createSession(
      'https://api.example.com',
      8080,
      undefined,
      undefined,
      consumer,
    );

    let t = Date.parse('2026-07-09T10:00:00.000Z');
    for (const s of REST_SAMPLES) {
      t += 1000;
      samples.insertSample({
        sessionId: session.id,
        httpMethod: s.method,
        path: s.path,
        normalizedPath: s.normalizedPath,
        statusCode: s.statusCode,
        capturedAt: new Date(t).toISOString(),
        requestSchema: s.requestBody !== undefined ? inferSchema(s.requestBody) : undefined,
        responseSchema: s.responseBody !== undefined ? inferSchema(s.responseBody) : undefined,
      });
      sessions.incrementSampleCount(session.id);
    }

    // Produce aggregated schemas (agent-report calls
    // schemaRepo.listBySessionLatestSnapshot and errors "No schemas found"
    // otherwise). runAggregation also transitions the session to completed.
    const result = runAggregation(db, session.id);
    if (result.schemas.length === 0) {
      throw new Error('Fixture seeding produced no aggregated schemas');
    }

    return session.id;
  } finally {
    db.close();
  }
}

interface RunResult {
  stdout: string;
  stderr: string;
  error?: Error;
}

/**
 * Runs `agent-report <args>` through the real commander program, capturing the
 * FULL stdout and stderr (every write chunk concatenated) plus any thrown/exit
 * error. process.exit is stubbed to throw so that the command's error path
 * (handleError -> process.exit) is observable instead of tearing down vitest.
 */
async function runAgentReport(args: string[]): Promise<RunResult> {
  let stdout = '';
  let stderr = '';

  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown): boolean => {
    stdout += typeof chunk === 'string' ? chunk : String(chunk);
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown): boolean => {
    stderr += typeof chunk === 'string' ? chunk : String(chunk);
    return true;
  });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number): never => {
    throw new Error(`__process_exit__:${code ?? 0}`);
  }) as never);

  let error: Error | undefined;
  try {
    const program = createProgram();
    program.exitOverride();
    await program.parseAsync(['agent-report', ...args], { from: 'user' });
  } catch (e) {
    error = e instanceof Error ? e : new Error(String(e));
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }

  return { stdout, stderr, error };
}

// ---------------------------------------------------------------------------
// Criterion 1: default (no format flag) emits pure AgentEvidence JSON
// ---------------------------------------------------------------------------

describe('agent-report default channel: pure AgentEvidence JSON (criterion 1)', () => {
  it('writes AgentEvidence JSON to stdout with the pinned schema_version and zero non-JSON bytes', async () => {
    const sessionId = seedAggregatedSession('agent');

    const { stdout, error } = await runAgentReport([sessionId]);

    expect(
      error,
      'default agent-report should not error on an aggregated agent session',
    ).toBeUndefined();
    expect(stdout.trim().length).toBeGreaterThan(0);

    // Zero non-JSON bytes: parsing the ENTIRE stdout must succeed.
    expect(() => JSON.parse(stdout)).not.toThrow();

    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(typeof parsed['schema_version']).toBe('string');
    expect(parsed['schema_version']).toBe(EXPECTED_SCHEMA_VERSION);

    // Parsing the entire stdout above already guarantees zero non-JSON bytes
    // (no ANSI escapes, no banner) — a leaked byte would have thrown.
  });
});

// ---------------------------------------------------------------------------
// Criterion 2 & 3: --human and --format human restore the human report
// ---------------------------------------------------------------------------

describe('agent-report human channel restored via flags (criteria 2 & 3)', () => {
  it('2. --human produces human-readable output that is NOT JSON and shows the report heading', async () => {
    const sessionId = seedAggregatedSession('agent');

    const { stdout, error } = await runAgentReport([sessionId, '--human']);

    expect(
      error,
      '--human agent-report should not error on an aggregated agent session',
    ).toBeUndefined();
    expect(() => JSON.parse(stdout)).toThrow();
    expect(stdout).toContain('Agent-Friendliness Report');
  });

  it('3. --format human behaves the same as --human (not JSON; contains the heading)', async () => {
    const sessionId = seedAggregatedSession('agent');

    const { stdout, error } = await runAgentReport([sessionId, '--format', 'human']);

    expect(error, '--format human agent-report should not error').toBeUndefined();
    expect(() => JSON.parse(stdout)).toThrow();
    expect(stdout).toContain('Agent-Friendliness Report');
  });

  it('3b. --pretty is an alias for --human (not JSON; contains the heading)', async () => {
    const sessionId = seedAggregatedSession('agent');

    const { stdout, error } = await runAgentReport([sessionId, '--pretty']);

    expect(error, '--pretty agent-report should not error').toBeUndefined();
    expect(() => JSON.parse(stdout)).toThrow();
    expect(stdout).toContain('Agent-Friendliness Report');
  });
});

// ---------------------------------------------------------------------------
// Criterion 4: --format json is the explicit JSON path (== default)
// ---------------------------------------------------------------------------

describe('agent-report --format json is the explicit JSON path (criterion 4)', () => {
  it('emits parseable AgentEvidence JSON with the pinned schema_version, same as the default', async () => {
    const sessionId = seedAggregatedSession('agent');

    const { stdout, error } = await runAgentReport([sessionId, '--format', 'json']);

    expect(error, '--format json agent-report should not error').toBeUndefined();
    expect(() => JSON.parse(stdout)).not.toThrow();

    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed['schema_version']).toBe(EXPECTED_SCHEMA_VERSION);
  });
});

// ---------------------------------------------------------------------------
// Criterion 5: -o <file> writes JSON to the file AND keeps stdout pure JSON,
// with status/log lines on stderr
// ---------------------------------------------------------------------------

describe('agent-report -o <file>: file + stdout both pure JSON, logs on stderr (criterion 5)', () => {
  it('writes valid AgentEvidence JSON to the file while stdout stays pure JSON and logs go to stderr', async () => {
    const sessionId = seedAggregatedSession('agent');
    const outFile = join(tmpHome, 'evidence.json');

    const { stdout, stderr, error } = await runAgentReport([sessionId, '-o', outFile]);

    expect(error, '-o agent-report should not error').toBeUndefined();

    // The file holds valid AgentEvidence JSON.
    const fileContents = readFileSync(outFile, 'utf8');
    const fromFile = JSON.parse(fileContents) as Record<string, unknown>;
    expect(fromFile['schema_version']).toBe(EXPECTED_SCHEMA_VERSION);

    // With -o and NO --human, the default channel is still JSON: stdout parses.
    expect(() => JSON.parse(stdout)).not.toThrow();
    const fromStdout = JSON.parse(stdout) as Record<string, unknown>;
    expect(fromStdout['schema_version']).toBe(EXPECTED_SCHEMA_VERSION);

    // Status/log lines (e.g. "Wrote agent evidence to ...") land on stderr, not
    // stdout — stdout stays pure JSON.
    expect(stderr).toContain('Wrote agent evidence to');
    expect(stdout).not.toContain('Wrote agent evidence to');
  });
});

// ---------------------------------------------------------------------------
// Criterion 6: invalid --format value errors
// ---------------------------------------------------------------------------

describe('agent-report --format bogus errors (criterion 6)', () => {
  it('reaches the error path for an invalid format value', async () => {
    const sessionId = seedAggregatedSession('agent');

    const { stdout, error } = await runAgentReport([sessionId, '--format', 'bogus']);

    expect(error, '--format bogus should error').toBeDefined();
    // Whatever else happens, an invalid format must not yield valid JSON on stdout.
    expect(() => JSON.parse(stdout)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Criterion 7: non-agent (human) session errors as before
// ---------------------------------------------------------------------------

describe('agent-report on a non-agent (human) session errors (criterion 7)', () => {
  it('errors, requiring a session captured with --consumer agent', async () => {
    const sessionId = seedAggregatedSession('human');

    const { stderr, error } = await runAgentReport([sessionId]);

    expect(error).toBeDefined();
    expect(stderr.toLowerCase()).toContain('agent');
  });
});
