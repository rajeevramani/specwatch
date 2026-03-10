/**
 * Unit tests for OpenAPI export functions.
 */

import { describe, it, expect } from 'vitest';
import {
  convertSchemaToOpenApi,
  extractPathParameters,
  generateOperationId,
  buildPathsObject,
  buildOperationObject,
  addMetadataExtensions,
  buildOpenApiDocument,
  serializeOpenApi,
  detectSecuritySchemes,
} from './openapi.js';
import type { InferredSchema, AggregatedSchema } from '../types/index.js';

// ============================================================
// Test helpers
// ============================================================

function makeStats(sampleCount = 5, presenceCount = 5) {
  return { sampleCount, presenceCount, confidence: presenceCount / sampleCount };
}

function makeStringSchema(format?: string): InferredSchema {
  const schema: InferredSchema = { type: 'string', stats: makeStats() };
  if (format !== undefined) schema.format = format as InferredSchema['format'];
  return schema;
}

function makeIntegerSchema(): InferredSchema {
  return { type: 'integer', stats: makeStats() };
}

function makeNumberSchema(): InferredSchema {
  return { type: 'number', stats: makeStats() };
}

function makeBooleanSchema(): InferredSchema {
  return { type: 'boolean', stats: makeStats() };
}

function makeNullSchema(): InferredSchema {
  return { type: 'null', stats: makeStats() };
}

function makeObjectSchema(
  properties: Record<string, InferredSchema>,
  required: string[] = [],
): InferredSchema {
  return {
    type: 'object',
    properties,
    required,
    stats: makeStats(),
  };
}

function makeArraySchema(items?: InferredSchema): InferredSchema {
  const schema: InferredSchema = { type: 'array', stats: makeStats() };
  if (items !== undefined) schema.items = items;
  return schema;
}

function makeOneOfSchema(...variants: InferredSchema[]): InferredSchema {
  return {
    type: 'object',
    oneOf: variants,
    stats: makeStats(),
  };
}

function makeAggregatedSchema(overrides: Partial<AggregatedSchema> = {}): AggregatedSchema {
  return {
    id: 1,
    sessionId: 'session-1',
    httpMethod: 'GET',
    path: '/users',
    version: 1,
    sampleCount: 10,
    confidenceScore: 0.85,
    firstObserved: '2026-03-10T00:00:00Z',
    lastObserved: '2026-03-10T01:00:00Z',
    ...overrides,
  };
}

// ============================================================
// Task 5.1 — convertSchemaToOpenApi
// ============================================================

