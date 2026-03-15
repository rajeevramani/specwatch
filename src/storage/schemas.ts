/**
 * Aggregated schema repository — storage for merged endpoint schemas.
 * JSON fields are serialized at the repository boundary; callers receive typed objects.
 */
import type Database from 'better-sqlite3';
import type {
  AggregatedSchema,
  InferredSchema,
  HeaderEntry,
  BreakingChange,
} from '../types/index.js';

// ---------------------------------------------------------------------------
// Row type returned by better-sqlite3
// ---------------------------------------------------------------------------

interface AggregatedSchemaRow {
  id: number;
  session_id: string;
  http_method: string;
  path: string;
  version: number;
  snapshot: number;
  request_schema: string | null;
  response_schemas: string | null;
  request_headers: string | null;
  response_headers: string | null;
  query_params: string | null;
  path_param_values: string | null;
  sample_count: number;
  confidence_score: number;
  breaking_changes: string | null;
  previous_session_id: string | null;
  first_observed: string;
  last_observed: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Maps a database row to the AggregatedSchema domain type. */
function rowToAggregatedSchema(row: AggregatedSchemaRow): AggregatedSchema {
  return {
    id: row.id,
    sessionId: row.session_id,
    httpMethod: row.http_method,
    path: row.path,
    version: row.version,
    snapshot: row.snapshot,
    requestSchema: row.request_schema
      ? (JSON.parse(row.request_schema) as InferredSchema)
      : undefined,
    responseSchemas: row.response_schemas
      ? (JSON.parse(row.response_schemas) as Record<string, InferredSchema>)
      : undefined,
    requestHeaders: row.request_headers
      ? (JSON.parse(row.request_headers) as HeaderEntry[])
      : undefined,
    responseHeaders: row.response_headers
      ? (JSON.parse(row.response_headers) as HeaderEntry[])
      : undefined,
    queryParams: row.query_params
      ? (JSON.parse(row.query_params) as Record<string, string[]>)
      : undefined,
    pathParamValues: row.path_param_values
      ? (JSON.parse(row.path_param_values) as Record<string, string[]>)
      : undefined,
    sampleCount: row.sample_count,
    confidenceScore: row.confidence_score,
    breakingChanges: row.breaking_changes
      ? (JSON.parse(row.breaking_changes) as BreakingChange[])
      : undefined,
    previousSessionId: row.previous_session_id ?? undefined,
    firstObserved: row.first_observed,
    lastObserved: row.last_observed,
  };
}

// ---------------------------------------------------------------------------
// AggregatedSchemaRepository
// ---------------------------------------------------------------------------

/** Input type for inserting an aggregated schema (id is auto-assigned by SQLite). */
export type InsertAggregatedInput = Omit<AggregatedSchema, 'id'> & { createdAt?: string };

/**
 * Repository for aggregated endpoint schemas.
 * All methods are synchronous.
 */
export class AggregatedSchemaRepository {
  constructor(private readonly db: Database.Database) {}

  /**
   * Inserts an aggregated schema and returns its auto-assigned id.
   * JSON fields are serialized automatically.
   */
  insertAggregated(schema: InsertAggregatedInput): number {
    const createdAt = schema.createdAt ?? new Date().toISOString();

    const result = this.db
      .prepare(
        `INSERT INTO aggregated_schemas
           (session_id, http_method, path, version, snapshot,
            request_schema, response_schemas,
            request_headers, response_headers, query_params, path_param_values,
            sample_count, confidence_score,
            breaking_changes, previous_session_id,
            first_observed, last_observed, created_at)
         VALUES
           (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        schema.sessionId,
        schema.httpMethod,
        schema.path,
        schema.version,
        schema.snapshot ?? 1,
        schema.requestSchema != null ? JSON.stringify(schema.requestSchema) : null,
        schema.responseSchemas != null ? JSON.stringify(schema.responseSchemas) : null,
        schema.requestHeaders != null ? JSON.stringify(schema.requestHeaders) : null,
        schema.responseHeaders != null ? JSON.stringify(schema.responseHeaders) : null,
        schema.queryParams != null ? JSON.stringify(schema.queryParams) : null,
        schema.pathParamValues != null ? JSON.stringify(schema.pathParamValues) : null,
        schema.sampleCount,
        schema.confidenceScore,
        schema.breakingChanges != null ? JSON.stringify(schema.breakingChanges) : null,
        schema.previousSessionId ?? null,
        schema.firstObserved,
        schema.lastObserved,
        createdAt,
      );

    return result.lastInsertRowid as number;
  }

  /**
   * Returns all aggregated schemas for a session, ordered by path then http_method.
   */
  listBySession(sessionId: string): AggregatedSchema[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM aggregated_schemas
         WHERE session_id = ?
         ORDER BY path ASC, http_method ASC`,
      )
      .all(sessionId) as AggregatedSchemaRow[];

    return rows.map(rowToAggregatedSchema);
  }

