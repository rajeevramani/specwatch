/**
 * OpenAPI 3.0 export conversion tests.
 *
 * Verifies that convertToOpenApi30 correctly transforms a 3.1 document
 * to 3.0.3 format, including nullable handling and type array conversion.
 */

import { describe, it, expect } from 'vitest';
import {
  buildOpenApiDocument,
  convertToOpenApi30,
  serializeOpenApi,
} from '../../src/export/openapi.js';
import type { AggregatedSchema, InferredSchema } from '../../src/inference/types.js';
import yaml from 'js-yaml';

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

describe('OpenAPI 3.0 conversion', () => {
  it('converts openapi version from 3.1.0 to 3.0.3', () => {
    const schemas = [
      makeAggregatedSchema({
        httpMethod: 'GET',
        path: '/users',
        responseSchemas: { '200': USER_RESPONSE_SCHEMA },
      }),
    ];

    const doc31 = buildOpenApiDocument(schemas, { title: 'Test API' });
    expect(doc31['openapi']).toBe('3.1.0');

    const doc30 = convertToOpenApi30(doc31);
    expect(doc30['openapi']).toBe('3.0.3');
  });

  it('preserves info block through conversion', () => {
    const schemas = [
      makeAggregatedSchema({
        httpMethod: 'GET',
        path: '/users',
        responseSchemas: { '200': USER_RESPONSE_SCHEMA },
      }),
    ];

    const doc31 = buildOpenApiDocument(schemas, { title: 'My API', version: '2.0.0' });
    const doc30 = convertToOpenApi30(doc31);

    const info = doc30['info'] as Record<string, unknown>;
    expect(info['title']).toBe('My API');
    expect(info['version']).toBe('2.0.0');
  });

  it('preserves paths and operations through conversion', () => {
    const schemas = [
      makeAggregatedSchema({
        httpMethod: 'GET',
        path: '/users',
        responseSchemas: { '200': USER_RESPONSE_SCHEMA },
      }),
      makeAggregatedSchema({
        id: 2,
        httpMethod: 'GET',
        path: '/users/{userId}',
        responseSchemas: { '200': USER_RESPONSE_SCHEMA },
      }),
    ];

    const doc31 = buildOpenApiDocument(schemas);
    const doc30 = convertToOpenApi30(doc31);

    const paths = doc30['paths'] as Record<string, unknown>;
    expect(paths).toHaveProperty('/users');
    expect(paths).toHaveProperty('/users/{userId}');
  });

  it('converts type arrays with null to nullable: true', () => {
    // Manually create a 3.1 doc with type arrays (as would come from oneOf resolution)
    const doc31: Record<string, unknown> = {
      openapi: '3.1.0',
      info: { title: 'Test', version: '1.0.0' },
      paths: {
        '/test': {
          get: {
            operationId: 'getTest',
            responses: {
              '200': {
                description: 'OK',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        name: { type: ['string', 'null'] },
                        age: { type: ['integer', 'null'] },
                        active: { type: 'boolean' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    const doc30 = convertToOpenApi30(doc31);
    expect(doc30['openapi']).toBe('3.0.3');

    const paths = doc30['paths'] as Record<string, Record<string, Record<string, unknown>>>;
    const responses = paths['/test']['get']['responses'] as Record<string, Record<string, unknown>>;
    const content = responses['200']['content'] as Record<string, Record<string, unknown>>;
    const schema = content['application/json']['schema'] as Record<string, unknown>;
    const props = schema['properties'] as Record<string, Record<string, unknown>>;

    // name: ['string', 'null'] -> type: 'string', nullable: true
    expect(props['name']['type']).toBe('string');
    expect(props['name']['nullable']).toBe(true);

    // age: ['integer', 'null'] -> type: 'integer', nullable: true
    expect(props['age']['type']).toBe('integer');
    expect(props['age']['nullable']).toBe(true);

    // active: 'boolean' -> unchanged (no array, no nullable)
    expect(props['active']['type']).toBe('boolean');
    expect(props['active']['nullable']).toBeUndefined();
  });

  it('handles nested objects with type arrays', () => {
    const doc31: Record<string, unknown> = {
      openapi: '3.1.0',
      info: { title: 'Test', version: '1.0.0' },
      paths: {
        '/nested': {
          get: {
            operationId: 'getNested',
            responses: {
              '200': {
                description: 'OK',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        user: {
                          type: 'object',
                          properties: {
                            nickname: { type: ['string', 'null'] },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    const doc30 = convertToOpenApi30(doc31);
    const paths = doc30['paths'] as Record<string, Record<string, Record<string, unknown>>>;
    const responses = paths['/nested']['get']['responses'] as Record<
      string,
      Record<string, unknown>
    >;
    const content = responses['200']['content'] as Record<string, Record<string, unknown>>;
    const schema = content['application/json']['schema'] as Record<string, unknown>;
    const props = schema['properties'] as Record<string, Record<string, unknown>>;
    const userProps = props['user']['properties'] as Record<string, Record<string, unknown>>;

    expect(userProps['nickname']['type']).toBe('string');
    expect(userProps['nickname']['nullable']).toBe(true);
  });

  it('handles array items with type arrays', () => {
    const doc31: Record<string, unknown> = {
      openapi: '3.1.0',
      info: { title: 'Test', version: '1.0.0' },
      paths: {
        '/items': {
          get: {
            operationId: 'getItems',
            responses: {
              '200': {
                description: 'OK',
                content: {
                  'application/json': {
                    schema: {
                      type: 'array',
                      items: {
                        type: ['string', 'null'],
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    const doc30 = convertToOpenApi30(doc31);
    const paths = doc30['paths'] as Record<string, Record<string, Record<string, unknown>>>;
    const responses = paths['/items']['get']['responses'] as Record<
      string,
      Record<string, unknown>
    >;
    const content = responses['200']['content'] as Record<string, Record<string, unknown>>;
    const schema = content['application/json']['schema'] as Record<string, unknown>;
    const items = schema['items'] as Record<string, unknown>;

    expect(items['type']).toBe('string');
    expect(items['nullable']).toBe(true);
  });

  it('default buildOpenApiDocument output remains 3.1', () => {
    const schemas = [
      makeAggregatedSchema({
        httpMethod: 'GET',
        path: '/users',
        responseSchemas: { '200': USER_RESPONSE_SCHEMA },
      }),
    ];

    const doc = buildOpenApiDocument(schemas);
    expect(doc['openapi']).toBe('3.1.0');
  });

  it('3.0 document survives YAML round-trip', () => {
    const schemas = [
      makeAggregatedSchema({
        httpMethod: 'GET',
        path: '/users',
        responseSchemas: { '200': USER_RESPONSE_SCHEMA },
      }),
    ];

    const doc31 = buildOpenApiDocument(schemas, { title: 'Round Trip API' });
    const doc30 = convertToOpenApi30(doc31);
    const yamlStr = serializeOpenApi(doc30, 'yaml');
    const parsed = yaml.load(yamlStr) as Record<string, unknown>;

    expect(parsed['openapi']).toBe('3.0.3');
    expect((parsed['info'] as Record<string, unknown>)['title']).toBe('Round Trip API');
    expect(parsed['paths']).toHaveProperty('/users');
  });

  it('3.0 document survives JSON round-trip', () => {
    const schemas = [
      makeAggregatedSchema({
        httpMethod: 'GET',
        path: '/users',
        responseSchemas: { '200': USER_RESPONSE_SCHEMA },
      }),
    ];

    const doc31 = buildOpenApiDocument(schemas, { title: 'JSON API' });
    const doc30 = convertToOpenApi30(doc31);
    const jsonStr = serializeOpenApi(doc30, 'json');
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;

    expect(parsed['openapi']).toBe('3.0.3');
    expect((parsed['info'] as Record<string, unknown>)['title']).toBe('JSON API');
  });

  it('preserves security schemes in 3.0 output', () => {
    const schemas = [
      makeAggregatedSchema({
        httpMethod: 'GET',
        path: '/users',
        requestHeaders: [
          { name: 'Authorization', example: 'Bearer token123' },
        ],
        responseSchemas: { '200': USER_RESPONSE_SCHEMA },
      }),
    ];

    const doc31 = buildOpenApiDocument(schemas);
    const doc30 = convertToOpenApi30(doc31);

    expect(doc30['openapi']).toBe('3.0.3');
    expect(doc30['components']).toBeDefined();
    const components = doc30['components'] as Record<string, unknown>;
    expect(components['securitySchemes']).toBeDefined();
    expect(doc30['security']).toBeDefined();
  });

  it('does not process a "schemas" key that is not under components', () => {
    // A document where "schemas" appears inside a response body description,
    // not under components. It should be recursed into normally (via convertDeep)
    // but NOT treated as component schema definitions (via convertSchemaTo30).
    const doc31: Record<string, unknown> = {
      openapi: '3.1.0',
      info: { title: 'Test', version: '1.0.0' },
      paths: {
        '/meta': {
          get: {
            operationId: 'getMeta',
            responses: {
              '200': {
                description: 'OK',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        // A response field named "schemas" that holds arbitrary data
                        schemas: {
                          type: 'object',
                          properties: {
                            count: { type: ['integer', 'null'] },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    const doc30 = convertToOpenApi30(doc31);
    const paths = doc30['paths'] as Record<string, Record<string, Record<string, unknown>>>;
    const responses = paths['/meta']['get']['responses'] as Record<string, Record<string, unknown>>;
    const content = responses['200']['content'] as Record<string, Record<string, unknown>>;
    const schema = content['application/json']['schema'] as Record<string, unknown>;
    const props = schema['properties'] as Record<string, Record<string, unknown>>;

    // The "schemas" field inside the response body should NOT have been processed
    // by convertSchemaTo30 directly. It is nested inside a "schema" key, so
    // convertSchemaTo30 handles it through normal property recursion.
    // The key point: "schemas.count" with type: ['integer', 'null'] should still
    // be converted (via the parent schema conversion), proving the recursive
    // path works correctly without the special-case schemas handling.
    const schemasField = props['schemas'] as Record<string, unknown>;
    expect(schemasField).toBeDefined();
    const schemasProps = schemasField['properties'] as Record<string, Record<string, unknown>>;
    expect(schemasProps['count']['type']).toBe('integer');
    expect(schemasProps['count']['nullable']).toBe(true);
  });

  it('does not apply convertSchemaTo30 to a top-level custom "schemas" field', () => {
    // Simulate an extension or custom field named "schemas" at the document root.
    // Before the fix, convertDeep would treat this as component schemas and run
    // convertSchemaTo30 on each entry. After the fix, it should recurse normally.
    const doc31: Record<string, unknown> = {
      openapi: '3.1.0',
      info: { title: 'Test', version: '1.0.0' },
      paths: {},
      // Custom top-level "schemas" field (not under components)
      'x-custom': {
        schemas: {
          MyThing: {
            type: ['string', 'null'],
            customField: 'should-be-preserved',
          },
        },
      },
    };

    const doc30 = convertToOpenApi30(doc31);
    const xCustom = doc30['x-custom'] as Record<string, unknown>;
    const schemas = xCustom['schemas'] as Record<string, Record<string, unknown>>;

    // Since this "schemas" is NOT under "components", convertSchemaTo30 should
    // NOT have been applied. The type array should remain as-is (unconverted).
    expect(schemas['MyThing']['type']).toEqual(['string', 'null']);
    expect(schemas['MyThing']['nullable']).toBeUndefined();
    expect(schemas['MyThing']['customField']).toBe('should-be-preserved');
  });

  it('still converts components/schemas correctly after the scoping fix', () => {
    const doc31: Record<string, unknown> = {
      openapi: '3.1.0',
      info: { title: 'Test', version: '1.0.0' },
      paths: {},
      components: {
        schemas: {
          User: {
            type: 'object',
            properties: {
              name: { type: ['string', 'null'] },
            },
          },
        },
      },
    };

    const doc30 = convertToOpenApi30(doc31);
    const components = doc30['components'] as Record<string, unknown>;
    const schemas = components['schemas'] as Record<string, Record<string, unknown>>;
    const userProps = schemas['User']['properties'] as Record<string, Record<string, unknown>>;

    // components/schemas SHOULD be converted
    expect(userProps['name']['type']).toBe('string');
    expect(userProps['name']['nullable']).toBe(true);
  });
});
