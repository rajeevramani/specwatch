/**
 * OpenAPI export validation tests.
 *
 * These tests verify that the export layer produces valid OpenAPI 3.1
 * documents from aggregated schemas.
 *
 * NOTE (Phase A/B): The tests that can run now validate fixture shapes and
 * basic structural expectations. Full export validation (Phase C) will be
 * added once the export/ and aggregation/ modules are implemented.
 *
 * Phase C tests will:
 *   - Export OpenAPI from aggregated schemas
 *   - Validate the result against OpenAPI 3.1 spec
 *   - Verify path parameters, operationIds, request/response bodies
 */

import { describe, it, expect } from 'vitest';
import yaml from 'js-yaml';
import {
  OPENAPI_GET_USERS_FRAGMENT,
  OPENAPI_USER_ID_PARAM_FRAGMENT,
  ALL_STRING_FORMATS_SCHEMA,
  SIMPLE_FLAT_OBJECT_SCHEMA,
  NESTED_OBJECT_SCHEMA,
  ARRAY_OF_OBJECTS_SCHEMA,
  EMPTY_OBJECT_SCHEMA,
  EMPTY_ARRAY_SCHEMA,
} from '../helpers/fixtures.js';
import {
  buildOpenApiDocument,
  generateOperationId,
  serializeOpenApi,
  detectSecuritySchemes,
} from '../../src/export/openapi.js';
import type { AggregatedSchema, InferredSchema } from '../../src/inference/types.js';

// ---------------------------------------------------------------------------
// Fixture shape validation — OpenAPI output expectations
// ---------------------------------------------------------------------------

