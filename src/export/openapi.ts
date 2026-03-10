/**
 * OpenAPI 3.1 spec generator.
 *
 * Converts aggregated schemas to OpenAPI 3.1 format.
 * The conversion logic is format-agnostic internally — OpenAPI version-specific
 * serialization (3.0 vs 3.1) is isolated so 3.0 can be added later without restructuring.
 *
 * Internal stats fields (stats, _*) are stripped from all exported schemas.
 * With --include-metadata, they become x-specwatch-* extensions.
 */

import yaml from 'js-yaml';
import type { InferredSchema, AggregatedSchema, ExportOptions, HeaderEntry } from '../types/index.js';

// ============================================================
// Task 5.1 — Schema to OpenAPI Conversion
// ============================================================

/**
 * Auth-related header names to exclude from OpenAPI parameter definitions.
 */
const AUTH_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'x-auth-token',
  'cookie',
  'set-cookie',
  'proxy-authorization',
]);

/**
 * Transport/plumbing header names to exclude from OpenAPI parameter definitions.
 * These are HTTP infrastructure headers, not part of the API contract.
 */
const TRANSPORT_HEADERS = new Set([
  'accept',
  'accept-encoding',
  'user-agent',
  'content-length',
  'content-type',
  'host',
]);

/**
 * Convert an InferredSchema to an OpenAPI 3.1 JSON Schema object.
 * Strips internal stats fields. Handles oneOf recursively.
 *
 * @param schema - The inferred schema to convert
 * @returns Plain object suitable for inclusion in OpenAPI spec
 */
export function convertSchemaToOpenApi(schema: InferredSchema): Record<string, unknown> {
  // Handle oneOf union types
  if (schema.oneOf !== undefined) {
    // Separate null variants from non-null variants
    const nonNullVariants = schema.oneOf.filter((v) => v.type !== 'null');

    // If only null variants, return empty schema
    if (nonNullVariants.length === 0) {
      return {};
    }

    // If one non-null variant remains, inline it (no oneOf wrapper needed)
    if (nonNullVariants.length === 1) {
      return convertSchemaToOpenApi(nonNullVariants[0]);
    }

    // Multiple non-null variants: keep oneOf
    return {
      oneOf: nonNullVariants.map((variant) => convertSchemaToOpenApi(variant)),
    };
  }

  // Skip null type — not a valid standalone type in most OpenAPI validators
  if (schema.type === 'null') {
    return {};
  }

  const result: Record<string, unknown> = { type: schema.type };

  // Add format for string types
  if (schema.format !== undefined) {
    result['format'] = schema.format;
  }

  // Add enum constraint for low-cardinality strings
  if (schema.enum !== undefined && schema.enum.length > 0) {
    result['enum'] = schema.enum;
  }

  // Handle object type
  if (schema.type === 'object') {
    if (schema.properties !== undefined && Object.keys(schema.properties).length > 0) {
      const properties: Record<string, unknown> = {};
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        properties[key] = convertSchemaToOpenApi(propSchema);
      }
      result['properties'] = properties;
    }

    if (schema.required !== undefined && schema.required.length > 0) {
      result['required'] = schema.required;
    }
  }

  // Handle array type
  if (schema.type === 'array' && schema.items !== undefined) {
    result['items'] = convertSchemaToOpenApi(schema.items);
  }

  return result;
}

// ============================================================
// Header Deduplication
// ============================================================

/**
 * Extract headers that appear in ALL schemas with identical values.
 * These are "global" headers that can be factored out of individual operations.
 *
 * Only considers headers that pass the auth/transport filter (i.e., headers
 * that would actually appear in the OpenAPI output).
 *
 * @param schemas - Aggregated schemas to analyze
 * @returns Headers present in every schema with the same name and example value
 */
