/**
 * Independent, spec-first black-box contract: approved release-recovery design
 * §2a / AC9–10 and plan S1. No production imports, repository seeding or mocks.
 * Sentinels exist ONLY in HTTP header values, never bodies, names, paths or queries.
 * npm's pretest builds the CLI; direct Vitest runs require npm run build first.
 */
import { expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, get, type IncomingHttpHeaders, type Server } from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = join(ROOT, 'dist/index.js');
const BODY = JSON.stringify({ id: 7, label: 'fixture', available: true });
const VALUES = {
  custom: 'SYNTHETIC_CUSTOM_67cb41',
  cookie: 'SYNTHETIC_COOKIE_32abc8',
  setCookie: 'SYNTHETIC_SET_COOKIE_f7d814',
  location: 'SYNTHETIC_LOCATION_c49a13',
  bearer: 'SYNTHETIC_BEARER_62dd18',
  apiKey: 'SYNTHETIC_API_KEY_a92f43',
  response: 'SYNTHETIC_RESPONSE_4d9c28',
};
const REQUEST_HEADERS = {
  'X-Shared-Context': VALUES.custom,
  Cookie: `session=${VALUES.cookie}`,
  Authorization: `Bearer ${VALUES.bearer}`,
  'X-API-Key': VALUES.apiKey,
};
const RESPONSE_HEADERS = {
  'Content-Type': 'application/json',
  'Set-Cookie': [`session=${VALUES.setCookie}; HttpOnly`],
  Location: `/next/${VALUES.location}`,
  'X-Upstream-Context': VALUES.response,
};
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

async function until(check: () => boolean, label: string, timeout = 10_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await pause(25);
  }
}

function launch(args: string[], home: string) {
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    env: { ...process.env, SPECWATCH_HOME: home, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let spawnError: Error | undefined;
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.on('error', (error) => {
    spawnError = error;
  });
  return { child, stdout: () => stdout, stderr: () => stderr, error: () => spawnError };
}

function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function dispose(child: ChildProcess): Promise<void> {
  if (exited(child) || child.pid === undefined) return;
  child.kill('SIGTERM');
  try {
    await until(() => exited(child), 'owned child SIGTERM', 2_000);
  } catch {
    child.kill('SIGKILL');
    await until(() => exited(child), 'owned child SIGKILL', 2_000);
  }
}

async function run(args: string[], home: string) {
  const processRun = launch(args, home);
  try {
    await until(() => {
      if (processRun.error()) throw processRun.error();
      return exited(processRun.child);
    }, `CLI ${args[0]}`);
    expect(processRun.child.signalCode, `${args[0]} must exit normally`).toBeNull();
    expect(processRun.child.exitCode, `${args[0]}: ${processRun.stderr()}`).toBe(0);
    return { stdout: processRun.stdout(), stderr: processRun.stderr() };
  } finally {
    await dispose(processRun.child);
  }
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      done();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing owned TCP address');
  return address.port;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  if (!server.listening) return;
  await new Promise<void>((done, reject) =>
    server.close((error) => (error ? reject(error) : done())),
  );
}

function ownedFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? ownedFiles(path) : entry.isFile() ? [path] : [];
  });
}

function databasePath(home: string): string | undefined {
  return ownedFiles(home).find(
    (path) => readFileSync(path).subarray(0, 16).toString() === 'SQLite format 3\u0000',
  );
}

function readRows(path: string, table: 'samples' | 'aggregated_schemas') {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return db.prepare(`SELECT request_headers, response_headers FROM ${table}`).all() as Array<{
      request_headers: string | null;
      response_headers: string | null;
    }>;
  } finally {
    db.close();
  }
}

function assertNoSentinels(text: string | Buffer, sink: string): void {
  for (const [label, sentinel] of Object.entries(VALUES)) {
    expect
      .soft(text.includes(sentinel), `${sink}: ${label} header value must not survive`)
      .toBe(false);
  }
}

