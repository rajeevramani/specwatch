import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import {
  applyMigrations,
  getSchemaVersion,
  setSchemaVersion,
  isPreMigrationDatabase,
  CURRENT_SCHEMA_VERSION,
  MIGRATIONS,
} from './migrations.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Opens a fresh in-memory database with no schema applied. */
function freshDb(): Database.Database {
  return new Database(':memory:');
}

/** Creates a "pre-migration" database — has tables but no user_version set. */
function preMigrationDb(): Database.Database {
  const db = new Database(':memory:');
  // Manually create the v1 schema without setting user_version
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      name TEXT,
      target_url TEXT NOT NULL,
      port INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      started_at TEXT,
      stopped_at TEXT,
      completed_at TEXT,
      sample_count INTEGER NOT NULL DEFAULT 0,
      skipped_count INTEGER NOT NULL DEFAULT 0,
      max_samples INTEGER,
      error_message TEXT,
      metadata TEXT
    );

    CREATE TABLE samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      http_method TEXT NOT NULL,
      path TEXT NOT NULL,
      normalized_path TEXT NOT NULL,
      status_code INTEGER,
      query_params TEXT,
      request_schema TEXT,
      response_schema TEXT,
      request_headers TEXT,
      response_headers TEXT,
      captured_at TEXT NOT NULL
    );

    CREATE TABLE aggregated_schemas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      http_method TEXT NOT NULL,
      path TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      request_schema TEXT,
      response_schemas TEXT,
      request_headers TEXT,
      response_headers TEXT,
      query_params TEXT,
      path_param_values TEXT,
      sample_count INTEGER NOT NULL DEFAULT 0,
      confidence_score REAL NOT NULL DEFAULT 0.0,
      breaking_changes TEXT,
      previous_session_id TEXT,
      first_observed TEXT NOT NULL,
      last_observed TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

function tableNames(db: Database.Database): string[] {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}

function columnNames(db: Database.Database, table: string): string[] {
  const cols = db.pragma(`table_info(${table})`) as { name: string }[];
  return cols.map((c) => c.name);
}

// ---------------------------------------------------------------------------
// getSchemaVersion
// ---------------------------------------------------------------------------

