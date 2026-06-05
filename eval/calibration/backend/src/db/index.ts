import Database from 'better-sqlite3';
import { SCHEMA_SQL } from './schema.js';
import { seed } from './seed.js';

export type DB = Database.Database;

/**
 * Create a fresh database, apply the schema, and load the deterministic seed.
 *
 * @param file  SQLite file path, or ':memory:' (default) for an ephemeral DB.
 *              For a file-backed DB the file is dropped/recreated so every boot
 *              starts from the same deterministic state.
 */
export function createDatabase(file = ':memory:'): DB {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  if (file !== ':memory:') {
    // Reset tables so a file-backed DB is deterministic across restarts.
    db.exec('DROP TABLE IF EXISTS line_items; DROP TABLE IF EXISTS orders; DROP TABLE IF EXISTS customers;');
  }

  db.exec(SCHEMA_SQL);
  seed(db);
  return db;
}
