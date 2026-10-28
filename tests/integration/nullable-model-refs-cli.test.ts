/** Black-box acceptance5: real CLI, loopback traffic, private disposable store. No production imports. */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import Database from 'better-sqlite3';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, get, type Server } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = process.env.SPECWATCH_TEST_CLI ?? join(ROOT, 'dist/index.js');
const USER = { id: 123, name: 'fixture', email: 'fixture' };
interface Schema {
  $ref?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  oneOf?: Schema[];
  anyOf?: Schema[];
  allOf?: Schema[];
}
interface Document {
  openapi: string;
  components: { schemas: Record<string, Schema> };
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
function inspectStore<T>(home: string, read: (db: Database.Database) => T): T {
  const db = new Database(join(home, 'specwatch.db'), { readonly: true, fileMustExist: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}
function response(doc: Document, path: string): Schema {
  return doc.paths[path].get.responses['200'].content['application/json'].schema;
}
function resolveSchema(doc: Document, schema: Schema): Schema {
  if (!schema.$ref) return schema;
  expect(schema.$ref).toMatch(/^#\/components\/schemas\//);
  const name = schema.$ref.split('/').at(-1)!.replace(/~1/g, '/').replace(/~0/g, '~');
  expect(doc.components.schemas[name], `resolvable ${schema.$ref}`).toBeDefined();
  return resolveSchema(doc, doc.components.schemas[name]);
}
function refs(schema: Schema): string[] {
  return [
    ...(schema.$ref ? [schema.$ref] : []),
    ...Object.values(schema.properties ?? {}).flatMap(refs),
    ...[...(schema.oneOf ?? []), ...(schema.anyOf ?? []), ...(schema.allOf ?? [])].flatMap(refs),
  ];
}
function validator(doc: Document, schema: Schema) {
  const ajv = doc.openapi === '3.1.0' ? new Ajv2020({ strict: false }) : new Ajv({ strict: false });
  // OpenAPI's signed int32 format is not built into AJV; validate it rather
  // than silently ignoring the generated numeric constraint.
  ajv.addFormat('int32', {
    type: 'number',
    validate: (value: number) => Number.isInteger(value) && value >= -(2 ** 31) && value < 2 ** 31,
  });
  return ajv.compile({ ...schema, components: doc.components });
}

describe('real CLI nullable promoted model references', () => {
  const documents = new Map<string, Document>();
  let cleanup: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    expect(isAbsolute(CLI), 'SPECWATCH_TEST_CLI must be an absolute candidate script').toBe(true);
    expect(
      existsSync(CLI),
      'build the candidate before running this test; this harness never builds',
    ).toBe(true);
    const home = mkdtempSync(join(tmpdir(), 'specwatch-nullable-cli-'));
    let nullableCalls = 0;
    const seen: string[] = [];
    const upstream = createServer((req, res) => {
      seen.push(req.url!);
      const body =
        req.url === '/nullable' ? { user: nullableCalls++ % 2 === 0 ? USER : null } : USER;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    let capture: ReturnType<typeof launch> | undefined;
    let reservation: Server | undefined;
    cleanup = async () => {
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
    };
    try {
      const upstreamPort = await listen(upstream);
      // Retry the entire boot only if stderr proves the released-port race.
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
            `nullable-${attempt}`,
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
          }, 'stderr readiness');
        } catch (error) {
          await dispose(active.child);
          if (attempt < 2 && /EADDRINUSE|address already in use/i.test(active.stderr())) continue;
          throw error;
        }
        for (let index = 0; index < 40; index++) {
          expect(await request(proxyPort, '/users')).toEqual(USER);
          expect(await request(proxyPort, '/users/123')).toEqual(USER);
          expect(await request(proxyPort, '/nullable')).toEqual({
            user: index % 2 === 0 ? USER : null,
          });
        }
        break;
      }
      expect(seen).toHaveLength(120);
      expect(nullableCalls).toBe(40);
      await until(
        () =>
          inspectStore(
            home,
            (db) =>
              (db.prepare('SELECT COUNT(*) AS count FROM samples').get() as { count: number })
                .count === 120,
          ),
        '120 real persisted samples',
      );
      capture!.child.kill('SIGINT');
      await until(() => exited(capture!.child), 'graceful SIGINT aggregation');
      expect(capture!.child.signalCode).toBeNull();
      expect(capture!.child.exitCode, capture!.stderr()).toBe(0);
      const session = inspectStore(
        home,
        (db) =>
          db.prepare('SELECT id, status FROM sessions WHERE sample_count = 120').get() as
            | { id: string; status: string }
            | undefined,
      );
      expect(session?.status).toBe('completed');
      for (const version of ['3.1', '3.0']) {
        const output = await run(
          ['export', session!.id, '--json', '--openapi-version', version],
          home,
        );
        documents.set(version, JSON.parse(output) as Document);
      }
      console.info(
        `CLI ${CLI}: 120 forwarded/persisted samples, 20 observed null bodies, SIGINT exit 0, both exports completed`,
      );
    } catch (error) {
      await cleanup();
      cleanup = undefined;
      throw error;
    }
  }, 60_000);
  afterAll(async () => {
    await cleanup?.();
  });

  it.each(['3.1', '3.0'])(
    'OAS %s accepts captured null without weakening the shared non-null User',
    (version) => {
      const doc = documents.get(version)!;
      expect(doc.openapi).toBe(version === '3.1' ? '3.1.0' : '3.0.3');
      const userPaths = Object.keys(doc.paths).filter((path) => /^\/users\/\{[^}]+\}$/.test(path));
      expect(userPaths).toHaveLength(1);
      const userRef = response(doc, userPaths[0]).$ref;
      expect(userRef, 'actual CLI must promote User').toBeDefined();
      expect(response(doc, '/users').$ref).toBe(userRef);

      const shared = validator(doc, { $ref: userRef });
      expect(shared(USER), 'shared non-null User positive control').toBe(true);
      for (const value of [null, { ...USER, id: 'wrong' }, 7, 'fixture']) {
        expect(shared(value), `shared User rejects ${JSON.stringify(value)}`).toBe(false);
      }
      const nullable = resolveSchema(doc, response(doc, '/nullable'));
      expect(nullable.required).toContain('user');
      expect(refs(nullable.properties!.user)).toContain(userRef);
      const validate = validator(doc, response(doc, '/nullable'));
      expect(validate({ user: USER }), 'nullable usage non-null positive control').toBe(true);
      // Assert generated constraints only: this CLI fixture's shared component has
      // no required User fields (separate discovery limitation). Missing required
      // User fields are covered by the in-memory integration fixture instead.
      const required = resolveSchema(doc, { $ref: userRef }).required ?? [];
      const missingRequired = required.map((key) => ({
        user: Object.fromEntries(Object.entries(USER).filter(([name]) => name !== key)),
      }));
      for (const value of [
        {},
        { user: { ...USER, id: 'wrong' } },
        ...missingRequired,
        { user: 7 },
        { user: 'fixture' },
        { user: false },
      ]) {
        expect(validate(value), `nullable usage rejects ${JSON.stringify(value)}`).toBe(false);
      }
      const accepted = validate({ user: null });
      console.info(
        `CLI OAS ${version}: shared/non-null/required/malformed controls passed; observed-null=${accepted}; errors=${JSON.stringify(validate.errors)}`,
      );
      expect(accepted, `CLI OAS ${version} must accept captured {user:null}`).toBe(true);
    },
  );
});
