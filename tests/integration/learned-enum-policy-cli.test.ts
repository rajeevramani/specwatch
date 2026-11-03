/** Independent policy contract: public CLI only, synthetic loopback traffic and owned store.
 * No producer imports, document repairs, manual snapshots, builds or user databases.
 * SPECWATCH_TEST_CLI selects the exact already-built/installed artifact for qualification.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Ajv } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import Database from 'better-sqlite3';
import { load } from 'js-yaml';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, get, type Server } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

type Schema = Record<string, any>;
interface Document {
  openapi: string;
  components?: { schemas: Record<string, Schema> };
  paths: Record<
    string,
    { get: { responses: Record<string, { content: Record<string, { schema: Schema }> }> } }
  >;
}
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = process.env.SPECWATCH_TEST_CLI ?? join(ROOT, 'dist/index.js');
const PROFILE = { id: 123, swiftCode: 'MOCKUS33', referenceCode: 'BANK0001', status: 'active' };
const wrap = (profile: unknown) => ({ profile, profiles: [profile], nullableProfile: profile });
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
async function until(check: () => boolean, label: string, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await pause(25);
  }
}
const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;
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
    await until(
      () => {
        if (active.error()) throw active.error();
        return exited(active.child);
      },
      `CLI ${args.join(' ')}`,
    );
    return {
      code: active.child.exitCode,
      signal: active.child.signalCode,
      stdout: active.stdout(),
      stderr: active.stderr(),
    };
  } finally {
    await dispose(active.child);
  }
}
type Result = Awaited<ReturnType<typeof run>>;
function success(result: Result) {
  expect(result.signal).toBeNull();
  expect(result.code, `CLI API availability: ${result.stderr}`).toBe(0);
  return result.stdout;
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
function engine(version: string) {
  const ajv = version === '3.1.0' ? new Ajv2020({ strict: false }) : new Ajv({ strict: false });
  ajv.addFormat('int32', {
    type: 'number',
    validate: (value: number) => Number.isInteger(value) && value >= -(2 ** 31) && value < 2 ** 31,
  });
  return ajv;
}
const escapePointer = (key: string) => key.replace(/~/g, '~0').replace(/\//g, '~1');
function validator(doc: Document, path: string) {
  // Full unmodified document context, including every promoted component reference.
  return engine(doc.openapi).compile({
    ...doc,
    $ref: `#/paths/${escapePointer(path)}/get/responses/200/content/application~1json/schema`,
  });
}
function check(doc: Document, path: string, value: unknown, accepted: boolean) {
  const validate = validator(doc, path);
  expect
    .soft(
      validate(value),
      `${doc.openapi} ${path} ${JSON.stringify(value)} expected=${accepted}; ${JSON.stringify(validate.errors)}`,
    )
    .toBe(accepted);
}
function nodes(value: unknown): Schema[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(nodes);
  return [value as Schema, ...Object.values(value).flatMap(nodes)];
}
function agentExtensions(value: unknown, path: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) =>
      key === 'x-specwatch-agent'
        ? [[JSON.stringify([...path, key]), item]]
        : Object.entries(agentExtensions(item, [...path, key])),
    ),
  );
}
function pointer(doc: Document, ref: string): Schema {
  expect(ref).toMatch(/^#\//);
  let node: any = doc;
  for (const key of ref.slice(2).split('/'))
    node = node?.[key.replace(/~1/g, '/').replace(/~0/g, '~')];
  expect(node, `resolvable ${ref}`).toBeDefined();
  return node;
}
function deref(doc: Document, schema: Schema): Schema {
  const seen = new Set<string>();
  while (schema.$ref) {
    if (seen.has(schema.$ref)) throw new Error(`Cyclic alias ${schema.$ref}`);
    seen.add(schema.$ref);
    schema = pointer(doc, schema.$ref);
  }
  return schema;
}
const response = (doc: Document, path: string) =>
  doc.paths[path].get.responses['200'].content['application/json'].schema;
function paths(doc: Document, base: string) {
  const dynamic = Object.keys(doc.paths).filter((path) =>
    new RegExp(`^/${base}/\\{[^}]+\\}$`).test(path),
  );
  expect(dynamic, `one numeric ${base} template`).toHaveLength(1);
  return [`/${base}`, dynamic[0]];
}
const without = (value: Record<string, unknown>, key: string) =>
  Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
const cases = ['3.1', '3.0'].flatMap((version) =>
  ['json', 'yaml'].flatMap((encoding) =>
    [false, true].map((metadata) => ({
      version,
      encoding,
      metadata,
      label: `${version}/${encoding}/metadata=${metadata}`,
    })),
  ),
);

describe('real CLI learned enum policy', () => {
  let home: string;
  let session: string;
  let originalRaw: string;
  let help: Result;
  let rawOptIn: Result;
  const defaults = new Map<string, Document>();
  const optIns = new Map<string, Result>();
  const snapshots = new Map<string, Document>();
  const parse = (result: Result, encoding: string) =>
    (encoding === 'json' ? JSON.parse(success(result)) : load(success(result))) as Document;
  // Setup captures genuine traffic and records unsupported option results instead of aborting
  // before default-semantic assertions can run against the pre-policy executable.
  beforeAll(async () => {
    expect(isAbsolute(CLI), 'SPECWATCH_TEST_CLI must be absolute').toBe(true);
    expect(existsSync(CLI), 'harness never builds the candidate').toBe(true);
    home = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'specwatch-enum-policy-'));
    const observations: Array<[string, unknown]> = [];
    for (let index = 0; index < 18; index++) {
      const profile = {
        ...PROFILE,
        referenceCode: index % 2 ? 'BANK0002' : 'BANK0001',
        status: ['active', 'draft', null][index % 3],
      };
      // Keep every categorical label in the non-null nullable-site population;
      // correlating null with odd indices would accidentally remove BANK0002 there.
      const wrapper = { ...wrap(profile), nullableProfile: index % 4 === 0 ? null : profile };
      observations.push(
        ['/profiles', profile],
        ['/profiles/123', profile],
        ['/wrappers', wrapper],
        ['/wrappers/123', wrapper],
        ['/null', null],
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
        const port = await listen(reservation);
        await close(reservation);
        capture = launch(
          [
            'start',
            `http://127.0.0.1:${upstreamPort}`,
            '--port',
            String(port),
            '--name',
            `enum-policy-${attempt}`,
            '--consumer',
            'agent',
            '--max-samples',
            '1000',
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
          expect(await request(port, path), `forward ${path}`).toEqual(body);
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
        'all persisted samples',
      );
      capture!.child.kill('SIGINT');
      await until(() => exited(capture!.child), 'graceful SIGINT aggregation');
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
      session = sessions[0].id;
      const report = JSON.parse(success(await run(['agent-report', session], home)));
      expect(report.run.consumer, 'real persisted agent-consumer session').toBe('agent');
      expect(report.run.sample_count).toBe(observations.length);
      originalRaw = success(await run(['export', session, '--format', 'json'], home));
      help = await run(['export', '--help'], home);
      for (const item of cases) {
        const args = [
          'export',
          session,
          '--snapshot',
          '1',
          '--openapi-version',
          item.version,
          `--${item.encoding}`,
          ...(item.metadata ? ['--include-metadata'] : []),
        ];
        defaults.set(item.label, parse(await run(args, home), item.encoding));
        optIns.set(item.label, await run([...args, '--include-inferred-enums'], home));
      }
      // Re-read the very first stored snapshot, not a new capture/reaggregation.
      for (const version of ['3.1', '3.0'])
        snapshots.set(
          version,
          parse(
            await run(
              ['export', session, '--snapshot', '1', '--json', '--openapi-version', version],
              home,
            ),
            'json',
          ),
        );
      rawOptIn = await run(
        ['export', session, '--format', 'json', '--include-inferred-enums'],
        home,
      );
      console.info(
        `CLI ${CLI}: ${observations.length} synthetic forwarded/persisted samples; completed session; SIGINT exit 0; 8 default exports and 8 opt-in attempts; stored snapshot 1 exported without reaggregation`,
      );
      console.info(
        `Opt-in API results: ${JSON.stringify([...optIns].map(([label, result]) => ({ label, code: result.code, stderr: result.stderr })))}`,
      );
    } finally {
      try {
        if (capture) await dispose(capture.child);
      } finally {
        try {
          if (reservation) await close(reservation);
        } finally {
          await close(upstream);
        }
      }
    }
  }, 60_000);
  afterAll(() => {
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it('advertises the explicit inferred-enum opt-in in current export help', () => {
    expect(success(help)).toContain('--include-inferred-enums');
  });
  it('retains stored candidate labels and leaves raw JSON byte-identical after all OpenAPI exports', async () => {
    const enums = nodes(JSON.parse(originalRaw))
      .filter((node) => Array.isArray(node.enum))
      .map((node) => node.enum);
    for (const label of ['MOCKUS33', 'BANK0001', 'BANK0002', 'active', 'draft'])
      expect(
        enums.some((values) => values.includes(label)),
        `raw stored candidate ${label}`,
      ).toBe(true);
    expect(success(await run(['export', session, '--format', 'json'], home))).toBe(originalRaw);
  });
  it('ignores inferred-enum opt-in for raw JSON, preserving the original bytes', () => {
    expect(success(rawOptIn)).toBe(originalRaw);
  });
  it.each(['3.1', '3.0'])(
    'applies conservative policy to existing stored snapshot 1 in OAS %s',
    (version) => {
      const doc = snapshots.get(version)!;
      for (const path of paths(doc, 'profiles'))
        check(
          doc,
          path,
          { ...PROFILE, swiftCode: 'UNSEEN22', referenceCode: 'BANK9999', status: 'retired' },
          true,
        );
    },
  );
  it.each(['3.1', '3.0'])(
    'uses the conservative default when session is omitted in OAS %s',
    async (version) => {
      const doc = parse(
        await run(['export', '--json', '--openapi-version', version], home),
        'json',
      );
      for (const path of paths(doc, 'profiles'))
        check(doc, path, { ...PROFILE, swiftCode: 'UNSEEN22', referenceCode: 'BANK9999' }, true);
    },
  );
  describe.each(cases)('$label', (item) => {
    it('default accepts unseen type-valid categories at direct, nested and array usages', () => {
      const doc = defaults.get(item.label)!;
      expect(doc.openapi).toBe(item.version === '3.1' ? '3.1.0' : '3.0.3');
      for (const changed of [
        { swiftCode: 'UNSEEN22' },
        { referenceCode: 'BANK9999' },
        { status: 'retired' },
      ]) {
        const profile = { ...PROFILE, ...changed };
        for (const path of paths(doc, 'profiles')) check(doc, path, profile, true);
        for (const path of paths(doc, 'wrappers')) {
          // Isolate each usage: an earlier invalid property cannot mask a stale array/ref.
          check(doc, path, { ...wrap(PROFILE), profile }, true);
          check(doc, path, { ...wrap(PROFILE), profiles: [profile] }, true);
          check(doc, path, { ...wrap(PROFILE), nullableProfile: profile }, true);
        }
      }
      // No categorical constraints may survive in inline schemas OR the component registry.
      const schemas = [
        ...Object.values(doc.paths).flatMap((path) =>
          Object.values(path.get.responses).flatMap((response) =>
            Object.values(response.content).map((content) => content.schema),
          ),
        ),
        ...Object.values(doc.components?.schemas ?? {}),
      ];
      for (const node of schemas.flatMap(nodes))
        if (Array.isArray(node.enum))
          expect
            .soft(node.enum, 'only semantic null-only enum is permitted by default')
            .toEqual([null]);
    });
    it('default preserves requiredness, signed int32, array and nullable semantics', () => {
      const doc = defaults.get(item.label)!;
      for (const path of paths(doc, 'profiles')) {
        for (const status of ['active', 'draft', null])
          check(doc, path, { ...PROFILE, status }, true);
        for (const key of Object.keys(PROFILE)) check(doc, path, without(PROFILE, key), false);
        for (const changed of [
          { id: '123' },
          { id: 2 ** 31 },
          { id: -(2 ** 31) - 1 },
          { swiftCode: 7 },
          { swiftCode: null },
          { referenceCode: false },
          { status: 7 },
        ])
          check(doc, path, { ...PROFILE, ...changed }, false);
      }
      for (const path of paths(doc, 'wrappers')) {
        check(doc, path, wrap(PROFILE), true);
        check(doc, path, { ...wrap(PROFILE), nullableProfile: null }, true);
        for (const referenceCode of ['BANK0001', 'BANK0002'])
          for (const status of ['active', 'draft', null])
            check(doc, path, wrap({ ...PROFILE, referenceCode, status }), true);
        for (const key of ['profile', 'profiles', 'nullableProfile'])
          check(doc, path, without(wrap(PROFILE), key), false);
        for (const profile of [
          ...Object.keys(PROFILE).map((key) => without(PROFILE, key)),
          { ...PROFILE, swiftCode: 7 },
          null,
        ]) {
          check(doc, path, { ...wrap(PROFILE), profile }, false);
          check(doc, path, { ...wrap(PROFILE), profiles: [profile] }, false);
          if (profile !== null)
            check(doc, path, { ...wrap(PROFILE), nullableProfile: profile }, false);
        }
        check(doc, path, { ...wrap(PROFILE), profiles: 'not an array' }, false);
        check(doc, path, { ...wrap(PROFILE), nullableProfile: { ...PROFILE, id: '123' } }, false);
      }
    });
    it('preserves promoted nested refs, formats and metadata policy', () => {
      const doc = defaults.get(item.label)!;
      for (const node of nodes(doc)) if (node.$ref) pointer(doc, node.$ref);
      const parent = response(doc, '/wrappers');
      expect(parent.$ref, 'shared wrapper promoted').toMatch(/^#\/components\/schemas\//);
      expect(response(doc, paths(doc, 'wrappers')[1]).$ref).toBe(parent.$ref);
      const body = deref(doc, parent);
      const child = body.properties.profile.$ref;
      expect(child, 'nested profile promoted').toMatch(/^#\/components\/schemas\//);
      expect(body.properties.profiles.items.$ref).toBe(child);
      expect(nodes(body.properties.nullableProfile).some((node) => node.$ref === child)).toBe(true);
      expect(deref(doc, pointer(doc, child)).properties.id.format).toBe('int32');
      const metadataKeys = [
        ...new Set(
          nodes(doc).flatMap((node) =>
            Object.keys(node).filter((key) => key.startsWith('x-specwatch-')),
          ),
        ),
      ];
      // Agent evidence is intentional in BOTH metadata modes, independently of optional
      // inference annotations. Do not mistake its presence for --include-metadata.
      expect(metadataKeys).toContain('x-specwatch-agent');
      expect(
        metadataKeys.some((key) => key !== 'x-specwatch-agent'),
        `optional metadata=${item.metadata}; keys=${JSON.stringify(metadataKeys)}`,
      ).toBe(item.metadata);
    });
    it('preserves semantic null-only encoding instead of removing enum [null]', () => {
      const doc = defaults.get(item.label)!;
      check(doc, '/null', null, true);
      for (const value of [{}, [], 'null', 0, false]) check(doc, '/null', value, false);
      if (item.version === '3.0') expect(deref(doc, response(doc, '/null')).enum).toEqual([null]);
    });
    it('opt-in restores stored categories, admitting observed labels/null and rejecting unseen labels', () => {
      const doc = parse(optIns.get(item.label)!, item.encoding);
      for (const path of paths(doc, 'profiles')) {
        for (const referenceCode of ['BANK0001', 'BANK0002'])
          for (const status of ['active', 'draft', null])
            check(doc, path, { ...PROFILE, referenceCode, status }, true);
      }
      for (const path of paths(doc, 'wrappers')) {
        check(doc, path, { ...wrap(PROFILE), nullableProfile: null }, true);
        for (const referenceCode of ['BANK0001', 'BANK0002'])
          for (const status of ['active', 'draft', null])
            check(doc, path, wrap({ ...PROFILE, referenceCode, status }), true);
      }
      for (const changed of [
        { swiftCode: 'UNSEEN22' },
        { referenceCode: 'BANK9999' },
        { status: 'retired' },
      ]) {
        const profile = { ...PROFILE, ...changed };
        for (const path of paths(doc, 'profiles')) check(doc, path, profile, false);
        for (const path of paths(doc, 'wrappers')) {
          check(doc, path, { ...wrap(PROFILE), profile }, false);
          check(doc, path, { ...wrap(PROFILE), profiles: [profile] }, false);
          check(doc, path, { ...wrap(PROFILE), nullableProfile: profile }, false);
        }
      }
      check(doc, '/null', null, true);
      check(doc, '/null', {}, false);
    });
    it('keeps actual nonempty agent extensions identical between default and opt-in on snapshot 1', () => {
      const before = agentExtensions(defaults.get(item.label)!);
      expect(Object.keys(before).length, 'default agent extensions must exist').toBeGreaterThan(0);
      const after = agentExtensions(parse(optIns.get(item.label)!, item.encoding));
      expect(Object.keys(after).length, 'opt-in agent extensions must exist').toBeGreaterThan(0);
      expect(
        after,
        'same snapshot, same actual extension values at every document location',
      ).toEqual(before);
    });
  });
});