describe('OpenAPI output fixtures — shape validation', () => {
  it('OPENAPI_GET_USERS_FRAGMENT has correct operationId', () => {
    expect(OPENAPI_GET_USERS_FRAGMENT.operationId).toBe('getUsers');
  });

  it('OPENAPI_GET_USERS_FRAGMENT has responses.200', () => {
    expect(OPENAPI_GET_USERS_FRAGMENT.responses).toHaveProperty('200');
    expect(OPENAPI_GET_USERS_FRAGMENT.responses['200']).toHaveProperty('description');
  });

  it('OPENAPI_USER_ID_PARAM_FRAGMENT defines a path parameter', () => {
    expect(OPENAPI_USER_ID_PARAM_FRAGMENT.in).toBe('path');
    expect(OPENAPI_USER_ID_PARAM_FRAGMENT.required).toBe(true);
    expect(OPENAPI_USER_ID_PARAM_FRAGMENT.name).toBe('userId');
    expect(OPENAPI_USER_ID_PARAM_FRAGMENT.schema.type).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// Inferred schema structure validation
// ---------------------------------------------------------------------------

describe('InferredSchema fixtures — structural validation', () => {
  it('SIMPLE_FLAT_OBJECT_SCHEMA has correct type and properties', () => {
    expect(SIMPLE_FLAT_OBJECT_SCHEMA.type).toBe('object');
    expect(SIMPLE_FLAT_OBJECT_SCHEMA.properties).toBeDefined();
    expect(SIMPLE_FLAT_OBJECT_SCHEMA.properties!['id'].type).toBe('integer');
    expect(SIMPLE_FLAT_OBJECT_SCHEMA.properties!['name'].type).toBe('string');
    expect(SIMPLE_FLAT_OBJECT_SCHEMA.properties!['email'].type).toBe('string');
    expect(SIMPLE_FLAT_OBJECT_SCHEMA.properties!['email'].format).toBe('email');
  });

  it('ALL_STRING_FORMATS_SCHEMA detects all string formats', () => {
    const props = ALL_STRING_FORMATS_SCHEMA.properties!;
    expect(props['id'].format).toBe('uuid');
    expect(props['email'].format).toBe('email');
    expect(props['createdAt'].format).toBe('date-time');
    expect(props['birthDate'].format).toBe('date');
    expect(props['website'].format).toBe('uri');
    expect(props['ipv4'].format).toBe('ipv4');
    expect(props['ipv6'].format).toBe('ipv6');
    expect(props['plain'].format).toBeUndefined();
  });

  it('NESTED_OBJECT_SCHEMA has correct nested structure', () => {
    expect(NESTED_OBJECT_SCHEMA.type).toBe('object');
    const user = NESTED_OBJECT_SCHEMA.properties!['user'];
    expect(user.type).toBe('object');
    const profile = user.properties!['profile'];
    expect(profile.type).toBe('object');
    const avatar = profile.properties!['avatar'];
    expect(avatar.type).toBe('string');
    expect(avatar.format).toBe('uri');
  });

  it('ARRAY_OF_OBJECTS_SCHEMA has array type with items', () => {
    expect(ARRAY_OF_OBJECTS_SCHEMA.type).toBe('array');
    expect(ARRAY_OF_OBJECTS_SCHEMA.items).toBeDefined();
    expect(ARRAY_OF_OBJECTS_SCHEMA.items!.type).toBe('object');
    expect(ARRAY_OF_OBJECTS_SCHEMA.items!.properties!['id'].type).toBe('integer');
    expect(ARRAY_OF_OBJECTS_SCHEMA.items!.properties!['name'].type).toBe('string');
  });

  it('EMPTY_OBJECT_SCHEMA has object type with empty properties', () => {
    expect(EMPTY_OBJECT_SCHEMA.type).toBe('object');
    expect(EMPTY_OBJECT_SCHEMA.properties).toEqual({});
  });

  it('EMPTY_ARRAY_SCHEMA has array type with no items', () => {
    expect(EMPTY_ARRAY_SCHEMA.type).toBe('array');
    expect(EMPTY_ARRAY_SCHEMA.items).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// OpenAPI 3.1 structural requirements (schema-level)
// ---------------------------------------------------------------------------

describe('OpenAPI 3.1 structural requirements', () => {
  it('OpenAPI 3.1 info block requires title and version', () => {
    // Validates our expected fragment shapes conform to spec requirements
    const minimalOpenApiDoc = {
      openapi: '3.1.0',
      info: {
        title: 'Test API',
        version: '1.0.0',
      },
      paths: {},
    };
    expect(minimalOpenApiDoc.openapi).toBe('3.1.0');
    expect(minimalOpenApiDoc.info.title).toBeDefined();
    expect(minimalOpenApiDoc.info.version).toBeDefined();
  });

  it('path parameters must be marked required: true', () => {
    expect(OPENAPI_USER_ID_PARAM_FRAGMENT.required).toBe(true);
    expect(OPENAPI_USER_ID_PARAM_FRAGMENT.in).toBe('path');
  });

  it('operationId follows camelCase method+path convention', () => {
    // getUsers → GET /users
    expect(OPENAPI_GET_USERS_FRAGMENT.operationId).toMatch(/^[a-z][a-zA-Z0-9]*$/);
    expect(OPENAPI_GET_USERS_FRAGMENT.operationId).toContain('get');
    expect(OPENAPI_GET_USERS_FRAGMENT.operationId).toContain('Users');
  });
});

// ---------------------------------------------------------------------------
// Phase C: Full export validation
// ---------------------------------------------------------------------------

/** Build a minimal AggregatedSchema with sensible defaults. */
function makeAggregatedSchema(
  overrides: Partial<AggregatedSchema> & Pick<AggregatedSchema, 'httpMethod' | 'path'>,
): AggregatedSchema {
  return {
    id: 1,
    sessionId: 'test-session',
    version: 1,
    sampleCount: 10,
    confidenceScore: 0.9,
    firstObserved: '2026-01-01T00:00:00Z',
    lastObserved: '2026-01-02T00:00:00Z',
    ...overrides,
  };
}

const FIELD_STATS = { sampleCount: 10, presenceCount: 10, confidence: 1.0 };

const USER_RESPONSE_SCHEMA: InferredSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer', stats: FIELD_STATS },
    name: { type: 'string', stats: FIELD_STATS },
    email: { type: 'string', format: 'email', stats: FIELD_STATS },
  },
  required: ['id', 'name', 'email'],
  stats: FIELD_STATS,
};

const CREATE_USER_REQUEST_SCHEMA: InferredSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', stats: FIELD_STATS },
    email: { type: 'string', format: 'email', stats: FIELD_STATS },
  },
  required: ['name', 'email'],
  stats: FIELD_STATS,
};

const ERROR_RESPONSE_SCHEMA: InferredSchema = {
  type: 'object',
  properties: {
    error: { type: 'string', stats: FIELD_STATS },
    message: { type: 'string', stats: FIELD_STATS },
  },
  required: [],
  stats: FIELD_STATS,
};

describe('Export validation (Phase C)', () => {
  it('export OpenAPI from aggregated schemas and validate spec structure', () => {
    const schemas: AggregatedSchema[] = [
      makeAggregatedSchema({
        id: 1,
        httpMethod: 'GET',
        path: '/users',
        responseSchemas: { '200': USER_RESPONSE_SCHEMA },
      }),
      makeAggregatedSchema({
        id: 2,
        httpMethod: 'POST',
        path: '/users',
        requestSchema: CREATE_USER_REQUEST_SCHEMA,
        responseSchemas: { '201': USER_RESPONSE_SCHEMA },
      }),
      makeAggregatedSchema({
        id: 3,
        httpMethod: 'GET',
        path: '/users/{userId}',
        responseSchemas: { '200': USER_RESPONSE_SCHEMA, '404': ERROR_RESPONSE_SCHEMA },
      }),
    ];

    const doc = buildOpenApiDocument(schemas, { title: 'Test API', version: '0.1.0' });

    // Top-level OpenAPI structure
    expect(doc['openapi']).toBe('3.1.0');
    expect(doc['info']).toBeDefined();
    const info = doc['info'] as Record<string, unknown>;
    expect(info['title']).toBe('Test API');
    expect(info['version']).toBe('0.1.0');
    expect(info['description']).toBeDefined();
    expect(doc['paths']).toBeDefined();

    // All paths are present
    const paths = doc['paths'] as Record<string, unknown>;
    expect(paths).toHaveProperty('/users');
    expect(paths).toHaveProperty('/users/{userId}');

    // YAML serialization round-trip preserves structure
    const yamlStr = serializeOpenApi(doc, 'yaml');
    const parsed = yaml.load(yamlStr) as Record<string, unknown>;
    expect(parsed['openapi']).toBe('3.1.0');
    expect((parsed['info'] as Record<string, unknown>)['title']).toBe('Test API');
    expect(parsed['paths']).toHaveProperty('/users');
    expect(parsed['paths']).toHaveProperty('/users/{userId}');
  });

  it('path parameters are correctly defined for /users/{userId}', () => {
    const schema = makeAggregatedSchema({
      httpMethod: 'GET',
      path: '/users/{userId}',
      responseSchemas: { '200': USER_RESPONSE_SCHEMA },
    });

    const doc = buildOpenApiDocument([schema]);
    const paths = doc['paths'] as Record<string, Record<string, unknown>>;
    const operation = paths['/users/{userId}']['get'] as Record<string, unknown>;

    expect(operation['parameters']).toBeDefined();
    const parameters = operation['parameters'] as Array<Record<string, unknown>>;

    const userIdParam = parameters.find((p) => p['name'] === 'userId');
    expect(userIdParam).toBeDefined();
    expect(userIdParam!['in']).toBe('path');
    expect(userIdParam!['required']).toBe(true);
    expect((userIdParam!['schema'] as Record<string, unknown>)['type']).toBe('string');

    // YAML round-trip check
    const yamlStr = serializeOpenApi(doc, 'yaml');
    const parsed = yaml.load(yamlStr) as Record<string, unknown>;
    const parsedPaths = parsed['paths'] as Record<string, Record<string, unknown>>;
    const parsedOp = parsedPaths['/users/{userId}']['get'] as Record<string, unknown>;
    const parsedParams = parsedOp['parameters'] as Array<Record<string, unknown>>;
    const parsedParam = parsedParams.find((p) => p['name'] === 'userId');
    expect(parsedParam).toBeDefined();
    expect(parsedParam!['in']).toBe('path');
    expect(parsedParam!['required']).toBe(true);
  });

  it('operationIds are generated correctly: getUsers, postUsers, getUsersUserId', () => {
    const schemas: AggregatedSchema[] = [
      makeAggregatedSchema({ id: 1, httpMethod: 'GET', path: '/users' }),
      makeAggregatedSchema({ id: 2, httpMethod: 'POST', path: '/users' }),
      makeAggregatedSchema({ id: 3, httpMethod: 'GET', path: '/users/{userId}' }),
    ];

    const doc = buildOpenApiDocument(schemas);
    const paths = doc['paths'] as Record<string, Record<string, unknown>>;

    const getUsers = paths['/users']['get'] as Record<string, unknown>;
    expect(getUsers['operationId']).toBe('getUsers');

    const postUsers = paths['/users']['post'] as Record<string, unknown>;
    expect(postUsers['operationId']).toBe('postUsers');

    const getUsersUserId = paths['/users/{userId}']['get'] as Record<string, unknown>;
    expect(getUsersUserId['operationId']).toBe('getUsersUserId');

    // Verify the helper function directly
    expect(generateOperationId('GET', '/users')).toBe('getUsers');
    expect(generateOperationId('POST', '/users')).toBe('postUsers');
    expect(generateOperationId('GET', '/users/{userId}')).toBe('getUsersUserId');
    expect(generateOperationId('DELETE', '/users/{userId}/orders/{orderId}')).toBe(
      'deleteUsersUserIdOrdersOrderId',
    );
  });

  it('request body uses $ref to components/schemas and schema is extracted', () => {
    const schema = makeAggregatedSchema({
      httpMethod: 'POST',
      path: '/users',
      requestSchema: CREATE_USER_REQUEST_SCHEMA,
      responseSchemas: { '201': USER_RESPONSE_SCHEMA },
    });

    const doc = buildOpenApiDocument([schema]);
    const paths = doc['paths'] as Record<string, Record<string, unknown>>;
    const operation = paths['/users']['post'] as Record<string, unknown>;

    // Navigate to requestBody.content["application/json"].schema
    expect(operation['requestBody']).toBeDefined();
    const requestBody = operation['requestBody'] as Record<string, unknown>;
    const content = requestBody['content'] as Record<string, unknown>;
    expect(content['application/json']).toBeDefined();
    const jsonContent = content['application/json'] as Record<string, unknown>;
    expect(jsonContent['schema']).toBeDefined();

    // Verify the schema uses $ref
    const bodySchema = jsonContent['schema'] as Record<string, unknown>;
    expect(bodySchema['$ref']).toBe('#/components/schemas/PostUsersRequest');

    // Verify the actual schema is in components/schemas
    const components = doc['components'] as Record<string, unknown>;
    expect(components).toBeDefined();
    const schemas = components['schemas'] as Record<string, Record<string, unknown>>;
    expect(schemas['PostUsersRequest']).toBeDefined();
    expect(schemas['PostUsersRequest']['type']).toBe('object');
    const props = schemas['PostUsersRequest']['properties'] as Record<string, unknown>;
    expect(props['name']).toEqual({ type: 'string' });
    expect(props['email']).toEqual({ type: 'string', format: 'email' });

    // Verify via YAML round-trip
    const yamlStr = serializeOpenApi(doc, 'yaml');
    const parsed = yaml.load(yamlStr) as Record<string, unknown>;
    const parsedPaths = parsed['paths'] as Record<string, Record<string, unknown>>;
    const parsedOp = parsedPaths['/users']['post'] as Record<string, unknown>;
    const parsedBody = parsedOp['requestBody'] as Record<string, unknown>;
    const parsedContent = parsedBody['content'] as Record<string, unknown>;
    expect(
      (parsedContent['application/json'] as Record<string, unknown>)['schema'],
    ).toBeDefined();
  });

  it('response schema uses $ref to components/schemas', () => {
    const schema = makeAggregatedSchema({
      httpMethod: 'GET',
      path: '/users',
      responseSchemas: { '200': USER_RESPONSE_SCHEMA },
    });

    const doc = buildOpenApiDocument([schema]);
    const paths = doc['paths'] as Record<string, Record<string, unknown>>;
    const operation = paths['/users']['get'] as Record<string, unknown>;
    const responses = operation['responses'] as Record<string, unknown>;

    // Navigate to responses["200"].content["application/json"].schema
    expect(responses['200']).toBeDefined();
    const response200 = responses['200'] as Record<string, unknown>;
    expect(response200['description']).toBeDefined();
    expect(response200['content']).toBeDefined();
    const content = response200['content'] as Record<string, unknown>;
    expect(content['application/json']).toBeDefined();
    const jsonContent = content['application/json'] as Record<string, unknown>;
    expect(jsonContent['schema']).toBeDefined();

    // Verify the schema uses $ref
    const responseSchema = jsonContent['schema'] as Record<string, unknown>;
    expect(responseSchema['$ref']).toBe('#/components/schemas/GetUsersResponse');

    // Verify the actual schema is in components/schemas
    const components = doc['components'] as Record<string, unknown>;
    const schemas = components['schemas'] as Record<string, Record<string, unknown>>;
    expect(schemas['GetUsersResponse']).toBeDefined();
    expect(schemas['GetUsersResponse']['type']).toBe('object');
    expect(schemas['GetUsersResponse']['required']).toEqual(['id', 'name', 'email']);
  });

  it('204 No Content response has description but no content block', () => {
    const emptySchema: InferredSchema = {
      type: 'object',
      properties: {},
      required: [],
      stats: { sampleCount: 3, presenceCount: 3, confidence: 1.0 },
    };

    const schema = makeAggregatedSchema({
      httpMethod: 'DELETE',
      path: '/users/{userId}',
      responseSchemas: { '204': emptySchema },
    });

    const doc = buildOpenApiDocument([schema]);
    const paths = doc['paths'] as Record<string, Record<string, unknown>>;
    const operation = paths['/users/{userId}']['delete'] as Record<string, unknown>;
    const responses = operation['responses'] as Record<string, unknown>;

    expect(responses['204']).toBeDefined();
    const response204 = responses['204'] as Record<string, unknown>;
    expect(response204['description']).toBe('No Content');
    expect(response204['content']).toBeUndefined();

    // Verify via YAML round-trip: no content key under 204
    const yamlStr = serializeOpenApi(doc, 'yaml');
    const parsed = yaml.load(yamlStr) as Record<string, unknown>;
    const parsedPaths = parsed['paths'] as Record<string, Record<string, unknown>>;
    const parsedOp = parsedPaths['/users/{userId}']['delete'] as Record<string, unknown>;
    const parsedResponses = parsedOp['responses'] as Record<string, unknown>;
    const parsed204 = parsedResponses[204] as Record<string, unknown>;
    expect(parsed204['description']).toBe('No Content');
    expect(parsed204['content']).toBeUndefined();
  });

  it('internal stats fields are stripped from OpenAPI output', () => {
    const schema = makeAggregatedSchema({
      httpMethod: 'GET',
      path: '/users',
      responseSchemas: { '200': USER_RESPONSE_SCHEMA },
      requestSchema: CREATE_USER_REQUEST_SCHEMA,
    });

    const doc = buildOpenApiDocument([schema]);
    const serializedJson = JSON.stringify(doc);

    // None of the internal stats fields should appear in the output
    expect(serializedJson).not.toContain('"sampleCount"');
    expect(serializedJson).not.toContain('"presenceCount"');
    expect(serializedJson).not.toContain('"confidence"');
    expect(serializedJson).not.toContain('"stats"');

    // YAML output must also be clean of stats
    const yamlStr = serializeOpenApi(doc, 'yaml');
    expect(yamlStr).not.toContain('sampleCount');
    expect(yamlStr).not.toContain('presenceCount');
    expect(yamlStr).not.toContain('stats');
    // "confidence" could appear in description text but not as a YAML key with colon
    expect(yamlStr).not.toMatch(/^confidence:/m);
  });

  it('--include-metadata adds x-specwatch-* extensions to operations', () => {
    const schema = makeAggregatedSchema({
      httpMethod: 'GET',
      path: '/users',
      sampleCount: 42,
      confidenceScore: 0.87,
      responseSchemas: { '200': USER_RESPONSE_SCHEMA },
    });

    const doc = buildOpenApiDocument([schema], { includeMetadata: true });
    const paths = doc['paths'] as Record<string, Record<string, unknown>>;
    const operation = paths['/users']['get'] as Record<string, unknown>;

    expect(operation['x-specwatch-sample-count']).toBe(42);
    expect(operation['x-specwatch-confidence']).toBe(0.87);

    // Verify via YAML round-trip
    const yamlStr = serializeOpenApi(doc, 'yaml');
    const parsed = yaml.load(yamlStr) as Record<string, unknown>;
    const parsedPaths = parsed['paths'] as Record<string, Record<string, unknown>>;
    const parsedOp = parsedPaths['/users']['get'] as Record<string, unknown>;
    expect(parsedOp['x-specwatch-sample-count']).toBe(42);
    expect(parsedOp['x-specwatch-confidence']).toBeCloseTo(0.87, 2);
  });

  it('--min-confidence filters low-confidence endpoints from output', () => {
    const highConfidenceSchema = makeAggregatedSchema({
      id: 1,
      httpMethod: 'GET',
      path: '/users',
      sampleCount: 50,
      confidenceScore: 0.95,
      responseSchemas: { '200': USER_RESPONSE_SCHEMA },
    });

    const mediumConfidenceSchema = makeAggregatedSchema({
      id: 2,
      httpMethod: 'POST',
      path: '/users',
      sampleCount: 20,
      confidenceScore: 0.6,
      requestSchema: CREATE_USER_REQUEST_SCHEMA,
      responseSchemas: { '201': USER_RESPONSE_SCHEMA },
    });

    const lowConfidenceSchema = makeAggregatedSchema({
      id: 3,
      httpMethod: 'GET',
      path: '/debug',
      sampleCount: 1,
      confidenceScore: 0.2,
      responseSchemas: {
        '200': {
          type: 'object',
          properties: {},
          required: [],
          stats: { sampleCount: 1, presenceCount: 1, confidence: 1.0 },
        },
      },
    });

    const allSchemas = [highConfidenceSchema, mediumConfidenceSchema, lowConfidenceSchema];

    // Filter with minConfidence = 0.5 — should keep high and medium, drop low
    const minConfidence = 0.5;
    const filtered = allSchemas.filter((s) => s.confidenceScore >= minConfidence);
    const doc = buildOpenApiDocument(filtered);
    const paths = doc['paths'] as Record<string, unknown>;

    expect(paths).toHaveProperty('/users');
    expect(paths).not.toHaveProperty('/debug');

    // Verify both high and medium endpoints are present
    const usersPath = paths['/users'] as Record<string, unknown>;
    expect(usersPath['get']).toBeDefined();
    expect(usersPath['post']).toBeDefined();

    // Filter with minConfidence = 0.9 — should keep only high
    const strictFiltered = allSchemas.filter((s) => s.confidenceScore >= 0.9);
    const strictDoc = buildOpenApiDocument(strictFiltered);
    const strictPaths = strictDoc['paths'] as Record<string, unknown>;

    expect(strictPaths).toHaveProperty('/users');
    expect(strictPaths).not.toHaveProperty('/debug');
    const strictUsersPath = strictPaths['/users'] as Record<string, unknown>;
    expect(strictUsersPath['get']).toBeDefined();
    expect(strictUsersPath['post']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Transport header filtering
// ---------------------------------------------------------------------------

describe('Transport header filtering', () => {
  it('transport headers are excluded from parameters', () => {
    const schema = makeAggregatedSchema({
      httpMethod: 'GET',
      path: '/users',
      requestHeaders: [
        { name: 'Accept', example: 'application/json' },
        { name: 'Accept-Encoding', example: 'gzip' },
        { name: 'User-Agent', example: 'Mozilla/5.0' },
        { name: 'Content-Length', example: '42' },
        { name: 'Content-Type', example: 'application/json' },
        { name: 'Host', example: 'api.example.com' },
        { name: 'X-Custom-Header', example: 'custom-value' },
      ],
      responseSchemas: { '200': USER_RESPONSE_SCHEMA },
    });

    const doc = buildOpenApiDocument([schema]);
    const paths = doc['paths'] as Record<string, Record<string, unknown>>;
    const operation = paths['/users']['get'] as Record<string, unknown>;
    const parameters = operation['parameters'] as Array<Record<string, unknown>>;

    const headerParams = parameters.filter((p) => p['in'] === 'header');
    const headerNames = headerParams.map((p) => p['name']);

    // Transport headers must be excluded
    expect(headerNames).not.toContain('Accept');
    expect(headerNames).not.toContain('Accept-Encoding');
    expect(headerNames).not.toContain('User-Agent');
    expect(headerNames).not.toContain('Content-Length');
    expect(headerNames).not.toContain('Content-Type');
    expect(headerNames).not.toContain('Host');

    // Custom header should still pass through
    expect(headerNames).toContain('X-Custom-Header');
  });

  it('transport header filtering is case-insensitive', () => {
    const schema = makeAggregatedSchema({
      httpMethod: 'GET',
      path: '/users',
      requestHeaders: [
        { name: 'ACCEPT', example: 'application/json' },
        { name: 'content-type', example: 'application/json' },
        { name: 'user-AGENT', example: 'test' },
        { name: 'X-Request-Id', example: '123' },
      ],
      responseSchemas: { '200': USER_RESPONSE_SCHEMA },
    });

    const doc = buildOpenApiDocument([schema]);
    const paths = doc['paths'] as Record<string, Record<string, unknown>>;
    const operation = paths['/users']['get'] as Record<string, unknown>;
    const parameters = operation['parameters'] as Array<Record<string, unknown>>;

    const headerParams = parameters.filter((p) => p['in'] === 'header');
    const headerNames = headerParams.map((p) => p['name']);

    expect(headerNames).not.toContain('ACCEPT');
    expect(headerNames).not.toContain('content-type');
    expect(headerNames).not.toContain('user-AGENT');
    expect(headerNames).toContain('X-Request-Id');
  });

  it('custom headers pass through when no transport/auth headers present', () => {
    const schema = makeAggregatedSchema({
      httpMethod: 'GET',
      path: '/items',
      requestHeaders: [
        { name: 'X-Request-Id', example: 'abc-123' },
        { name: 'X-Correlation-Id', example: 'xyz-789' },
      ],
      responseSchemas: { '200': USER_RESPONSE_SCHEMA },
    });

    const doc = buildOpenApiDocument([schema]);
    const paths = doc['paths'] as Record<string, Record<string, unknown>>;
    const operation = paths['/items']['get'] as Record<string, unknown>;
    const parameters = operation['parameters'] as Array<Record<string, unknown>>;

    const headerParams = parameters.filter((p) => p['in'] === 'header');
    expect(headerParams).toHaveLength(2);
    expect(headerParams[0]['name']).toBe('X-Request-Id');
    expect(headerParams[1]['name']).toBe('X-Correlation-Id');
  });
});

// ---------------------------------------------------------------------------
// Security schemes detection
// ---------------------------------------------------------------------------

describe('Security schemes detection', () => {
  it('detects Bearer auth from Authorization header', () => {
    const schemas = [
      makeAggregatedSchema({
        httpMethod: 'GET',
        path: '/users',
        requestHeaders: [
          { name: 'Authorization', example: 'Bearer eyJhbGciOiJIUzI1NiJ9...' },
        ],
        responseSchemas: { '200': USER_RESPONSE_SCHEMA },
      }),
    ];

    const result = detectSecuritySchemes(schemas);
    expect(result).toBeDefined();
    expect(result!.securitySchemes['bearerAuth']).toEqual({ type: 'http', scheme: 'bearer' });
    expect(result!.security).toContainEqual({ bearerAuth: [] });
  });

  it('detects Basic auth from Authorization header', () => {
    const schemas = [
      makeAggregatedSchema({
        httpMethod: 'GET',
        path: '/users',
        requestHeaders: [
          { name: 'Authorization', example: 'Basic dXNlcjpwYXNz' },
        ],
        responseSchemas: { '200': USER_RESPONSE_SCHEMA },
      }),
    ];

    const result = detectSecuritySchemes(schemas);
    expect(result).toBeDefined();
    expect(result!.securitySchemes['basicAuth']).toEqual({ type: 'http', scheme: 'basic' });
    expect(result!.security).toContainEqual({ basicAuth: [] });
  });

  it('detects X-API-Key header', () => {
    const schemas = [
      makeAggregatedSchema({
        httpMethod: 'GET',
        path: '/users',
        requestHeaders: [
          { name: 'X-API-Key', example: 'sk-abc123' },
        ],
        responseSchemas: { '200': USER_RESPONSE_SCHEMA },
      }),
    ];

    const result = detectSecuritySchemes(schemas);
    expect(result).toBeDefined();
    expect(result!.securitySchemes['apiKeyAuth']).toEqual({
      type: 'apiKey',
      in: 'header',
      name: 'X-API-Key',
    });
    expect(result!.security).toContainEqual({ apiKeyAuth: [] });
  });

  it('detects multiple auth types across schemas', () => {
    const schemas = [
      makeAggregatedSchema({
        httpMethod: 'GET',
        path: '/users',
        requestHeaders: [
          { name: 'Authorization', example: 'Bearer token123' },
        ],
        responseSchemas: { '200': USER_RESPONSE_SCHEMA },
      }),
      makeAggregatedSchema({
        id: 2,
        httpMethod: 'GET',
        path: '/admin',
        requestHeaders: [
          { name: 'X-API-Key', example: 'key-456' },
        ],
        responseSchemas: { '200': USER_RESPONSE_SCHEMA },
      }),
    ];

    const result = detectSecuritySchemes(schemas);
    expect(result).toBeDefined();
    expect(Object.keys(result!.securitySchemes)).toHaveLength(2);
    expect(result!.securitySchemes['bearerAuth']).toBeDefined();
    expect(result!.securitySchemes['apiKeyAuth']).toBeDefined();
    expect(result!.security).toHaveLength(2);
  });

  it('returns undefined when no auth headers present', () => {
    const schemas = [
      makeAggregatedSchema({
        httpMethod: 'GET',
        path: '/public',
        requestHeaders: [
          { name: 'X-Request-Id', example: '123' },
        ],
        responseSchemas: { '200': USER_RESPONSE_SCHEMA },
      }),
    ];

    const result = detectSecuritySchemes(schemas);
    expect(result).toBeUndefined();
  });

  it('security schemes appear in buildOpenApiDocument output', () => {
    const schemas = [
      makeAggregatedSchema({
        httpMethod: 'GET',
        path: '/users',
        requestHeaders: [
          { name: 'Authorization', example: 'Bearer token' },
        ],
        responseSchemas: { '200': USER_RESPONSE_SCHEMA },
      }),
    ];

    const doc = buildOpenApiDocument(schemas);
    expect(doc['components']).toBeDefined();
    const components = doc['components'] as Record<string, unknown>;
    expect(components['securitySchemes']).toBeDefined();
    expect(doc['security']).toBeDefined();
  });

  it('security schemes survive YAML round-trip', () => {
    const schemas = [
      makeAggregatedSchema({
        httpMethod: 'GET',
        path: '/users',
        requestHeaders: [
          { name: 'Authorization', example: 'Bearer token' },
          { name: 'X-API-Key', example: 'key123' },
        ],
        responseSchemas: { '200': USER_RESPONSE_SCHEMA },
      }),
    ];

    const doc = buildOpenApiDocument(schemas);
    const yamlStr = serializeOpenApi(doc, 'yaml');
    const parsed = yaml.load(yamlStr) as Record<string, unknown>;

    const components = parsed['components'] as Record<string, unknown>;
    expect(components).toBeDefined();
    const secSchemes = components['securitySchemes'] as Record<string, unknown>;
    expect(secSchemes['bearerAuth']).toEqual({ type: 'http', scheme: 'bearer' });
    expect(secSchemes['apiKeyAuth']).toEqual({ type: 'apiKey', in: 'header', name: 'X-API-Key' });

    const security = parsed['security'] as Array<Record<string, unknown[]>>;
    expect(security).toHaveLength(2);
  });
});