function assertMetadata(raw: string | null, expected: string[], sink: string): void {
  expect.soft(raw, `${sink}: metadata must be captured`).not.toBeNull();
  if (raw === null) return;
  assertNoSentinels(raw, sink);
  const entries = JSON.parse(raw) as Array<Record<string, unknown>>;
  expect.soft(Array.isArray(entries), `${sink}: metadata array`).toBe(true);
  for (const name of expected) {
    expect
      .soft(
        entries.map((entry) => entry.name),
        `${sink}: ${name} presence`,
      )
      .toContain(name);
  }
  for (const entry of entries) {
    expect
      .soft(Object.keys(entry).sort(), `${sink}: names and closed enum ONLY`)
      .toEqual(entry.authSchemes === undefined ? ['name'] : ['authSchemes', 'name']);
    if (entry.authSchemes !== undefined) {
      expect.soft(entry.name).toBe('authorization');
      expect.soft(entry.authSchemes).toEqual(['bearer']);
    }
    if (entry.name === 'authorization') expect.soft(entry.authSchemes).toEqual(['bearer']);
  }
}

it('real CLI preserves peer headers but retains only structural metadata across capture, SQLite and every export/report', async () => {
  const home = mkdtempSync(join(tmpdir(), 'specwatch-header-privacy-cli-'));
  const seen: IncomingHttpHeaders[] = [];
  const upstream = createServer((request, response) => {
    seen.push(request.headers);
    response.writeHead(200, RESPONSE_HEADERS);
    response.end(BODY);
  });
  let capture: ReturnType<typeof launch> | undefined;
  try {
    const upstreamPort = await listen(upstream);
    const reservation = createServer();
    const proxyPort = await listen(reservation);
    await close(reservation);
    const name = 'header-privacy-fixture';
    capture = launch(
      [
        'start',
        `http://127.0.0.1:${upstreamPort}`,
        '--port',
        String(proxyPort),
        '--name',
        name,
        '--consumer',
        'agent',
      ],
      home,
    );
    const active = capture;
    await until(() => {
      if (active.error()) throw active.error();
      if (exited(active.child)) throw new Error(`CLI exited before readiness: ${active.stderr()}`);
      return active.stderr().includes('Specwatch proxy started');
    }, 'real stderr proxy readiness');

    // No readiness HTTP probe: all six captured calls are intentional fixture traffic.
    for (const path of ['/items', '/catalog', '/items', '/catalog', '/items', '/catalog']) {
      const result = await new Promise<{
        status: number | undefined;
        headers: IncomingHttpHeaders;
        body: string;
      }>((done, reject) => {
        const request = get(
          `http://127.0.0.1:${proxyPort}${path}`,
          { headers: REQUEST_HEADERS, agent: false },
          (response) => {
            let body = '';
            response.on('data', (chunk: Buffer) => {
              body += chunk.toString();
            });
            response.on('error', reject);
            response.on('end', () =>
              done({ status: response.statusCode, headers: response.headers, body }),
            );
          },
        );
        request.setTimeout(5_000, () => request.destroy(new Error('Owned proxy request timeout')));
        request.on('error', reject);
      });
      expect(result.status).toBe(200);
      expect(result.body).toBe(BODY);
      expect(result.headers['set-cookie']).toEqual(RESPONSE_HEADERS['Set-Cookie']);
      expect(result.headers.location).toBe(RESPONSE_HEADERS.Location);
      expect(result.headers['x-upstream-context']).toBe(VALUES.response);
    }
    expect(seen).toHaveLength(6);
    for (const headers of seen) {
      expect(headers['x-shared-context']).toBe(VALUES.custom);
      expect(headers.cookie).toBe(REQUEST_HEADERS.Cookie);
      expect(headers.authorization).toBe(REQUEST_HEADERS.Authorization);
      expect(headers['x-api-key']).toBe(VALUES.apiKey);
    }
    await until(() => {
      const path = databasePath(home);
      return path !== undefined && readRows(path, 'samples').length === 6;
    }, 'six real persisted samples');
    active.child.kill('SIGINT');
    await until(() => exited(active.child), 'graceful capture shutdown and aggregation');
    expect(active.child.signalCode).toBeNull();
    expect(active.child.exitCode, active.stderr()).toBe(0);

    // Execute every real command before privacy assertions: a behavioral RED must
    // not conceal an unexercised export/report path or a broken subprocess harness.
    const outputs: Array<{ label: string; stdout: string; stderr: string }> = [];
    for (const version of ['3.1', '3.0']) {
      for (const metadata of [false, true]) {
        const args = ['export', '--name', name, '--json'];
        if (version === '3.0') args.push('--openapi-version', '3.0');
        if (metadata) args.push('--include-metadata');
        outputs.push({ label: `OAS ${version} metadata=${metadata}`, ...(await run(args, home)) });
      }
    }
    outputs.push({
      label: 'raw JSON',
      ...(await run(['export', '--name', name, '--format', 'json'], home)),
    });
    outputs.push({ label: 'agent JSON', ...(await run(['agent-report', '--name', name], home)) });
    outputs.push({
      label: 'agent human',
      ...(await run(['agent-report', '--name', name, '--human'], home)),
    });
    outputs.push({
      label: 'investigation JSON',
      ...(await run(['investigate', '--name', name, '--json'], home)),
    });
    console.info(
      'CLI privacy journey: readiness, 6 forwarded calls, SIGINT exit 0, 4 OAS exports, raw export, agent JSON/human and investigation executed',
    );

    for (const output of outputs) {
      assertNoSentinels(output.stdout, output.label);
      assertNoSentinels(output.stderr, `${output.label} stderr`);
      if (output.label.startsWith('OAS')) {
        const doc = JSON.parse(output.stdout);
        expect.soft(doc.openapi).toBe(output.label.includes('3.0') ? '3.0.3' : '3.1.0');
        const security = Object.values(doc.components.securitySchemes);
        expect
          .soft(security)
          .toContainEqual(expect.objectContaining({ type: 'http', scheme: 'bearer' }));
        expect.soft(security).toContainEqual(
          expect.objectContaining({
            type: 'apiKey',
            in: 'header',
            name: expect.stringMatching(/^x-api-key$/i),
          }),
        );
        for (const path of ['/items', '/catalog']) {
          const operation = doc.paths[path].get;
          const parameter = (operation.parameters ?? []).find(
            (item: Record<string, unknown>) =>
              item.in === 'header' && item.name === 'x-shared-context',
          );
          expect
            .soft(parameter, `${output.label} ${path}: shared header remains per operation`)
            .toMatchObject({
              name: 'x-shared-context',
              in: 'header',
              required: false,
              schema: { type: 'string' },
            });
          if (parameter !== undefined) expect.soft(parameter).not.toHaveProperty('example');
          const responseSchema = operation.responses['200'].content['application/json'].schema;
          const resolvedSchema = responseSchema.$ref
            ? responseSchema.$ref
                .split('/')
                .slice(1)
                .reduce(
                  (value: Record<string, unknown>, segment: string) =>
                    value[segment.replace(/~1/g, '/').replace(/~0/g, '~')] as Record<
                      string,
                      unknown
                    >,
                  doc,
                )
            : responseSchema;
          expect.soft(resolvedSchema.properties).toMatchObject({
            id: { type: 'integer' },
            label: { type: 'string' },
            available: { type: 'boolean' },
          });
        }
      } else if (output.label === 'agent JSON') {
        expect(JSON.parse(output.stdout).schema_version).toBe('specwatch.agent_evidence.v1');
      } else if (output.label === 'investigation JSON') {
        const investigation = JSON.parse(output.stdout);
        expect(investigation.schema_version).toBe('specwatch.investigation.v1');
        expect(Array.isArray(investigation.investigations)).toBe(true);
      } else if (output.label === 'agent human') {
        expect(output.stdout).toContain('Agent-Friendliness Report');
      } else {
        expect(() => JSON.parse(output.stdout)).not.toThrow();
        expect.soft(output.stdout).toContain('available');
      }
    }
    const dbPath = databasePath(home);
    expect(dbPath).toBeDefined();
    for (const table of ['samples', 'aggregated_schemas'] as const) {
      const rows = readRows(dbPath!, table);
      expect(rows.length, `${table} cannot be vacuous`).toBeGreaterThan(0);
      for (const [index, row] of rows.entries()) {
        assertMetadata(
          row.request_headers,
          ['x-shared-context', 'cookie', 'authorization', 'x-api-key'],
          `${table}[${index}] request`,
        );
        assertMetadata(
          row.response_headers,
          ['set-cookie', 'location', 'x-upstream-context'],
          `${table}[${index}] response`,
        );
      }
    }
    assertNoSentinels(active.stdout(), 'capture stdout');
    assertNoSentinels(active.stderr(), 'capture stderr');
    // Fresh owned store only: physical check is NOT a legacy-erasure guarantee.
    for (const path of ownedFiles(home))
      assertNoSentinels(readFileSync(path), 'fresh owned store bytes');
  } finally {
    try {
      if (capture) await dispose(capture.child);
    } finally {
      try {
        await close(upstream);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }
  }
}, 60_000);