describe('convertSchemaToOpenApi', () => {
  it('converts string type', () => {
    const result = convertSchemaToOpenApi(makeStringSchema());
    expect(result).toEqual({ type: 'string' });
  });

  it('converts integer type', () => {
    const result = convertSchemaToOpenApi(makeIntegerSchema());
    expect(result).toEqual({ type: 'integer' });
  });

  it('converts number type', () => {
    const result = convertSchemaToOpenApi(makeNumberSchema());
    expect(result).toEqual({ type: 'number' });
  });

  it('converts boolean type', () => {
    const result = convertSchemaToOpenApi(makeBooleanSchema());
    expect(result).toEqual({ type: 'boolean' });
  });

  it('converts null type to empty schema (avoids validator errors)', () => {
    const result = convertSchemaToOpenApi(makeNullSchema());
    expect(result).toEqual({});
  });

  it('includes format for string with format', () => {
    const result = convertSchemaToOpenApi(makeStringSchema('uuid'));
    expect(result).toEqual({ type: 'string', format: 'uuid' });
  });

  it('includes format: date-time', () => {
    const result = convertSchemaToOpenApi(makeStringSchema('date-time'));
    expect(result).toEqual({ type: 'string', format: 'date-time' });
  });

  it('includes format: int32 for integer with int32 format', () => {
    const schema: InferredSchema = { type: 'integer', format: 'int32', stats: makeStats() };
    const result = convertSchemaToOpenApi(schema);
    expect(result).toEqual({ type: 'integer', format: 'int32' });
  });

  it('includes format: int64 for integer with int64 format', () => {
    const schema: InferredSchema = { type: 'integer', format: 'int64', stats: makeStats() };
    const result = convertSchemaToOpenApi(schema);
    expect(result).toEqual({ type: 'integer', format: 'int64' });
  });

  it('includes format: double for number with double format', () => {
    const schema: InferredSchema = { type: 'number', format: 'double', stats: makeStats() };
    const result = convertSchemaToOpenApi(schema);
    expect(result).toEqual({ type: 'number', format: 'double' });
  });

  it('converts object with properties and required', () => {
    const schema = makeObjectSchema(
      { id: makeIntegerSchema(), name: makeStringSchema() },
      ['id'],
    );
    const result = convertSchemaToOpenApi(schema);
    expect(result['type']).toBe('object');
    expect(result['properties']).toBeDefined();
    expect((result['properties'] as Record<string, unknown>)['id']).toEqual({ type: 'integer' });
    expect((result['properties'] as Record<string, unknown>)['name']).toEqual({ type: 'string' });
    expect(result['required']).toEqual(['id']);
  });

  it('excludes empty required array from output', () => {
    const schema = makeObjectSchema({ id: makeIntegerSchema() }, []);
    const result = convertSchemaToOpenApi(schema);
    expect(result['required']).toBeUndefined();
  });

  it('converts array with items', () => {
    const schema = makeArraySchema(makeStringSchema());
    const result = convertSchemaToOpenApi(schema);
    expect(result).toEqual({
      type: 'array',
      items: { type: 'string' },
    });
  });

  it('converts array without items', () => {
    const schema = makeArraySchema();
    const result = convertSchemaToOpenApi(schema);
    expect(result).toEqual({ type: 'array' });
  });

  it('converts oneOf with null variant to inlined non-null schema', () => {
    const schema = makeOneOfSchema(makeStringSchema(), makeNullSchema());
    const result = convertSchemaToOpenApi(schema);
    // oneOf [string, null] collapses to just { type: 'string' }
    expect(result).toEqual({ type: 'string' });
  });

  it('converts oneOf with nested object and null to inlined object', () => {
    const schema = makeOneOfSchema(
      makeObjectSchema({ id: makeIntegerSchema() }, ['id']),
      makeNullSchema(),
    );
    const result = convertSchemaToOpenApi(schema);
    // oneOf [object, null] collapses to just the object
    expect(result['type']).toBe('object');
    expect(result['properties']).toBeDefined();
  });

  it('keeps oneOf when multiple non-null variants exist', () => {
    const schema = makeOneOfSchema(makeStringSchema(), makeIntegerSchema(), makeNullSchema());
    const result = convertSchemaToOpenApi(schema);
    const oneOf = result['oneOf'] as Record<string, unknown>[];
    expect(oneOf).toHaveLength(2);
    expect(oneOf[0]).toEqual({ type: 'string' });
    expect(oneOf[1]).toEqual({ type: 'integer' });
  });

  it('strips stats from output', () => {
    const schema = makeStringSchema();
    const result = convertSchemaToOpenApi(schema);
    expect(result['stats']).toBeUndefined();
  });

  it('strips stats from nested properties', () => {
    const schema = makeObjectSchema({ name: makeStringSchema() });
    const result = convertSchemaToOpenApi(schema);
    const nameProp = (result['properties'] as Record<string, Record<string, unknown>>)['name'];
    expect(nameProp['stats']).toBeUndefined();
  });

  it('includes enum in output when present on string schema', () => {
    const schema: InferredSchema = {
      type: 'string',
      enum: ['active', 'inactive', 'pending'],
      stats: makeStats(),
    };
    const result = convertSchemaToOpenApi(schema);
    expect(result['enum']).toEqual(['active', 'inactive', 'pending']);
  });

  it('strips _observedValues from output', () => {
    const schema: InferredSchema = {
      type: 'string',
      _observedValues: ['active', 'inactive'],
      stats: makeStats(),
    };
    const result = convertSchemaToOpenApi(schema);
    expect(result['_observedValues']).toBeUndefined();
  });

  it('includes enum in nested object property', () => {
    const schema = makeObjectSchema({
      status: {
        type: 'string',
        enum: ['open', 'closed'],
        stats: makeStats(),
      },
    });
    const result = convertSchemaToOpenApi(schema);
    const statusProp = (result['properties'] as Record<string, Record<string, unknown>>)['status'];
    expect(statusProp['enum']).toEqual(['open', 'closed']);
    expect(statusProp['_observedValues']).toBeUndefined();
  });

  it('does not include empty enum array', () => {
    const schema: InferredSchema = {
      type: 'string',
      enum: [],
      stats: makeStats(),
    };
    const result = convertSchemaToOpenApi(schema);
    expect(result['enum']).toBeUndefined();
  });

  it('converts nested objects recursively', () => {
    const nested = makeObjectSchema({ street: makeStringSchema() }, ['street']);
    const schema = makeObjectSchema({ address: nested }, ['address']);
    const result = convertSchemaToOpenApi(schema);
    const addressProp = (result['properties'] as Record<string, Record<string, unknown>>)['address'];
    expect(addressProp['type']).toBe('object');
    expect(addressProp['properties']).toBeDefined();
  });

  it('does not include properties key for empty object', () => {
    const schema: InferredSchema = { type: 'object', stats: makeStats() };
    const result = convertSchemaToOpenApi(schema);
    expect(result['properties']).toBeUndefined();
  });
});

