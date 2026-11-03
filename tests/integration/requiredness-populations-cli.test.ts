/** Independent black-box requiredness contract: real CLI and owned loopback/store. */
import { beforeAll, describe, expect, it } from 'vitest';
import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import Database from 'better-sqlite3';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, get, type Server } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = process.env.SPECWATCH_TEST_CLI ?? join(ROOT, 'dist/index.js');
const SCRATCH = process.env.TMPDIR ?? tmpdir();
const USER = { id: 123, name: 'fixture', email: 'fixture' };
const EXTRA = { ...USER, alias: 'fixture' };
type Schema = Record<string, unknown>;
interface Document {
  openapi: string;
  components?: { schemas: Record<string, Schema> };
  paths: Record<
    string,
    { get: { responses: Record<string, { content: Record<string, { schema: Schema }> }> } }
  >;
}
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
async function until(check: () => boolean, label: string, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await pause(25);
  }
}
function exited(child: ChildProcess) {
  return child.exitCode !== null || child.signalCode !== null;
}
function launch(args: string[], home: string) {
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    env: { ...process.env, HOME: home, TMPDIR: home, SPECWATCH_HOME: home, NO_COLOR: '1' },
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
  child.on('error', (caught) => {
    error = caught;
  });
  return { child, stdout: () => stdout, stderr: () => stderr, error: () => error };
}
async function dispose(child: ChildProcess) {
  if (exited(child) || child.pid === undefined) return;
  child.kill('SIGTERM');
  try {
    await until(() => exited(child), 'owned CLI SIGTERM', 2_000);
  } catch {
    child.kill('SIGKILL');
    await until(() => exited(child), 'owned CLI SIGKILL', 2_000);
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
    return active.stdout();
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
  if (!address || typeof address === 'string') throw new Error('Missing owned TCP address');
  return address.port;
}
async function close(server: Server) {
  server.closeAllConnections();
  if (server.listening)
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
}
async function request(port: number, path: string): Promise<unknown> {
  return new Promise((done, reject) => {
    const req = get(`http://127.0.0.1:${port}${path}`, { agent: false }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      res.on('error', reject);
      res.on('end', () => {
        try {
          expect(res.statusCode).toBe(200);
          expect(res.headers['content-type']).toContain('application/json');
          done(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.setTimeout(5_000, () => req.destroy(new Error('Owned proxy request timeout')));
    req.on('error', reject);
  });
}
function inspect<T>(home: string, read: (db: Database.Database) => T): T {
  const db = new Database(join(home, 'specwatch.db'), { readonly: true, fileMustExist: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}
function validator(doc: Document, path: string) {
  const schema = doc.paths[path].get.responses['200'].content['application/json'].schema;
  const ajv = doc.openapi === '3.1.0' ? new Ajv2020({ strict: false }) : new Ajv({ strict: false });
  ajv.addFormat('int32', {
    type: 'number',
    validate: (value: number) => Number.isInteger(value) && value >= -(2 ** 31) && value < 2 ** 31,
  });
  return ajv.compile({ ...schema, components: doc.components });
}
function check(doc: Document, path: string, value: unknown, accepted: boolean) {
  const validate = validator(doc, path);
  const actual = validate(value);
  expect
    .soft(
      actual,
      `CLI ${doc.openapi} ${path} ${JSON.stringify(value)} expected=${accepted}; errors=${JSON.stringify(validate.errors)}`,
    )
    .toBe(accepted);
}

// Every semantic test runs even when another expected behavior is missing.
// No generated required list is used to decide which fields must be rejected.
describe('real CLI object/array requiredness populations', () => {
  const documents = new Map<string, Document>();
  beforeAll(async () => {
    expect(isAbsolute(CLI), 'SPECWATCH_TEST_CLI must be absolute').toBe(true);
    expect(existsSync(CLI), 'candidate must already exist; harness never builds').toBe(true);
    const home = mkdtempSync(join(SCRATCH, 'specwatch-requiredness-cli-'));
    const observations: Array<[string, unknown]> = [];
    for (let index = 0; index < 40; index++) {
      observations.push(
        ['/users', index % 2 ? USER : EXTRA],
        ['/users/123', index % 2 ? EXTRA : USER],
        ['/nullable', { user: index % 2 ? null : USER }],
        ['/arrays', index % 3 === 0 ? [] : index % 3 === 1 ? [EXTRA, USER, EXTRA] : [USER]],
      );
    }
    const queues = new Map<string, unknown[]>();
    for (const [path, body] of observations) queues.set(path, [...(queues.get(path) ?? []), body]);
    const seen: Array<[string, unknown]> = [];
    const upstream = createServer((req, res) => {
      const queue = queues.get(req.url!);
      if (req.method !== 'GET' || !queue?.length) {
        res.writeHead(500);
        res.end('unexpected fixture request');
        return;
      }
      const body = queue.shift();
      seen.push([req.url!, body]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    let capture: ReturnType<typeof launch> | undefined;
    let reservation: Server | undefined;
    try {
      const upstreamPort = await listen(upstream);
      for (let attempt = 0; attempt < 3; attempt++) {
        reservation = createServer();
        const proxyPort = await listen(reservation);
        await close(reservation);
        capture = launch(
          [
            'start',
            `http://127.0.0.1:${upstreamPort}`,
            '--port',
            String(proxyPort),
            '--name',
            `requiredness-${attempt}`,
            '--consumer',
            'agent',
          ],
          home,
        );
        const active = capture;
        try {
          await until(() => {
            if (active.error()) throw active.error();
            if (exited(active.child))
              throw new Error(`CLI exited before readiness: ${active.stderr()}`);
            return active.stderr().includes('Specwatch proxy started');
          }, 'CLI readiness');
        } catch (error) {
          await dispose(active.child);
          if (attempt < 2 && /EADDRINUSE|address already in use/i.test(active.stderr())) continue;
          throw error;
        }
        for (const [path, body] of observations)
          expect(await request(proxyPort, path)).toEqual(body);
        break;
      }
      expect(seen).toEqual(observations);
      expect([...queues.values()].every((queue) => queue.length === 0)).toBe(true);
      await until(
        () =>
          inspect(
            home,
            (db) =>
              (db.prepare('SELECT COUNT(*) AS count FROM samples').get() as { count: number })
                .count === observations.length,
          ),
        'all 160 persisted samples',
      );
      capture!.child.kill('SIGINT');
      await until(() => exited(capture!.child), 'graceful SIGINT and aggregation');
      expect(capture!.child.signalCode).toBeNull();
      expect(capture!.child.exitCode, capture!.stderr()).toBe(0);
      const sessions = inspect(
        home,
        (db) =>
          db.prepare('SELECT id, status, sample_count FROM sessions').all() as Array<{
            id: string;
            status: string;
            sample_count: number;
          }>,
      );
      expect(sessions).toHaveLength(1);
      expect(sessions[0].status).toBe('completed');
      expect(sessions[0].sample_count).toBe(observations.length);
      for (const version of ['3.1', '3.0']) {
        const doc = JSON.parse(
          await run(['export', sessions[0].id, '--json', '--openapi-version', version], home),
        ) as Document;
        expect(doc.openapi).toBe(version === '3.1' ? '3.1.0' : '3.0.3');
        documents.set(version, doc);
      }
      console.info(
        `CLI ${CLI}: ${observations.length} forwarded/persisted samples; session completed; SIGINT exit 0; 3.1/3.0 exports parsed`,
      );
    } finally {
      try {
        if (capture) await dispose(capture.child);
      } finally {
        try {
          if (reservation) await close(reservation);
        } finally {
          try {
            await close(upstream);
          } finally {
            rmSync(home, { recursive: true, force: true });
          }
        }
      }
    }
  }, 60_000);

  describe.each(['3.1', '3.0'])('export OAS %s', (version) => {
    it('rejects missing universally observed fields at both non-null user endpoints', () => {
      const doc = documents.get(version)!;
      const itemPaths = Object.keys(doc.paths).filter((path) => /^\/users\/\{[^}]+\}$/.test(path));
      expect(itemPaths).toHaveLength(1);
      for (const path of ['/users', itemPaths[0]]) {
        check(doc, path, USER, true);
        check(doc, path, EXTRA, true);
        for (const key of Object.keys(USER))
          check(
            doc,
            path,
            Object.fromEntries(Object.entries(USER).filter(([name]) => name !== key)),
            false,
          );
        check(doc, path, null, false);
        check(doc, path, { ...USER, id: 'wrong' }, false);
        check(doc, path, { ...USER, id: 2 ** 31 }, false);
      }
    });
    it('accepts null only at its observed wrapper site while retaining required inner fields', () => {
      const doc = documents.get(version)!;
      check(doc, '/nullable', { user: USER }, true);
      check(doc, '/nullable', { user: null }, true);
      check(doc, '/nullable', {}, false);
      check(doc, '/nullable', null, false);
      for (const key of Object.keys(USER))
        check(
          doc,
          '/nullable',
          { user: Object.fromEntries(Object.entries(USER).filter(([name]) => name !== key)) },
          false,
        );
      for (const user of [7, false, 'fixture', { ...USER, id: 'wrong' }])
        check(doc, '/nullable', { user }, false);
    });
    it('retains optional element fields without weakening universal array-element fields', () => {
      const doc = documents.get(version)!;
      for (const value of [[], [USER], [EXTRA, USER, EXTRA]]) check(doc, '/arrays', value, true);
      for (const key of Object.keys(USER))
        check(
          doc,
          '/arrays',
          [USER, Object.fromEntries(Object.entries(USER).filter(([name]) => name !== key)), EXTRA],
          false,
        );
      check(doc, '/arrays', [null], false);
      check(doc, '/arrays', [{ ...USER, id: 'wrong' }], false);
    });
  });
});
