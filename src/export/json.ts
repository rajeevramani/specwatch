/**
 * Raw JSON export for aggregated schemas.
 *
 * Used when `specwatch export --format json` is requested.
 * Serializes the raw aggregated schemas (not OpenAPI format) to JSON.
 */

import type { AggregatedSchema } from '../types/index.js';

/**
 * Serialize a plain object to JSON with 2-space indentation.
 * No trailing newline is added.
 *
 * @param data - Data to serialize
 * @returns JSON string with 2-space indentation
 */
export function serializeJson(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

/**
 * Build a raw JSON export structure from aggregated schemas.
 * This is format-agnostic (not OpenAPI) and includes all internal metadata.
 *
 * @param schemas - Aggregated schemas to export
 * @returns Plain object ready for JSON serialization
 */
export function buildJsonExport(schemas: AggregatedSchema[]): Record<string, unknown> {
  return {
    schemas: schemas.map((schema) => ({
      id: schema.id,
      sessionId: schema.sessionId,
      httpMethod: schema.httpMethod,
      path: schema.path,
      version: schema.version,
      sampleCount: schema.sampleCount,
      confidenceScore: schema.confidenceScore,
      requestSchema: schema.requestSchema,
      responseSchemas: schema.responseSchemas,
      requestHeaders: schema.requestHeaders,
      responseHeaders: schema.responseHeaders,
      breakingChanges: schema.breakingChanges,
      firstObserved: schema.firstObserved,
      lastObserved: schema.lastObserved,
    })),
  };
}