// ============================================================
// Task 5.2 — extractPathParameters
// ============================================================

describe('extractPathParameters', () => {
  it('returns empty for path with no parameters', () => {
    expect(extractPathParameters('/users')).toHaveLength(0);
  });

  it('extracts single path parameter', () => {
    const params = extractPathParameters('/users/{id}');
    expect(params).toHaveLength(1);
    expect(params[0]['name']).toBe('id');
    expect(params[0]['in']).toBe('path');
    expect(params[0]['required']).toBe(true);
    expect((params[0]['schema'] as Record<string, unknown>)['type']).toBe('string');
  });

  it('extracts multiple path parameters', () => {
    const params = extractPathParameters('/users/{userId}/orders/{orderId}');
    expect(params).toHaveLength(2);
    expect(params[0]['name']).toBe('userId');
    expect(params[1]['name']).toBe('orderId');
  });

  it('handles path with api versioning', () => {
    const params = extractPathParameters('/api/v1/users/{id}');
    expect(params).toHaveLength(1);
    expect(params[0]['name']).toBe('id');
  });
});

// ============================================================
// Task 5.2 — generateOperationId
// ============================================================

describe('generateOperationId', () => {
  it('generates getUsers for GET /users', () => {
    expect(generateOperationId('GET', '/users')).toBe('getUsers');
  });

  it('generates postUsers for POST /users', () => {
    expect(generateOperationId('POST', '/users')).toBe('postUsers');
  });

  it('generates getUsersId for GET /users/{id}', () => {
    expect(generateOperationId('GET', '/users/{id}')).toBe('getUsersId');
  });

  it('generates getUsersUserId for GET /users/{userId}', () => {
    expect(generateOperationId('GET', '/users/{userId}')).toBe('getUsersUserId');
  });

  it('generates deleteUsersUserIdOrdersOrderId for DELETE /users/{userId}/orders/{orderId}', () => {
    const result = generateOperationId('DELETE', '/users/{userId}/orders/{orderId}');
    expect(result).toBe('deleteUsersUserIdOrdersOrderId');
  });

  it('handles root path', () => {
    expect(generateOperationId('GET', '/')).toBe('get');
  });

  it('handles lowercase method', () => {
    expect(generateOperationId('get', '/users')).toBe('getUsers');
  });

  it('handles PUT method', () => {
    expect(generateOperationId('PUT', '/users/{id}')).toBe('putUsersId');
  });
});

// ============================================================
// Task 5.3 — buildOperationObject
// ============================================================

