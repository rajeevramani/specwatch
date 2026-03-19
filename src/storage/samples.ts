/**
 * Sample repository — CRUD for individual request/response schema observations.
 * JSON fields are serialized at the repository boundary; callers receive typed objects.
 */
import type Database from 'better-sqlite3';
import type { Sample, InferredSchema, HeaderEntry } from '../types/index.js';

// ---------------------------------------------------------------------------
// Row type returned by better-sqlite3
// ---------------------------------------------------------------------------

interface SampleRow {
  id: number;
  session_id: string;
  http_method: string;
  path: string;
  normalized_path: string;
  status_code: number | null;
  query_params: string | null;
  request_schema: string | null;
  response_schema: string | null;
  request_headers: string | null;
  response_headers: string | null;
  captured_at: string;
  jsonrpc_method: string | null;
  jsonrpc_tool: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Maps a database row to the Sample domain type, deserializing JSON fields. */
function rowToSample(row: SampleRow): Sample {
  return {
    id: row.id,
    sessionId: row.session_id,
    httpMethod: row.http_method,
    path: row.path,
    normalizedPath: row.normalized_path,
    statusCode: row.status_code ?? undefined,
    queryParams: row.query_params
      ? (JSON.parse(row.query_params) as Record<string, string>)
      : undefined,
    requestSchema: row.request_schema
      ? (JSON.parse(row.request_schema) as InferredSchema)
      : undefined,
    responseSchema: row.response_schema
      ? (JSON.parse(row.response_schema) as InferredSchema)
      : undefined,
    requestHeaders: row.request_headers
      ? (JSON.parse(row.request_headers) as HeaderEntry[])
      : undefined,
    responseHeaders: row.response_headers
      ? (JSON.parse(row.response_headers) as HeaderEntry[])
      : undefined,
    capturedAt: row.captured_at,
    jsonrpcMethod: row.jsonrpc_method ?? undefined,
    jsonrpcTool: row.jsonrpc_tool ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// SampleRepository
// ---------------------------------------------------------------------------

/** Input type for inserting a sample (id is auto-assigned by SQLite). */
export type InsertSampleInput = Omit<Sample, 'id'>;

/**
 * Repository for sample (request/response observation) storage.
 * All methods are synchronous.
 */
export class SampleRepository {
  constructor(private readonly db: Database.Database) {}

  /**
   * Inserts a sample and returns its auto-assigned id.
   * JSON fields (schemas, headers, queryParams) are serialized automatically.
   */
  insertSample(sample: InsertSampleInput): number {
    const result = this.db
      .prepare(
        `INSERT INTO samples
           (session_id, http_method, path, normalized_path, status_code,
            query_params, request_schema, response_schema,
            request_headers, response_headers, captured_at,
            jsonrpc_method, jsonrpc_tool)
         VALUES
           (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sample.sessionId,
        sample.httpMethod,
        sample.path,
        sample.normalizedPath,
        sample.statusCode ?? null,
        sample.queryParams != null ? JSON.stringify(sample.queryParams) : null,
        sample.requestSchema != null ? JSON.stringify(sample.requestSchema) : null,
        sample.responseSchema != null ? JSON.stringify(sample.responseSchema) : null,
        sample.requestHeaders != null ? JSON.stringify(sample.requestHeaders) : null,
        sample.responseHeaders != null ? JSON.stringify(sample.responseHeaders) : null,
        sample.capturedAt,
        sample.jsonrpcMethod ?? null,
        sample.jsonrpcTool ?? null,
      );

    return result.lastInsertRowid as number;
  }

  /**
   * Returns all samples for a given session, ordered by captured_at ascending.
   */
  listBySession(sessionId: string): Sample[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM samples WHERE session_id = ? ORDER BY captured_at ASC`,
      )
      .all(sessionId) as SampleRow[];

    return rows.map(rowToSample);
  }

  /**
   * Returns all samples for a specific endpoint within a session.
   */
  listByEndpoint(sessionId: string, method: string, normalizedPath: string): Sample[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM samples
         WHERE session_id = ? AND http_method = ? AND normalized_path = ?
         ORDER BY captured_at ASC`,
      )
      .all(sessionId, method, normalizedPath) as SampleRow[];

    return rows.map(rowToSample);
  }

  /**
   * Returns all samples for a specific JSON-RPC method within a session.
   */
  listByJsonRpcMethod(sessionId: string, jsonrpcMethod: string): Sample[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM samples
         WHERE session_id = ? AND jsonrpc_method = ?
         ORDER BY captured_at ASC`,
      )
      .all(sessionId, jsonrpcMethod) as SampleRow[];

    return rows.map(rowToSample);
  }

  /**
   * Groups all samples for a session by "METHOD /path STATUS_CODE".
   * Returns a Map keyed by that composite string.
   */
  groupByEndpoint(sessionId: string): Map<string, Sample[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM samples WHERE session_id = ? ORDER BY captured_at ASC`,
      )
      .all(sessionId) as SampleRow[];

    const grouped = new Map<string, Sample[]>();
    for (const row of rows) {
      const sample = rowToSample(row);
      const key = `${sample.httpMethod} ${sample.normalizedPath} ${sample.statusCode ?? 'unknown'}`;
      const existing = grouped.get(key);
      if (existing) {
        existing.push(sample);
      } else {
        grouped.set(key, [sample]);
      }
    }

    return grouped;
  }

  /**
   * Returns the number of samples for a given session.
   */
  countBySession(sessionId: string): number {
    const result = this.db
      .prepare(`SELECT COUNT(*) as count FROM samples WHERE session_id = ?`)
      .get(sessionId) as { count: number };

    return result.count;
  }
}
