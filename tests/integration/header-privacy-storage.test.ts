import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getDatabase } from '../../src/storage/database.js';
import { applyMigrations, getSchemaVersion, MIGRATIONS } from '../../src/storage/migrations.js';
import { SessionRepository } from '../../src/storage/sessions.js';
import { SampleRepository } from '../../src/storage/samples.js';
import { AggregatedSchemaRepository } from '../../src/storage/schemas.js';

// Independent contract tests: no production implementation or bundle was read.
// Every database is in memory or in an exclusively owned scratch directory.
const SENTINEL = 'SYNTHETIC_HEADER_VALUE_DO_NOT_RETAIN';
const handles: Database.Database[] = [];
const directories: string[] = [];
const columns = [
  ['samples', 'request_headers'],
  ['samples', 'response_headers'],
  ['aggregated_schemas', 'request_headers'],
  ['aggregated_schemas', 'response_headers'],
] as const;
const now = '2026-01-02T03:04:05.000Z';

function own(db: Database.Database) {
  handles.push(db);
  return db;
}
afterEach(() => {
  for (const db of handles.splice(0)) if (db.open) db.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function sample(sessionId: string, headers: unknown = []) {
  return {
    sessionId,
    httpMethod: 'GET',
    path: '/items/1',
    normalizedPath: '/items/{id}',
    statusCode: 200,
    capturedAt: now,
    requestSchema: { type: 'object', properties: { query: { type: 'string' } } },
    responseSchema: { type: 'object', properties: { id: { type: 'integer' } } },
    requestHeaders: headers,
    responseHeaders: headers,
  } as unknown as Parameters<SampleRepository['insertSample']>[0];
}
function aggregated(sessionId: string, snapshot: number, headers: unknown = []) {
  return {
    sessionId,
    httpMethod: 'GET',
    path: '/items/{id}',
    version: 1,
    snapshot,
    sampleCount: snapshot * 2,
    confidenceScore: 0.75,
    firstObserved: now,
    lastObserved: now,
    requestSchema: { type: 'object', properties: { query: { type: 'string' } } },
    responseSchemas: { '200': { type: 'object', properties: { id: { type: 'integer' } } } },
    requestHeaders: headers,
    responseHeaders: headers,
  } as unknown as Parameters<AggregatedSchemaRepository['insertAggregated']>[0];
}
function seed(db: Database.Database) {
  const sessions = new SessionRepository(db);
  const session = sessions.createSession('https://fixture.invalid', 8080, 'privacy', 20, 'agent');
  new SampleRepository(db).insertSample(sample(session.id));
  const schemas = new AggregatedSchemaRepository(db);
  schemas.insertAggregated(aggregated(session.id, 1));
  schemas.insertAggregated(aggregated(session.id, 2));
  db.prepare('UPDATE sessions SET sample_count = 4, skipped_count = 2 WHERE id = ?').run(
    session.id,
  );
  return session.id;
}
function v3(path = ':memory:') {
  const db = own(new Database(path));
  db.transaction(() => {
    for (const migration of MIGRATIONS.slice(0, 3)) migration.up(db);
    db.pragma('user_version = 3');
  })();
  expect(getSchemaVersion(db)).toBe(3);
  return db;
}
function rows(db: Database.Database, table: string) {
  return db.prepare(`SELECT * FROM ${table} ORDER BY id`).all() as Record<string, unknown>[];
}
function allData(db: Database.Database) {
  return {
    sessions: rows(db, 'sessions'),
    samples: rows(db, 'samples'),
    schemas: rows(db, 'aggregated_schemas'),
  };
}
function nonHeaders(db: Database.Database) {
  const data = allData(db);
  for (const row of [...data.samples, ...data.schemas]) {
    delete row.request_headers;
    delete row.response_headers;
  }
  return data;
}
function setColumn(db: Database.Database, table: string, column: string, value: string | null) {
  db.prepare(`UPDATE ${table} SET ${column} = ?`).run(value);
}
function decodedColumns(db: Database.Database) {
  return columns.flatMap(([table, column]) =>
    rows(db, table).map((row) => {
      const value = row[column];
      return value === null ? null : (JSON.parse(value as string) as unknown);
    }),
  );
}
function fixedError(action: () => unknown): string {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught, 'must reject invalid stored header JSON').toBeInstanceOf(Error);
  const message = (caught as Error).message;
  expect(message.length).toBeGreaterThan(0);
  expect(message).not.toContain(SENTINEL);
  expect(message).not.toContain('example');
  expect(message).not.toContain('RAW_INPUT');
  return message;
}
const runtimeAttack = () => [
  { name: 'X-Custom', example: SENTINEL, unknown: { secret: SENTINEL } },
  { name: 'Set-Cookie', example: SENTINEL },
  { name: 'Location', example: SENTINEL },
  { name: 'Authorization', example: `Bearer ${SENTINEL}` },
  { name: 'AUTHORIZATION', authSchemes: ['bearer', 'basic', 'bearer', SENTINEL], extra: SENTINEL },
  { name: 'X-Api-Key', authSchemes: ['bearer'], example: SENTINEL },
  { name: 'bad name', example: SENTINEL },
  { name: 'bad\r\nname', example: SENTINEL },
];
const expectedRuntime = [
  { name: 'x-custom' },
  { name: 'set-cookie' },
  { name: 'location' },
  { name: 'authorization', authSchemes: ['basic', 'bearer'] },
  { name: 'x-api-key' },
];
function canonical(value: unknown) {
  expect(Array.isArray(value), 'projected headers must be an array').toBe(true);
  for (const entry of value as unknown[]) {
    expect(entry, 'malformed legacy entries must be dropped').not.toBeNull();
    expect(typeof entry).toBe('object');
    expect(typeof (entry as { name?: unknown }).name).toBe('string');
  }
  return [...(value as { name: string }[])].sort((a, b) => a.name.localeCompare(b.name));
}
function assertRuntime(value: unknown) {
  expect(canonical(value)).toEqual(canonical(expectedRuntime));
  expect(JSON.stringify(value)).not.toContain(SENTINEL);
  expect(JSON.stringify(value)).not.toContain('example');
}

for (const kind of ['sample', 'aggregated'] as const) {
  describe(`${kind} repository header privacy`, () => {
    it('projects direct legacy/unknown caller objects on writes and persists only canonical metadata', () => {
      const db = own(getDatabase(':memory:'));
      const id = new SessionRepository(db).createSession('https://fixture.invalid', 8080).id;
      if (kind === 'sample') new SampleRepository(db).insertSample(sample(id, runtimeAttack()));
      else new AggregatedSchemaRepository(db).insertAggregated(aggregated(id, 1, runtimeAttack()));
      const table = kind === 'sample' ? 'samples' : 'aggregated_schemas';
      for (const column of ['request_headers', 'response_headers']) {
        assertRuntime(JSON.parse(rows(db, table)[0][column] as string));
      }
      const result =
        kind === 'sample'
          ? new SampleRepository(db).listBySession(id)
          : new AggregatedSchemaRepository(db).listBySession(id);
      assertRuntime(result[0].requestHeaders);
      assertRuntime(result[0].responseHeaders);
    });

    it('never reads a runtime legacy example getter, even for authorization classification', () => {
      const db = own(getDatabase(':memory:'));
      const id = new SessionRepository(db).createSession('https://fixture.invalid', 8080).id;
      let reads = 0;
      const header = Object.defineProperty({ name: 'Authorization' }, 'example', {
        enumerable: true,
        get() {
          reads++;
          throw new Error('runtime example getter was read');
        },
      });
      expect(() => {
        if (kind === 'sample') new SampleRepository(db).insertSample(sample(id, [header]));
        else new AggregatedSchemaRepository(db).insertAggregated(aggregated(id, 1, [header]));
      }).not.toThrow();
      expect(reads).toBe(0);
      const table = kind === 'sample' ? 'samples' : 'aggregated_schemas';
      expect(JSON.parse(rows(db, table)[0].request_headers as string)).toEqual([
        { name: 'authorization' },
      ]);
    });

    it('guards decoded reads without interpreting legacy examples or rewriting storage', () => {
      const db = own(getDatabase(':memory:'));
      const id = seed(db);
      const table = kind === 'sample' ? 'samples' : 'aggregated_schemas';
      const raw = JSON.stringify([
        { name: 'Authorization', example: `Basic ${SENTINEL}`, unknown: SENTINEL },
        { name: 'Set-Cookie', example: SENTINEL },
      ]);
      for (const column of ['request_headers', 'response_headers'])
        setColumn(db, table, column, raw);
      const before = allData(db);
      const result =
        kind === 'sample'
          ? new SampleRepository(db).listBySession(id)
          : new AggregatedSchemaRepository(db).listBySession(id);
      for (const entry of result)
        for (const headers of [entry.requestHeaders, entry.responseHeaders]) {
          expect(canonical(headers)).toEqual(
            canonical([{ name: 'authorization' }, { name: 'set-cookie' }]),
          );
        }
      expect(allData(db)).toEqual(before);
    });

    for (const column of ['request_headers', 'response_headers']) {
      it(`uses a fixed value-free error for malformed decoded ${column}`, () => {
        const messages: string[] = [];
        for (const raw of [`RAW_INPUT_${SENTINEL}`, `{"RAW_INPUT_${SENTINEL}":`]) {
          const db = own(getDatabase(':memory:'));
          const id = seed(db);
          setColumn(db, kind === 'sample' ? 'samples' : 'aggregated_schemas', column, raw);
          messages.push(
            fixedError(() =>
              kind === 'sample'
                ? new SampleRepository(db).listBySession(id)
                : new AggregatedSchemaRepository(db).listBySession(id),
            ),
          );
        }
        expect(messages[0]).toBe(messages[1]);
      });
    }
  });
}

describe('forward-only v4 logical header cleanup', () => {
  it('creates fresh databases at v4', () => {
    expect(getSchemaVersion(own(getDatabase(':memory:')))).toBe(4);
  });

  it('upgrades genuine populated v3 across all four columns and snapshots, preserving every nonheader field', () => {
    const db = v3();
    const id = seed(db);
    const legacy = JSON.stringify([
      { name: 'AUTHORIZATION', example: `bEaReR\t${SENTINEL}`, unknown: SENTINEL },
      { name: 'authorization', example: 'Basic ***' },
      { name: 'Authorization', example: `BearerSentinel ${SENTINEL}` },
      { name: 'Authorization', example: `Digest ${SENTINEL}` },
      { name: 'X-Custom', example: SENTINEL, extra: [SENTINEL] },
      { name: 'Set-Cookie', example: SENTINEL },
      { name: 'Location', example: SENTINEL },
      { name: 'X-Api-Key', example: SENTINEL, authSchemes: ['basic'] },
      { name: 'bad name', example: SENTINEL },
      null,
      42,
    ]);
    for (const [table, column] of columns) setColumn(db, table, column, legacy);
    const before = nonHeaders(db);
    applyMigrations(db);
    for (const value of decodedColumns(db)) assertRuntime(value);
    expect(nonHeaders(db)).toEqual(before);
    expect(getSchemaVersion(db)).toBe(4);
    expect(new SessionRepository(db).getSession(id)?.sampleCount).toBe(4);
    expect(
      new AggregatedSchemaRepository(db)
        .listBySession(id)
        .map((row) => row.snapshot)
        .sort(),
    ).toEqual([1, 2]);
  });

  it('preserves NULL and converts empty sanitized sets to NULL', () => {
    const db = v3();
    seed(db);
    for (const [table, column] of columns) setColumn(db, table, column, null);
    const before = allData(db);
    applyMigrations(db);
    expect(allData(db)).toEqual(before);
    expect(decodedColumns(db).every((value) => value === null)).toBe(true);
    // Separate genuine v3 fixture for an empty projected set.
    const empty = v3();
    seed(empty);
    for (const [table, column] of columns)
      setColumn(
        empty,
        table,
        column,
        JSON.stringify([null, 42, { name: 'bad name', example: SENTINEL }]),
      );
    applyMigrations(empty);
    expect(decodedColumns(empty).every((value) => value === null)).toBe(true);
    expect(getSchemaVersion(empty)).toBe(4);
  });

  it('recognizes only strict legacy auth prefixes; never preserves unknown scheme text', () => {
    const db = v3();
    seed(db);
    const cases = [
      [`Bearer ${SENTINEL}`, ['bearer']],
      [`bAsIc\t${SENTINEL}`, ['basic']],
      ['Bearer ***', ['bearer']],
      ['Basic ***', ['basic']],
      [`BearerSentinel ${SENTINEL}`, undefined],
      [`Digest ${SENTINEL}`, undefined],
      ['Bearer', undefined],
      ['Basic   ', undefined],
    ] as const;
    // Distinct rows avoid relying on auth-union behavior to hide a false classification.
    db.prepare('DELETE FROM samples').run();
    const id = rows(db, 'sessions')[0].id as string;
    for (const [index, [example]] of cases.entries()) {
      new SampleRepository(db).insertSample({ ...sample(id), path: `/auth/${index}` });
      const last = rows(db, 'samples').at(-1)!;
      db.prepare('UPDATE samples SET request_headers = ? WHERE id = ?').run(
        JSON.stringify([{ name: 'Authorization', example }]),
        last.id,
      );
    }
    applyMigrations(db);
    for (const [index, [, schemes]] of cases.entries()) {
      expect(JSON.parse(rows(db, 'samples')[index].request_headers as string)).toEqual([
        schemes ? { name: 'authorization', authSchemes: [...schemes] } : { name: 'authorization' },
      ]);
    }
    expect(getSchemaVersion(db)).toBe(4);
  });

  it('reopens v4 idempotently and an old migration runner rejects v4', () => {
    const directory = mkdtempSync(join(tmpdir(), 'specwatch-header-privacy-'));
    directories.push(directory);
    const path = join(directory, 'owned.sqlite');
    const db = v3(path);
    seed(db);
    for (const [table, column] of columns)
      setColumn(db, table, column, JSON.stringify([{ name: 'X-Custom', example: SENTINEL }]));
    const originalNonHeaders = nonHeaders(db);
    db.close();
    const upgraded = own(getDatabase(path));
    expect(getSchemaVersion(upgraded)).toBe(4);
    expect(nonHeaders(upgraded)).toEqual(originalNonHeaders);
    for (const value of decodedColumns(upgraded)) expect(value).toEqual([{ name: 'x-custom' }]);
    const before = allData(upgraded);
    upgraded.close();
    const reopened = own(getDatabase(path));
    expect(getSchemaVersion(reopened)).toBe(4);
    expect(allData(reopened)).toEqual(before);
    const removed = MIGRATIONS.splice(3);
    try {
      expect(() => applyMigrations(reopened)).toThrow();
      expect(getSchemaVersion(reopened)).toBe(4);
      expect(allData(reopened)).toEqual(before);
    } finally {
      MIGRATIONS.push(...removed);
    }
  });

  for (const [table, column] of columns) {
    for (const shape of ['malformed JSON', 'nonarray JSON'] as const) {
      it(`rolls back all v4 writes for ${shape} in ${table}.${column} with a fixed value-free error`, () => {
        const inputs =
          shape === 'malformed JSON'
            ? [`RAW_INPUT_${SENTINEL}`, `{"RAW_INPUT_${SENTINEL}":`]
            : [JSON.stringify({ unknown: SENTINEL }), JSON.stringify(`RAW_INPUT_${SENTINEL}`)];
        const messages: string[] = [];
        for (const raw of inputs) {
          const db = v3();
          seed(db);
          for (const [t, c] of columns)
            setColumn(db, t, c, JSON.stringify([{ name: 'X-Custom', example: SENTINEL }]));
          // Corrupt the last row, so earlier rows/columns are candidates for rollback.
          const last = rows(db, table).at(-1)!;
          db.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`).run(raw, last.id);
          const before = allData(db);
          messages.push(fixedError(() => applyMigrations(db)));
          expect(getSchemaVersion(db)).toBe(3);
          expect(allData(db)).toEqual(before);
        }
        expect(messages[0]).toBe(messages[1]);
      });
    }
  }
});