describe('buildOperationObject', () => {
  it('includes operationId', () => {
    const schema = makeAggregatedSchema({ httpMethod: 'GET', path: '/users' });
    const op = buildOperationObject(schema);
    expect(op['operationId']).toBe('getUsers');
  });

  it('includes summary', () => {
    const schema = makeAggregatedSchema({ httpMethod: 'GET', path: '/users' });
    const op = buildOperationObject(schema);
    expect(op['summary']).toBeDefined();
    expect(typeof op['summary']).toBe('string');
  });

  it('includes path parameters for templated paths', () => {
    const schema = makeAggregatedSchema({ httpMethod: 'GET', path: '/users/{userId}' });
    const op = buildOperationObject(schema);
    const params = op['parameters'] as Array<Record<string, unknown>>;
    expect(params).toBeDefined();
    expect(params.some((p) => p['name'] === 'userId' && p['in'] === 'path')).toBe(true);
  });

  it('does not include parameters when path has no templates', () => {
    const schema = makeAggregatedSchema({ httpMethod: 'GET', path: '/users' });
    const op = buildOperationObject(schema);
    expect(op['parameters']).toBeUndefined();
  });

  it('includes request body when requestSchema present', () => {
    const schema = makeAggregatedSchema({
      httpMethod: 'POST',
      path: '/users',
      requestSchema: makeObjectSchema({ name: makeStringSchema() }, ['name']),
    });
    const op = buildOperationObject(schema);
    expect(op['requestBody']).toBeDefined();
    const requestBody = op['requestBody'] as Record<string, unknown>;
    const content = requestBody['content'] as Record<string, unknown>;
    expect(content['application/json']).toBeDefined();
  });

  it('does not include requestBody when no requestSchema', () => {
    const schema = makeAggregatedSchema({ requestSchema: undefined });
    const op = buildOperationObject(schema);
    expect(op['requestBody']).toBeUndefined();
  });

  it('includes responses for each status code', () => {
    const schema = makeAggregatedSchema({
      responseSchemas: {
        '200': makeObjectSchema({ id: makeIntegerSchema() }),
        '404': makeObjectSchema({ message: makeStringSchema() }),
      },
    });
    const op = buildOperationObject(schema);
    const responses = op['responses'] as Record<string, unknown>;
    expect(responses['200']).toBeDefined();
    expect(responses['404']).toBeDefined();
  });

  it('adds default 200 response when no responseSchemas', () => {
    const schema = makeAggregatedSchema({ responseSchemas: undefined });
    const op = buildOperationObject(schema);
    const responses = op['responses'] as Record<string, unknown>;
    expect(responses['200']).toBeDefined();
  });

  it('uses description only for status 204 (no content)', () => {
    const schema = makeAggregatedSchema({
      responseSchemas: {
        '204': { type: 'null', stats: makeStats() },
      },
    });
    const op = buildOperationObject(schema);
    const responses = op['responses'] as Record<string, unknown>;
    const response204 = responses['204'] as Record<string, unknown>;
    expect(response204['description']).toBe('No Content');
    expect(response204['content']).toBeUndefined();
  });

  it('includes header parameters from requestHeaders (excluding auth and transport headers)', () => {
    const schema = makeAggregatedSchema({
      requestHeaders: [
        { name: 'X-Request-ID', example: 'abc-123' },
        { name: 'Authorization', example: 'Bearer ***' },
        { name: 'Content-Type', example: 'application/json' },
      ],
    });
    const op = buildOperationObject(schema);
    const params = op['parameters'] as Array<Record<string, unknown>>;
    expect(params).toBeDefined();
    // Should have X-Request-ID, but NOT Authorization (auth) or Content-Type (transport)
    const names = params.map((p) => p['name']);
    expect(names).toContain('X-Request-ID');
    expect(names).not.toContain('Content-Type');
    expect(names).not.toContain('Authorization');
  });

  it('excludes x-api-key from header parameters', () => {
    const schema = makeAggregatedSchema({
      requestHeaders: [
        { name: 'X-API-Key', example: '***' },
        { name: 'X-Custom-Header', example: 'value' },
      ],
    });
    const op = buildOperationObject(schema);
    const params = op['parameters'] as Array<Record<string, unknown>>;
    const names = params.map((p) => p['name']);
    expect(names).not.toContain('X-API-Key');
    expect(names).toContain('X-Custom-Header');
  });

  it('excludes transport headers (accept, user-agent, content-type, content-length, accept-encoding, host)', () => {
    const schema = makeAggregatedSchema({
      requestHeaders: [
        { name: 'accept', example: 'application/json' },
        { name: 'user-agent', example: 'curl/7.88' },
        { name: 'content-type', example: 'application/json' },
        { name: 'content-length', example: '42' },
        { name: 'accept-encoding', example: 'gzip, deflate' },
        { name: 'host', example: 'api.example.com' },
        { name: 'X-Custom-Header', example: 'keep-me' },
      ],
    });
    const op = buildOperationObject(schema);
    const params = op['parameters'] as Array<Record<string, unknown>>;
    const names = params.map((p) => p['name']);
    expect(names).toEqual(['X-Custom-Header']);
  });

  it('excludes transport headers case-insensitively', () => {
    const schema = makeAggregatedSchema({
      requestHeaders: [
        { name: 'Accept', example: 'application/json' },
        { name: 'USER-AGENT', example: 'curl/7.88' },
        { name: 'Content-Type', example: 'application/json' },
        { name: 'Host', example: 'api.example.com' },
        { name: 'X-Trace-ID', example: 'trace-456' },
      ],
    });
    const op = buildOperationObject(schema);
    const params = op['parameters'] as Array<Record<string, unknown>>;
    const names = params.map((p) => p['name']);
    expect(names).toContain('X-Trace-ID');
    expect(names).not.toContain('Accept');
    expect(names).not.toContain('USER-AGENT');
    expect(names).not.toContain('Content-Type');
    expect(names).not.toContain('Host');
  });

  it('includes non-transport, non-auth custom headers', () => {
    const schema = makeAggregatedSchema({
      requestHeaders: [
        { name: 'X-Request-ID', example: 'abc-123' },
        { name: 'X-Correlation-ID', example: 'corr-456' },
        { name: 'X-Tenant-ID', example: 'tenant-789' },
      ],
    });
    const op = buildOperationObject(schema);
    const params = op['parameters'] as Array<Record<string, unknown>>;
    const names = params.map((p) => p['name']);
    expect(names).toEqual(['X-Request-ID', 'X-Correlation-ID', 'X-Tenant-ID']);
  });
});

