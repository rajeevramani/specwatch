/**
 * Session repository — CRUD operations for proxy capture sessions.
 * Accepts a Database instance for dependency injection and testability.
 */
import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Session, SessionConsumer, SessionStatus } from '../types/index.js';

// ---------------------------------------------------------------------------
// Row type returned by better-sqlite3 (snake_case columns)
// ---------------------------------------------------------------------------

interface SessionRow {
  id: string;
  name: string | null;
  target_url: string;
  port: number;
  status: string;
  created_at: string;
  started_at: string | null;
  stopped_at: string | null;
  completed_at: string | null;
  sample_count: number;
  skipped_count: number;
  max_samples: number | null;
  error_message: string | null;
  consumer: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Maps a database row to the Session domain type. */
function rowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    name: row.name ?? undefined,
    targetUrl: row.target_url,
    port: row.port,
    status: row.status as SessionStatus,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    stoppedAt: row.stopped_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    sampleCount: row.sample_count,
    skippedCount: row.skipped_count,
    maxSamples: row.max_samples ?? undefined,
    errorMessage: row.error_message ?? undefined,
    consumer: (row.consumer as SessionConsumer) ?? 'human',
  };
}

// Valid state machine transitions (from -> set of allowed to)
const VALID_TRANSITIONS: Record<SessionStatus, readonly SessionStatus[]> = {
  active: ['aggregating', 'failed'],
  aggregating: ['completed', 'failed'],
  completed: [],
  failed: [],
};

// ---------------------------------------------------------------------------
// SessionRepository
// ---------------------------------------------------------------------------

/**
 * Repository for session lifecycle management.
 * All methods are synchronous (better-sqlite3 is synchronous by design).
 */
export class SessionRepository {
  constructor(private readonly db: Database.Database) {}

  /**
   * Creates a new session with status 'active'.
   *
   * @param targetUrl - The upstream API URL being proxied
   * @param port - Local proxy port
   * @param name - Optional user-provided session name
   * @param maxSamples - Optional cap on number of samples
   */
  createSession(targetUrl: string, port: number, name?: string, maxSamples?: number, consumer?: SessionConsumer): Session {
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO sessions
           (id, name, target_url, port, status, created_at, sample_count, skipped_count, max_samples, consumer)
         VALUES
           (?, ?, ?, ?, 'active', ?, 0, 0, ?, ?)`,
      )
      .run(id, name ?? null, targetUrl, port, createdAt, maxSamples ?? null, consumer ?? 'human');

    return this.getSession(id) as Session;
  }

  /**
   * Returns the session with the given ID, or null if not found.
   */
  getSession(id: string): Session | null {
    const row = this.db
      .prepare(`SELECT * FROM sessions WHERE id = ?`)
      .get(id) as SessionRow | undefined;

    return row ? rowToSession(row) : null;
  }

  /**
   * Returns the most recent session with the given name, or null if not found.
   */
  getSessionByName(name: string): Session | null {
    const row = this.db
      .prepare(`SELECT * FROM sessions WHERE name = ? ORDER BY created_at DESC LIMIT 1`)
      .get(name) as SessionRow | undefined;

    return row ? rowToSession(row) : null;
  }

  /**
   * Returns the currently active session, or null if none exists.
   */
  getActiveSession(): Session | null {
    const row = this.db
      .prepare(`SELECT * FROM sessions WHERE status = 'active' LIMIT 1`)
      .get() as SessionRow | undefined;

    return row ? rowToSession(row) : null;
  }

  /**
   * Returns the most recently completed session, or null if none exists.
   * Uses rowid as a tiebreaker when created_at timestamps are equal (e.g., in tests).
   */
  getLatestCompleted(): Session | null {
    const row = this.db
      .prepare(
        `SELECT * FROM sessions WHERE status = 'completed' ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get() as SessionRow | undefined;

    return row ? rowToSession(row) : null;
  }

  /**
   * Returns all sessions sorted by createdAt descending (most recent first).
   * Uses rowid as a tiebreaker when created_at timestamps are equal (e.g., in tests).
   */
  listSessions(): Session[] {
    const rows = this.db
      .prepare(`SELECT * FROM sessions ORDER BY created_at DESC, rowid DESC`)
      .all() as SessionRow[];

    return rows.map(rowToSession);
  }

  /**
   * Transitions a session to a new status, validating the state machine.
   *
   * Valid transitions:
   *   active      → aggregating | failed
   *   aggregating → completed | failed
   *
   * @throws Error if the transition is not permitted
   */
  updateSessionStatus(
    id: string,
    status: SessionStatus,
    errorMessage?: string,
  ): void {
    const session = this.getSession(id);
    if (!session) {
      throw new Error(`Session '${id}' not found`);
    }

    const allowed = VALID_TRANSITIONS[session.status];
    if (!allowed.includes(status)) {
      throw new Error(
        `Invalid state transition for session '${id}': ${session.status} → ${status}`,
      );
    }

    // Build the timestamp column to set based on the target status
    const now = new Date().toISOString();
    let extraColumn = '';

    if (status === 'aggregating') {
      extraColumn = ', stopped_at = ?';
    } else if (status === 'completed') {
      extraColumn = ', completed_at = ?';
    }

    if (extraColumn) {
      this.db
        .prepare(
          `UPDATE sessions SET status = ?, error_message = ?${extraColumn} WHERE id = ?`,
        )
        .run(status, errorMessage ?? null, now, id);
    } else {
      this.db
        .prepare(`UPDATE sessions SET status = ?, error_message = ? WHERE id = ?`)
        .run(status, errorMessage ?? null, id);
    }
  }

  /**
   * Atomically increments the sample_count for a session by 1.
   */
  incrementSampleCount(id: string): void {
    this.db
      .prepare(`UPDATE sessions SET sample_count = sample_count + 1 WHERE id = ?`)
      .run(id);
  }

  /**
   * Atomically increments the skipped_count for a session by 1.
   */
  incrementSkippedCount(id: string): void {
    this.db
      .prepare(`UPDATE sessions SET skipped_count = skipped_count + 1 WHERE id = ?`)
      .run(id);
  }

  /**
   * Deletes a session and all its related samples and aggregated_schemas (CASCADE).
   */
  deleteSession(id: string): void {
    this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
  }
}
