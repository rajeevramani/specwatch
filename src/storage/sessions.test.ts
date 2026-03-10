import { describe, it, expect, beforeEach } from 'vitest';
import { getDatabase } from './database.js';
import { SessionRepository } from './sessions.js';
import type Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let db: Database.Database;
let repo: SessionRepository;

beforeEach(() => {
  db = getDatabase(':memory:');
  repo = new SessionRepository(db);
});

// ---------------------------------------------------------------------------
// createSession
// ---------------------------------------------------------------------------

describe('createSession', () => {
  it('returns a session with status "active"', () => {
    const session = repo.createSession('https://api.example.com', 8080);
    expect(session.status).toBe('active');
  });

  it('assigns a UUID id', () => {
    const session = repo.createSession('https://api.example.com', 8080);
    expect(session.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('stores the targetUrl and port', () => {
    const session = repo.createSession('https://api.example.com', 9090);
    expect(session.targetUrl).toBe('https://api.example.com');
    expect(session.port).toBe(9090);
  });

  it('stores an optional name', () => {
    const session = repo.createSession('https://api.example.com', 8080, 'my-session');
    expect(session.name).toBe('my-session');
  });

  it('stores an optional maxSamples', () => {
    const session = repo.createSession('https://api.example.com', 8080, undefined, 500);
    expect(session.maxSamples).toBe(500);
  });

  it('defaults sampleCount and skippedCount to 0', () => {
    const session = repo.createSession('https://api.example.com', 8080);
    expect(session.sampleCount).toBe(0);
    expect(session.skippedCount).toBe(0);
  });

  it('sets createdAt to a valid ISO 8601 timestamp', () => {
    const session = repo.createSession('https://api.example.com', 8080);
    expect(new Date(session.createdAt).toISOString()).toBe(session.createdAt);
  });

  it('does not set name when not provided', () => {
    const session = repo.createSession('https://api.example.com', 8080);
    expect(session.name).toBeUndefined();
  });

  it('does not set maxSamples when not provided', () => {
    const session = repo.createSession('https://api.example.com', 8080);
    expect(session.maxSamples).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getSession
// ---------------------------------------------------------------------------

describe('getSession', () => {
  it('returns the session by id', () => {
    const created = repo.createSession('https://api.example.com', 8080);
    const found = repo.getSession(created.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
  });

  it('returns null for unknown id', () => {
    const found = repo.getSession('00000000-0000-0000-0000-000000000000');
    expect(found).toBeNull();
  });

  it('round-trips all fields correctly', () => {
    const created = repo.createSession('https://api.example.com', 8080, 'test-name', 100);
    const found = repo.getSession(created.id)!;
    expect(found.targetUrl).toBe('https://api.example.com');
    expect(found.port).toBe(8080);
    expect(found.name).toBe('test-name');
    expect(found.maxSamples).toBe(100);
    expect(found.status).toBe('active');
    expect(found.sampleCount).toBe(0);
    expect(found.skippedCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getActiveSession
// ---------------------------------------------------------------------------

describe('getActiveSession', () => {
  it('returns null when no sessions exist', () => {
    expect(repo.getActiveSession()).toBeNull();
  });

  it('returns the active session', () => {
    const session = repo.createSession('https://api.example.com', 8080);
    const active = repo.getActiveSession();
    expect(active).not.toBeNull();
    expect(active!.id).toBe(session.id);
  });

  it('returns null when the only session is completed', () => {
    const session = repo.createSession('https://api.example.com', 8080);
    repo.updateSessionStatus(session.id, 'aggregating');
    repo.updateSessionStatus(session.id, 'completed');
    expect(repo.getActiveSession()).toBeNull();
  });

  it('returns null when the only session is failed', () => {
    const session = repo.createSession('https://api.example.com', 8080);
    repo.updateSessionStatus(session.id, 'failed');
    expect(repo.getActiveSession()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getLatestCompleted
// ---------------------------------------------------------------------------

describe('getLatestCompleted', () => {
  it('returns null when no completed sessions exist', () => {
    expect(repo.getLatestCompleted()).toBeNull();
  });

  it('returns null when only active sessions exist', () => {
    repo.createSession('https://api.example.com', 8080);
    expect(repo.getLatestCompleted()).toBeNull();
  });

  it('returns the completed session', () => {
    const session = repo.createSession('https://api.example.com', 8080);
    repo.updateSessionStatus(session.id, 'aggregating');
    repo.updateSessionStatus(session.id, 'completed');
    const latest = repo.getLatestCompleted();
    expect(latest).not.toBeNull();
    expect(latest!.id).toBe(session.id);
  });

  it('returns the most recently created completed session', () => {
    const s1 = repo.createSession('https://api1.example.com', 8080);
    repo.updateSessionStatus(s1.id, 'aggregating');
    repo.updateSessionStatus(s1.id, 'completed');

    const s2 = repo.createSession('https://api2.example.com', 8081);
    repo.updateSessionStatus(s2.id, 'aggregating');
    repo.updateSessionStatus(s2.id, 'completed');

    const latest = repo.getLatestCompleted();
    expect(latest!.id).toBe(s2.id);
  });
});

// ---------------------------------------------------------------------------
// listSessions
// ---------------------------------------------------------------------------

describe('listSessions', () => {
  it('returns empty array when no sessions', () => {
    expect(repo.listSessions()).toEqual([]);
  });

  it('returns all sessions', () => {
    repo.createSession('https://api1.example.com', 8080);
    repo.createSession('https://api2.example.com', 8081);
    expect(repo.listSessions()).toHaveLength(2);
  });

  it('returns sessions sorted by createdAt DESC (most recent first)', () => {
    const s1 = repo.createSession('https://first.example.com', 8080);
    const s2 = repo.createSession('https://second.example.com', 8081);
    const list = repo.listSessions();
    // s2 was created after s1, so it should come first
    expect(list[0].id).toBe(s2.id);
    expect(list[1].id).toBe(s1.id);
  });
});

// ---------------------------------------------------------------------------
// updateSessionStatus — valid transitions
// ---------------------------------------------------------------------------

describe('updateSessionStatus — valid transitions', () => {
  it('transitions active → aggregating', () => {
    const session = repo.createSession('https://api.example.com', 8080);
    repo.updateSessionStatus(session.id, 'aggregating');
    expect(repo.getSession(session.id)!.status).toBe('aggregating');
  });

  it('transitions active → failed', () => {
    const session = repo.createSession('https://api.example.com', 8080);
    repo.updateSessionStatus(session.id, 'failed');
    expect(repo.getSession(session.id)!.status).toBe('failed');
  });

  it('transitions aggregating → completed', () => {
    const session = repo.createSession('https://api.example.com', 8080);
    repo.updateSessionStatus(session.id, 'aggregating');
    repo.updateSessionStatus(session.id, 'completed');
    expect(repo.getSession(session.id)!.status).toBe('completed');
  });

  it('transitions aggregating → failed', () => {
    const session = repo.createSession('https://api.example.com', 8080);
    repo.updateSessionStatus(session.id, 'aggregating');
    repo.updateSessionStatus(session.id, 'failed');
    expect(repo.getSession(session.id)!.status).toBe('failed');
  });

  it('stores errorMessage on failed transition', () => {
    const session = repo.createSession('https://api.example.com', 8080);
    repo.updateSessionStatus(session.id, 'failed', 'Something went wrong');
    const updated = repo.getSession(session.id)!;
    expect(updated.errorMessage).toBe('Something went wrong');
  });

  it('sets stopped_at when transitioning to aggregating', () => {
    const session = repo.createSession('https://api.example.com', 8080);
    repo.updateSessionStatus(session.id, 'aggregating');
    const updated = repo.getSession(session.id)!;
    expect(updated.stoppedAt).toBeDefined();
    expect(new Date(updated.stoppedAt!).toISOString()).toBe(updated.stoppedAt);
  });

  it('sets completed_at when transitioning to completed', () => {
    const session = repo.createSession('https://api.example.com', 8080);
    repo.updateSessionStatus(session.id, 'aggregating');
    repo.updateSessionStatus(session.id, 'completed');
    const updated = repo.getSession(session.id)!;
    expect(updated.completedAt).toBeDefined();
    expect(new Date(updated.completedAt!).toISOString()).toBe(updated.completedAt);
  });
});

// ---------------------------------------------------------------------------
// updateSessionStatus — invalid transitions
// ---------------------------------------------------------------------------

describe('updateSessionStatus — invalid transitions', () => {
  it('throws for active → completed', () => {
    const session = repo.createSession('https://api.example.com', 8080);
    expect(() => repo.updateSessionStatus(session.id, 'completed')).toThrow();
  });

  it('throws for aggregating → active', () => {
    const session = repo.createSession('https://api.example.com', 8080);
    repo.updateSessionStatus(session.id, 'aggregating');
    expect(() => repo.updateSessionStatus(session.id, 'active')).toThrow();
  });

  it('throws for completed → active', () => {
    const session = repo.createSession('https://api.example.com', 8080);
    repo.updateSessionStatus(session.id, 'aggregating');
    repo.updateSessionStatus(session.id, 'completed');
    expect(() => repo.updateSessionStatus(session.id, 'active')).toThrow();
  });

  it('throws for completed → failed', () => {
    const session = repo.createSession('https://api.example.com', 8080);
    repo.updateSessionStatus(session.id, 'aggregating');
    repo.updateSessionStatus(session.id, 'completed');
    expect(() => repo.updateSessionStatus(session.id, 'failed')).toThrow();
  });

  it('throws for completed → aggregating', () => {
    const session = repo.createSession('https://api.example.com', 8080);
    repo.updateSessionStatus(session.id, 'aggregating');
    repo.updateSessionStatus(session.id, 'completed');
    expect(() => repo.updateSessionStatus(session.id, 'aggregating')).toThrow();
  });

  it('throws for failed → completed', () => {
    const session = repo.createSession('https://api.example.com', 8080);
    repo.updateSessionStatus(session.id, 'failed');
    expect(() => repo.updateSessionStatus(session.id, 'completed')).toThrow();
  });

  it('throws for unknown session id', () => {
    expect(() =>
      repo.updateSessionStatus('00000000-0000-0000-0000-000000000000', 'aggregating'),
    ).toThrow();
  });

  it('error message describes the invalid transition', () => {
    const session = repo.createSession('https://api.example.com', 8080);
    expect(() => repo.updateSessionStatus(session.id, 'completed')).toThrowError(
      /active.*completed/,
    );
  });
});

// ---------------------------------------------------------------------------
// incrementSampleCount
// ---------------------------------------------------------------------------

describe('incrementSampleCount', () => {
  it('increments from 0 to 1', () => {
    const session = repo.createSession('https://api.example.com', 8080);
    repo.incrementSampleCount(session.id);
    expect(repo.getSession(session.id)!.sampleCount).toBe(1);
  });

  it('is cumulative', () => {
    const session = repo.createSession('https://api.example.com', 8080);
    repo.incrementSampleCount(session.id);
    repo.incrementSampleCount(session.id);
    repo.incrementSampleCount(session.id);
    expect(repo.getSession(session.id)!.sampleCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// incrementSkippedCount
// ---------------------------------------------------------------------------

describe('incrementSkippedCount', () => {
  it('increments from 0 to 1', () => {
    const session = repo.createSession('https://api.example.com', 8080);
    repo.incrementSkippedCount(session.id);
    expect(repo.getSession(session.id)!.skippedCount).toBe(1);
  });

  it('is independent from sampleCount', () => {
    const session = repo.createSession('https://api.example.com', 8080);
    repo.incrementSampleCount(session.id);
    repo.incrementSkippedCount(session.id);
    repo.incrementSkippedCount(session.id);
    const updated = repo.getSession(session.id)!;
    expect(updated.sampleCount).toBe(1);
    expect(updated.skippedCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// deleteSession
// ---------------------------------------------------------------------------

describe('deleteSession', () => {
  it('removes the session', () => {
    const session = repo.createSession('https://api.example.com', 8080);
    repo.deleteSession(session.id);
    expect(repo.getSession(session.id)).toBeNull();
  });

  it('is idempotent for unknown ids', () => {
    // Should not throw
    expect(() =>
      repo.deleteSession('00000000-0000-0000-0000-000000000000'),
    ).not.toThrow();
  });

  it('removes the session from listSessions', () => {
    const session = repo.createSession('https://api.example.com', 8080);
    repo.deleteSession(session.id);
    expect(repo.listSessions()).toHaveLength(0);
  });
});