// ============================================================
// Task 5.4 — addMetadataExtensions
// ============================================================

describe('addMetadataExtensions', () => {
  it('adds x-specwatch-sample-count extension', () => {
    const schema = makeAggregatedSchema({ sampleCount: 42 });
    const op = addMetadataExtensions({}, schema, true);
    expect(op['x-specwatch-sample-count']).toBe(42);
  });

  it('adds x-specwatch-confidence extension', () => {
    const schema = makeAggregatedSchema({ confidenceScore: 0.85 });
    const op = addMetadataExtensions({}, schema, true);
    expect(op['x-specwatch-confidence']).toBe(0.85);
  });

  it('does not add extensions when includeMetadata is false', () => {
    const schema = makeAggregatedSchema({ sampleCount: 42, confidenceScore: 0.85 });
    const op = addMetadataExtensions({}, schema, false);
    expect(op['x-specwatch-sample-count']).toBeUndefined();
    expect(op['x-specwatch-confidence']).toBeUndefined();
  });

  it('preserves existing operation properties', () => {
    const schema = makeAggregatedSchema();
    const op = addMetadataExtensions({ operationId: 'getUsers' }, schema, true);
    expect(op['operationId']).toBe('getUsers');
  });

  it('adds x-specwatch-unique-response-shapes when present and includeMetadata is true', () => {
    const schema = makeAggregatedSchema({ uniqueResponseShapes: 3 });
    const op = addMetadataExtensions({}, schema, true);
    expect(op['x-specwatch-unique-response-shapes']).toBe(3);
  });

  it('does not add x-specwatch-unique-response-shapes when includeMetadata is false', () => {
    const schema = makeAggregatedSchema({ uniqueResponseShapes: 3 });
    const op = addMetadataExtensions({}, schema, false);
    expect(op['x-specwatch-unique-response-shapes']).toBeUndefined();
  });

  it('does not add x-specwatch-unique-response-shapes when not set on schema', () => {
    const schema = makeAggregatedSchema();
    const op = addMetadataExtensions({}, schema, true);
    expect(op['x-specwatch-unique-response-shapes']).toBeUndefined();
  });
});

// ============================================================
// Task 5.5 — buildOpenApiDocument
// ============================================================

describe('buildOpenApiDocument', () => {
  it('produces valid OpenAPI 3.1 structure', () => {
    const schemas = [
      makeAggregatedSchema({ httpMethod: 'GET', path: '/users' }),
    ];
    const doc = buildOpenApiDocument(schemas);
    expect(doc['openapi']).toBe('3.1.0');
    expect(doc['info']).toBeDefined();
    expect(doc['paths']).toBeDefined();
  });

  it('uses provided title and version', () => {
    const schemas = [makeAggregatedSchema()];
    const doc = buildOpenApiDocument(schemas, { title: 'My API', version: '2.0.0' });
    const info = doc['info'] as Record<string, unknown>;
    expect(info['title']).toBe('My API');
    expect(info['version']).toBe('2.0.0');
  });

  it('uses default title when not provided', () => {
    const schemas = [makeAggregatedSchema()];
    const doc = buildOpenApiDocument(schemas);
    const info = doc['info'] as Record<string, unknown>;
    expect(info['title']).toBe('API');
  });

  it('includes sample count and endpoint count in description', () => {
    const schemas = [
      makeAggregatedSchema({ sampleCount: 25 }),
      makeAggregatedSchema({ sampleCount: 15, path: '/orders' }),
    ];
    const doc = buildOpenApiDocument(schemas);
    const info = doc['info'] as Record<string, unknown>;
    expect(info['description']).toContain('40'); // 25 + 15
    expect(info['description']).toContain('2'); // 2 endpoints
  });

  it('groups multiple schemas for same path under same path key', () => {
    const schemas = [
      makeAggregatedSchema({ httpMethod: 'GET', path: '/users' }),
      makeAggregatedSchema({ httpMethod: 'POST', path: '/users' }),
    ];
    const doc = buildOpenApiDocument(schemas);
    const paths = doc['paths'] as Record<string, Record<string, unknown>>;
    expect(paths['/users']).toBeDefined();
    expect(paths['/users']['get']).toBeDefined();
    expect(paths['/users']['post']).toBeDefined();
  });

  it('uses provided description', () => {
    const schemas = [makeAggregatedSchema()];
    const doc = buildOpenApiDocument(schemas, { description: 'Custom description' });
    const info = doc['info'] as Record<string, unknown>;
    expect(info['description']).toBe('Custom description');
  });
});