export function extractGlobalHeaders(schemas: AggregatedSchema[]): HeaderEntry[] {
  if (schemas.length <= 1) return [];

  // Build a Set<"lowername:example"> per schema for O(1) membership checks
  const perSchemaKeySets: Set<string>[] = [];
  for (const s of schemas) {
    const headers = s.requestHeaders ?? [];
    const keySet = new Set<string>();
    for (const h of headers) {
      const lower = h.name.toLowerCase();
      if (!AUTH_HEADERS.has(lower) && !TRANSPORT_HEADERS.has(lower)) {
        keySet.add(`${lower}:${h.example}`);
      }
    }
    // If any schema has no filtered headers, no globals possible
    if (keySet.size === 0) return [];
    perSchemaKeySets.push(keySet);
  }

  // Use first schema's filtered headers as candidates, check membership in all others
  const firstHeaders = (schemas[0].requestHeaders ?? []).filter((h) => {
    const lower = h.name.toLowerCase();
    return !AUTH_HEADERS.has(lower) && !TRANSPORT_HEADERS.has(lower);
  });

  const globals: HeaderEntry[] = [];
  const seen = new Set<string>();

  for (const candidate of firstHeaders) {
    const key = `${candidate.name.toLowerCase()}:${candidate.example}`;
    if (seen.has(key)) continue;
    if (perSchemaKeySets.every((keySet) => keySet.has(key))) {
      globals.push({ name: candidate.name, example: candidate.example });
      seen.add(key);
    }
  }

  return globals;
}

// ============================================================
// Task 5.2 — Path and Operation Generation
// ============================================================

/**
 * Extract path parameters from a template path like /users/{id}/orders/{orderId}.
 * Returns an array of OpenAPI parameter definition objects.
 *
 * @param templatePath - Path with {param} placeholders
 * @returns Array of OpenAPI parameter objects (in: path)
 */
export function extractPathParameters(
  templatePath: string,
): Array<Record<string, unknown>> {
  const params: Array<Record<string, unknown>> = [];
  const regex = /\{([^}]+)\}/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(templatePath)) !== null) {
    params.push({
      name: match[1],
      in: 'path',
      required: true,
      schema: { type: 'string' },
    });
  }

  return params;
}

/**
 * Generate an operationId from an HTTP method and path.
 * Examples:
 *   GET /users          -> "getUsers"
 *   POST /users         -> "postUsers"
 *   GET /users/{id}     -> "getUsersId"
 *   GET /users/{userId} -> "getUsersUserId"
 *
 * @param method - HTTP method (GET, POST, etc.)
 * @param path - Template path (e.g., /users/{id})
 * @returns camelCase operation ID
 */
export function generateOperationId(method: string, path: string): string {
  // Start with the lowercase method
  const methodPart = method.toLowerCase();

  // Split path into segments and process each
  const segments = path
    .split('/')
    .filter((s) => s.length > 0)
    .map((segment) => {
      // Remove curly braces from path params and capitalize
      const clean = segment.replace(/^\{/, '').replace(/\}$/, '');
      return clean.charAt(0).toUpperCase() + clean.slice(1);
    });

  if (segments.length === 0) {
    return methodPart;
  }

  return methodPart + segments.join('');
}

/**
 * Build the paths object for an OpenAPI document from aggregated schemas.
 *
 * @param schemas - Aggregated schemas to include in the paths object
 * @param options - Export options
 * @returns OpenAPI paths object
 */
export function buildPathsObject(
  schemas: AggregatedSchema[],
  options: Partial<ExportOptions> = {},
  globalHeaders: Set<string> = new Set(),
): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const schema of schemas) {
    const pathKey = schema.path;
    if (paths[pathKey] === undefined) {
      paths[pathKey] = {};
    }

    const operation = buildOperationObject(schema, options, globalHeaders);
    paths[pathKey][schema.httpMethod.toLowerCase()] = operation;
  }

  return paths;
}

// ============================================================
// Task 5.3 — Request/Response Body Handling
// ============================================================

/**
 * Build an OpenAPI operation object from an aggregated schema.
 *
 * Includes:
 * - operationId
 * - summary
 * - path parameters
 * - query parameters (from first sample's query params)
 * - request body (if present)
 * - responses (per status code)
 * - captured headers as header parameters (excluding auth headers)
 *
 * @param schema - Aggregated schema for this endpoint
 * @param options - Export options
 * @returns OpenAPI operation object
 */
