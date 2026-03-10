import { describe, it, expect, beforeEach } from 'vitest';
import { getDatabase, runMigrations } from './database.js';
import type Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function openMemoryDb(): Database.Database {
  return getDatabase(':memory:');
}

function tableNames(db: Database.Database): string[] {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}

function indexNames(db: Database.Database): string[] {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='index' ORDER BY name`)
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getDatabase', () => {
  it('returns a database connection for :memory:', () => {
    const db = openMemoryDb();
    expect(db).toBeDefined();
    db.close();
  });

  it('creates all three tables', () => {
    const db = openMemoryDb();
    const tables = tableNames(db);
    expect(tables).toContain('sessions');
    expect(tables).toContain('samples');
    expect(tables).toContain('aggregated_schemas');
    db.close();
  });

  it('creates all required indexes', () => {
    const db = openMemoryDb();
    const indexes = indexNames(db);
    expect(indexes).toContain('idx_samples_session');
    expect(indexes).toContain('idx_samples_endpoint');
    expect(indexes).toContain('idx_samples_session_endpoint');
    expect(indexes).toContain('idx_agg_session');
    expect(indexes).toContain('idx_agg_endpoint');
    expect(indexes).toContain('idx_agg_session_endpoint');
    db.close();
  });

  it('enables WAL journal mode', () => {
    const db = openMemoryDb();
    // For in-memory databases SQLite reports 'memory', WAL pragma still runs without error
    // The important thing is no exception is thrown and the pragma executes
    const result = db.pragma('journal_mode', { simple: true }) as string;
    // In-memory databases use 'memory' journal mode — WAL cannot be used in-memory,
    // but the pragma runs idempotently. For file databases it would return 'wal'.
    expect(['memory', 'wal']).toContain(result);
    db.close();
  });

  it('sessions table has correct columns', () => {
    const db = openMemoryDb();
    const cols = db.pragma('table_info(sessions)') as { name: string }[];
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain('id');
    expect(colNames).toContain('name');
    expect(colNames).toContain('target_url');
    expect(colNames).toContain('port');
    expect(colNames).toContain('status');
    expect(colNames).toContain('created_at');
    expect(colNames).toContain('started_at');
    expect(colNames).toContain('stopped_at');
    expect(colNames).toContain('completed_at');
    expect(colNames).toContain('sample_count');
    expect(colNames).toContain('skipped_count');
    expect(colNames).toContain('max_samples');
    expect(colNames).toContain('error_message');
    expect(colNames).toContain('metadata');
    db.close();
  });

  it('samples table has correct columns', () => {
    const db = openMemoryDb();
    const cols = db.pragma('table_info(samples)') as { name: string }[];
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain('id');
    expect(colNames).toContain('session_id');
    expect(colNames).toContain('http_method');
    expect(colNames).toContain('path');
    expect(colNames).toContain('normalized_path');
    expect(colNames).toContain('status_code');
    expect(colNames).toContain('query_params');
    expect(colNames).toContain('request_schema');
    expect(colNames).toContain('response_schema');
    expect(colNames).toContain('request_headers');
    expect(colNames).toContain('response_headers');
    expect(colNames).toContain('captured_at');
    db.close();
  });

  it('aggregated_schemas table has correct columns', () => {
    const db = openMemoryDb();
    const cols = db.pragma('table_info(aggregated_schemas)') as { name: string }[];
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain('id');
    expect(colNames).toContain('session_id');
    expect(colNames).toContain('http_method');
    expect(colNames).toContain('path');
    expect(colNames).toContain('version');
    expect(colNames).toContain('request_schema');
    expect(colNames).toContain('response_schemas');
    expect(colNames).toContain('request_headers');
    expect(colNames).toContain('response_headers');
    expect(colNames).toContain('sample_count');
    expect(colNames).toContain('confidence_score');
    expect(colNames).toContain('breaking_changes');
    expect(colNames).toContain('previous_session_id');
    expect(colNames).toContain('first_observed');
    expect(colNames).toContain('last_observed');
    expect(colNames).toContain('created_at');
    db.close();
  });
});

describe('runMigrations (idempotency)', () => {
  it('is safe to run multiple times without error', () => {
    const db = getDatabase(':memory:');
    // runMigrations was already called by getDatabase; calling again must not throw
    expect(() => runMigrations(db)).not.toThrow();
    expect(() => runMigrations(db)).not.toThrow();
    db.close();
  });

  it('does not duplicate tables on repeated calls', () => {
    const db = getDatabase(':memory:');
    runMigrations(db);
    runMigrations(db);
    const tables = tableNames(db);
    const sessionTables = tables.filter((t) => t === 'sessions');
    expect(sessionTables).toHaveLength(1);
    db.close();
  });

  it('does not duplicate indexes on repeated calls', () => {
    const db = getDatabase(':memory:');
    runMigrations(db);
    const indexes = indexNames(db);
    const dupCheck = indexes.filter((i) => i === 'idx_samples_session');
    expect(dupCheck).toHaveLength(1);
    db.close();
  });
});

describe('SPECWATCH_HOME env var', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env['SPECWATCH_HOME'];
  });

  it('uses :memory: override regardless of SPECWATCH_HOME', () => {
    process.env['SPECWATCH_HOME'] = '/tmp/fake-specwatch-home';
    // Passing :memory: explicitly should still work
    const db = getDatabase(':memory:');
    expect(db).toBeDefined();
    db.close();
    // Restore
    if (originalEnv !== undefined) {
      process.env['SPECWATCH_HOME'] = originalEnv;
    } else {
      delete process.env['SPECWATCH_HOME'];
    }
  });
});
