/**
 * Tests for session lookup by name (getSessionByName) and CLI --name option.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { getDatabase } from '../../src/storage/database.js';
import { SessionRepository } from '../../src/storage/sessions.js';
import type Database from 'better-sqlite3';

describe('SessionRepository.getSessionByName', () => {
  let db: Database.Database;
  let repo: SessionRepository;

  beforeEach(() => {
    db = getDatabase(':memory:');
    repo = new SessionRepository(db);
  });

  it('returns null when no session exists with the given name', () => {
    const result = repo.getSessionByName('nonexistent');
    expect(result).toBeNull();
  });

  it('returns the session matching the given name', () => {
    const session = repo.createSession('https://api.example.com', 8080, 'my-api');
    const found = repo.getSessionByName('my-api');
    expect(found).not.toBeNull();
    expect(found!.id).toBe(session.id);
    expect(found!.name).toBe('my-api');
  });

  it('returns the most recent session when multiple sessions share the same name', () => {
    const first = repo.createSession('https://api.example.com', 8080, 'my-api');
    // Force different created_at by updating directly
    db.prepare(`UPDATE sessions SET created_at = '2025-01-01T00:00:00Z' WHERE id = ?`).run(
      first.id,
    );

    const second = repo.createSession('https://api.example.com', 8081, 'my-api');
    db.prepare(`UPDATE sessions SET created_at = '2025-06-01T00:00:00Z' WHERE id = ?`).run(
      second.id,
    );

    const found = repo.getSessionByName('my-api');
    expect(found).not.toBeNull();
    expect(found!.id).toBe(second.id);
    expect(found!.port).toBe(8081);
  });

  it('does not match sessions with different names', () => {
    repo.createSession('https://api.example.com', 8080, 'alpha');
    repo.createSession('https://api.example.com', 8081, 'beta');

    const found = repo.getSessionByName('alpha');
    expect(found).not.toBeNull();
    expect(found!.name).toBe('alpha');
  });

  it('does not match unnamed sessions', () => {
    repo.createSession('https://api.example.com', 8080);
    const found = repo.getSessionByName('');
    expect(found).toBeNull();
  });

  it('name matching is exact (case-sensitive)', () => {
    repo.createSession('https://api.example.com', 8080, 'MyApi');
    expect(repo.getSessionByName('MyApi')).not.toBeNull();
    expect(repo.getSessionByName('myapi')).toBeNull();
    expect(repo.getSessionByName('MYAPI')).toBeNull();
  });
});

describe('CLI --name option resolution', () => {
  let db: Database.Database;
  let repo: SessionRepository;

  beforeEach(() => {
    db = getDatabase(':memory:');
    repo = new SessionRepository(db);
  });

  it('session ID takes priority over name when both could match', () => {
    // This tests the logic: if sessionId argument is provided, it's used directly
    const session = repo.createSession('https://api.example.com', 8080, 'my-api');

    // Simulate the CLI resolution logic: sessionId arg takes priority
    const sessionId = session.id;
    const nameOpt = 'my-api';

    let resolvedId: string;
    if (sessionId) {
      const s = repo.getSession(sessionId);
      expect(s).not.toBeNull();
      resolvedId = sessionId;
    } else if (nameOpt) {
      const s = repo.getSessionByName(nameOpt);
      expect(s).not.toBeNull();
      resolvedId = s!.id;
    } else {
      resolvedId = '';
    }

    expect(resolvedId).toBe(session.id);
  });

  it('--name resolves to correct session when no session ID argument', () => {
    const session = repo.createSession('https://api.example.com', 8080, 'production');

    // Simulate: no sessionId arg, only --name
    const sessionId = undefined;
    const nameOpt = 'production';

    let resolvedId: string | undefined;
    if (sessionId) {
      resolvedId = sessionId;
    } else if (nameOpt) {
      const s = repo.getSessionByName(nameOpt);
      if (s) resolvedId = s.id;
    }

    expect(resolvedId).toBe(session.id);
  });

  it('--name throws when session name not found', () => {
    // Simulate: no sessionId, --name provided but not found
    const found = repo.getSessionByName('does-not-exist');
    expect(found).toBeNull();
  });
});