export function buildOperationObject(
  schema: AggregatedSchema,
  options: Partial<ExportOptions> = {},
  globalHeaders: Set<string> = new Set(),
): Record<string, unknown> {
  const operation: Record<string, unknown> = {};

  // operationId
  operation['operationId'] = generateOperationId(schema.httpMethod, schema.path);

  // summary
  operation['summary'] = generateSummary(schema.httpMethod, schema.path);

  // Collect all parameters (path + header)
  const parameters: Array<Record<string, unknown>> = [];

  // Path parameters from template (with type inference from observed values)
  const pathParams = extractPathParameters(schema.path);
  if (schema.pathParamValues !== undefined) {
    for (const param of pathParams) {
      const paramName = param['name'] as string;
      const values = schema.pathParamValues[paramName];
      if (values !== undefined && values.length > 0 && values.every((v) => /^\d+$/.test(v))) {
        param['schema'] = { type: 'integer' };
      }
    }
  }
  parameters.push(...pathParams);

  // Query parameters from aggregated query params
  if (schema.queryParams !== undefined) {
    for (const [paramName, values] of Object.entries(schema.queryParams)) {
      const allNumeric = values.length > 0 && values.every((v) => /^\d+$/.test(v));
      parameters.push({
        name: paramName,
        in: 'query',
        required: false,
        schema: { type: allNumeric ? 'integer' : 'string' },
      });
    }
  }

  // Header parameters (excluding auth, transport, and global headers)
  if (schema.requestHeaders !== undefined) {
    const headerParams = buildHeaderParameters(schema.requestHeaders, globalHeaders);
    parameters.push(...headerParams);
  }

  if (parameters.length > 0) {
    operation['parameters'] = parameters;
  }

  // Request body
  if (schema.requestSchema !== undefined) {
    const requestBodySchema = convertSchemaToOpenApi(schema.requestSchema);
    operation['requestBody'] = {
      content: {
        'application/json': {
          schema: requestBodySchema,
        },
      },
    };
  }

  // Responses per status code
  const responses: Record<string, unknown> = {};

  if (schema.responseSchemas !== undefined) {
    for (const [statusCode, responseSchema] of Object.entries(schema.responseSchemas)) {
      const statusNum = parseInt(statusCode, 10);
      responses[statusCode] = buildResponseObject(statusNum, responseSchema, options);
    }
  }

  // If no responses defined, add a default 200 placeholder
  if (Object.keys(responses).length === 0) {
    responses['200'] = { description: 'Response with status 200' };
  }

  operation['responses'] = responses;

  // Add metadata extensions if requested
  if (options.includeMetadata === true) {
    return addMetadataExtensions(operation, schema, true);
  }

  return operation;
}

/**
 * Build a response object for a given status code and schema.
 */
function buildResponseObject(
  statusCode: number,
  responseSchema: InferredSchema,
  _options: Partial<ExportOptions> = {},
): Record<string, unknown> {
  const description = getStatusCodeDescription(statusCode);

  // Status 204 has no content
  if (statusCode === 204) {
    return { description };
  }

  const openApiSchema = convertSchemaToOpenApi(responseSchema);

  return {
    description,
    content: {
      'application/json': {
        schema: openApiSchema,
      },
    },
  };
}

/**
 * Build header parameter definitions from captured headers.
 * Excludes auth-related headers.
 */
function buildHeaderParameters(
  headers: HeaderEntry[],
  globalHeaders: Set<string> = new Set(),
): Array<Record<string, unknown>> {
  return headers
    .filter((h) => {
      const lower = h.name.toLowerCase();
      return !AUTH_HEADERS.has(lower) && !TRANSPORT_HEADERS.has(lower) && !globalHeaders.has(lower);
    })
    .map((h) => ({
      name: h.name,
      in: 'header',
      required: false,
      schema: { type: 'string' },
      example: h.example,
    }));
}

/**
 * Generate a human-readable summary from method and path.
 */
function generateSummary(method: string, path: string): string {
  const methodUpper = method.toUpperCase();
  return `${methodUpper} ${path}`;
}

/**
 * Get a description for an HTTP status code.
 */