// ============================================================
// Task 5.5 — serializeOpenApi
// ============================================================

describe('serializeOpenApi', () => {
  const sampleDoc = {
    openapi: '3.1.0',
    info: { title: 'Test API', version: '1.0.0' },
    paths: {},
  };

  it('serializes to YAML by default', () => {
    const result = serializeOpenApi(sampleDoc);
    expect(result).toContain('openapi:');
    expect(result).toContain('3.1.0');
    expect(result).toContain('info:');
    // Should NOT start with '{' (JSON)
    expect(result.trim()).not.toMatch(/^\{/);
  });

  it('serializes to JSON when format is json', () => {
    const result = serializeOpenApi(sampleDoc, 'json');
    expect(() => JSON.parse(result)).not.toThrow();
    const parsed = JSON.parse(result);
    expect(parsed['openapi']).toBe('3.1.0');
  });

  it('produces valid 2-space indented JSON', () => {
    const result = serializeOpenApi(sampleDoc, 'json');
    // Should have 2-space indentation
    expect(result).toContain('  "info":');
  });

  it('YAML output contains path data', () => {
    const doc = {
      openapi: '3.1.0',
      paths: {
        '/users': {
          get: { operationId: 'getUsers' },
        },
      },
    };
    const result = serializeOpenApi(doc);
    expect(result).toContain('/users');
    expect(result).toContain('getUsers');
  });

  it('roundtrips: serialize JSON and parse back', () => {
    const schemas = [makeAggregatedSchema({ httpMethod: 'GET', path: '/users' })];
    const doc = buildOpenApiDocument(schemas, { title: 'Test', version: '1.0.0' });
    const json = serializeOpenApi(doc, 'json');
    const parsed = JSON.parse(json);
    expect(parsed['openapi']).toBe('3.1.0');
    expect(parsed['paths']['/users']).toBeDefined();
  });
});

// ============================================================
// buildPathsObject
// ============================================================

describe('buildPathsObject', () => {
  it('returns empty object for no schemas', () => {
    const result = buildPathsObject([]);
    expect(Object.keys(result)).toHaveLength(0);
  });

  it('creates path entries for each unique path', () => {
    const schemas = [
      makeAggregatedSchema({ httpMethod: 'GET', path: '/users' }),
      makeAggregatedSchema({ httpMethod: 'GET', path: '/orders' }),
    ];
    const result = buildPathsObject(schemas);
    expect(result['/users']).toBeDefined();
    expect(result['/orders']).toBeDefined();
  });

  it('groups multiple methods under same path', () => {
    const schemas = [
      makeAggregatedSchema({ httpMethod: 'GET', path: '/users' }),
      makeAggregatedSchema({ httpMethod: 'POST', path: '/users' }),
    ];
    const result = buildPathsObject(schemas);
    const usersPath = result['/users'] as Record<string, unknown>;
    expect(usersPath['get']).toBeDefined();
    expect(usersPath['post']).toBeDefined();
  });

  it('uses lowercase method as key', () => {
    const schemas = [makeAggregatedSchema({ httpMethod: 'DELETE', path: '/users/{id}' })];
    const result = buildPathsObject(schemas);
    const userPath = result['/users/{id}'] as Record<string, unknown>;
    expect(userPath['delete']).toBeDefined();
    expect(userPath['DELETE']).toBeUndefined();
  });
});

// ============================================================
// detectSecuritySchemes
// ============================================================

describe('detectSecuritySchemes', () => {
  it('detects Bearer auth from Authorization header', () => {
    const schemas = [
      makeAggregatedSchema({
        requestHeaders: [{ name: 'Authorization', example: 'Bearer ***' }],
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
        requestHeaders: [{ name: 'Authorization', example: 'Basic dXNlcjpwYXNz' }],
      }),
    ];
    const result = detectSecuritySchemes(schemas);
    expect(result).toBeDefined();
    expect(result!.securitySchemes['basicAuth']).toEqual({ type: 'http', scheme: 'basic' });
    expect(result!.security).toContainEqual({ basicAuth: [] });
  });

  it('detects X-API-Key header as apiKey security scheme', () => {
    const schemas = [
      makeAggregatedSchema({
        requestHeaders: [{ name: 'X-API-Key', example: '***' }],
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
        requestHeaders: [{ name: 'Authorization', example: 'Bearer ***' }],
        path: '/users',
      }),
      makeAggregatedSchema({
        requestHeaders: [{ name: 'X-API-Key', example: '***' }],
        path: '/orders',
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
        requestHeaders: [{ name: 'X-Request-ID', example: 'abc-123' }],
      }),
    ];
    const result = detectSecuritySchemes(schemas);
    expect(result).toBeUndefined();
  });

  it('returns undefined when no requestHeaders at all', () => {
    const schemas = [makeAggregatedSchema()];
    const result = detectSecuritySchemes(schemas);
    expect(result).toBeUndefined();
  });

  it('does not duplicate schemes when same auth appears on multiple endpoints', () => {
    const schemas = [
      makeAggregatedSchema({
        requestHeaders: [{ name: 'Authorization', example: 'Bearer ***' }],
        path: '/users',
      }),
      makeAggregatedSchema({
        requestHeaders: [{ name: 'Authorization', example: 'Bearer ***' }],
        path: '/orders',
      }),
    ];
    const result = detectSecuritySchemes(schemas);
    expect(result).toBeDefined();
    expect(Object.keys(result!.securitySchemes)).toHaveLength(1);
    expect(result!.security).toHaveLength(1);
  });
});

// ============================================================
// buildOpenApiDocument — securitySchemes integration
// ============================================================

describe('buildOpenApiDocument securitySchemes', () => {
  it('includes securitySchemes in components when Bearer auth detected', () => {
    const schemas = [
      makeAggregatedSchema({
        requestHeaders: [{ name: 'Authorization', example: 'Bearer ***' }],
      }),
    ];
    const doc = buildOpenApiDocument(schemas);
    const components = doc['components'] as Record<string, unknown>;
    expect(components).toBeDefined();
    const securitySchemes = components['securitySchemes'] as Record<string, unknown>;
    expect(securitySchemes['bearerAuth']).toEqual({ type: 'http', scheme: 'bearer' });
  });

  it('includes top-level security array when auth detected', () => {
    const schemas = [
      makeAggregatedSchema({
        requestHeaders: [{ name: 'Authorization', example: 'Bearer ***' }],
      }),
    ];
    const doc = buildOpenApiDocument(schemas);
    const security = doc['security'] as Array<Record<string, unknown[]>>;
    expect(security).toBeDefined();
    expect(security).toContainEqual({ bearerAuth: [] });
  });

  it('does not include components or security when no auth headers', () => {
    const schemas = [makeAggregatedSchema()];
    const doc = buildOpenApiDocument(schemas);
    expect(doc['components']).toBeUndefined();
    expect(doc['security']).toBeUndefined();
  });

  it('YAML round-trip preserves securitySchemes', () => {
    const schemas = [
      makeAggregatedSchema({
        requestHeaders: [
          { name: 'Authorization', example: 'Bearer ***' },
          { name: 'X-API-Key', example: '***' },
        ],
      }),
    ];
    const doc = buildOpenApiDocument(schemas);
    const yamlStr = serializeOpenApi(doc, 'yaml');
    expect(yamlStr).toContain('securitySchemes');
    expect(yamlStr).toContain('bearerAuth');
    expect(yamlStr).toContain('apiKeyAuth');

    // JSON round-trip
    const jsonStr = serializeOpenApi(doc, 'json');
    const parsed = JSON.parse(jsonStr);
    expect(parsed['components']['securitySchemes']['bearerAuth']).toEqual({
      type: 'http',
      scheme: 'bearer',
    });
    expect(parsed['components']['securitySchemes']['apiKeyAuth']).toEqual({
      type: 'apiKey',
      in: 'header',
      name: 'X-API-Key',
    });
    expect(parsed['security']).toBeDefined();
  });
});

// ============================================================
// Query parameter export
// ============================================================

describe('query parameter export', () => {
  it('includes query params as in:query parameters', () => {
    const schema = makeAggregatedSchema({
      queryParams: { page: ['1', '2'], search: ['foo', 'bar'] },
    });
    const operation = buildOperationObject(schema);
    const params = operation['parameters'] as Array<Record<string, unknown>>;
    const queryParams = params.filter((p) => p['in'] === 'query');
    expect(queryParams).toHaveLength(2);

    const pageParam = queryParams.find((p) => p['name'] === 'page');
    expect(pageParam).toBeDefined();
    expect(pageParam!['required']).toBe(false);
    expect(pageParam!['schema']).toEqual({ type: 'integer' });

    const searchParam = queryParams.find((p) => p['name'] === 'search');
    expect(searchParam).toBeDefined();
    expect(searchParam!['required']).toBe(false);
    expect(searchParam!['schema']).toEqual({ type: 'string' });
  });

  it('infers integer type when all values are numeric', () => {
    const schema = makeAggregatedSchema({
      queryParams: { limit: ['10', '20', '50'] },
    });
    const operation = buildOperationObject(schema);
    const params = operation['parameters'] as Array<Record<string, unknown>>;
    const limitParam = params.find((p) => p['name'] === 'limit');
    expect(limitParam!['schema']).toEqual({ type: 'integer' });
  });

  it('infers string type when values are mixed', () => {
    const schema = makeAggregatedSchema({
      queryParams: { sort: ['name', 'date', '1'] },
    });
    const operation = buildOperationObject(schema);
    const params = operation['parameters'] as Array<Record<string, unknown>>;
    const sortParam = params.find((p) => p['name'] === 'sort');
    expect(sortParam!['schema']).toEqual({ type: 'string' });
  });

  it('does not add query parameters when queryParams is undefined', () => {
    const schema = makeAggregatedSchema({ queryParams: undefined });
    const operation = buildOperationObject(schema);
    const params = (operation['parameters'] as Array<Record<string, unknown>> | undefined) ?? [];
    const queryParams = params.filter((p) => p['in'] === 'query');
    expect(queryParams).toHaveLength(0);
  });
});

// ============================================================
// Path parameter type inference
// ============================================================

describe('buildOperationObject — path param type inference', () => {
  it('types path params as integer when all observed values are numeric', () => {
    const schema = makeAggregatedSchema({
      path: '/users/{userId}',
      pathParamValues: { userId: ['1', '42', '100'] },
    });
    const operation = buildOperationObject(schema);
    const params = operation['parameters'] as Array<Record<string, unknown>>;
    const userIdParam = params.find((p) => p['name'] === 'userId');
    expect(userIdParam).toBeDefined();
    expect(userIdParam!['schema']).toEqual({ type: 'integer' });
  });

  it('keeps path params as string when values are mixed (UUIDs)', () => {
    const schema = makeAggregatedSchema({
      path: '/users/{userId}',
      pathParamValues: { userId: ['abc-123', 'def-456'] },
    });
    const operation = buildOperationObject(schema);
    const params = operation['parameters'] as Array<Record<string, unknown>>;
    const userIdParam = params.find((p) => p['name'] === 'userId');
    expect(userIdParam).toBeDefined();
    expect(userIdParam!['schema']).toEqual({ type: 'string' });
  });

  it('keeps path params as string when values are mixed numeric and non-numeric', () => {
    const schema = makeAggregatedSchema({
      path: '/items/{itemId}',
      pathParamValues: { itemId: ['123', 'abc'] },
    });
    const operation = buildOperationObject(schema);
    const params = operation['parameters'] as Array<Record<string, unknown>>;
    const itemIdParam = params.find((p) => p['name'] === 'itemId');
    expect(itemIdParam!['schema']).toEqual({ type: 'string' });
  });

  it('keeps path params as string when no pathParamValues provided (backwards compat)', () => {
    const schema = makeAggregatedSchema({
      path: '/users/{userId}',
    });
    const operation = buildOperationObject(schema);
    const params = operation['parameters'] as Array<Record<string, unknown>>;
    const userIdParam = params.find((p) => p['name'] === 'userId');
    expect(userIdParam!['schema']).toEqual({ type: 'string' });
  });

  it('infers types independently for multiple path params', () => {
    const schema = makeAggregatedSchema({
      path: '/users/{userId}/orders/{orderId}',
      pathParamValues: { userId: ['1', '2'], orderId: ['abc', 'def'] },
    });
    const operation = buildOperationObject(schema);
    const params = operation['parameters'] as Array<Record<string, unknown>>;
    const userIdParam = params.find((p) => p['name'] === 'userId');
    const orderIdParam = params.find((p) => p['name'] === 'orderId');
    expect(userIdParam!['schema']).toEqual({ type: 'integer' });
    expect(orderIdParam!['schema']).toEqual({ type: 'string' });
  });
});
