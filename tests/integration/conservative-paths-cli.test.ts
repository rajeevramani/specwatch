/** Independent b0e.1 real-CLI contract. No production imports or repository seeding.
 * Uses the existing compiled CLI, or an absolute exact-installed candidate override.
 * Numeric/code controls exercise capture normalization, NOT positive legacy Case2.
 */
import { expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, get, type Server } from 'node:http';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = process.env.SPECWATCH_TEST_CLI ?? join(ROOT, 'dist/index.js');
const BODY = JSON.stringify({ enabled: true, label: 'synthetic' });
const STATIC = [
  '/config/theme',
  '/config/language',
  '/arbitrary/cobalt',
  '/arbitrary/meadow',
  '/owners/owner_alice',
  '/owners/owner_bob',
];
const DYNAMIC = ['/users/123', '/users/456', '/orders/ord_1', '/orders/ord_2'];
const TRAFFIC = [...STATIC, ...DYNAMIC];
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

async function until(check: () => boolean, label: string, timeout = 10_000) {
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
  let error: Error | undefined;
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.on('error', (value) => {
    error = value;
  });
  return { child, stdout: () => stdout, stderr: () => stderr, error: () => error };
}
async function dispose(child: ChildProcess) {
  if (exited(child) || child.pid === undefined) return;
  child.kill('SIGTERM');
  try {
    await until(() => exited(child), 'SIGTERM cleanup', 2_000);
  } catch {
    child.kill('SIGKILL');
    await until(() => exited(child), 'SIGKILL cleanup', 2_000);
  }
}
async function run(args: string[], home: string) {
  const active = launch(args, home);
  try {
    await until(() => {
      if (active.error()) throw active.error();
      return exited(active.child);
    }, `CLI ${args[0]}`);
    expect(active.child.signalCode).toBeNull();
    expect(active.child.exitCode, active.stderr()).toBe(0);
    return JSON.parse(active.stdout());
  } finally {
    await dispose(active.child);
  }
}
async function listen(server: Server) {
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      done();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  return address.port;
}
async function close(server: Server) {
  server.closeAllConnections();
  if (server.listening)
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
}
function rows(home: string) {
  const path = join(home, 'specwatch.db');
  if (!existsSync(path)) return [];
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return db
      .prepare('SELECT http_method, path, normalized_path, status_code FROM samples ORDER BY id')
      .all() as Array<{
      http_method: string;
      path: string;
      normalized_path: string;
      status_code: number;
    }>;
  } finally {
    db.close();
  }
}
async function request(port: number, path: string) {
  return new Promise<{ status: number | undefined; body: string }>((done, reject) => {
    const request = get(`http://127.0.0.1:${port}${path}`, { agent: false }, (response) => {
      let body = '';
      response.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      response.on('error', reject);
      response.on('end', () => done({ status: response.statusCode, body }));
    });
    request.on('error', reject);
    request.setTimeout(5_000, () => request.destroy(new Error('Fixture request timed out')));
  });
}

it('real capture preserves static siblings and existing numeric/code paths through both OAS exports', async () => {
  expect(isAbsolute(CLI), 'SPECWATCH_TEST_CLI must be absolute').toBe(true);
  const home = mkdtempSync(join(tmpdir(), 'specwatch-conservative-paths-cli-'));
  const seen: string[] = [];
  const upstream = createServer((request, response) => {
    seen.push(request.url ?? '');
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(BODY);
  });
  let capture: ReturnType<typeof launch> | undefined;
  try {
    const upstreamPort = await listen(upstream);
    // Retry a complete boot only for a demonstrated port-bind race.
    let proxyPort = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      const reservation = createServer();
      try {
        proxyPort = await listen(reservation);
      } finally {
        await close(reservation);
      }
      capture = launch(
        [
          'start',
          `http://127.0.0.1:${upstreamPort}`,
          '--port',
          String(proxyPort),
          '--name',
          'conservative-path-fixture',
          '--consumer',
          'agent',
          '--max-samples',
          '1000',
        ],
        home,
      );
      const active = capture;
      await until(() => {
        if (active.error()) throw active.error();
        return active.stderr().includes('Specwatch proxy started') || exited(active.child);
      }, 'stderr readiness');
      if (!exited(active.child)) break;
      if (!/EADDRINUSE|address already in use/i.test(active.stderr()) || attempt === 2) {
        throw new Error(`CLI failed before readiness: ${active.stderr()}`);
      }
      await dispose(active.child);
    }
    const active = capture!;
    expect(active.stderr()).toContain('Specwatch proxy started');
    for (const path of TRAFFIC) {
      expect(await request(proxyPort, path), path).toEqual({ status: 200, body: BODY });
    }
    expect(seen).toEqual(TRAFFIC);
    await until(() => rows(home).length === TRAFFIC.length, 'all ten samples persisted');
    const captured = rows(home);
    expect(captured.map((row) => row.path)).toEqual(TRAFFIC);
    for (const row of captured) {
      expect(row.http_method).toBe('GET');
      expect(row.status_code).toBe(200);
      const expected = STATIC.includes(row.path)
        ? row.path
        : row.path.startsWith('/users/')
          ? '/users/{userId}'
          : '/orders/{orderCode}';
      expect(row.normalized_path, row.path).toBe(expected);
    }
    active.child.kill('SIGINT');
    await until(() => exited(active.child), 'graceful SIGINT aggregation');
    expect(active.child.signalCode).toBeNull();
    expect(active.child.exitCode, active.stderr()).toBe(0);
    const outputs = [];
    for (const version of ['3.1', '3.0']) {
      outputs.push(
        await run(
          ['export', '--name', 'conservative-path-fixture', '--json', '--openapi-version', version],
          home,
        ),
      );
    }
    console.info(
      'Conservative CLI controls: 10 exact forwarded responses, 10 captured normalized rows, SIGINT exit 0, both exports executed',
    );
    for (const [index, doc] of outputs.entries()) {
      expect(doc.openapi).toBe(index === 0 ? '3.1.0' : '3.0.3');
      // Hard positive controls first: behavioral RED below must not hide them.
      for (const path of ['/users/{userId}', '/orders/{orderCode}']) {
        expect(
          doc.paths[path]?.get?.responses,
          `${doc.openapi} normalization ${path}`,
        ).toHaveProperty('200');
      }
      const expectedPaths = [...STATIC, '/users/{userId}', '/orders/{orderCode}'].sort();
      expect
        .soft(Object.keys(doc.paths).sort(), `${doc.openapi} exact conservative paths`)
        .toEqual(expectedPaths);
      for (const path of STATIC) {
        expect
          .soft(doc.paths[path]?.get?.responses ?? {}, `${doc.openapi} static ${path}`)
          .toHaveProperty('200');
      }
    }
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