function getStatusCodeDescription(statusCode: number): string {
  const descriptions: Record<number, string> = {
    200: 'Response with status 200',
    201: 'Created',
    204: 'No Content',
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    409: 'Conflict',
    422: 'Unprocessable Entity',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
  };

  return descriptions[statusCode] ?? `Response with status ${statusCode}`;
}

// ============================================================
// Task 5.4 — Metadata Extensions
// ============================================================

/**
 * Add x-specwatch-* metadata extensions to an operation object.
 *
 * Extensions added:
 *   x-specwatch-sample-count: number
 *   x-specwatch-confidence: number
 *
 * @param operation - The operation object to extend
 * @param schema - The aggregated schema with metadata
 * @param includeMetadata - Whether to include metadata
 * @returns Updated operation object
 */
export function addMetadataExtensions(
  operation: Record<string, unknown>,
  schema: AggregatedSchema,
  includeMetadata: boolean,
): Record<string, unknown> {
  if (!includeMetadata) return operation;

  const extended: Record<string, unknown> = {
    ...operation,
    'x-specwatch-sample-count': schema.sampleCount,
    'x-specwatch-confidence': schema.confidenceScore,
  };

  if (schema.uniqueResponseShapes !== undefined) {
    extended['x-specwatch-unique-response-shapes'] = schema.uniqueResponseShapes;
  }

  return extended;
}

// ============================================================
// Task 5.5 — YAML and JSON Serialization
// ============================================================

/**
 * Detect security schemes from auth-related headers across all aggregated schemas.
 *
 * Scans requestHeaders for:
 * - Authorization: Bearer *** → bearerAuth (type: http, scheme: bearer)
 * - Authorization: Basic *** → basicAuth (type: http, scheme: basic)
 * - X-API-Key → apiKeyAuth (type: apiKey, in: header, name: X-API-Key)
 *
 * @param schemas - Aggregated schemas to scan for auth headers
 * @returns Object with securitySchemes and security arrays, or undefined if none found
 */
export function detectSecuritySchemes(
  schemas: AggregatedSchema[],
): { securitySchemes: Record<string, unknown>; security: Array<Record<string, unknown[]>> } | undefined {
  const securitySchemes: Record<string, unknown> = {};
  const securityItems: Array<Record<string, unknown[]>> = [];

  let hasBearer = false;
  let hasBasic = false;
  let hasApiKey = false;

  for (const schema of schemas) {
    if (schema.requestHeaders === undefined) continue;

    for (const header of schema.requestHeaders) {
      const name = header.name.toLowerCase();

      if (name === 'authorization') {
        const exampleLower = header.example.toLowerCase();
        if (exampleLower.startsWith('bearer') && !hasBearer) {
          hasBearer = true;
          securitySchemes['bearerAuth'] = { type: 'http', scheme: 'bearer' };
          securityItems.push({ bearerAuth: [] });
        } else if (exampleLower.startsWith('basic') && !hasBasic) {
          hasBasic = true;
          securitySchemes['basicAuth'] = { type: 'http', scheme: 'basic' };
          securityItems.push({ basicAuth: [] });
        }
      } else if (name === 'x-api-key' && !hasApiKey) {
        hasApiKey = true;
        securitySchemes['apiKeyAuth'] = { type: 'apiKey', in: 'header', name: 'X-API-Key' };
        securityItems.push({ apiKeyAuth: [] });
      }
    }
  }

  if (Object.keys(securitySchemes).length === 0) {
    return undefined;
  }

  return { securitySchemes, security: securityItems };
}

/**
 * Build a complete OpenAPI 3.1 document from aggregated schemas.
 *
 * @param schemas - Aggregated schemas to include
 * @param options - Export options
 * @returns OpenAPI document as a plain object
 */
