/**
 * Test fixtures — sample JSON payloads and their expected inferred schemas.
 *
 * These fixtures exercise all inference paths:
 *   - Simple flat objects
 *   - Nested objects
 *   - Arrays of objects
 *   - Mixed-type (nullable) fields
 *   - All string formats: UUID, email, datetime, date, URI, IPv4, IPv6
 *   - Empty objects and arrays
 *   - Deeply nested structures (5+ levels)
 *
 * The expected schemas are ground-truth values for test assertions.
 * They reflect the output of inferSchema() and mergeSchemas() as documented
 * in PLAN.md sections 6.1–6.4.
 */

import type { InferredSchema, FieldStats } from '../../src/inference/types.js';

// ---------------------------------------------------------------------------
// Helper: create FieldStats for expected schemas
// ---------------------------------------------------------------------------

export function stats(sampleCount: number, presenceCount?: number): FieldStats {
  const pc = presenceCount ?? sampleCount;
  return {
    sampleCount,
    presenceCount: pc,
    confidence: sampleCount > 0 ? pc / sampleCount : 0,
  };
}

/** Default stats for a freshly inferred single-sample schema node */
export const DEFAULT_STATS: FieldStats = {
  sampleCount: 1,
  presenceCount: 1,
  confidence: 1.0,
};

// ---------------------------------------------------------------------------
// Fixture 1: Simple flat object
// ---------------------------------------------------------------------------

export const SIMPLE_FLAT_OBJECT = {
  id: 1,
  name: 'Alice',
  email: 'alice@example.com',
};

export const SIMPLE_FLAT_OBJECT_SCHEMA: InferredSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer', stats: DEFAULT_STATS },
    name: { type: 'string', stats: DEFAULT_STATS },
    email: { type: 'string', format: 'email', stats: DEFAULT_STATS },
  },
  required: [],
  stats: DEFAULT_STATS,
};

// ---------------------------------------------------------------------------
// Fixture 2: Nested object
// ---------------------------------------------------------------------------

export const NESTED_OBJECT = {
  user: {
    profile: {
      avatar: 'https://example.com/avatar.png',
    },
  },
};

export const NESTED_OBJECT_SCHEMA: InferredSchema = {
  type: 'object',
  properties: {
    user: {
      type: 'object',
      properties: {
        profile: {
          type: 'object',
          properties: {
            avatar: { type: 'string', format: 'uri', stats: DEFAULT_STATS },
          },
          required: [],
          stats: DEFAULT_STATS,
        },
      },
      required: [],
      stats: DEFAULT_STATS,
    },
  },
  required: [],
  stats: DEFAULT_STATS,
};

// ---------------------------------------------------------------------------
// Fixture 3: Array of objects
// ---------------------------------------------------------------------------

export const ARRAY_OF_OBJECTS = [
  { id: 1, name: 'Alpha' },
  { id: 2, name: 'Beta' },
];

/** Expected items schema after merging the two array elements */
export const ARRAY_OF_OBJECTS_ITEMS_SCHEMA: InferredSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer', stats: stats(2) },
    name: { type: 'string', stats: stats(2) },
  },
  required: [],
  stats: stats(2),
};

export const ARRAY_OF_OBJECTS_SCHEMA: InferredSchema = {
  type: 'array',
  items: ARRAY_OF_OBJECTS_ITEMS_SCHEMA,
  stats: DEFAULT_STATS,
};

// ---------------------------------------------------------------------------
// Fixture 4: Mixed-type (nullable) field
// ---------------------------------------------------------------------------

/** Two samples where 'avatar' is a string in one, null in the other */
export const MIXED_TYPE_SAMPLE_A = {
  id: 1,
  name: 'Alice',
  avatar: 'https://example.com/avatar.png',
};

export const MIXED_TYPE_SAMPLE_B = {
  id: 2,
  name: 'Bob',
  avatar: null,
};

/** The merged schema should have oneOf for the avatar field */
export const MIXED_TYPE_AVATAR_SCHEMA: InferredSchema = {
  type: 'string', // type is ignored when oneOf is present
  oneOf: [
    { type: 'string', format: 'uri', stats: DEFAULT_STATS },
    { type: 'null', stats: DEFAULT_STATS },
  ],
  stats: stats(2),
};

// ---------------------------------------------------------------------------
// Fixture 5: All string formats
// ---------------------------------------------------------------------------

export const ALL_STRING_FORMATS_OBJECT = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  email: 'user@example.com',
  createdAt: '2024-01-15T10:30:00Z',
  birthDate: '1990-01-15',
  website: 'https://example.com',
  ipv4: '192.168.1.1',
  ipv6: '2001:0db8:85a3:0000:0000:8a2e:0370:7334',
  plain: 'just a string',
};

