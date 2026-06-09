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
// Path Unification
// ============================================================

interface EndpointEntry {
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

/**
 * Pluralized parent segment → singular + Id.
 * "owners" → "ownerId", "users" → "userId", "events" → "eventId".
 * Falls back to "{parent}Id" if the parent isn't a known plural.
 */
function paramNameFromParent(parent: string): string {
  const lower = parent.toLowerCase();
  let singular = lower;
  // Reuse a small subset of the plural map from path-normalizer for parent→singular
  if (lower.endsWith('ies') && lower.length > 3) singular = lower.slice(0, -3) + 'y';
  else if (lower.endsWith('ses') && lower.length > 3) singular = lower.slice(0, -2);
  else if (lower.endsWith('s') && lower.length > 2) singular = lower.slice(0, -1);
  return singular + 'Id';
}

/**
 * Merge endpoint entry `from` into `into`. Combines status groups, samples,
 * headers. Used during path unification.
 */
function mergeEndpointEntry(into: EndpointEntry, from: EndpointEntry): void {
  for (const [statusCode, fromGroup] of from.statusGroups) {
    const intoGroup = into.statusGroups.get(statusCode);
    if (intoGroup === undefined) {
      into.statusGroups.set(statusCode, fromGroup);
    } else {
      // Merge schemas
      if (fromGroup.requestSchema !== undefined) {
        intoGroup.requestSchema =
          intoGroup.requestSchema === undefined
            ? fromGroup.requestSchema
            : mergeSchemas(intoGroup.requestSchema, fromGroup.requestSchema);
      }
      if (fromGroup.responseSchema !== undefined) {
        intoGroup.responseSchema =
          intoGroup.responseSchema === undefined
            ? fromGroup.responseSchema
            : mergeSchemas(intoGroup.responseSchema, fromGroup.responseSchema);
      }
      intoGroup.samples = intoGroup.samples.concat(fromGroup.samples);
    }
  }
  into.allSamples = into.allSamples.concat(from.allSamples);
  into.requestHeaders = into.requestHeaders.concat(from.requestHeaders);
  into.responseHeaders = into.responseHeaders.concat(from.responseHeaders);
}

/**
 * Pick a representative 2xx response schema for fingerprint-based comparison.
 * Returns undefined if the entry has no 2xx responses at all.
 */
function pick2xxResponseSchema(entry: EndpointEntry): InferredSchema | undefined {
  for (const [statusCode, group] of entry.statusGroups) {
    const code = parseInt(statusCode, 10);
    if (code >= 200 && code < 300 && group.responseSchema !== undefined) {
      return group.responseSchema;
    }
  }
  return undefined;
}

/**
 * Unify sibling endpoint paths whose differing leaf segment looks like a value
 * for the same parameter. Two cases:
 *
 *   1. **Fold-into-existing-param**: a parameterized sibling already exists
 *      (e.g. /pets/{petId}) and the literal-leaf endpoint (e.g. /pets/abc)
 *      has only 4xx/5xx responses — likely an invalid call to the same
 *      endpoint. Fold the literal into the param sibling.
 *
 *   2. **Parameterize-by-shape-match**: no param sibling exists, but ≥2
 *      literal siblings share the same 2xx response shape (e.g.
 *      /owners/owner_alice and /owners/owner_bob both return Owner). Unify
 *      them under a parameterized path derived from the parent segment.
 *
 * Modifies `endpointMap` in place. Path normalization at sample-capture time
 * is per-path; unification is the cross-path pass that finishes the job.
 */
export function unifyEndpointPaths(endpointMap: Map<string, EndpointEntry>): void {
  // Group entries by (method, parent path). Parent = path with last segment removed.
  const groupsByParent = new Map<string, Array<{ key: string; entry: EndpointEntry }>>();
  for (const [key, entry] of endpointMap) {
    const segments = entry.path.split('/');
    if (segments.length < 3) continue; // need at least /parent/leaf
    const lastSeg = segments[segments.length - 1];
    const parentPath = segments.slice(0, -1).join('/');
    const groupKey = `${entry.method} ${parentPath}`;
    if (!groupsByParent.has(groupKey)) groupsByParent.set(groupKey, []);
    groupsByParent.get(groupKey)!.push({ key, entry });
    void lastSeg; // referenced below per-group
  }

  for (const members of groupsByParent.values()) {
    if (members.length < 2) continue;

    // Identify any already-parameterized member (last segment is {param})
    const paramMember = members.find(({ entry }) => {
      const last = entry.path.split('/').pop()!;
      return last.startsWith('{') && last.endsWith('}');
    });

    if (paramMember !== undefined) {
      // Case 1: fold literal-leaf siblings into the param member when they
      // have no 2xx responses (i.e. they're invalid-input calls to the same
      // logical endpoint).
      for (const { key, entry } of members) {
        if (entry === paramMember.entry) continue;
        const last = entry.path.split('/').pop()!;
        if (last.startsWith('{')) continue; // already a different param
        const has2xx = Array.from(entry.statusGroups.keys()).some((sc) => {
          const code = parseInt(sc, 10);
          return code >= 200 && code < 300;
        });
        if (has2xx) continue; // legitimate distinct endpoint, leave alone
        mergeEndpointEntry(paramMember.entry, entry);
        endpointMap.delete(key);
      }
      continue;
    }

    // Case 2: no param sibling — partition literal members by 2xx response
    // fingerprint. Members in the same partition share a response shape and
    // should unify under a parameterized path.
    const literalMembers = members.filter(({ entry }) => {
      const last = entry.path.split('/').pop()!;
      return !(last.startsWith('{') && last.endsWith('}'));
    });
    if (literalMembers.length < 2) continue;

    const byShape = new Map<string, Array<{ key: string; entry: EndpointEntry }>>();
    for (const m of literalMembers) {
      const responseSchema = pick2xxResponseSchema(m.entry);
      if (responseSchema === undefined) continue; // need a 2xx shape to unify on
      const fp = computeSchemaFingerprint(responseSchema);
      if (!byShape.has(fp)) byShape.set(fp, []);
      byShape.get(fp)!.push(m);
    }

    for (const partition of byShape.values()) {
      if (partition.length < 2) continue;

      // Unified path: replace last segment with a parameter named from parent
      const firstSegments = partition[0].entry.path.split('/');
      const parentSeg = firstSegments[firstSegments.length - 2];
      const paramName = paramNameFromParent(parentSeg);

      const unifiedSegments = firstSegments.slice(0, -1).concat(`{${paramName}}`);
      const unifiedPath = unifiedSegments.join('/');
      const newKey = `${partition[0].entry.method} ${unifiedPath}`;

      // Build merged entry from partition[0], then fold the rest in
      const merged: EndpointEntry = {
        method: partition[0].entry.method,
        path: unifiedPath,
        statusGroups: new Map(partition[0].entry.statusGroups),
        allSamples: [...partition[0].entry.allSamples],
        requestHeaders: [...partition[0].entry.requestHeaders],
        responseHeaders: [...partition[0].entry.responseHeaders],
      };
      for (let i = 1; i < partition.length; i++) {
        mergeEndpointEntry(merged, partition[i].entry);
      }

      // Remove originals; install unified
      for (const m of partition) endpointMap.delete(m.key);
      endpointMap.set(newKey, merged);
    }
  }
}

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

// Field names that almost never represent enums even with low observed cardinality.
// Used to suppress over-eager enum inference for IDs, names, versions, identifiers,
// free-text search inputs, and continuous numerics echoed as strings.
const NON_ENUM_FIELD_NAMES = new Set([
  'id',
  'name',
  'title',
  'description',
  'slug',
  'username',
  'firstname',
  'lastname',
  'fullname',
  'displayname',
  'email',
  'version',
  'sku',
  'code',
  'hash',
  'token',
  'secret',
  'apikey',
  'url',
  'uri',
  'href',
  'path',
  'message',
  'comment',
  'note',
  'bio',
  'summary',
  'label',
  // Free-text query inputs — almost always continuous, never enum
  'q',
  'query',
  'search',
  'filter',
  'term',
  'keyword',
  'keywords',
  // Numeric/quantitative — even when echoed as strings (e.g. query params)
  'price',
  'amount',
  'cost',
  'fee',
  'value',
  'total',
  'count',
  'size',
  'limit',
  'offset',
  'page',
  'minprice',
  'maxprice',
  'min',
  'max',
]);

const NON_ENUM_FIELD_SUFFIXES = [
  'id',
  '_id',
  'name',
  'url',
  'uri',
  'token',
  'hash',
  'code',
  'price',
  'amount',
  'cost',
  'fee',
  'value',
  'count',
  'size',
];

const UUID_LIKE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const SEMVER_LIKE = /^\d+\.\d+(\.\d+)?([-+]\S*)?$/;
const URL_LIKE = /^https?:\/\//i;
const PATH_LIKE = /^\/[\w-]/;
const HEX_LONG = /^[0-9a-f]{16,}$/i;

function fieldNameLooksNonEnum(fieldName: string): boolean {
  const lower = fieldName.toLowerCase();
  if (NON_ENUM_FIELD_NAMES.has(lower)) return true;
  return NON_ENUM_FIELD_SUFFIXES.some((suffix) => lower.endsWith(suffix) && lower !== suffix);
}

function valuesLookNonEnum(values: string[]): boolean {
  // If every value parses as a number, treat as continuous quantity rather than
  // enum. Catches numeric query params (price, count, etc.) echoed as strings.
  if (values.length > 0 && values.every((v) => v.length > 0 && !Number.isNaN(Number(v)))) {
    return true;
  }
  for (const v of values) {
    // Free-form text — enums are usually single tokens
    if (v.length > 32) return true;
    if (/\s/.test(v)) return true;
    // ID-like patterns
    if (UUID_LIKE.test(v)) return true;
    if (HEX_LONG.test(v)) return true;
    // Versions, URLs, paths
    if (SEMVER_LIKE.test(v)) return true;
    if (URL_LIKE.test(v)) return true;
    if (PATH_LIKE.test(v)) return true;
  }
  return false;
}

/**
 * Recursively walk a schema and promote string fields with low cardinality
 * to enum constraints. A field qualifies if:
 *   - It has _observedValues with ≤10 distinct values
 *   - totalSamples ≥ 10
 *   - Field name does not look like an identifier/name (id, name, sku, version, etc.)
 *   - Observed values do not look like UUIDs, URLs, paths, semver, or free text
 *
 * After processing, _observedValues is cleared (it's internal tracking only).
 *
 * @param schema - The schema to process
 * @param totalSamples - Total samples for this endpoint group
 * @param fieldName - Name of the property holding this schema (when applicable),
 *                    used for the field-name heuristic
 * @returns Schema with enum annotations and _observedValues stripped
 */
export function inferEnums(
  schema: InferredSchema,
  totalSamples: number,
  fieldName?: string,
): InferredSchema {
  // Handle oneOf: recurse into each variant
  if (schema.oneOf !== undefined) {
    return {
      ...schema,
      oneOf: schema.oneOf.map((v) => inferEnums(v, totalSamples, fieldName)),
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
      const fieldExempt = fieldName !== undefined && fieldNameLooksNonEnum(fieldName);
      if (unique.length <= 10 && !fieldExempt && !valuesLookNonEnum(unique)) {
        result.enum = unique.sort();
      }
    }
    delete result._observedValues;
    return result;
  }

  // Object: recurse into properties, passing each property name through
  if (schema.type === 'object' && schema.properties !== undefined) {
    const updatedProperties: Record<string, InferredSchema> = {};
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      updatedProperties[key] = inferEnums(propSchema, totalSamples, key);
    }
    return { ...schema, properties: updatedProperties };
  }

