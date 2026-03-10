/**
 * SQLite connection and migrations for Specwatch.
 * Uses better-sqlite3 for synchronous, embedded storage with WAL mode.
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';

export type { Database };

/**
 * Returns the default database path, respecting the SPECWATCH_HOME env var.
 * Default: ~/.specwatch/specwatch.db
 */
function getDefaultDbPath(): string {
  const specwatchHome = process.env['SPECWATCH_HOME'];
  const baseDir = specwatchHome ? specwatchHome : join(homedir(), '.specwatch');
  return join(baseDir, 'specwatch.db');
}

/**
 * Opens (or creates) the SQLite database, runs idempotent migrations,
 * and enables WAL mode.
 *
 * @param dbPath - Path to the database file. Defaults to ~/.specwatch/specwatch.db.
 *                 Pass ':memory:' for an in-memory database (useful in tests).
 */
export function getDatabase(dbPath?: string): Database.Database {
  const resolvedPath = dbPath ?? getDefaultDbPath();

  // Ensure directory exists (not needed for :memory:)
  if (resolvedPath !== ':memory:') {
    mkdirSync(dirname(resolvedPath), { recursive: true });
  }

  const db = new Database(resolvedPath);

  runMigrations(db);

  return db;
}

/**
 * Runs idempotent schema migrations against the given database connection.
 * Safe to call multiple times — uses CREATE TABLE IF NOT EXISTS.
 */
export function runMigrations(db: Database.Database): void {
  // Enable WAL mode for concurrent read performance during high-throughput proxying
  db.pragma('journal_mode=WAL');

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
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agg_session_endpoint ON aggregated_schemas(session_id, http_method, path, version);
  `);
}
