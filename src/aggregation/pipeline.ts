/**
 * Aggregation pipeline — groups, merges, and scores samples.
 *
 * Steps:
 *   1. groupSamples: Group by (method, normalizedPath, statusCode)
 *   2. mergeGroupSchemas: Merge all schemas in a group into a single consensus schema
 *   3. calculateRequiredFields: Mark fields present in 100% of samples as required
 *   4. mergeHeaders: Deduplicate headers across samples
 *   5. Collapse status codes: one row per (method, path) with response_schemas map
 */

import type { Sample, InferredSchema, HeaderEntry, AggregatedSchema } from '../types/index.js';
import type { Database } from '../storage/database.js';
import { mergeSchemas } from '../inference/merge.js';
import { calculateSchemaConfidence } from './confidence.js';
import { detectBreakingChanges } from './diff.js';
import { SampleRepository } from '../storage/samples.js';
import { SessionRepository } from '../storage/sessions.js';
import { AggregatedSchemaRepository } from '../storage/schemas.js';

// ============================================================
// Task 4.1 — Sample Grouping
// ============================================================

/**
 * Group samples by their canonical endpoint key: "METHOD /normalizedPath STATUS_CODE".
 * Samples with undefined status code are grouped under status code "0".
 *
 * @param samples - Array of samples to group
 * @returns Map from group key to samples in that group
 */
export function groupSamples(samples: Sample[]): Map<string, Sample[]> {
  const groups = new Map<string, Sample[]>();

  for (const sample of samples) {
    const statusCode = sample.statusCode ?? 0;
    const key = `${sample.httpMethod.toUpperCase()} ${sample.normalizedPath} ${statusCode}`;

    const existing = groups.get(key);
    if (existing !== undefined) {
      existing.push(sample);
    } else {
      groups.set(key, [sample]);
    }
  }

  return groups;
}

// ============================================================
// Task 4.2 — Multi-Sample Schema Merging
// ============================================================

/**
 * Count how many samples in the group have a given field path present in their request schema.
 * This tracks presence at the top level only (nested tracking is deferred to stats).
 */
function countFieldPresence(
  samples: Sample[],
  fieldName: string,
  getSchema: (s: Sample) => InferredSchema | undefined,
): number {
  let count = 0;
  for (const sample of samples) {
    const schema = getSchema(sample);
    if (schema?.type === 'object' && schema.properties !== undefined) {
      if (fieldName in schema.properties) {
        count++;
      }
    }
  }
  return count;
}

/**
 * Fix field statistics after merging by counting actual field presence
 * across original samples (not from merged schema).
 *
 * The merge operation sums stats, but we need accurate per-field presence counts
 * relative to the total number of samples in this group.
 */
function fixFieldStats(
  mergedSchema: InferredSchema,
  samples: Sample[],
  getSchema: (s: Sample) => InferredSchema | undefined,
): InferredSchema {
  const totalSamples = samples.length;

  if (mergedSchema.type !== 'object' || mergedSchema.properties === undefined) {
    // For non-object schemas, fix the top-level stats
    return {
      ...mergedSchema,
      stats: {
        sampleCount: totalSamples,
        presenceCount: totalSamples,
        confidence: 1.0,
      },
    };
  }

  // Fix each property's stats based on actual presence count
  const fixedProperties: Record<string, InferredSchema> = {};
  for (const [fieldName, fieldSchema] of Object.entries(mergedSchema.properties)) {
    const presenceCount = countFieldPresence(samples, fieldName, getSchema);
    const confidence = totalSamples > 0 ? presenceCount / totalSamples : 0;

    // Get the samples that actually had this field, for recursion
    const samplesWithField = samples.filter((s) => {
      const schema = getSchema(s);
      return (
        schema?.type === 'object' &&
        schema.properties !== undefined &&
        fieldName in schema.properties
      );
    });

    // Recursively fix nested object stats if applicable
    let fixedFieldSchema = fieldSchema;
    if (
      fieldSchema.type === 'object' &&
      fieldSchema.properties !== undefined &&
      samplesWithField.length > 0
    ) {
      fixedFieldSchema = fixFieldStats(
        fieldSchema,
        samplesWithField,
        (s) => {
          const parentSchema = getSchema(s);
          return parentSchema?.properties?.[fieldName];
        },
      );
    }

    fixedProperties[fieldName] = {
      ...fixedFieldSchema,
      stats: {
        sampleCount: totalSamples,
        presenceCount,
        confidence,
      },
    };
  }

  return {
    ...mergedSchema,
    properties: fixedProperties,
    stats: {
      sampleCount: totalSamples,
      presenceCount: totalSamples,
      confidence: 1.0,
    },
  };
}