  // Array: recurse into items under the same property context.
  if (schema.type === 'array' && schema.items !== undefined) {
    return { ...schema, items: inferEnums(schema.items, totalSamples, fieldName) };
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
 * @param explicitTemplate - Override the template inferred from samples[0].normalizedPath.
 *                           Required when path unification has rewritten the endpoint
 *                           template (e.g. /owners/owner_alice + /owners/owner_bob →
 *                           /owners/{ownerId}) — the samples still carry their original
 *                           per-sample normalizedPath but should be matched against the
 *                           unified template.
 * @returns Map of param name → unique observed values, or undefined if no path params
 */
export function collectPathParamValues(
  samples: Sample[],
  explicitTemplate?: string,
): Record<string, string[]> | undefined {
  if (samples.length === 0) return undefined;

  const template = explicitTemplate ?? samples[0].normalizedPath;
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
  snapshot: number;
}

export interface AggregationOptions {
  /** Snapshot number to use. When provided, deletes existing rows for this snapshot before inserting. */
  snapshot?: number;
  /** If true, skip session state transitions (for mid-session auto-aggregation). */
  skipStateTransition?: boolean;
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
export function runAggregation(
  db: Database.Database,
  sessionId: string,
  options?: AggregationOptions,
): AggregationResult {
  const sessions = new SessionRepository(db);
  const sampleRepo = new SampleRepository(db);
  const schemaRepo = new AggregatedSchemaRepository(db);

  const session = sessions.getSession(sessionId);
  if (!session) throw new Error(`Session '${sessionId}' not found`);

  const snapshot = options?.snapshot ?? 1;
  const skipStateTransition = options?.skipStateTransition ?? false;

  // Transition to aggregating (skip for mid-session auto-aggregate)
  if (!skipStateTransition && session.status === 'active') {
    sessions.updateSessionStatus(sessionId, 'aggregating');
  }

  try {
    const allSamples = sampleRepo.listBySession(sessionId);
    if (allSamples.length === 0) {
      if (!skipStateTransition) {
        sessions.updateSessionStatus(sessionId, 'completed');
      }
      return { schemas: [], sampleCount: 0, snapshot };
    }

    // For cumulative snapshots, delete previous rows for this snapshot before inserting
    if (options?.snapshot !== undefined) {
      schemaRepo.deleteBySessionSnapshot(sessionId, snapshot);
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

    // Cross-path unification: fold sibling endpoints whose differing leaf
    // segment is the same logical parameter. Per-sample path normalization
    // is per-path; this is the cross-path pass that finishes it.
    unifyEndpointPaths(endpointMap);

    // Collapse into one aggregated schema per (method, path)
    const aggregated: AggregatedSchema[] = [];
    const now = new Date().toISOString();

    for (const [, endpoint] of endpointMap) {
      // Merge request schemas only from successful (2xx) status groups.
      // 4xx/5xx samples represent invalid client input by definition — including
      // them in request-body inference drops required fields below 100% presence
      // and contradicts the API contract. Falls back to all groups if no 2xx
      // samples exist (so endpoints observed only via errors still get a schema).
      const successGroups = Array.from(endpoint.statusGroups.entries()).filter(
        ([statusCode]) => {
          const code = parseInt(statusCode, 10);
          return code >= 200 && code < 300;
        },
      );
      const requestGroups =
        successGroups.length > 0 ? successGroups : Array.from(endpoint.statusGroups.entries());
      const requestSampleCount = requestGroups.reduce(
        (sum, [, group]) => sum + group.samples.length,
        0,
      );

      let requestSchema: InferredSchema | undefined;
      for (const [, group] of requestGroups) {
        if (group.requestSchema !== undefined) {
          if (requestSchema === undefined) {
            requestSchema = group.requestSchema;
          } else {
            requestSchema = mergeSchemas(requestSchema, group.requestSchema);
          }
        }
      }

      // Calculate required fields on request schema using only the success-sample
      // count, so a field present in all 2xx samples is correctly marked required
      // even when error samples lack it.
      if (requestSchema) {
        requestSchema = calculateRequiredFields(
          requestSchema,
          requestSampleCount,
          endpoint.method,
        );
        requestSchema = inferEnums(requestSchema, requestSampleCount);
      }

      // Build response_schemas map: statusCode → schema (or null for no-body responses
      // like 204, so the export still emits the status code).
      const responseSchemas: Record<string, InferredSchema | null> = {};
      for (const [statusCode, group] of endpoint.statusGroups) {
        if (group.responseSchema !== undefined) {
          let withRequired = calculateRequiredFields(
            group.responseSchema,
            group.samples.length,
          );
          withRequired = inferEnums(withRequired, group.samples.length);
          responseSchemas[statusCode] = withRequired;
        } else if (group.samples.length > 0) {
          // Status code was observed in the wire traffic but the response had no
          // body (e.g. 204 No Content, 304 Not Modified). Record null so the
          // status code is preserved in the export.
          responseSchemas[statusCode] = null;
        }
      }

      // Merge headers
      const mergedRequestHeaders = mergeHeaders(endpoint.requestHeaders);
      const mergedResponseHeaders = mergeHeaders(endpoint.responseHeaders);

      // Merge query parameters
      const queryParams = mergeQueryParams(endpoint.allSamples);

      // Collect path parameter values for type inference. Pass the (possibly
      // unified) endpoint path explicitly — samples retain their per-sample
      // normalizedPath which can lag behind cross-path unification.
      //
      // Use only 2xx samples: 4xx samples carry deliberately invalid path
      // values (e.g. /pets/abc folded in from a 400 case) which would
      // contaminate the type-narrowing heuristic (all-numeric → integer).
      const successPathSamples = endpoint.allSamples.filter((s) => {
        if (s.statusCode === undefined) return false;
        return s.statusCode >= 200 && s.statusCode < 300;
      });
      const pathParamSamples =
        successPathSamples.length > 0 ? successPathSamples : endpoint.allSamples;
      const pathParamValues = collectPathParamValues(pathParamSamples, endpoint.path);

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
        snapshot,
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
        snapshot,
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

    // Transition to completed (skip for mid-session auto-aggregate)
    if (!skipStateTransition) {
      sessions.updateSessionStatus(sessionId, 'completed');
    }

    return { schemas: aggregated, sampleCount: allSamples.length, snapshot };
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