export function buildOpenApiDocument(
  schemas: AggregatedSchema[],
  options: Partial<ExportOptions> = {},
): Record<string, unknown> {
  const title = options.title ?? 'API';
  const version = options.version ?? '1.0.0';
  const totalSamples = schemas.reduce((sum, s) => sum + s.sampleCount, 0);
  const endpointCount = schemas.length;

  const description =
    options.description ??
    `Auto-generated from ${totalSamples} traffic samples (${endpointCount} endpoints)`;

  // Compute global headers (present in ALL schemas with identical values)
  const globalHeaderEntries = extractGlobalHeaders(schemas);
  const globalHeaderNames = new Set(globalHeaderEntries.map((h) => h.name.toLowerCase()));

  const paths = buildPathsObject(schemas, options, globalHeaderNames);

  const doc: Record<string, unknown> = {
    openapi: '3.1.0',
    info: {
      title,
      version,
      description,
    },
    paths,
  };

  const securityResult = detectSecuritySchemes(schemas);
  if (securityResult !== undefined) {
    doc['components'] = { securitySchemes: securityResult.securitySchemes };
    doc['security'] = securityResult.security;
  }

  // Add global headers as metadata extension when requested
  if (options.includeMetadata === true && globalHeaderEntries.length > 0) {
    doc['x-specwatch-global-headers'] = globalHeaderEntries.map((h) => ({
      name: h.name,
      example: h.example,
    }));
  }

  return doc;
}

// ============================================================
// OpenAPI 3.0 Conversion
// ============================================================

/**
 * Recursively convert a schema object from OpenAPI 3.1 to 3.0.
 *
 * Transforms:
 * - `type: ['string', 'null']` → `type: 'string'` + `nullable: true`
 * - Any type array with 'null' → single non-null type + `nullable: true`
 * - Type array without 'null' → first type (edge case)
 */
function convertSchemaTo30(schema: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(schema)) {
    if (key === 'type' && Array.isArray(value)) {
      const types = value as string[];
      const nonNull = types.filter((t) => t !== 'null');
      if (types.includes('null')) {
        result['nullable'] = true;
      }
      result['type'] = nonNull.length === 1 ? nonNull[0] : nonNull[0] ?? 'string';
    } else if (key === 'oneOf' && Array.isArray(value)) {
      result['oneOf'] = value.map((v) =>
        typeof v === 'object' && v !== null ? convertSchemaTo30(v as Record<string, unknown>) : v,
      );
    } else if (key === 'properties' && typeof value === 'object' && value !== null) {
      const props: Record<string, unknown> = {};
      for (const [propKey, propVal] of Object.entries(value as Record<string, unknown>)) {
        props[propKey] =
          typeof propVal === 'object' && propVal !== null
            ? convertSchemaTo30(propVal as Record<string, unknown>)
            : propVal;
      }
      result['properties'] = props;
    } else if (key === 'items' && typeof value === 'object' && value !== null) {
      result['items'] = convertSchemaTo30(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Recursively walk an OpenAPI document and convert all `schema` objects to 3.0.
 */
function convertDeep(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(convertDeep);
  }
  if (typeof obj !== 'object' || obj === null) {
    return obj;
  }

  const record = obj as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(record)) {
    if (key === 'schema' && typeof value === 'object' && value !== null) {
      result[key] = convertSchemaTo30(value as Record<string, unknown>);
    } else if (typeof value === 'object' && value !== null) {
      result[key] = convertDeep(value);
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Convert an OpenAPI 3.1 document to OpenAPI 3.0.3 format.
 *
 * Transforms:
 * - `openapi: '3.1.0'` → `openapi: '3.0.3'`
 * - JSON Schema type arrays (e.g., `['string', 'null']`) → single type + `nullable: true`
 *
 * @param doc - OpenAPI 3.1 document
 * @returns OpenAPI 3.0.3 document
 */
export function convertToOpenApi30(doc: Record<string, unknown>): Record<string, unknown> {
  const converted = convertDeep(doc) as Record<string, unknown>;
  converted['openapi'] = '3.0.3';
  return converted;
}

/**
 * Serialize an OpenAPI document to YAML or JSON format.
 *
 * @param doc - OpenAPI document object
 * @param format - Output format ('yaml' or 'json')
 * @returns Serialized string
 */
export function serializeOpenApi(
  doc: Record<string, unknown>,
  format: 'yaml' | 'json' = 'yaml',
): string {
  if (format === 'json') {
    return JSON.stringify(doc, null, 2);
  }

  // YAML output via js-yaml
  return yaml.dump(doc, {
    indent: 2,
    lineWidth: -1, // No line wrapping
    noRefs: true,
    quotingType: '"',
  });
}