export const ALL_STRING_FORMATS_SCHEMA: InferredSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid', stats: DEFAULT_STATS },
    email: { type: 'string', format: 'email', stats: DEFAULT_STATS },
    createdAt: { type: 'string', format: 'date-time', stats: DEFAULT_STATS },
    birthDate: { type: 'string', format: 'date', stats: DEFAULT_STATS },
    website: { type: 'string', format: 'uri', stats: DEFAULT_STATS },
    ipv4: { type: 'string', format: 'ipv4', stats: DEFAULT_STATS },
    ipv6: { type: 'string', format: 'ipv6', stats: DEFAULT_STATS },
    plain: { type: 'string', stats: DEFAULT_STATS },
  },
  required: [],
  stats: DEFAULT_STATS,
};

// ---------------------------------------------------------------------------
// Fixture 6: Empty object
// ---------------------------------------------------------------------------

export const EMPTY_OBJECT = {};

export const EMPTY_OBJECT_SCHEMA: InferredSchema = {
  type: 'object',
  properties: {},
  required: [],
  stats: DEFAULT_STATS,
};

// ---------------------------------------------------------------------------
// Fixture 7: Empty array
// ---------------------------------------------------------------------------

export const EMPTY_ARRAY: unknown[] = [];

export const EMPTY_ARRAY_SCHEMA: InferredSchema = {
  type: 'array',
  stats: DEFAULT_STATS,
};

// ---------------------------------------------------------------------------
// Fixture 8: Deeply nested (5+ levels)
// ---------------------------------------------------------------------------

export const DEEP_NESTED_OBJECT = {
  level1: {
    level2: {
      level3: {
        level4: {
          level5: {
            value: 42,
          },
        },
      },
    },
  },
};

export const DEEP_NESTED_SCHEMA: InferredSchema = {
  type: 'object',
  properties: {
    level1: {
      type: 'object',
      properties: {
        level2: {
          type: 'object',
          properties: {
            level3: {
              type: 'object',
              properties: {
                level4: {
                  type: 'object',
                  properties: {
                    level5: {
                      type: 'object',
                      properties: {
                        value: { type: 'integer', stats: DEFAULT_STATS },
                      },
                      required: [],
                      stats: DEFAULT_STATS,
                    },
                  },
                  required: [],
                  stats: DEFAULT_STATS,
                },
              },
              required: [],
              stats: DEFAULT_STATS,
            },
          },
          required: [],
          stats: DEFAULT_STATS,
        },
      },
      required: [],
      stats: DEFAULT_STATS,
    },
  },
  required: [],
  stats: DEFAULT_STATS,
};

// ---------------------------------------------------------------------------
// Fixture 9: All scalar types
// ---------------------------------------------------------------------------

export const ALL_SCALAR_TYPES_OBJECT = {
  aString: 'hello',
  anInteger: 42,
  aFloat: 3.14,
  aBoolean: true,
  aNull: null,
};

export const ALL_SCALAR_TYPES_SCHEMA: InferredSchema = {
  type: 'object',
  properties: {
    aString: { type: 'string', stats: DEFAULT_STATS },
    anInteger: { type: 'integer', stats: DEFAULT_STATS },
    aFloat: { type: 'number', stats: DEFAULT_STATS },
    aBoolean: { type: 'boolean', stats: DEFAULT_STATS },
    aNull: { type: 'null', stats: DEFAULT_STATS },
  },
  required: [],
  stats: DEFAULT_STATS,
};

// ---------------------------------------------------------------------------
// Fixture 10: Format conflict (same type, different formats → drop format)
// ---------------------------------------------------------------------------

/** Two schemas for the same string field with different formats */
export const FORMAT_CONFLICT_SCHEMA_A: InferredSchema = {
  type: 'string',
  format: 'uuid',
  stats: DEFAULT_STATS,
};

export const FORMAT_CONFLICT_SCHEMA_B: InferredSchema = {
  type: 'string',
  format: 'email',
  stats: DEFAULT_STATS,
};

/** Expected result: format dropped because of conflict */
export const FORMAT_CONFLICT_MERGED_SCHEMA: InferredSchema = {
  type: 'string',
  stats: stats(2),
};

// ---------------------------------------------------------------------------
// Fixture 11: integer → number is compatible; number → integer is breaking
// ---------------------------------------------------------------------------

