/**
 * Schema migration system for Specwatch SQLite database.
 *
 * Uses SQLite's PRAGMA user_version to track the current schema version.
 * Each migration is a function that takes a Database instance and runs
 * the needed DDL statements. Migrations are applied in order within
 * individual transactions.
 */
import type Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single migration step. */
export interface Migration {
  /** Target version after this migration runs (1-based). */
  version: number;
  /** Human-readable description of what the migration does. */
  description: string;
  /** The migration function. Receives the db — the caller wraps it in a transaction. */
  up: (db: Database.Database) => void;
}

// ---------------------------------------------------------------------------
// Initial schema (version 1) — the baseline
// ---------------------------------------------------------------------------

const INITIAL_SCHEMA: Migration = {
  version: 1,
  description: 'Initial schema: sessions, samples, aggregated_schemas tables',
  up: (db) => {
    db.exec(`
      -- Session lifecycle management
      CREATE TABLE IF NOT EXISTS sessions (
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

      -- Individual request/response observations (structural metadata only)
      CREATE TABLE IF NOT EXISTS samples (
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
        captured_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_samples_session ON samples(session_id);
      CREATE INDEX IF NOT EXISTS idx_samples_endpoint ON samples(http_method, normalized_path);
      CREATE INDEX IF NOT EXISTS idx_samples_session_endpoint ON samples(session_id, http_method, normalized_path, status_code);

      -- Aggregated consensus schemas per endpoint
      CREATE TABLE IF NOT EXISTS aggregated_schemas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        http_method TEXT NOT NULL,
        path TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        snapshot INTEGER NOT NULL DEFAULT 1,
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
        created_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_agg_session ON aggregated_schemas(session_id);
      CREATE INDEX IF NOT EXISTS idx_agg_endpoint ON aggregated_schemas(http_method, path);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agg_session_endpoint ON aggregated_schemas(session_id, http_method, path, snapshot);
    `);
  },
};

// ---------------------------------------------------------------------------
// Migration registry — append new migrations here
// ---------------------------------------------------------------------------

/**
 * Ordered list of all migrations. Each migration brings the DB from
 * (version - 1) to (version). The initial schema is version 1.
 *
 * To add a new migration:
 *   1. Create a Migration object with the next version number
 *   2. Append it to this array
 *   3. Bump CURRENT_SCHEMA_VERSION
 *
 * Example:
 *   {
 *     version: 2,
 *     description: 'Add foo column to sessions',
 *     up: (db) => {
 *       db.exec(`ALTER TABLE sessions ADD COLUMN foo TEXT`);
 *     },
 *   }
 */
export const MIGRATIONS: Migration[] = [
  INITIAL_SCHEMA,
  // Future migrations go here, e.g.:
  // { version: 2, description: '...', up: (db) => { ... } },
];

/** The schema version that a fully-migrated database should be at. */
export const CURRENT_SCHEMA_VERSION = MIGRATIONS.length;

// ---------------------------------------------------------------------------
// Migration runner
// ---------------------------------------------------------------------------

/**
 * Returns the current schema version stored in the database.
 * Returns 0 if no version has been set (fresh or pre-migration database).
 */
export function getSchemaVersion(db: Database.Database): number {
  const result = db.pragma('user_version', { simple: true });
  return result as number;
}

/**
 * Sets the schema version in the database.
 */
export function setSchemaVersion(db: Database.Database, version: number): void {
  if (!Number.isInteger(version) || version < 0) {
    throw new Error(`Invalid schema version: ${version}`);
  }
  db.pragma(`user_version = ${version}`);
}

/**
 * Detects whether a database is a pre-migration database (has tables but
 * user_version is 0). This distinguishes between a truly fresh database
 * and an existing database created before the migration system was added.
 */
export function isPreMigrationDatabase(db: Database.Database): boolean {
  const version = getSchemaVersion(db);
  if (version !== 0) return false;

  // Check if the sessions table exists — if it does, this is a pre-migration DB
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'`)
    .get() as { name: string } | undefined;

  return row !== undefined;
}

/**
 * Runs all pending migrations to bring the database up to CURRENT_SCHEMA_VERSION.
 *
 * - Fresh databases (no tables, version 0): runs all migrations from version 1.
 * - Pre-migration databases (has tables, version 0): stamps as version 1,
 *   then runs migrations from version 2 onward.
 * - Partially migrated databases: runs only the migrations not yet applied.
 *
 * Each migration runs in its own transaction for atomicity.
 *
 * @throws Error if the database version is higher than CURRENT_SCHEMA_VERSION
 *         (downgrade not supported)
 */
export function applyMigrations(db: Database.Database): void {
  // Read target version dynamically from the array length so that
  // any migrations appended at runtime (e.g. in tests) are picked up.
  const targetVersion = MIGRATIONS.length;
  let currentVersion = getSchemaVersion(db);

  if (currentVersion > targetVersion) {
    throw new Error(
      `Database schema version ${currentVersion} is newer than the application's ` +
        `schema version ${targetVersion}. Downgrade is not supported.`,
    );
  }

  if (currentVersion === targetVersion) {
    return; // Already up to date
  }

  // Handle pre-migration databases: they already have the v1 schema,
  // so stamp them as version 1 and skip the initial migration.
  if (currentVersion === 0 && isPreMigrationDatabase(db)) {
    setSchemaVersion(db, 1);
    currentVersion = 1;
  }

  // Apply each pending migration in its own transaction
  for (const migration of MIGRATIONS) {
    if (migration.version <= currentVersion) {
      continue;
    }

    const runMigration = db.transaction(() => {
      migration.up(db);
      setSchemaVersion(db, migration.version);
    });

    runMigration();
  }
}
