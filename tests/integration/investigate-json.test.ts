/**
 * Spec-driven integration tests for `specwatch investigate --json`.
 *
 * These tests are written PURELY from the acceptance criteria for the new
 * `--json` flag. The JSON shape is treated as a black box: we only assert the
 * pinned contract the criteria describe (schema_version, session_id,
 * investigations[], and snake_case per-investigation keys). We do NOT reach
 * into the serializer implementation.
 *
 * The command is driven through the REAL `createProgram()` commander program,
 * backed by a REAL on-disk SQLite database (via SPECWATCH_HOME) that we seed
 * with real repositories. Nothing about the serializer or investigation engine
 * is mocked.
 *
 * Acceptance criteria under test:
 *   1. --json writes pure JSON to stdout (JSON.parse accepts it; no stray bytes).
 *   2. Parsed JSON has string schema_version === "specwatch.investigation.v1",
 *      a string session_id, and an array investigations.
 *   3. Each investigation uses snake_case keys: operation_key (string),
 *      primary_cause (string), explanation, recommendation, occurrences (array),
 *      pair_analyses (array). NO camelCase (operationKey / pairAnalyses).
 *   4. Without --json the output is the human/table format (NOT JSON) produced
 *      by formatInvestigation.
 *   5. Agent session with NO redundant calls: --json emits a valid object with
 *      investigations: []; without --json prints an informational
 *      "No redundant calls" line to stderr (not stdout).
 *   6. investigate on a non-agent (human) session errors (requires --consumer agent).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProgram } from '../../src/cli/commands.js';
import { getDatabase } from '../../src/storage/database.js';
import { SessionRepository } from '../../src/storage/sessions.js';
import { SampleRepository } from '../../src/storage/samples.js';
import type { SessionConsumer } from '../../src/types/index.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

interface RpcOp {
  method: string;
  tool?: string;
}

/**
 * A JSON-RPC (MCP-style) agent session with a redundant `tools/list` call.
 * `tools/list` is a once-per-session operation; calling it 3 times makes it a
 * genuine redundant call that the investigation engine will pick up.
 */
const REDUNDANT_OPS: RpcOp[] = [
  { method: 'initialize' },
  { method: 'tools/list' },
  { method: 'tools/call', tool: 'search_items' },
  { method: 'tools/list' },
  { method: 'tools/list' },
];

/**
 * A JSON-RPC agent session with NO redundant calls: each once-per-session
 * operation is invoked exactly once and the tool calls are distinct.
 */
const CLEAN_OPS: RpcOp[] = [
  { method: 'initialize' },
  { method: 'tools/list' },
  { method: 'tools/call', tool: 'search_items' },
  { method: 'tools/call', tool: 'fetch_item' },
];

let tmpHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'specwatch-investigate-json-'));
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
 * Seeds a completed session (with the given consumer type) and a timeline of
 * JSON-RPC samples into the SPECWATCH_HOME database, returning the session id.
 * Writes are flushed by closing the connection so the command's own connection
 * observes them.
 */
