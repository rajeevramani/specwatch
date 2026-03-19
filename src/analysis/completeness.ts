/**
 * Response completeness scoring — compares write (POST/PUT/PATCH) responses
 * against read (GET) responses for the same resource to flag thin responses
 * that force agents into verification loops.
 */
import type { AggregatedSchema, InferredSchema, Sample } from '../types/index.js';
import { extractJsonRpcOperation } from './jsonrpc.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Completeness analysis for a single write endpoint */
export interface ResponseCompleteness {
  /** HTTP method (POST, PUT, PATCH) */
  method: string;
  /** Normalized path */
  path: string;
  /** Number of fields in the write response */
  writeFieldCount: number;
  /** Number of fields in the corresponding GET response */
  readFieldCount: number;
  /** Completeness score (0.0–1.0): writeFieldCount / readFieldCount */
  completenessScore: number;
  /** Fields present in GET response but missing from write response */
  missingFields: string[];
}

/** Summary report for a session */
export interface CompletenessReport {
  /** All analyzed endpoints */
  endpoints: ResponseCompleteness[];
  /** Endpoints with completeness score < 0.5 */
  thinResponses: ResponseCompleteness[];
  /** Average completeness score across all endpoints */
  avgCompleteness: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/**
 * Extract top-level field names from an InferredSchema.
 * Only meaningful for object schemas with properties.
 */
function extractFields(schema: InferredSchema): string[] {
  if (schema.type === 'object' && schema.properties) {
    return Object.keys(schema.properties);
  }
  return [];
}

/**
 * Get the primary (success) response schema from an aggregated schema.
 * Looks for 200, 201, or the first 2xx status code.
 */
function getSuccessResponseSchema(
  schema: AggregatedSchema,
): InferredSchema | undefined {
  if (!schema.responseSchemas) return undefined;

  // Prefer 200, then 201, then first 2xx
  if (schema.responseSchemas['200']) return schema.responseSchemas['200'];
  if (schema.responseSchemas['201']) return schema.responseSchemas['201'];

  for (const [code, responseSchema] of Object.entries(schema.responseSchemas)) {
    if (code.startsWith('2')) return responseSchema;
  }
  return undefined;
}

/**
 * Match a write endpoint path to its corresponding GET path.
 *
 * POST /users → GET /users/{userId}
 * POST /users/{userId}/orders → GET /users/{userId}/orders/{orderId}
 * PUT /users/{userId} → GET /users/{userId}
 * PATCH /users/{userId} → GET /users/{userId}
 */
export function findMatchingGetPath(
  writePath: string,
  writeMethod: string,
  getPaths: string[],
): string | undefined {
  // For PUT/PATCH, look for exact GET path match
  if (writeMethod === 'PUT' || writeMethod === 'PATCH') {
    if (getPaths.includes(writePath)) {
      return writePath;
    }
  }

  // For POST (and fallback for PUT/PATCH), look for GET with one more path segment
  // POST /users → GET /users/{something}
  for (const getPath of getPaths) {
    const writeSegments = writePath.split('/').filter(Boolean);
    const getSegments = getPath.split('/').filter(Boolean);

    // GET should have exactly one more segment than the write path
    if (getSegments.length !== writeSegments.length + 1) continue;

    // All write segments must match the beginning of the GET path
    const prefixMatches = writeSegments.every(
      (seg, i) => seg === getSegments[i],
    );
    if (!prefixMatches) continue;

    // The extra segment should be a path parameter (e.g., {userId})
    const lastSegment = getSegments[getSegments.length - 1];
    if (lastSegment.startsWith('{') && lastSegment.endsWith('}')) {
      return getPath;
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Main analysis
// ---------------------------------------------------------------------------

/**
 * Analyze response completeness for all write endpoints in a set of
 * aggregated schemas, comparing their responses against corresponding
 * GET endpoints.
 */
export function analyzeCompleteness(
  schemas: AggregatedSchema[],
): CompletenessReport {
  // Index GET endpoints by path
  const getSchemas = new Map<string, AggregatedSchema>();
  for (const schema of schemas) {
    if (schema.httpMethod === 'GET') {
      getSchemas.set(schema.path, schema);
    }
  }

  const getPaths = Array.from(getSchemas.keys());
  const endpoints: ResponseCompleteness[] = [];

  for (const schema of schemas) {
    if (!WRITE_METHODS.has(schema.httpMethod)) continue;

    const matchingGetPath = findMatchingGetPath(
      schema.path,
      schema.httpMethod,
      getPaths,
    );
    if (!matchingGetPath) continue;

    const getSchema = getSchemas.get(matchingGetPath)!;

    const writeResponse = getSuccessResponseSchema(schema);
    const readResponse = getSuccessResponseSchema(getSchema);

    if (!writeResponse || !readResponse) continue;

    const writeFields = extractFields(writeResponse);
    const readFields = extractFields(readResponse);

    if (readFields.length === 0) continue;

    const writeFieldSet = new Set(writeFields);
    const missingFields = readFields.filter((f) => !writeFieldSet.has(f));

    const completenessScore = Math.min(writeFields.length / readFields.length, 1.0);

    endpoints.push({
      method: schema.httpMethod,
      path: schema.path,
      writeFieldCount: writeFields.length,
      readFieldCount: readFields.length,
      completenessScore,
      missingFields,
    });
  }

  const thinResponses = endpoints.filter((e) => e.completenessScore < 0.5);
  const avgCompleteness =
    endpoints.length > 0
      ? endpoints.reduce((sum, e) => sum + e.completenessScore, 0) / endpoints.length
      : 0;

  return { endpoints, thinResponses, avgCompleteness };
}

// ---------------------------------------------------------------------------
// JSON-RPC tool name matching
// ---------------------------------------------------------------------------

const WRITE_VERBS = /(?:^|[-_])(create|set|update|put|patch|add|insert|upsert|delete|remove)[-_]/i;
const READ_VERBS = /(?:^|[-_])(get|query|read|describe|list|fetch|show|find|lookup)[-_]/i;

/**
 * Check if a tool name contains a write-like verb.
 * Handles prefixed names like "cp_create_cluster".
 */
export function isWriteTool(toolName: string): boolean {
  return WRITE_VERBS.test(toolName);
}

/**
 * Check if a tool name contains a read-like verb.
 * Handles prefixed names like "cp_get_listener".
 */
export function isReadTool(toolName: string): boolean {
  return READ_VERBS.test(toolName);
}

/**
 * Extract the resource suffix from a tool name.
 * Strips everything up to and including the verb.
 * e.g., "cp_create_cluster" → "cluster", "get_listener" → "listener"
 */
function getToolResourceSuffix(toolName: string): string {
  const writeMatch = toolName.match(WRITE_VERBS);
  if (writeMatch) {
    const verbEnd = toolName.indexOf(writeMatch[1]) + writeMatch[1].length;
    return toolName.slice(verbEnd).replace(/^[-_]/, '');
  }
  const readMatch = toolName.match(READ_VERBS);
  if (readMatch) {
    const verbEnd = toolName.indexOf(readMatch[1]) + readMatch[1].length;
    return toolName.slice(verbEnd).replace(/^[-_]/, '');
  }
  return toolName;
}

/**
 * Find a matching read tool for a write tool.
 * Matches by shared resource suffix (e.g., create_cluster → get_cluster).
 */
export function findMatchingReadTool(
  writeTool: string,
  readTools: string[],
): string | undefined {
  const suffix = getToolResourceSuffix(writeTool);
  return readTools.find((rt) => getToolResourceSuffix(rt) === suffix);
}

// ---------------------------------------------------------------------------
// JSON-RPC completeness analysis
// ---------------------------------------------------------------------------

/**
 * Analyze response completeness for JSON-RPC sessions.
 * Groups samples by tool name, compares write-tool responses against
 * matching read-tool responses.
 */
export function analyzeJsonRpcCompleteness(
  samples: Sample[],
): CompletenessReport {
  // Group samples by tool name and collect response schemas
  const toolResponses = new Map<string, InferredSchema[]>();

  for (const sample of samples) {
    const op = extractJsonRpcOperation(sample);
    if (!op || !op.toolName) continue;
    if (!sample.responseSchema) continue;

    const existing = toolResponses.get(op.toolName) ?? [];
    existing.push(sample.responseSchema);
    toolResponses.set(op.toolName, existing);
  }

  // Identify write and read tools
  const writeTools: string[] = [];
  const readTools: string[] = [];
  for (const toolName of toolResponses.keys()) {
    if (isWriteTool(toolName)) writeTools.push(toolName);
    if (isReadTool(toolName)) readTools.push(toolName);
  }

  const endpoints: ResponseCompleteness[] = [];

  for (const writeTool of writeTools) {
    const matchingRead = findMatchingReadTool(writeTool, readTools);
    if (!matchingRead) continue;

    // Use the first response schema from each tool for comparison
    const writeSchemas = toolResponses.get(writeTool)!;
    const readSchemas = toolResponses.get(matchingRead)!;

    // Pick the schema with the most fields as representative
    const writeResponse = pickRichestSchema(writeSchemas);
    const readResponse = pickRichestSchema(readSchemas);

    if (!writeResponse || !readResponse) continue;

    const writeFields = extractFields(writeResponse);
    const readFields = extractFields(readResponse);

    if (readFields.length === 0) continue;

    const writeFieldSet = new Set(writeFields);
    const missingFields = readFields.filter((f) => !writeFieldSet.has(f));
    const completenessScore = Math.min(writeFields.length / readFields.length, 1.0);

    endpoints.push({
      method: 'tools/call',
      path: `tools/call:${writeTool}`,
      writeFieldCount: writeFields.length,
      readFieldCount: readFields.length,
      completenessScore,
      missingFields,
    });
  }

  const thinResponses = endpoints.filter((e) => e.completenessScore < 0.5);
  const avgCompleteness =
    endpoints.length > 0
      ? endpoints.reduce((sum, e) => sum + e.completenessScore, 0) / endpoints.length
      : 0;

  return { endpoints, thinResponses, avgCompleteness };
}

/**
 * Pick the schema with the most top-level fields from a list.
 */
function pickRichestSchema(schemas: InferredSchema[]): InferredSchema | undefined {
  let best: InferredSchema | undefined;
  let bestCount = -1;
  for (const s of schemas) {
    const count = extractFields(s).length;
    if (count > bestCount) {
      best = s;
      bestCount = count;
    }
  }
  return best;
}