/**
 * Merge all request and response schemas from a group of samples into
 * a single consensus schema per direction.
 *
 * @param samples - All samples in a single group (same method+path+statusCode)
 * @returns Merged request schema and response schema (both optional)
 */
export function mergeGroupSchemas(samples: Sample[]): {
  requestSchema?: InferredSchema;
  responseSchema?: InferredSchema;
} {
  if (samples.length === 0) {
    return {};
  }

  // Merge request schemas
  let requestSchema: InferredSchema | undefined;
  for (const sample of samples) {
    if (sample.requestSchema !== undefined) {
      if (requestSchema === undefined) {
        requestSchema = sample.requestSchema;
      } else {
        requestSchema = mergeSchemas(requestSchema, sample.requestSchema);
      }
    }
  }

  // Merge response schemas
  let responseSchema: InferredSchema | undefined;
  for (const sample of samples) {
    if (sample.responseSchema !== undefined) {
      if (responseSchema === undefined) {
        responseSchema = sample.responseSchema;
      } else {
        responseSchema = mergeSchemas(responseSchema, sample.responseSchema);
      }
    }
  }

  // Fix field stats based on actual presence in original samples
  if (requestSchema !== undefined) {
    requestSchema = fixFieldStats(requestSchema, samples, (s) => s.requestSchema);
  }
  if (responseSchema !== undefined) {
    responseSchema = fixFieldStats(responseSchema, samples, (s) => s.responseSchema);
  }

  return { requestSchema, responseSchema };
}

// ============================================================
// Task 4.3 — Required Field Calculation
// ============================================================

/**
 * Recursively calculate required fields for a schema.
 * A field is required if its presenceCount equals totalSamples (100% presence).
 *
 * Modifies the schema in-place and returns it.
 *
 * @param schema - The schema to update
 * @param totalSamples - Total samples for this group
 * @returns Schema with required arrays populated
 */
export function calculateRequiredFields(
  schema: InferredSchema,
  totalSamples: number,
  httpMethod?: string,
): InferredSchema {
  if (schema.type !== 'object' || schema.properties === undefined) {
    return schema;
  }

  // For PATCH requests, no fields should be required (partial update semantics)
  const isPatch = httpMethod !== undefined && httpMethod.toUpperCase() === 'PATCH';

  const required: string[] = [];

  const updatedProperties: Record<string, InferredSchema> = {};
  for (const [fieldName, fieldSchema] of Object.entries(schema.properties)) {
    // A field is required if it was present in 100% of samples
    // (but never for PATCH requests — partial update semantics)
    if (!isPatch && fieldSchema.stats.presenceCount === totalSamples) {
      required.push(fieldName);
    }

    // Recurse into nested objects (pass httpMethod to propagate PATCH semantics)
    let updatedFieldSchema = fieldSchema;
    if (fieldSchema.type === 'object' && fieldSchema.properties !== undefined) {
      // For nested objects, use the field's presenceCount as the total
      // (only samples that had this field count toward nested required)
      updatedFieldSchema = calculateRequiredFields(
        fieldSchema,
        fieldSchema.stats.presenceCount,
        httpMethod,
      );
    } else if (fieldSchema.type === 'array' && fieldSchema.items !== undefined) {
      const updatedItems = calculateRequiredFields(fieldSchema.items, totalSamples, httpMethod);
      updatedFieldSchema = { ...fieldSchema, items: updatedItems };
    }

    updatedProperties[fieldName] = updatedFieldSchema;
  }

  // Sort required fields alphabetically (per spec)
  required.sort();

  return {
    ...schema,
    properties: updatedProperties,
    required,
  };
}

