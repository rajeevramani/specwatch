/**
 * Tests for $ref extraction — moving inline schemas to components/schemas.
 *
 * Verifies:
 * - Schema name generation (PascalCase from method + path + role)
 * - Request/response schemas are extracted into components/schemas
 * - Inline schemas replaced with $ref pointers
 * - Multiple endpoints, multiple status codes
 * - 204 responses (no content) are not extracted
 * - OpenAPI 3.0 conversion preserves $ref and converts component schemas
 * - YAML/JSON round-trip preserves $ref structure
 */

import { describe, it, expect } from 'vitest';
import yaml from 'js-yaml';
import {
  generateSchemaName,
  buildOpenApiDocument,
  convertToOpenApi30,
  serializeOpenApi,
} from '../../src/export/openapi.js';
import type { AggregatedSchema, InferredSchema } from '../../src/inference/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIELD_STATS = { sampleCount: 10, presenceCount: 10, confidence: 1.0 };

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

const USER_SCHEMA: InferredSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer', stats: FIELD_STATS },
    name: { type: 'string', stats: FIELD_STATS },
    email: { type: 'string', format: 'email', stats: FIELD_STATS },
  },
  required: ['id', 'name', 'email'],
  stats: FIELD_STATS,
};

const CREATE_USER_SCHEMA: InferredSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', stats: FIELD_STATS },
    email: { type: 'string', format: 'email', stats: FIELD_STATS },
  },
  required: ['name', 'email'],
  stats: FIELD_STATS,
};

const ERROR_SCHEMA: InferredSchema = {
  type: 'object',
  properties: {
    error: { type: 'string', stats: FIELD_STATS },
    message: { type: 'string', stats: FIELD_STATS },
  },
  stats: FIELD_STATS,
};

// ---------------------------------------------------------------------------
// generateSchemaName
// ---------------------------------------------------------------------------

describe('generateSchemaName', () => {
  it('generates PascalCase name for GET response', () => {
    expect(generateSchemaName('GET', '/users', 'response', '200')).toBe('GetUsersResponse');
  });

  it('generates PascalCase name for POST request', () => {
    expect(generateSchemaName('POST', '/users', 'request')).toBe('PostUsersRequest');
  });

  it('includes path params in name', () => {
    expect(generateSchemaName('GET', '/users/{userId}', 'response', '200')).toBe(
      'GetUsersUserIdResponse',
    );
  });

  it('appends status code for non-200 responses', () => {
    expect(generateSchemaName('GET', '/users/{userId}', 'response', '404')).toBe(
      'GetUsersUserIdResponse404',
    );
  });

  it('does not append status code for 200 responses', () => {
    expect(generateSchemaName('GET', '/users', 'response', '200')).toBe('GetUsersResponse');
  });

  it('handles deeply nested paths', () => {
    expect(generateSchemaName('PUT', '/users/{userId}/orders/{orderId}', 'request')).toBe(
      'PutUsersUserIdOrdersOrderIdRequest',
    );
  });

  it('handles DELETE method', () => {
    expect(generateSchemaName('DELETE', '/users/{userId}', 'response', '204')).toBe(
      'DeleteUsersUserIdResponse204',
    );
  });

  it('handles PATCH method', () => {
    expect(generateSchemaName('PATCH', '/users/{userId}', 'request')).toBe(
      'PatchUsersUserIdRequest',
    );
  });

  it('handles root path', () => {
    expect(generateSchemaName('GET', '/', 'response', '200')).toBe('GetResponse');
  });

  it('handles api versioned paths', () => {
    expect(generateSchemaName('GET', '/api/v1/users', 'response', '200')).toBe(
      'GetApiV1UsersResponse',
    );
  });

  it('appends 201 status code suffix', () => {
    expect(generateSchemaName('POST', '/users', 'response', '201')).toBe(
      'PostUsersResponse201',
    );
  });

  it('appends 500 status code suffix', () => {
    expect(generateSchemaName('GET', '/users', 'response', '500')).toBe(
      'GetUsersResponse500',
    );
  });
});

