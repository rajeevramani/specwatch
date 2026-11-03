/** Independent known-contract acceptance: only public CLI, owned HTTP fixture and scratch store.
 * The declared API is an oracle, not a claim that traffic proves unseen API behavior.
 * Run the same file against an absolute SPECWATCH_TEST_CLI; never rebuild shared dist.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { Ajv } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import Database from 'better-sqlite3';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, get, type Server } from 'node:http';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
const CHILD = { id: 123, name: 'fixture', active: true };
const TEAM = { title: 'fixture', owner: CHILD, entries: [CHILD], nullable: CHILD };
const STATIC = ['/config/theme', '/config/language', '/owners/owner_alice', '/owners/owner_bob'];
const CODE = {
  countryCode: 'AU',
  currencyCode: 'AUD',
  code: 'opaque',
  statusCode: 200,
  status: 'active',
};
// Independent API declaration: exact categories and signed int32 are deliberate fixture rules.
const childContract = {
  type: 'object',
  required: ['id', 'name', 'active'],
  properties: {
    id: { type: 'integer', format: 'int32' },
    name: { type: 'string' },
    active: { type: 'boolean' },
  },
};
const teamContract = {
  type: 'object',
  required: ['title', 'owner', 'entries', 'nullable'],
  properties: {
    title: { type: 'string' },
    owner: childContract,
    entries: { type: 'array', items: childContract },
    nullable: { anyOf: [childContract, { type: 'null' }] },
    extra: { type: 'string' },
  },
};
const codeContract = {
  type: 'object',
  required: Object.keys(CODE),
  properties: {
    countryCode: { type: 'string', enum: ['AU', 'NZ'] },
    currencyCode: { type: 'string', enum: ['AUD', 'NZD'] },
    code: { type: 'string' },
    statusCode: { type: 'integer', format: 'int32' },
    status: { enum: ['active', 'draft', null] },
  },
};
const contracts: Record<string, Schema> = {
  ...Object.fromEntries(
    STATIC.map((path) => [
      path,
      {
        type: 'object',
        required: ['enabled', 'label'],
        properties: { enabled: { type: 'boolean' }, label: { type: 'string' } },
      },
    ]),
  ),
  '/teams': teamContract,
  '/teams/123': teamContract,
  '/teams/456': teamContract,
  '/codes': codeContract,
  '/mixed': { anyOf: [childContract, { type: 'array', items: childContract }, { type: 'null' }] },
  '/null': { type: 'null' },
  '/search': { type: 'object' },
};
function engine(version = '3.1.0') {
  const ajv = version === '3.1.0' ? new Ajv2020({ strict: false }) : new Ajv({ strict: false });
  ajv.addFormat('int32', {
    type: 'number',
    validate: (value: number) => Number.isInteger(value) && value >= -(2 ** 31) && value < 2 ** 31,
  });
  return ajv;
}
const oracle = Object.fromEntries(
  Object.entries(contracts).map(([path, schema]) => [path, engine().compile(schema)]),
);
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
function response(doc: Document, path: string): Schema {
  return doc.paths[path].get.responses['200'].content['application/json'].schema;
}
const escapePointer = (key: string) => key.replace(/~/g, '~0').replace(/\//g, '~1');
function validator(doc: Document, path: string) {
  // The entire actual document is the reference context. No schema conversion or injected constraints.
  return engine(doc.openapi).compile({
    ...doc,
    $ref: `#/paths/${escapePointer(path)}/get/responses/200/content/application~1json/schema`,
  });
}
function check(
  doc: Document,
  path: string,
  declaredPath: string,
  value: unknown,
  accepted: boolean,
) {
  expect(
    oracle[declaredPath](value),
    `independent fixture oracle ${declaredPath} ${JSON.stringify(value)}`,
  ).toBe(accepted);
  const validate = validator(doc, path);
  expect
    .soft(
      validate(value),
      `${doc.openapi} ${path} ${JSON.stringify(value)} expected=${accepted}; ${JSON.stringify(validate.errors)}`,
    )
    .toBe(accepted);
}
function refs(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(refs);
  return Object.entries(value).flatMap(([key, item]) =>
    key === '$ref' ? [String(item)] : refs(item),
  );
}
function deref(doc: Document, schema: Schema): Schema {
  const seen = new Set<string>();
  while (schema.$ref) {
    const ref = schema.$ref as string;
    if (seen.has(ref)) throw new Error(`Cyclic alias ${ref}`);
    seen.add(ref);
    schema = pointer(doc, ref);
  }
  return schema;
}
function pointer(doc: Document, ref: string): Schema {
  expect(ref).toMatch(/^#\//);
  let node: any = doc;
  for (const key of ref.slice(2).split('/'))
    node = node?.[key.replace(/~1/g, '/').replace(/~0/g, '~')];
  expect(node, `resolvable ${ref}`).toBeDefined();
  return node;
}
function teamPath(doc: Document) {
  const paths = Object.keys(doc.paths).filter((path) => /^\/teams\/\{[^}]+\}$/.test(path));
  expect(paths, 'one numeric team template, parameter name is not prescribed').toHaveLength(1);
  return paths[0];
}
const without = (value: Record<string, unknown>, key: string) =>
  Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));

describe('known independent API contract through the real CLI', () => {
  const documents = new Map<string, Document>();
  const enforcingDocuments = new Map<string, Document>();
  let report: any;
  beforeAll(async () => {
    expect(isAbsolute(CLI), 'SPECWATCH_TEST_CLI must be absolute').toBe(true);
    expect(existsSync(CLI), 'CLI must already exist; this harness never builds').toBe(true);
    const home = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'specwatch-known-contract-'));
    const observations: Array<[string, unknown]> = [];
    for (let index = 0; index < 36; index++) {
      const team = {
        ...TEAM,
        nullable: index % 2 ? null : CHILD,
        ...(index % 3 === 0 ? { extra: 'fixture' } : {}),
      };
      for (const path of STATIC) observations.push([path, { enabled: true, label: 'fixture' }]);
      observations.push(
        ['/teams', team],
        ['/teams/123', team],
        ['/teams/456', team],
        [
          '/codes',
          {
            ...CODE,
            countryCode: index % 2 ? 'NZ' : 'AU',
            currencyCode: index % 2 ? 'NZD' : 'AUD',
            statusCode: index % 2 ? 201 : 200,
            status: ['active', 'draft', null][index % 3],
          },
        ],
        ['/mixed', [CHILD, [CHILD], null][index % 3]],
        ['/null', null],
      );
    }
    // Exactly one true duplicate at the tail; differing query values are not retries.
    for (const query of ['cats', 'dogs', 'dogs', 'birds'])
      observations.push([`/search?q=${query}`, {}]);
    const queues = new Map<string, unknown[]>();
    for (const [path, body] of observations) {
      expect(oracle[path.split('?')[0]](body), `fixture response ${path}`).toBe(true);
      queues.set(path, [...(queues.get(path) ?? []), body]);
    }
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
            `known-${attempt}`,
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
      for (const version of ['3.1', '3.0']) {
        documents.set(
          version,
          await run(['export', sessions[0].id, '--json', '--openapi-version', version], home),
        );
        enforcingDocuments.set(
          version,
          await run(
            [
              'export',
              sessions[0].id,
              '--json',
              '--openapi-version',
              version,
              '--include-inferred-enums',
            ],
            home,
          ),
        );
      }
      const spec = join(home, 'independent-api.json');
      writeFileSync(
        spec,
        JSON.stringify({
          openapi: '3.1.0',
          info: { title: 'Independent fixture API', version: '1' },
          paths: {
            '/teams': {
              get: { operationId: 'listTeams', responses: { '200': { description: 'team' } } },
            },
            '/teams/me': {
              get: {
                operationId: 'getCurrentTeam',
                responses: { '200': { description: 'current team' } },
              },
            },
            '/teams/{id}': {
              get: {
                operationId: 'getTeam',
                parameters: [
                  { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
                ],
                responses: {
                  '200': {
                    description: 'team',
                    content: { 'application/json': { schema: teamContract } },
                  },
                },
              },
            },
          },
        }),
      );
      report = await run(['agent-report', sessions[0].id, '--spec', spec], home);
      console.info(
        `CLI ${CLI}: ${observations.length} synthetic forwarded/persisted samples, completed session, SIGINT exit 0, both exports and mapped agent report executed`,
      );
      console.info(
        'Public search/team evidence:',
        JSON.stringify(
          report.operations.filter(
            (operation: any) =>
              operation.path === '/search' || /^\/teams\/\{[^}]+\}$/.test(operation.path),
          ),
        ),
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

  describe.each(['3.1', '3.0'])('OAS %s', (version) => {
    it('preserves literal siblings and numeric team template without invented parameters', () => {
      const doc = documents.get(version)!;
      expect(doc.openapi).toBe(version === '3.1' ? '3.1.0' : '3.0.3');
      const dynamic = teamPath(doc);
      expect
        .soft(Object.keys(doc.paths).sort())
        .toEqual([...STATIC, '/teams', dynamic, '/codes', '/mixed', '/null', '/search'].sort());
      for (const path of STATIC) expect.soft(doc.paths[path], `literal ${path}`).toBeDefined();
    });
    it('promotes the same parent and child, with resolvable refs in the actual parent body', () => {
      const doc = documents.get(version)!;
      for (const ref of refs(doc)) pointer(doc, ref);
      const parent = response(doc, '/teams');
      expect(parent.$ref, 'parent component promotion').toMatch(/^#\/components\/schemas\//);
      expect(response(doc, teamPath(doc)).$ref).toBe(parent.$ref);
      const body = deref(doc, parent);
      const ownerRefs = refs(body.properties?.owner);
      expect(ownerRefs, 'child ref in parent component body').toHaveLength(1);
      expect(ownerRefs[0]).not.toBe(parent.$ref);
      expect(refs(body.properties?.entries?.items)).toContain(ownerRefs[0]);
      expect(refs(body.properties?.nullable)).toContain(ownerRefs[0]);
      const validateChild = engine(doc.openapi).compile({ ...doc, $ref: ownerRefs[0] });
      expect.soft(validateChild(CHILD)).toBe(true);
      expect.soft(validateChild(null), 'shared child itself remains non-null').toBe(false);
    });
    it('enforces universal parent/child fields while retaining real optional extra', () => {
      const doc = documents.get(version)!;
      for (const path of ['/teams', teamPath(doc)]) {
        for (const value of [TEAM, { ...TEAM, extra: 'fixture' }, { ...TEAM, nullable: null }])
          check(doc, path, '/teams', value, true);
        for (const key of Object.keys(TEAM)) check(doc, path, '/teams', without(TEAM, key), false);
        for (const key of Object.keys(CHILD)) {
          const incomplete = without(CHILD, key);
          for (const value of [
            { ...TEAM, owner: incomplete },
            { ...TEAM, entries: [incomplete] },
            { ...TEAM, nullable: incomplete },
          ])
            check(doc, path, '/teams', value, false);
        }
        for (const value of [
          null,
          { ...TEAM, owner: null },
          { ...TEAM, entries: [null] },
          { ...TEAM, owner: { ...CHILD, id: 'wrong' } },
          { ...TEAM, owner: { ...CHILD, id: 2 ** 31 } },
        ])
          check(doc, path, '/teams', value, false);
      }
    });
    it('opt-in learns categorical code labels and nullable status without closing open/numeric codes', () => {
      const doc = enforcingDocuments.get(version)!;
      for (const countryCode of ['AU', 'NZ'])
        for (const currencyCode of ['AUD', 'NZD'])
          for (const status of ['active', 'draft', null])
            check(doc, '/codes', '/codes', { ...CODE, countryCode, currencyCode, status }, true);
      check(
        doc,
        '/codes',
        '/codes',
        { ...CODE, code: 'unseen arbitrary string', statusCode: 202 },
        true,
      );
      for (const value of [
        { ...CODE, countryCode: 'US' },
        { ...CODE, currencyCode: 'USD' },
        { ...CODE, status: 'retired' },
        { ...CODE, code: null },
        { ...CODE, countryCode: null },
        { ...CODE, statusCode: '200' },
        { ...CODE, statusCode: 2 ** 31 },
      ])
        check(doc, '/codes', '/codes', value, false);
      for (const key of Object.keys(CODE))
        check(doc, '/codes', '/codes', without(CODE, key), false);
    });
    it('keeps mixed object/array/null branches bounded and standalone null null-only', () => {
      const doc = documents.get(version)!;
      for (const value of [CHILD, [CHILD], null]) check(doc, '/mixed', '/mixed', value, true);
      for (const value of ['arbitrary', 7, false, [{ ...CHILD, id: 'wrong' }]])
        check(doc, '/mixed', '/mixed', value, false);
      check(doc, '/null', '/null', null, true);
      for (const value of ['arbitrary', {}, [], 7, false])
        check(doc, '/null', '/null', value, false);
    });
  });

  it('counts only the identical query as a retry and never leaks query values in evidence', () => {
    expect(report.schema_version).toBe('specwatch.agent_evidence.v1');
    expect(report.run.consumer).toBe('agent');
    expect(report.run.sample_count).toBe(364);
    for (const value of ['cats', 'dogs', 'birds'])
      expect.soft(JSON.stringify(report)).not.toContain(value);
    const search = report.operations.filter(
      (operation: any) => operation.method === 'GET' && operation.path === '/search',
    );
    expect(search).toHaveLength(1);
    expect(search[0].observed_count).toBe(4);
    expect(
      search[0].wasted_request_count,
      'cats, dogs, dogs, birds has one identical retry, not three',
    ).toBe(1);
  });
  it('maps the observed team template to getTeam, not the literal /teams/me', () => {
    const operations = report.operations.filter(
      (operation: any) => operation.method === 'GET' && /^\/teams\/\{[^}]+\}$/.test(operation.path),
    );
    expect(operations).toHaveLength(1);
    const operation = operations[0];
    expect(operation.observed_count).toBe(72);
    expect.soft(operation.operation_id, 'independent source-spec operationId').toBe('getTeam');
    expect.soft(operation.spec_location).toBe('#/paths/~1teams~1{id}/get');
    expect
      .soft(operation.warnings ?? [], 'template match is neither ambiguous nor unmatched')
      .toEqual([]);
    expect
      .soft(
        report.unmatched_observations.filter(
          (entry: any) => entry.operation_key === operation.operation_key,
        ),
      )
      .toEqual([]);
  });
});