// ============================================================
// Enum Inference
// ============================================================

/**
 * Recursively walk a schema and promote string fields with low cardinality
 * to enum constraints. A field qualifies if:
 *   - It has _observedValues with ≤10 distinct values
 *   - totalSamples ≥ 10
 *
 * After processing, _observedValues is cleared (it's internal tracking only).
 *
 * @param schema - The schema to process
 * @param totalSamples - Total samples for this endpoint group
 * @returns Schema with enum annotations and _observedValues stripped
 */
export function inferEnums(schema: InferredSchema, totalSamples: number): InferredSchema {
  // Handle oneOf: recurse into each variant
  if (schema.oneOf !== undefined) {
    return {
      ...schema,
      oneOf: schema.oneOf.map((v) => inferEnums(v, totalSamples)),
      _observedValues: undefined,
    };
  }

  // String leaf: check for enum promotion
  if (schema.type === 'string') {
    const result = { ...schema };
    if (
      result._observedValues !== undefined &&
      result._observedValues.length > 0 &&
      totalSamples >= 10
    ) {
      const unique = [...new Set(result._observedValues)];
      if (unique.length <= 10) {
        result.enum = unique.sort();
      }
    }
    delete result._observedValues;
    return result;
  }

  // Object: recurse into properties
  if (schema.type === 'object' && schema.properties !== undefined) {
    const updatedProperties: Record<string, InferredSchema> = {};
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      updatedProperties[key] = inferEnums(propSchema, totalSamples);
    }
    return { ...schema, properties: updatedProperties };
  }

  // Array: recurse into items
  if (schema.type === 'array' && schema.items !== undefined) {
    return { ...schema, items: inferEnums(schema.items, totalSamples) };
  }

  return schema;
}

// ============================================================
// Task 4.5 — Header Merging
// ============================================================

/**
 * Merge arrays of headers from multiple samples into a deduplicated list.
 * - Deduplicates by name (case-insensitive)
 * - Keeps the first example value seen for each header name
 * - Sorts alphabetically by header name
 * - Returns undefined for empty results
 *
 * @param headerArrays - Arrays of headers from each sample
 * @returns Deduplicated, sorted header list, or undefined if empty
 */
export function mergeHeaders(
  headerArrays: (HeaderEntry[] | undefined)[],
): HeaderEntry[] | undefined {
  // Map from lowercase name to the first HeaderEntry seen
  const seen = new Map<string, HeaderEntry>();

  for (const headers of headerArrays) {
    if (headers === undefined) continue;
    for (const header of headers) {
      const lowerName = header.name.toLowerCase();
      if (!seen.has(lowerName)) {
        seen.set(lowerName, header);
      }
    }
  }

  if (seen.size === 0) return undefined;

  // Sort alphabetically by the original header name (case-insensitive)
  return Array.from(seen.values()).sort((a, b) =>
    a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
  );
}

// ============================================================
// Task — Query Parameter Merging
// ============================================================

/**
 * Merge query parameters from multiple samples into a map of param name → unique observed values.
 * Returns undefined if no query params found across any sample.
 */
export function mergeQueryParams(samples: Sample[]): Record<string, string[]> | undefined {
  const paramMap = new Map<string, Set<string>>();

  for (const sample of samples) {
    if (sample.queryParams === undefined) continue;
    for (const [name, value] of Object.entries(sample.queryParams)) {
      let valueSet = paramMap.get(name);
      if (valueSet === undefined) {
        valueSet = new Set<string>();
        paramMap.set(name, valueSet);
      }
      valueSet.add(value);
    }
  }

  if (paramMap.size === 0) return undefined;

  const result: Record<string, string[]> = {};
  for (const [name, values] of paramMap) {
    result[name] = Array.from(values).sort();
  }
  return result;
}