// ---------------------------------------------------------------------------
// $ref extraction in buildOpenApiDocument
// ---------------------------------------------------------------------------

describe('$ref extraction', () => {
  it('extracts response schema into components/schemas with $ref', () => {
    const doc = buildOpenApiDocument([
      makeAggregatedSchema({
        httpMethod: 'GET',
        path: '/users',
        responseSchemas: { '200': USER_SCHEMA },
      }),
    ]);

    // Operation should have $ref
    const paths = doc['paths'] as Record<string, Record<string, Record<string, unknown>>>;
    const responses = paths['/users']['get']['responses'] as Record<string, Record<string, unknown>>;
    const content = responses['200']['content'] as Record<string, Record<string, unknown>>;
    const schema = content['application/json']['schema'] as Record<string, unknown>;
    expect(schema['$ref']).toBe('#/components/schemas/GetUsersResponse');

    // Schema should be in components/schemas
    const components = doc['components'] as Record<string, Record<string, unknown>>;
    expect(components['schemas']['GetUsersResponse']).toBeDefined();
    const extracted = components['schemas']['GetUsersResponse'] as Record<string, unknown>;
    expect(extracted['type']).toBe('object');
    expect(extracted['required']).toEqual(['id', 'name', 'email']);
  });

  it('extracts request schema into components/schemas with $ref', () => {
    const doc = buildOpenApiDocument([
      makeAggregatedSchema({
        httpMethod: 'POST',
        path: '/users',
        requestSchema: CREATE_USER_SCHEMA,
        responseSchemas: { '201': USER_SCHEMA },
      }),
    ]);

    const paths = doc['paths'] as Record<string, Record<string, Record<string, unknown>>>;
    const requestBody = paths['/users']['post']['requestBody'] as Record<string, unknown>;
    const content = requestBody['content'] as Record<string, Record<string, unknown>>;
    const schema = content['application/json']['schema'] as Record<string, unknown>;
    expect(schema['$ref']).toBe('#/components/schemas/PostUsersRequest');

    const components = doc['components'] as Record<string, Record<string, unknown>>;
    expect(components['schemas']['PostUsersRequest']).toBeDefined();
    const extracted = components['schemas']['PostUsersRequest'] as Record<string, unknown>;
    expect(extracted['type']).toBe('object');
    expect(extracted['required']).toEqual(['name', 'email']);
  });

  it('handles multiple status codes for same endpoint', () => {
    const doc = buildOpenApiDocument([
      makeAggregatedSchema({
        httpMethod: 'GET',
        path: '/users/{userId}',
        responseSchemas: { '200': USER_SCHEMA, '404': ERROR_SCHEMA },
      }),
    ]);

    const paths = doc['paths'] as Record<string, Record<string, Record<string, unknown>>>;
    const responses = paths['/users/{userId}']['get']['responses'] as Record<
      string,
      Record<string, unknown>
    >;

    // 200 response
    const content200 = responses['200']['content'] as Record<string, Record<string, unknown>>;
    expect((content200['application/json']['schema'] as Record<string, unknown>)['$ref']).toBe(
      '#/components/schemas/GetUsersUserIdResponse',
    );

    // 404 response
    const content404 = responses['404']['content'] as Record<string, Record<string, unknown>>;
    expect((content404['application/json']['schema'] as Record<string, unknown>)['$ref']).toBe(
      '#/components/schemas/GetUsersUserIdResponse404',
    );

    // Both schemas exist in components
    const components = doc['components'] as Record<string, Record<string, unknown>>;
    expect(components['schemas']['GetUsersUserIdResponse']).toBeDefined();
    expect(components['schemas']['GetUsersUserIdResponse404']).toBeDefined();
  });

  it('extracts schemas from multiple endpoints', () => {
    const doc = buildOpenApiDocument([
      makeAggregatedSchema({
        id: 1,
        httpMethod: 'GET',
        path: '/users',
        responseSchemas: { '200': USER_SCHEMA },
      }),
      makeAggregatedSchema({
        id: 2,
        httpMethod: 'POST',
        path: '/users',
        requestSchema: CREATE_USER_SCHEMA,
        responseSchemas: { '201': USER_SCHEMA },
      }),
      makeAggregatedSchema({
        id: 3,
        httpMethod: 'GET',
        path: '/users/{userId}',
        responseSchemas: { '200': USER_SCHEMA, '404': ERROR_SCHEMA },
      }),
    ]);

    const components = doc['components'] as Record<string, Record<string, unknown>>;
    const schemas = components['schemas'] as Record<string, unknown>;

    expect(schemas['GetUsersResponse']).toBeDefined();
    expect(schemas['PostUsersRequest']).toBeDefined();
    expect(schemas['PostUsersResponse201']).toBeDefined();
    expect(schemas['GetUsersUserIdResponse']).toBeDefined();
    expect(schemas['GetUsersUserIdResponse404']).toBeDefined();
  });

  it('does not extract 204 responses (no content)', () => {
    const emptySchema: InferredSchema = {
      type: 'object',
      properties: {},
      stats: FIELD_STATS,
    };

    const doc = buildOpenApiDocument([
      makeAggregatedSchema({
        httpMethod: 'DELETE',
        path: '/users/{userId}',
        responseSchemas: { '204': emptySchema },
      }),
    ]);

    // 204 should have no content block
    const paths = doc['paths'] as Record<string, Record<string, Record<string, unknown>>>;
    const responses = paths['/users/{userId}']['delete']['responses'] as Record<
      string,
      Record<string, unknown>
    >;
    expect(responses['204']['description']).toBe('No Content');
    expect(responses['204']['content']).toBeUndefined();

    // No schemas should be extracted (no components/schemas)
    const components = doc['components'] as Record<string, unknown> | undefined;
    if (components !== undefined) {
      expect(components['schemas']).toBeUndefined();
    }
  });

  it('strips stats from extracted schemas', () => {
    const doc = buildOpenApiDocument([
      makeAggregatedSchema({
        httpMethod: 'GET',
        path: '/users',
        responseSchemas: { '200': USER_SCHEMA },
      }),
    ]);

    const serialized = JSON.stringify(doc);
    expect(serialized).not.toContain('"stats"');
    expect(serialized).not.toContain('"sampleCount"');
    expect(serialized).not.toContain('"presenceCount"');
  });

  it('components includes both securitySchemes and schemas when auth is present', () => {
    const doc = buildOpenApiDocument([
      makeAggregatedSchema({
        httpMethod: 'GET',
        path: '/users',
        responseSchemas: { '200': USER_SCHEMA },
        requestHeaders: [{ name: 'Authorization', example: 'Bearer token123' }],
      }),
    ]);

    const components = doc['components'] as Record<string, unknown>;
    expect(components['securitySchemes']).toBeDefined();
    expect(components['schemas']).toBeDefined();
    expect(
      (components['schemas'] as Record<string, unknown>)['GetUsersResponse'],
    ).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Collision detection in SchemaCollector
// ---------------------------------------------------------------------------

describe('$ref collision detection', () => {
  it('reuses the same $ref when identical schemas collide on the same name', () => {
    // Two endpoints that produce the same generated schema name with identical schemas.
    // We simulate this by having two endpoints whose response schemas are structurally
    // identical — the collector should NOT create a second entry.
    const identicalSchema: InferredSchema = {
      type: 'object',
      properties: {
        error: { type: 'string', stats: FIELD_STATS },
        message: { type: 'string', stats: FIELD_STATS },
      },
      stats: FIELD_STATS,
    };

    // GET /users 404 and GET /users/{userId} 404 both produce error schemas.
    // We deliberately construct a scenario where the same name is generated twice
    // by using same method + path + role + statusCode for two schemas passed in sequence.
    // The easiest way: two aggregated schemas on the same path/method with the same
    // response status — but buildOpenApiDocument groups by path so the second overwrites.
    // Instead, let's directly test via a single endpoint with request + response using
    // the same generated name — but that's not possible either.
    //
    // Simplest realistic scenario: two separate endpoints whose 404 error responses
    // have the same schema structure. They'll have different names by default
    // (GetUsersResponse404 vs GetUsersUserIdResponse404), so no collision.
    //
    // The actual collision happens when custom code or edge cases produce the same name.
    // Let's test with endpoints that legitimately collide: e.g., two endpoints that
    // both reuse the same path/method but with different response schemas on the same
    // status code — in practice this would be a data race or misconfiguration.
    //
    // The most realistic collision: buildOpenApiDocument processes schemas sequentially,
    // and the same endpoint appears in the input twice with identical response schemas.
    const doc = buildOpenApiDocument([
      makeAggregatedSchema({
        id: 1,
        httpMethod: 'GET',
        path: '/users',
        responseSchemas: { '200': USER_SCHEMA, '404': identicalSchema },
      }),
      makeAggregatedSchema({
        id: 2,
        httpMethod: 'GET',
        path: '/users',
        responseSchemas: { '200': USER_SCHEMA, '404': identicalSchema },
      }),
    ]);

    const components = doc['components'] as Record<string, Record<string, unknown>>;
    const schemas = components['schemas'] as Record<string, unknown>;

    // The identical schemas should be deduplicated — no "GetUsersResponse2" should exist
    expect(schemas['GetUsersResponse']).toBeDefined();
    expect(schemas['GetUsersResponse2']).toBeUndefined();
    expect(schemas['GetUsersResponse4042']).toBeUndefined();
  });

  it('appends numeric suffix when different schemas collide on the same name', () => {
    // Two endpoints on the same path/method with structurally DIFFERENT response schemas
    // for the same status code. The second registration should get a suffixed name.
    const schemaA: InferredSchema = {
      type: 'object',
      properties: {
        id: { type: 'integer', stats: FIELD_STATS },
        name: { type: 'string', stats: FIELD_STATS },
      },
      required: ['id', 'name'],
      stats: FIELD_STATS,
    };

    const schemaB: InferredSchema = {
      type: 'object',
      properties: {
        id: { type: 'string', stats: FIELD_STATS },
        label: { type: 'string', stats: FIELD_STATS },
        active: { type: 'boolean', stats: FIELD_STATS },
      },
      required: ['id', 'label'],
      stats: FIELD_STATS,
    };

    const doc = buildOpenApiDocument([
      makeAggregatedSchema({
        id: 1,
        httpMethod: 'GET',
        path: '/users',
        responseSchemas: { '200': schemaA },
      }),
      makeAggregatedSchema({
        id: 2,
        httpMethod: 'GET',
        path: '/users',
        responseSchemas: { '200': schemaB },
      }),
    ]);

    const components = doc['components'] as Record<string, Record<string, unknown>>;
    const schemas = components['schemas'] as Record<string, unknown>;

    // First schema keeps the original name
    expect(schemas['GetUsersResponse']).toBeDefined();
    const first = schemas['GetUsersResponse'] as Record<string, unknown>;
    expect((first['properties'] as Record<string, unknown>)['name']).toBeDefined();

    // Second schema gets a suffixed name
    expect(schemas['GetUsersResponse2']).toBeDefined();
    const second = schemas['GetUsersResponse2'] as Record<string, unknown>;
    expect((second['properties'] as Record<string, unknown>)['label']).toBeDefined();
    expect((second['properties'] as Record<string, unknown>)['active']).toBeDefined();

    // The second endpoint's $ref should point to the suffixed name
    const paths = doc['paths'] as Record<string, Record<string, Record<string, unknown>>>;
    const responses = paths['/users']['get']['responses'] as Record<string, Record<string, unknown>>;
    const content = responses['200']['content'] as Record<string, Record<string, unknown>>;
    const schema = content['application/json']['schema'] as Record<string, unknown>;
    // The last-processed endpoint's operation wins for the path (since same path/method),
    // so the $ref should point to the suffixed schema
    expect(schema['$ref']).toBe('#/components/schemas/GetUsersResponse2');
  });

  it('increments suffix correctly for multiple collisions', () => {
    const makeSchema = (fieldName: string): InferredSchema => ({
      type: 'object',
      properties: {
        [fieldName]: { type: 'string', stats: FIELD_STATS },
      },
      stats: FIELD_STATS,
    });

    const doc = buildOpenApiDocument([
      makeAggregatedSchema({
        id: 1,
        httpMethod: 'GET',
        path: '/users',
        responseSchemas: { '200': makeSchema('alpha') },
      }),
      makeAggregatedSchema({
        id: 2,
        httpMethod: 'GET',
        path: '/users',
        responseSchemas: { '200': makeSchema('beta') },
      }),
      makeAggregatedSchema({
        id: 3,
        httpMethod: 'GET',
        path: '/users',
        responseSchemas: { '200': makeSchema('gamma') },
      }),
    ]);

    const components = doc['components'] as Record<string, Record<string, unknown>>;
    const schemas = components['schemas'] as Record<string, unknown>;

    expect(schemas['GetUsersResponse']).toBeDefined();
    expect(schemas['GetUsersResponse2']).toBeDefined();
    expect(schemas['GetUsersResponse3']).toBeDefined();

    // Each has a different field
    const s1 = schemas['GetUsersResponse'] as Record<string, Record<string, unknown>>;
    const s2 = schemas['GetUsersResponse2'] as Record<string, Record<string, unknown>>;
    const s3 = schemas['GetUsersResponse3'] as Record<string, Record<string, unknown>>;
    expect(s1['properties']['alpha']).toBeDefined();
    expect(s2['properties']['beta']).toBeDefined();
    expect(s3['properties']['gamma']).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// $ref in OpenAPI 3.0 conversion
// ---------------------------------------------------------------------------

describe('$ref extraction with OpenAPI 3.0 conversion', () => {
  it('preserves $ref pointers after 3.0 conversion', () => {
    const doc31 = buildOpenApiDocument([
      makeAggregatedSchema({
        httpMethod: 'GET',
        path: '/users',
        responseSchemas: { '200': USER_SCHEMA },
      }),
    ]);

    const doc30 = convertToOpenApi30(doc31);
    expect(doc30['openapi']).toBe('3.0.3');

    const paths = doc30['paths'] as Record<string, Record<string, Record<string, unknown>>>;
    const responses = paths['/users']['get']['responses'] as Record<string, Record<string, unknown>>;
    const content = responses['200']['content'] as Record<string, Record<string, unknown>>;
    const schema = content['application/json']['schema'] as Record<string, unknown>;
    expect(schema['$ref']).toBe('#/components/schemas/GetUsersResponse');
  });

  it('converts component schemas to 3.0 format', () => {
    // Create a schema with type arrays (3.1 feature)
    const nullableFieldSchema: InferredSchema = {
      type: 'object',
      properties: {
        name: { type: 'string', stats: FIELD_STATS },
      },
      stats: FIELD_STATS,
    };

    const doc31 = buildOpenApiDocument([
      makeAggregatedSchema({
        httpMethod: 'GET',
        path: '/users',
        responseSchemas: { '200': nullableFieldSchema },
      }),
    ]);

    const doc30 = convertToOpenApi30(doc31);

    // Component schemas should exist and be converted
    const components = doc30['components'] as Record<string, Record<string, unknown>>;
    expect(components['schemas']).toBeDefined();
    expect(components['schemas']['GetUsersResponse']).toBeDefined();
  });

  it('converts 3.1 type arrays in component schemas to 3.0 nullable format', () => {
    // Build a 3.1 doc that has type: ['string', 'null'] in a component schema.
    // We inject this manually since the inference engine doesn't produce type arrays,
    // but the 3.0 converter must handle them if present.
    const doc31 = buildOpenApiDocument([
      makeAggregatedSchema({
        httpMethod: 'GET',
        path: '/users',
        responseSchemas: {
          '200': {
            type: 'object',
            properties: {
              name: { type: 'string', stats: FIELD_STATS },
            },
            stats: FIELD_STATS,
          },
        },
      }),
    ]);

    // Manually inject a type array into the component schema to simulate a 3.1 feature
    const components31 = doc31['components'] as Record<string, Record<string, Record<string, unknown>>>;
    const schemaObj = components31['schemas']['GetUsersResponse'] as Record<string, unknown>;
    const props = schemaObj['properties'] as Record<string, Record<string, unknown>>;
    props['name'] = { type: ['string', 'null'] };

    const doc30 = convertToOpenApi30(doc31);
    const components30 = doc30['components'] as Record<string, Record<string, Record<string, unknown>>>;
    const converted = components30['schemas']['GetUsersResponse'] as Record<string, unknown>;
    const convertedProps = converted['properties'] as Record<string, Record<string, unknown>>;

    expect(convertedProps['name']['type']).toBe('string');
    expect(convertedProps['name']['nullable']).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// YAML and JSON round-trip with $ref
// ---------------------------------------------------------------------------

describe('$ref YAML/JSON round-trip', () => {
  it('$ref survives YAML round-trip', () => {
    const doc = buildOpenApiDocument([
      makeAggregatedSchema({
        httpMethod: 'GET',
        path: '/users',
        responseSchemas: { '200': USER_SCHEMA },
      }),
    ]);

    const yamlStr = serializeOpenApi(doc, 'yaml');
    const parsed = yaml.load(yamlStr) as Record<string, unknown>;

    // Verify $ref in paths
    const paths = parsed['paths'] as Record<string, Record<string, Record<string, unknown>>>;
    const responses = paths['/users']['get']['responses'] as Record<string, Record<string, unknown>>;
    const content = responses[200]['content'] as Record<string, Record<string, unknown>>;
    const schema = content['application/json']['schema'] as Record<string, unknown>;
    expect(schema['$ref']).toBe('#/components/schemas/GetUsersResponse');

    // Verify components/schemas
    const components = parsed['components'] as Record<string, Record<string, unknown>>;
    expect(components['schemas']['GetUsersResponse']).toBeDefined();
  });

  it('$ref survives JSON round-trip', () => {
    const doc = buildOpenApiDocument([
      makeAggregatedSchema({
        httpMethod: 'POST',
        path: '/users',
        requestSchema: CREATE_USER_SCHEMA,
        responseSchemas: { '201': USER_SCHEMA },
      }),
    ]);

    const jsonStr = serializeOpenApi(doc, 'json');
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;

    // Verify $ref for request body
    const paths = parsed['paths'] as Record<string, Record<string, Record<string, unknown>>>;
    const requestBody = paths['/users']['post']['requestBody'] as Record<string, unknown>;
    const reqContent = requestBody['content'] as Record<string, Record<string, unknown>>;
    const reqSchema = reqContent['application/json']['schema'] as Record<string, unknown>;
    expect(reqSchema['$ref']).toBe('#/components/schemas/PostUsersRequest');

    // Verify $ref for response
    const responses = paths['/users']['post']['responses'] as Record<string, Record<string, unknown>>;
    const resContent = responses['201']['content'] as Record<string, Record<string, unknown>>;
    const resSchema = resContent['application/json']['schema'] as Record<string, unknown>;
    expect(resSchema['$ref']).toBe('#/components/schemas/PostUsersResponse201');

    // Verify components
    const components = parsed['components'] as Record<string, Record<string, unknown>>;
    expect(components['schemas']['PostUsersRequest']).toBeDefined();
    expect(components['schemas']['PostUsersResponse201']).toBeDefined();
  });

  it('YAML output contains $ref syntax', () => {
    const doc = buildOpenApiDocument([
      makeAggregatedSchema({
        httpMethod: 'GET',
        path: '/users',
        responseSchemas: { '200': USER_SCHEMA },
      }),
    ]);

    const yamlStr = serializeOpenApi(doc, 'yaml');
    expect(yamlStr).toContain("$ref: \"#/components/schemas/GetUsersResponse\"");
  });
});