export const INTEGER_SCHEMA: InferredSchema = {
  type: 'integer',
  stats: DEFAULT_STATS,
};

export const NUMBER_SCHEMA: InferredSchema = {
  type: 'number',
  stats: DEFAULT_STATS,
};

// ---------------------------------------------------------------------------
// Fixture 12: Path normalization cases
// ---------------------------------------------------------------------------

export interface PathNormalizationCase {
  input: string;
  expected: string;
  description: string;
}

export const PATH_NORMALIZATION_CASES: PathNormalizationCase[] = [
  { input: '/users/123', expected: '/users/{userId}', description: 'numeric id after users' },
  {
    input: '/orders/550e8400-e29b-41d4-a716-446655440000',
    expected: '/orders/{orderId}',
    description: 'UUID after orders',
  },
  {
    input: '/events/2024-01-15',
    expected: '/events/{eventDate}',
    description: 'date after events',
  },
  {
    input: '/products/ABC123',
    expected: '/products/{productCode}',
    description: 'alphanumeric code after products',
  },
  {
    input: '/users/123/orders/456',
    expected: '/users/{userId}/orders/{orderId}',
    description: 'compound path',
  },
  {
    input: '/api/v1/users/123',
    expected: '/api/v1/users/{userId}',
    description: 'literal keywords preserved',
  },
  {
    input: '/users/123?page=1',
    expected: '/users/{userId}',
    description: 'query string stripped',
  },
  {
    input: '/users/{userId}',
    expected: '/users/{userId}',
    description: 'already parameterized path passes through',
  },
];

// ---------------------------------------------------------------------------
// Fixture 13: Session samples for aggregation testing
// ---------------------------------------------------------------------------

/** A realistic set of samples representing traffic through a Users API */
export const USERS_API_SAMPLES = [
  {
    httpMethod: 'GET',
    path: '/users',
    normalizedPath: '/users',
    statusCode: 200,
    responseBody: JSON.stringify([
      { id: 1, name: 'Alice', email: 'alice@example.com' },
      { id: 2, name: 'Bob', email: 'bob@example.com' },
    ]),
  },
  {
    httpMethod: 'GET',
    path: '/users/1',
    normalizedPath: '/users/{userId}',
    statusCode: 200,
    responseBody: JSON.stringify({
      id: 1,
      name: 'Alice',
      email: 'alice@example.com',
      avatar: 'https://example.com/alice.png',
    }),
  },
  {
    httpMethod: 'GET',
    path: '/users/2',
    normalizedPath: '/users/{userId}',
    statusCode: 200,
    responseBody: JSON.stringify({
      id: 2,
      name: 'Bob',
      email: 'bob@example.com',
      avatar: null, // nullable field
    }),
  },
  {
    httpMethod: 'GET',
    path: '/users/999',
    normalizedPath: '/users/{userId}',
    statusCode: 404,
    responseBody: JSON.stringify({ error: 'not_found', message: 'User not found' }),
  },
  {
    httpMethod: 'POST',
    path: '/users',
    normalizedPath: '/users',
    statusCode: 201,
    requestBody: JSON.stringify({ name: 'Charlie', email: 'charlie@example.com' }),
    responseBody: JSON.stringify({ id: 3, name: 'Charlie', email: 'charlie@example.com' }),
  },
];

// ---------------------------------------------------------------------------
// Fixture 14: OpenAPI output fragments for validation
// ---------------------------------------------------------------------------

/** Expected OpenAPI path item structure for GET /users */
export const OPENAPI_GET_USERS_FRAGMENT = {
  operationId: 'getUsers',
  responses: {
    '200': {
      description: 'Response with status 200',
    },
  },
};

/** Expected OpenAPI parameter for path template /users/{userId} */
export const OPENAPI_USER_ID_PARAM_FRAGMENT = {
  name: 'userId',
  in: 'path',
  required: true,
  schema: {
    type: 'string',
  },
};

// ---------------------------------------------------------------------------
// Fixture 15: Breaking change detection scenarios
// ---------------------------------------------------------------------------

/** Schema version A: user with required email */
export const SCHEMA_V1: InferredSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer', stats: DEFAULT_STATS },
    name: { type: 'string', stats: DEFAULT_STATS },
    email: { type: 'string', format: 'email', stats: DEFAULT_STATS },
  },
  required: ['email', 'id', 'name'],
  stats: DEFAULT_STATS,
};

/** Schema version B: email removed (breaking), avatar added (non-breaking) */
export const SCHEMA_V2_REMOVED_FIELD: InferredSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer', stats: DEFAULT_STATS },
    name: { type: 'string', stats: DEFAULT_STATS },
    avatar: { type: 'string', format: 'uri', stats: DEFAULT_STATS },
  },
  required: ['id', 'name'],
  stats: DEFAULT_STATS,
};