// ============================================================
// Task — Path Parameter Value Collection
// ============================================================

/**
 * Extract path parameter values by comparing raw paths against the normalized template.
 * e.g., raw="/users/123/orders/456", template="/users/{userId}/orders/{orderId}"
 * → { userId: ["123"], orderId: ["456"] }
 *
 * @param samples - Samples sharing the same normalized path
 * @returns Map of param name → unique observed values, or undefined if no path params
 */
export function collectPathParamValues(samples: Sample[]): Record<string, string[]> | undefined {
  if (samples.length === 0) return undefined;

  const template = samples[0].normalizedPath;
  const templateSegments = template.split('/');

  // Find param positions: indices where segment matches {paramName}
  const paramPositions: Array<{ index: number; name: string }> = [];
  for (let i = 0; i < templateSegments.length; i++) {
    const seg = templateSegments[i];
    const match = /^\{(.+)\}$/.exec(seg);
    if (match) {
      paramPositions.push({ index: i, name: match[1] });
    }
  }

  if (paramPositions.length === 0) return undefined;

  const paramValues = new Map<string, Set<string>>();
  for (const { name } of paramPositions) {
    paramValues.set(name, new Set<string>());
  }

  for (const sample of samples) {
    // Strip query string from raw path
    const rawPath = sample.path.split('?')[0];
    const rawSegments = rawPath.split('/');

    if (rawSegments.length !== templateSegments.length) continue;

    for (const { index, name } of paramPositions) {
      const value = rawSegments[index];
      if (value !== undefined && value.length > 0) {
        paramValues.get(name)!.add(value);
      }
    }
  }

  const result: Record<string, string[]> = {};
  for (const [name, values] of paramValues) {
    result[name] = Array.from(values).sort();
  }
  return result;
}

// ============================================================
// Response Shape Fingerprinting
// ============================================================

/**
 * Compute a fingerprint string for a response schema based on its structural shape.
 * Two schemas with the same field names and types (recursively) produce the same fingerprint.
 * This ignores stats, format, required, enum — only structure matters.
 */
export function computeSchemaFingerprint(schema: InferredSchema | undefined): string {
  if (schema === undefined) return '<empty>';

  if (schema.oneOf !== undefined) {
    const variants = schema.oneOf.map(computeSchemaFingerprint).sort();
    return `oneOf(${variants.join('|')})`;
  }

  if (schema.type === 'object' && schema.properties !== undefined) {
    const fields = Object.keys(schema.properties).sort();
    const parts = fields.map((f) => `${f}:${computeSchemaFingerprint(schema.properties![f])}`);
    return `{${parts.join(',')}}`;
  }

  if (schema.type === 'array' && schema.items !== undefined) {
    return `[${computeSchemaFingerprint(schema.items)}]`;
  }

  return schema.type;
}

/**
 * Count unique response schema shapes across samples for an endpoint.
 * Each sample's response schema is fingerprinted and deduplicated.
 */
export function countUniqueResponseShapes(samples: Sample[]): number {
  const fingerprints = new Set<string>();
  for (const sample of samples) {
    fingerprints.add(computeSchemaFingerprint(sample.responseSchema));
  }
  return fingerprints.size;
}

// ============================================================
// Task 4.8 — Pipeline Orchestrator
// ============================================================

export interface AggregationResult {
  schemas: AggregatedSchema[];
  sampleCount: number;
}

