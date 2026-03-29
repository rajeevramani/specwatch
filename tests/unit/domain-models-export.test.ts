/**
 * Integration test: domain models produce shared $ref in exported OpenAPI specs.
 *
 * Verifies the full path from aggregated schemas → discoverDomainModels → buildOpenApiDocument,
 * ensuring that shared domain models become $ref entries in components/schemas and that
 * single-use schemas still get per-operation names.
 */

import { describe, it, expect } from 'vitest';
import { buildOpenApiDocument } from '../../src/export/openapi.js';
import { discoverDomainModels } from '../../src/export/domain-models.js';
import type { AggregatedSchema, InferredSchema } from '../../src/inference/types.js';

// ---------------------------------------------------------------------------
// Helpers (mirrored from domain-models.test.ts)
// ---------------------------------------------------------------------------

const FIELD_STATS = { sampleCount: 10, presenceCount: 10, confidence: 1.0 };

function makeAggregatedSchema(
  overrides: Partial<AggregatedSchema> & Pick<AggregatedSchema, 'httpMethod' | 'path'>,
): AggregatedSchema {
  return {
    id: 1,
    sessionId: 'test-session',
    version: 1,
    snapshot: 1,
    sampleCount: 10,
    confidenceScore: 0.9,
    firstObserved: '2026-01-01T00:00:00Z',
    lastObserved: '2026-01-02T00:00:00Z',
    ...overrides,
  };
}

/** User schema: {id, name, email} — appears on multiple endpoints → domain model */
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

/** Order schema: different shape, only one endpoint → no domain model */
const ORDER_SCHEMA: InferredSchema = {
  type: 'object',
  properties: {
    orderId: { type: 'integer', stats: FIELD_STATS },
    total: { type: 'number', stats: FIELD_STATS },
    status: { type: 'string', stats: FIELD_STATS },
  },
  required: ['orderId', 'total', 'status'],
  stats: FIELD_STATS,
};

/** Array-of-users schema for GET /users */
const ARRAY_OF_USERS: InferredSchema = {
  type: 'array',
  items: USER_SCHEMA,
  stats: FIELD_STATS,
};

// ---------------------------------------------------------------------------
// Test schemas
// ---------------------------------------------------------------------------

function buildTestSchemas(): AggregatedSchema[] {
  return [
    makeAggregatedSchema({
      id: 1,
      httpMethod: 'GET',
      path: '/users/{userId}',
      responseSchemas: { '200': USER_SCHEMA },
    }),
    makeAggregatedSchema({
      id: 2,
      httpMethod: 'POST',
      path: '/users',
      responseSchemas: { '200': USER_SCHEMA },
    }),
    makeAggregatedSchema({
      id: 3,
      httpMethod: 'GET',
      path: '/users',
      responseSchemas: { '200': ARRAY_OF_USERS },
    }),
    makeAggregatedSchema({
      id: 4,
      httpMethod: 'GET',
      path: '/orders/{orderId}',
      responseSchemas: { '200': ORDER_SCHEMA },
    }),
  ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('domain models → OpenAPI export integration', () => {
  const schemas = buildTestSchemas();
  const registry = discoverDomainModels(schemas);
  const doc = buildOpenApiDocument(schemas, {}, undefined, registry);
  const components = doc['components'] as Record<string, unknown>;
  const componentSchemas = components['schemas'] as Record<string, unknown>;
  const paths = doc['paths'] as Record<string, Record<string, Record<string, unknown>>>;

  it('components/schemas has a "User" key', () => {
    expect(componentSchemas).toHaveProperty('User');
  });

  it('GET /users/{userId} 200 response uses $ref to User', () => {
    const responseSchema = paths['/users/{userId}']['get']['responses'] as Record<string, unknown>;
    const resp200 = responseSchema['200'] as Record<string, unknown>;
    const content = resp200['content'] as Record<string, unknown>;
    const jsonContent = content['application/json'] as Record<string, unknown>;
    expect(jsonContent['schema']).toEqual({ $ref: '#/components/schemas/User' });
  });

  it('POST /users 200 response uses $ref to User', () => {
    const responseSchema = paths['/users']['post']['responses'] as Record<string, unknown>;
    const resp200 = responseSchema['200'] as Record<string, unknown>;
    const content = resp200['content'] as Record<string, unknown>;
    const jsonContent = content['application/json'] as Record<string, unknown>;
    expect(jsonContent['schema']).toEqual({ $ref: '#/components/schemas/User' });
  });

  it('GET /users 200 response uses array with $ref items to User', () => {
    const responseSchema = paths['/users']['get']['responses'] as Record<string, unknown>;
    const resp200 = responseSchema['200'] as Record<string, unknown>;
    const content = resp200['content'] as Record<string, unknown>;
    const jsonContent = content['application/json'] as Record<string, unknown>;
    expect(jsonContent['schema']).toEqual({
      type: 'array',
      items: { $ref: '#/components/schemas/User' },
    });
  });

  it('GET /orders/{orderId} does NOT use a domain model $ref', () => {
    const responseSchema = paths['/orders/{orderId}']['get']['responses'] as Record<string, unknown>;
    const resp200 = responseSchema['200'] as Record<string, unknown>;
    const content = resp200['content'] as Record<string, unknown>;
    const jsonContent = content['application/json'] as Record<string, unknown>;
    const schema = jsonContent['schema'] as Record<string, unknown>;

    // Should be a per-operation $ref, NOT '#/components/schemas/Order'
    // (Order only appears once, so it doesn't qualify as a domain model)
    expect(schema).toHaveProperty('$ref');
    const ref = schema['$ref'] as string;
    expect(ref).not.toBe('#/components/schemas/Order');
    // Should be a per-operation name like GetOrdersOrderIdResponse
    expect(ref).toMatch(/^#\/components\/schemas\/GetOrders/);
  });
});