  /**
   * Returns the most recent aggregated schema for the given method and path,
   * across all sessions (by created_at descending).
   */
  getLatestForEndpoint(method: string, path: string): AggregatedSchema | null {
    const row = this.db
      .prepare(
        `SELECT * FROM aggregated_schemas
         WHERE http_method = ? AND path = ?
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(method, path) as AggregatedSchemaRow | undefined;

    return row ? rowToAggregatedSchema(row) : null;
  }

  /**
   * Returns the aggregated schema for a specific session, method and path, or null.
   */
  getBySessionEndpoint(
    sessionId: string,
    method: string,
    path: string,
  ): AggregatedSchema | null {
    const row = this.db
      .prepare(
        `SELECT * FROM aggregated_schemas
         WHERE session_id = ? AND http_method = ? AND path = ?
         LIMIT 1`,
      )
      .get(sessionId, method, path) as AggregatedSchemaRow | undefined;

    return row ? rowToAggregatedSchema(row) : null;
  }

  /**
   * Returns the latest snapshot number for a session, or 0 if none exist.
   */
  getMaxSnapshotForSession(sessionId: string): number {
    const row = this.db
      .prepare(
        `SELECT MAX(snapshot) as max_snapshot FROM aggregated_schemas WHERE session_id = ?`,
      )
      .get(sessionId) as { max_snapshot: number | null } | undefined;

    return row?.max_snapshot ?? 0;
  }

  /**
   * Returns all aggregated schemas for a specific snapshot of a session.
   */
  listBySessionSnapshot(sessionId: string, snapshot: number): AggregatedSchema[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM aggregated_schemas
         WHERE session_id = ? AND snapshot = ?
         ORDER BY path ASC, http_method ASC`,
      )
      .all(sessionId, snapshot) as AggregatedSchemaRow[];

    return rows.map(rowToAggregatedSchema);
  }

  /**
   * Returns schemas for the latest snapshot of a session.
   */
  listBySessionLatestSnapshot(sessionId: string): AggregatedSchema[] {
    const maxSnapshot = this.getMaxSnapshotForSession(sessionId);
    if (maxSnapshot === 0) return [];
    return this.listBySessionSnapshot(sessionId, maxSnapshot);
  }

  /**
   * Deletes all aggregated schemas for a specific snapshot of a session.
   */
  /**
   * Returns distinct snapshot numbers for a session with summary stats.
   */
  listSnapshotsForSession(
    sessionId: string,
  ): Array<{ snapshot: number; endpointCount: number; sampleCount: number; avgConfidence: number; createdAt: string }> {
    const rows = this.db
      .prepare(
        `SELECT snapshot,
                COUNT(*) as endpoint_count,
                SUM(sample_count) as total_samples,
                AVG(confidence_score) as avg_confidence,
                MAX(created_at) as created_at
         FROM aggregated_schemas
         WHERE session_id = ?
         GROUP BY snapshot
         ORDER BY snapshot ASC`,
      )
      .all(sessionId) as Array<{
        snapshot: number;
        endpoint_count: number;
        total_samples: number;
        avg_confidence: number;
        created_at: string;
      }>;

    return rows.map((r) => ({
      snapshot: r.snapshot,
      endpointCount: r.endpoint_count,
      sampleCount: r.total_samples,
      avgConfidence: r.avg_confidence,
      createdAt: r.created_at,
    }));
  }

  deleteBySessionSnapshot(sessionId: string, snapshot: number): void {
    this.db
      .prepare(`DELETE FROM aggregated_schemas WHERE session_id = ? AND snapshot = ?`)
      .run(sessionId, snapshot);
  }
}