/**
 * Run the full aggregation pipeline for a session.
 *
 * Steps:
 *   1. Transition session to 'aggregating'
 *   2. Load all samples for the session
 *   3. Group by (method, path, statusCode)
 *   4. Merge schemas per group
 *   5. Calculate required fields
 *   6. Collapse status codes into one row per (method, path)
 *   7. Compute confidence scores
 *   8. Detect breaking changes vs previous session
 *   9. Store aggregated schemas
 *   10. Transition session to 'completed'
 */
export function runAggregation(db: Database.Database, sessionId: string): AggregationResult {
  const sessions = new SessionRepository(db);
  const sampleRepo = new SampleRepository(db);
  const schemaRepo = new AggregatedSchemaRepository(db);

  const session = sessions.getSession(sessionId);
  if (!session) throw new Error(`Session '${sessionId}' not found`);

  // Transition to aggregating
  if (session.status === 'active') {
    sessions.updateSessionStatus(sessionId, 'aggregating');
  }

  try {
    const allSamples = sampleRepo.listBySession(sessionId);
    if (allSamples.length === 0) {
      sessions.updateSessionStatus(sessionId, 'completed');
      return { schemas: [], sampleCount: 0 };
    }

    // Group by method + normalizedPath + statusCode
    const groups = groupSamples(allSamples);

    // Per-status-code schema merging
    // Key: "METHOD /path" → { statusCode → { requestSchema, responseSchema, headers, samples } }
    const endpointMap = new Map<
      string,
      {
        method: string;
        path: string;
        statusGroups: Map<
          string,
          {
            requestSchema?: InferredSchema;
            responseSchema?: InferredSchema;
            samples: Sample[];
          }
        >;
        allSamples: Sample[];
        requestHeaders: (HeaderEntry[] | undefined)[];
        responseHeaders: (HeaderEntry[] | undefined)[];
      }
    >();

    for (const [key, samples] of groups) {
      const parts = key.split(' ');
      const method = parts[0];
      const path = parts[1];
      const statusCode = parts[2];
      const endpointKey = `${method} ${path}`;

      if (!endpointMap.has(endpointKey)) {
        endpointMap.set(endpointKey, {
          method,
          path,
          statusGroups: new Map(),
          allSamples: [],
          requestHeaders: [],
          responseHeaders: [],
        });
      }

      const endpoint = endpointMap.get(endpointKey)!;
      endpoint.allSamples.push(...samples);

      // Merge schemas for this status code group
      const merged = mergeGroupSchemas(samples);
      endpoint.statusGroups.set(statusCode, {
        requestSchema: merged.requestSchema,
        responseSchema: merged.responseSchema,
        samples,
      });

      // Collect headers
      for (const s of samples) {
        endpoint.requestHeaders.push(s.requestHeaders);
        endpoint.responseHeaders.push(s.responseHeaders);
      }
    }

    // Collapse into one aggregated schema per (method, path)
    const aggregated: AggregatedSchema[] = [];
    const now = new Date().toISOString();

    for (const [, endpoint] of endpointMap) {
      // Merge request schemas across all status codes (usually same)
      let requestSchema: InferredSchema | undefined;
      for (const [, group] of endpoint.statusGroups) {
        if (group.requestSchema !== undefined) {
          if (requestSchema === undefined) {
            requestSchema = group.requestSchema;
          } else {
            requestSchema = mergeSchemas(requestSchema, group.requestSchema);
          }
        }
      }

      // Calculate required fields on request schema
      // Pass HTTP method so PATCH requests get no required fields (partial update semantics)
      if (requestSchema) {
        requestSchema = calculateRequiredFields(
          requestSchema,
          endpoint.allSamples.length,
          endpoint.method,
        );
        requestSchema = inferEnums(requestSchema, endpoint.allSamples.length);
      }

      // Build response_schemas map: statusCode → schema
      const responseSchemas: Record<string, InferredSchema> = {};
      for (const [statusCode, group] of endpoint.statusGroups) {
        if (group.responseSchema !== undefined) {
          let withRequired = calculateRequiredFields(
            group.responseSchema,
            group.samples.length,
          );
          withRequired = inferEnums(withRequired, group.samples.length);
          responseSchemas[statusCode] = withRequired;
        }
      }

      // Merge headers
      const mergedRequestHeaders = mergeHeaders(endpoint.requestHeaders);
      const mergedResponseHeaders = mergeHeaders(endpoint.responseHeaders);

      // Merge query parameters
      const queryParams = mergeQueryParams(endpoint.allSamples);

      // Collect path parameter values for type inference
      const pathParamValues = collectPathParamValues(endpoint.allSamples);

      // Count unique response shapes for completeness indicator
      const uniqueResponseShapes = countUniqueResponseShapes(endpoint.allSamples);

      // Compute confidence from a representative response schema
      const primaryResponseSchema = Object.values(responseSchemas)[0];
      const schemaForConfidence = primaryResponseSchema ?? requestSchema;
      const confidenceScore = schemaForConfidence
        ? calculateSchemaConfidence(schemaForConfidence, endpoint.allSamples.length)
        : 0;

      // Detect breaking changes vs previous session
      const previous = schemaRepo.getLatestForEndpoint(endpoint.method, endpoint.path);
      let breakingChanges = undefined;
      let previousSessionId = undefined;
      let version = 1;

      if (previous && previous.sessionId !== sessionId) {
        previousSessionId = previous.sessionId;
        version = previous.version + 1;

        // Compare response schemas
        const oldResponseSchema = previous.responseSchemas
          ? Object.values(previous.responseSchemas)[0]
          : undefined;
        const newResponseSchema = primaryResponseSchema;

        if (oldResponseSchema && newResponseSchema) {
          const diff = detectBreakingChanges(oldResponseSchema, newResponseSchema);
          if (diff.breakingChanges.length > 0) {
            breakingChanges = diff.breakingChanges;
          }
        }
      }

      // Timestamps — linear scan for min/max
      let firstObserved = endpoint.allSamples[0].capturedAt;
      let lastObserved = firstObserved;
      for (let i = 1; i < endpoint.allSamples.length; i++) {
        const t = endpoint.allSamples[i].capturedAt;
        if (t < firstObserved) firstObserved = t;
        if (t > lastObserved) lastObserved = t;
      }

      // Store
      const id = schemaRepo.insertAggregated({
        sessionId,
        httpMethod: endpoint.method,
        path: endpoint.path,
        version,
        requestSchema: requestSchema ?? undefined,
        responseSchemas: Object.keys(responseSchemas).length > 0 ? responseSchemas : undefined,
        requestHeaders: mergedRequestHeaders,
        responseHeaders: mergedResponseHeaders,
        queryParams,
        pathParamValues,
        uniqueResponseShapes,
        sampleCount: endpoint.allSamples.length,
        confidenceScore,
        breakingChanges,
        previousSessionId,
        firstObserved,
        lastObserved,
        createdAt: now,
      });

      aggregated.push({
        id,
        sessionId,
        httpMethod: endpoint.method,
        path: endpoint.path,
        version,
        requestSchema,
        responseSchemas: Object.keys(responseSchemas).length > 0 ? responseSchemas : undefined,
        requestHeaders: mergedRequestHeaders,
        responseHeaders: mergedResponseHeaders,
        queryParams,
        pathParamValues,
        uniqueResponseShapes,
        sampleCount: endpoint.allSamples.length,
        confidenceScore,
        breakingChanges,
        previousSessionId,
        firstObserved,
        lastObserved,
      });
    }

    // Transition to completed
    sessions.updateSessionStatus(sessionId, 'completed');

    return { schemas: aggregated, sampleCount: allSamples.length };
  } catch (err) {
    // Transition to failed
    try {
      sessions.updateSessionStatus(
        sessionId,
        'failed',
        err instanceof Error ? err.message : 'Unknown error',
      );
    } catch {
      // ignore — session might already be in failed state
    }
    throw err;
  }
}