/** Schema version B: email type changed from string to integer (breaking) */
export const SCHEMA_V2_TYPE_CHANGED: InferredSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer', stats: DEFAULT_STATS },
    name: { type: 'string', stats: DEFAULT_STATS },
    email: { type: 'integer', stats: DEFAULT_STATS }, // incompatible change
  },
  required: ['email', 'id', 'name'],
  stats: DEFAULT_STATS,
};

/** Schema version B: new required field added (breaking) */
export const SCHEMA_V2_ADDED_REQUIRED: InferredSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer', stats: DEFAULT_STATS },
    name: { type: 'string', stats: DEFAULT_STATS },
    email: { type: 'string', format: 'email', stats: DEFAULT_STATS },
    phoneNumber: { type: 'string', stats: DEFAULT_STATS }, // new required field
  },
  required: ['email', 'id', 'name', 'phoneNumber'],
  stats: DEFAULT_STATS,
};

/** Schema version B: optional field becomes required (breaking) */
export const SCHEMA_V2_FIELD_BECAME_REQUIRED: InferredSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer', stats: DEFAULT_STATS },
    name: { type: 'string', stats: DEFAULT_STATS },
    email: { type: 'string', format: 'email', stats: DEFAULT_STATS },
    avatar: { type: 'string', format: 'uri', stats: DEFAULT_STATS }, // was optional, now required
  },
  required: ['avatar', 'email', 'id', 'name'], // avatar now required
  stats: DEFAULT_STATS,
};

/** Schema version A: object type */
export const SCHEMA_V1_OBJECT: InferredSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer', stats: DEFAULT_STATS },
  },
  required: ['id'],
  stats: DEFAULT_STATS,
};

/** Schema version B: root type changed to array (breaking) */
export const SCHEMA_V2_TYPE_CHANGED_ROOT: InferredSchema = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      id: { type: 'integer', stats: DEFAULT_STATS },
    },
    required: ['id'],
    stats: DEFAULT_STATS,
  },
  stats: DEFAULT_STATS,
};

/** Schema version B: integer → number widening (compatible, NOT breaking) */
export const SCHEMA_V2_INTEGER_TO_NUMBER: InferredSchema = {
  type: 'object',
  properties: {
    id: { type: 'number', stats: DEFAULT_STATS }, // integer → number is compatible widening
    name: { type: 'string', stats: DEFAULT_STATS },
    email: { type: 'string', format: 'email', stats: DEFAULT_STATS },
  },
  required: ['email', 'id', 'name'],
  stats: DEFAULT_STATS,
};

/** Schema version B: number → integer narrowing (BREAKING — fixes Flowplane bug) */
export const SCHEMA_V1_NUMBER: InferredSchema = {
  type: 'object',
  properties: {
    price: { type: 'number', stats: DEFAULT_STATS }, // was number
    name: { type: 'string', stats: DEFAULT_STATS },
  },
  required: ['name', 'price'],
  stats: DEFAULT_STATS,
};

export const SCHEMA_V2_NUMBER_TO_INTEGER: InferredSchema = {
  type: 'object',
  properties: {
    price: { type: 'integer', stats: DEFAULT_STATS }, // narrowed to integer — BREAKING
    name: { type: 'string', stats: DEFAULT_STATS },
  },
  required: ['name', 'price'],
  stats: DEFAULT_STATS,
};

// ---------------------------------------------------------------------------
// Fixture 16: Requests for the full pipeline integration test
// ---------------------------------------------------------------------------

export interface PipelineRequest {
  method: string;
  path: string;
  body?: string;
  headers?: Record<string, string>;
}

/** A set of requests to send through the proxy for integration testing */
export const PIPELINE_TEST_REQUESTS: PipelineRequest[] = [
  { method: 'GET', path: '/users' },
  { method: 'GET', path: '/users/1' },
  { method: 'GET', path: '/users/2' },
  { method: 'GET', path: '/users/999' },
  {
    method: 'POST',
    path: '/users',
    body: JSON.stringify({ name: 'Charlie', email: 'charlie@example.com' }),
    headers: { 'Content-Type': 'application/json' },
  },
  { method: 'GET', path: '/orders' },
  { method: 'GET', path: '/health' },
  { method: 'GET', path: '/nested' },
  { method: 'GET', path: '/text' }, // non-JSON, should be skipped
  { method: 'GET', path: '/error' },
];