function seedSession(consumer: SessionConsumer, ops: RpcOp[]): string {
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

    // Deterministic timeline: 1s apart (short enough to avoid session-restart
    // classification, long enough to be a real delta).
    let t = Date.parse('2026-07-09T10:00:00.000Z');
    for (const op of ops) {
      t += 1000;
      samples.insertSample({
        sessionId: session.id,
        httpMethod: 'POST',
        path: '/mcp',
        normalizedPath: '/mcp',
        statusCode: 200,
        capturedAt: new Date(t).toISOString(),
        jsonrpcMethod: op.method,
        jsonrpcTool: op.tool,
      });
    }

    sessions.updateSessionStatus(session.id, 'aggregating');
    sessions.updateSessionStatus(session.id, 'completed');

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
 * Runs `investigate <args>` through the real commander program, capturing
 * stdout and stderr and any thrown/exit error. process.exit is stubbed to
 * throw so that the command's error path (handleError -> process.exit) is
 * observable instead of tearing down the test runner.
 */
async function runInvestigate(args: string[]): Promise<RunResult> {
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
    await program.parseAsync(['investigate', ...args], { from: 'user' });
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
// Criteria 1 & 2: --json emits a pinned, parseable JSON envelope
// ---------------------------------------------------------------------------

describe('investigate --json: JSON envelope (criteria 1 & 2)', () => {
  it('1. writes pure JSON to stdout (JSON.parse accepts it, no stray non-JSON bytes)', async () => {
    const sessionId = seedSession('agent', REDUNDANT_OPS);

    const { stdout, error } = await runInvestigate([sessionId, '--json']);

    expect(
      error,
      'investigate --json should not error on a redundant agent session',
    ).toBeUndefined();
    expect(stdout.trim().length).toBeGreaterThan(0);
    // Pure JSON on stdout: parsing the entire stdout must succeed.
    expect(() => JSON.parse(stdout)).not.toThrow();
  });

  it('2. top-level envelope has the pinned schema_version, a string session_id, and an investigations array', async () => {
    const sessionId = seedSession('agent', REDUNDANT_OPS);

    const { stdout } = await runInvestigate([sessionId, '--json']);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;

    expect(parsed['schema_version']).toBe('specwatch.investigation.v1');
    expect(typeof parsed['session_id']).toBe('string');
    expect(parsed['session_id']).toBe(sessionId);
    expect(Array.isArray(parsed['investigations'])).toBe(true);
    expect((parsed['investigations'] as unknown[]).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Criteria 3: snake_case per-investigation shape, no camelCase
// ---------------------------------------------------------------------------

describe('investigate --json: per-investigation snake_case shape (criterion 3)', () => {
  it('each investigation uses snake_case keys and never camelCase', async () => {
    const sessionId = seedSession('agent', REDUNDANT_OPS);

    const { stdout } = await runInvestigate([sessionId, '--json']);
    const parsed = JSON.parse(stdout) as { investigations: Array<Record<string, unknown>> };

    expect(parsed.investigations.length).toBeGreaterThan(0);

    for (const inv of parsed.investigations) {
      // Required snake_case keys with their documented value shapes.
      expect(typeof inv['operation_key']).toBe('string');
      expect(typeof inv['primary_cause']).toBe('string');
      expect(inv).toHaveProperty('explanation');
      expect(inv).toHaveProperty('recommendation');
      expect(Array.isArray(inv['occurrences'])).toBe(true);
      expect(Array.isArray(inv['pair_analyses'])).toBe(true);

      // No camelCase keys.
      expect(inv).not.toHaveProperty('operationKey');
      expect(inv).not.toHaveProperty('pairAnalyses');
      expect(inv).not.toHaveProperty('primaryCause');
    }
  });

  it('the redundant tools/list operation surfaces as an operation_key', async () => {
    const sessionId = seedSession('agent', REDUNDANT_OPS);

    const { stdout } = await runInvestigate([sessionId, '--json']);
    const parsed = JSON.parse(stdout) as { investigations: Array<{ operation_key: string }> };

    const keys = parsed.investigations.map((i) => i.operation_key);
    expect(keys).toContain('tools/list');
  });
});

// ---------------------------------------------------------------------------
// Criterion 4: without --json the output is the human/table format
// ---------------------------------------------------------------------------

describe('investigate (no --json): human output unchanged (criterion 4)', () => {
  it('prints the human formatInvestigation output, which is NOT JSON', async () => {
    const sessionId = seedSession('agent', REDUNDANT_OPS);

    const { stdout, error } = await runInvestigate([sessionId]);

    expect(
      error,
      'human investigate should not error on a redundant agent session',
    ).toBeUndefined();
    // Human output is not JSON.
    expect(() => JSON.parse(stdout)).toThrow();
    // It contains the formatting produced by formatInvestigation.
    expect(stdout).toContain('Investigation:');
    expect(stdout).toContain('TIMELINE');
  });
});

// ---------------------------------------------------------------------------
// Criterion 5: no-redundant-call agent session
// ---------------------------------------------------------------------------

describe('investigate: agent session with no redundant calls (criterion 5)', () => {
  it('--json still emits a valid object with an empty investigations array', async () => {
    const sessionId = seedSession('agent', CLEAN_OPS);

    const { stdout, error } = await runInvestigate([sessionId, '--json']);

    expect(error, '--json on a clean agent session should not error').toBeUndefined();
    expect(() => JSON.parse(stdout)).not.toThrow();

    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed['schema_version']).toBe('specwatch.investigation.v1');
    expect(typeof parsed['session_id']).toBe('string');
    expect(Array.isArray(parsed['investigations'])).toBe(true);
    expect(parsed['investigations']).toEqual([]);
  });

  it('without --json prints an informational "No redundant calls" line to stderr, not stdout', async () => {
    const sessionId = seedSession('agent', CLEAN_OPS);

    const { stdout, stderr, error } = await runInvestigate([sessionId]);

    expect(error, 'human investigate on a clean agent session should not error').toBeUndefined();
    expect(stderr).toContain('No redundant calls');
    // The informational line is NOT on stdout.
    expect(stdout).not.toContain('No redundant calls');
  });
});

// ---------------------------------------------------------------------------
// Edge case: --tool --json (single-operation JSON)
// ---------------------------------------------------------------------------

describe('investigate --tool --json: single-operation JSON', () => {
  it('emits the pinned envelope with exactly the requested operation', async () => {
    const sessionId = seedSession('agent', REDUNDANT_OPS);

    const { stdout, error } = await runInvestigate([sessionId, '--tool', 'tools/list', '--json']);

    expect(error, '--tool --json should not error for a present operation').toBeUndefined();
    expect(() => JSON.parse(stdout)).not.toThrow();

    const parsed = JSON.parse(stdout) as {
      schema_version: string;
      session_id: string;
      investigations: Array<{ operation_key: string; primary_cause: string }>;
    };
    expect(parsed.schema_version).toBe('specwatch.investigation.v1');
    expect(parsed.session_id).toBe(sessionId);
    // The --tool path serializes exactly one investigation: the requested op.
    expect(parsed.investigations).toHaveLength(1);
    expect(parsed.investigations[0].operation_key).toBe('tools/list');
    expect(typeof parsed.investigations[0].primary_cause).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// Criterion 6: non-agent session errors
// ---------------------------------------------------------------------------

describe('investigate: non-agent (human) session errors (criterion 6)', () => {
  it('errors, requiring a session captured with --consumer agent', async () => {
    const sessionId = seedSession('human', REDUNDANT_OPS);

    const { stderr, error } = await runInvestigate([sessionId, '--json']);

    // The command reaches its error path (handleError -> stubbed process.exit throws).
    expect(error).toBeDefined();
    expect(stderr.toLowerCase()).toContain('agent');
  });
});