describe('getSchemaVersion', () => {
  it('returns 0 for a fresh database', () => {
    const db = freshDb();
    expect(getSchemaVersion(db)).toBe(0);
    db.close();
  });

  it('returns the set version after pragma is updated', () => {
    const db = freshDb();
    db.pragma('user_version = 42');
    expect(getSchemaVersion(db)).toBe(42);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// setSchemaVersion
// ---------------------------------------------------------------------------

describe('setSchemaVersion', () => {
  it('throws on non-integer version', () => {
    const db = freshDb();
    expect(() => setSchemaVersion(db, 1.5)).toThrow('Invalid schema version: 1.5');
    db.close();
  });

  it('throws on negative version', () => {
    const db = freshDb();
    expect(() => setSchemaVersion(db, -1)).toThrow('Invalid schema version: -1');
    db.close();
  });

  it('accepts valid integer version', () => {
    const db = freshDb();
    expect(() => setSchemaVersion(db, 3)).not.toThrow();
    expect(getSchemaVersion(db)).toBe(3);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// isPreMigrationDatabase
// ---------------------------------------------------------------------------

describe('isPreMigrationDatabase', () => {
  it('returns false for a fresh database with no tables', () => {
    const db = freshDb();
    expect(isPreMigrationDatabase(db)).toBe(false);
    db.close();
  });

  it('returns true for a database with tables but no version', () => {
    const db = preMigrationDb();
    expect(isPreMigrationDatabase(db)).toBe(true);
    db.close();
  });

  it('returns false for a database with tables and a version set', () => {
    const db = preMigrationDb();
    db.pragma('user_version = 1');
    expect(isPreMigrationDatabase(db)).toBe(false);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// applyMigrations — fresh database
// ---------------------------------------------------------------------------

describe('applyMigrations on fresh database', () => {
  it('creates all tables', () => {
    const db = freshDb();
    applyMigrations(db);
    const tables = tableNames(db);
    expect(tables).toContain('sessions');
    expect(tables).toContain('samples');
    expect(tables).toContain('aggregated_schemas');
    db.close();
  });

  it('sets schema version to CURRENT_SCHEMA_VERSION', () => {
    const db = freshDb();
    applyMigrations(db);
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    db.close();
  });

  it('is idempotent — running twice does not throw', () => {
    const db = freshDb();
    applyMigrations(db);
    expect(() => applyMigrations(db)).not.toThrow();
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    db.close();
  });

  it('sessions table has expected columns', () => {
    const db = freshDb();
    applyMigrations(db);
    const cols = columnNames(db, 'sessions');
    expect(cols).toContain('id');
    expect(cols).toContain('target_url');
    expect(cols).toContain('status');
    expect(cols).toContain('metadata');
    db.close();
  });
});

// ---------------------------------------------------------------------------
// applyMigrations — pre-migration database
// ---------------------------------------------------------------------------

describe('applyMigrations on pre-migration database', () => {
  it('stamps version to CURRENT_SCHEMA_VERSION without re-creating tables', () => {
    const db = preMigrationDb();
    // Insert some data so we can verify it survives migration
    db.prepare(
      `INSERT INTO sessions (id, target_url, port, status, created_at)
       VALUES ('test-id', 'http://localhost', 8080, 'active', '2024-01-01T00:00:00Z')`,
    ).run();

    applyMigrations(db);

    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION);

    // Verify data survived
    const row = db.prepare(`SELECT * FROM sessions WHERE id = 'test-id'`).get() as {
      id: string;
    };
    expect(row.id).toBe('test-id');

    db.close();
  });

  it('does not error on existing tables with IF NOT EXISTS', () => {
    const db = preMigrationDb();
    expect(() => applyMigrations(db)).not.toThrow();
    db.close();
  });
});

// ---------------------------------------------------------------------------
// applyMigrations — downgrade protection
// ---------------------------------------------------------------------------

describe('applyMigrations downgrade protection', () => {
  it('throws if database version is newer than application version', () => {
    const db = freshDb();
    db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION + 1}`);
    expect(() => applyMigrations(db)).toThrow(/newer than the application/);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// applyMigrations — incremental migration
// ---------------------------------------------------------------------------

describe('applyMigrations incremental migration', () => {
  it('only runs migrations newer than the current version', () => {
    const db = freshDb();

    // Apply only the first migration manually
    const firstMigration = MIGRATIONS[0];
    firstMigration.up(db);
    db.pragma('user_version = 1');

    // Now apply all migrations — should be a no-op for version 1
    applyMigrations(db);

    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    db.close();
  });

  it('correctly applies a simulated v2 migration (ALTER TABLE)', () => {
    // This test simulates what would happen when we add a real migration.
    // We manually add a migration, apply it, and verify the column exists.
    const db = freshDb();

    // Start with v1 schema
    MIGRATIONS[0].up(db);
    db.pragma('user_version = 1');

    // Simulate a v2 migration that adds a column
    const testMigration: typeof MIGRATIONS[number] = {
      version: 2,
      description: 'Test: add description column to sessions',
      up: (d) => {
        d.exec(`ALTER TABLE sessions ADD COLUMN description TEXT`);
      },
    };

    // Temporarily add our test migration
    MIGRATIONS.push(testMigration);

    try {
      applyMigrations(db);

      expect(getSchemaVersion(db)).toBe(2);
      const cols = columnNames(db, 'sessions');
      expect(cols).toContain('description');
    } finally {
      // Clean up: remove the test migration
      MIGRATIONS.pop();
    }

    db.close();
  });
});

// ---------------------------------------------------------------------------
// MIGRATIONS array integrity
// ---------------------------------------------------------------------------

describe('MIGRATIONS array integrity', () => {
  it('has sequential version numbers starting at 1', () => {
    for (let i = 0; i < MIGRATIONS.length; i++) {
      expect(MIGRATIONS[i].version).toBe(i + 1);
    }
  });

  it('CURRENT_SCHEMA_VERSION matches the number of migrations', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(MIGRATIONS.length);
  });

  it('every migration has a description', () => {
    for (const m of MIGRATIONS) {
      expect(m.description).toBeTruthy();
    }
  });
});
