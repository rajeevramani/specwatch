/**
 * Tests for the consumer column on sessions table (v2 migration).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { getDatabase } from '../../src/storage/database.js';
import { SessionRepository } from '../../src/storage/sessions.js';
import { MIGRATIONS, applyMigrations, getSchemaVersion, setSchemaVersion } from '../../src/storage/migrations.js';

describe('consumer column migration', () => {
  let db: Database.Database;
  let repo: SessionRepository;

  beforeEach(() => {
    db = getDatabase(':memory:');
    repo = new SessionRepository(db);
  });

  it('fresh DB has consumer column with default "human"', () => {
    const session = repo.createSession('https://api.example.com', 8080);
    expect(session.consumer).toBe('human');
  });

  it('createSession with consumer="agent" stores correctly', () => {
    const session = repo.createSession('https://api.example.com', 8080, 'test', undefined, 'agent');
    expect(session.consumer).toBe('agent');

    // Verify directly in DB
    const row = db.prepare('SELECT consumer FROM sessions WHERE id = ?').get(session.id) as { consumer: string };
    expect(row.consumer).toBe('agent');
  });

  it('createSession without consumer defaults to "human"', () => {
    const session = repo.createSession('https://api.example.com', 8080, 'test');
    expect(session.consumer).toBe('human');

    const row = db.prepare('SELECT consumer FROM sessions WHERE id = ?').get(session.id) as { consumer: string };
    expect(row.consumer).toBe('human');
  });

  it('migration from v1 adds consumer column with default "human" to existing sessions', () => {
    // Create a v1-only database manually
    const rawDb = new Database(':memory:');
    rawDb.pragma('journal_mode=WAL');

    // Run only the v1 migration
    const v1Migration = MIGRATIONS[0];
    rawDb.transaction(() => {
      v1Migration.up(rawDb);
      setSchemaVersion(rawDb, 1);
    })();

    // Insert a session at v1 (no consumer column)
    rawDb.prepare(
      `INSERT INTO sessions (id, name, target_url, port, status, created_at, sample_count, skipped_count)
       VALUES (?, ?, ?, ?, 'active', ?, 0, 0)`,
    ).run('old-session-id', 'legacy', 'https://api.example.com', 8080, '2025-01-01T00:00:00Z');

    expect(getSchemaVersion(rawDb)).toBe(1);

    // Now apply all migrations (should run v2)
    applyMigrations(rawDb);

    expect(getSchemaVersion(rawDb)).toBe(MIGRATIONS.length);

    // The existing session should have consumer='human' (the DEFAULT)
    const row = rawDb.prepare('SELECT consumer FROM sessions WHERE id = ?').get('old-session-id') as { consumer: string };
    expect(row.consumer).toBe('human');

    // New sessions should also get 'human' by default
    const repo2 = new SessionRepository(rawDb);
    const newSession = repo2.createSession('https://api2.example.com', 9090);
    expect(newSession.consumer).toBe('human');

    rawDb.close();
  });

  it('schema version matches MIGRATIONS.length after full migration', () => {
    expect(getSchemaVersion(db)).toBe(MIGRATIONS.length);
  });
});
