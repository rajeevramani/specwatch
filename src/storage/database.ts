/**
 * SQLite connection and migrations for Specwatch.
 * Uses better-sqlite3 for synchronous, embedded storage with WAL mode.
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { applyMigrations } from './migrations.js';

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
 * Opens (or creates) the SQLite database, runs schema migrations,
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
 * Runs schema migrations against the given database connection.
 * Uses PRAGMA user_version to track schema version and applies
 * any pending migrations. Safe to call multiple times.
 */
export function runMigrations(db: Database.Database): void {
  // Enable WAL mode for concurrent read performance during high-throughput proxying
  db.pragma('journal_mode=WAL');

  // Apply versioned migrations
  applyMigrations(db);
}
