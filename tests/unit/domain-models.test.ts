/**
 * Tests for domain model discovery — cross-endpoint schema fingerprinting,
 * grouping, naming, and array-of unwrapping.
 *
 * Verifies:
 * - Empty input returns empty registry
 * - Single endpoint (< 2 usages) produces no domain models
 * - Two endpoints with identical response schemas discover one domain model
 * - Name inference from path segments (singularization, PascalCase)
 * - Array-of unwrapping (GET /users returns array, GET /users/{id} returns object)
 * - Naming collision resolution (User, User2)
 * - Primitive/small schemas (< 2 properties) are excluded
 * - Request + response sharing counted as separate usages
 * - Registry.resolve() for direct and array-of matches
 * - Registry.getByFingerprint() returns correct model or undefined
 */

import { describe, it, expect } from 'vitest';
import { discoverDomainModels } from '../../src/export/domain-models.js';
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
    snapshot: 1,
    sampleCount: 10,
    confidenceScore: 0.9,
    firstObserved: '2026-01-01T00:00:00Z',
    lastObserved: '2026-01-02T00:00:00Z',
    ...overrides,
  };
}

/** A user schema with 3 properties — good candidate for domain model */
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

/** An order schema distinct from user */
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

/** A review schema */
const REVIEW_SCHEMA: InferredSchema = {
  type: 'object',
  properties: {
    reviewId: { type: 'integer', stats: FIELD_STATS },
    rating: { type: 'integer', stats: FIELD_STATS },
    comment: { type: 'string', stats: FIELD_STATS },
  },
  required: ['reviewId', 'rating'],
  stats: FIELD_STATS,
};

/** A category schema */
const CATEGORY_SCHEMA: InferredSchema = {
  type: 'object',
  properties: {
    categoryId: { type: 'integer', stats: FIELD_STATS },
    label: { type: 'string', stats: FIELD_STATS },
  },
  required: ['categoryId', 'label'],
  stats: FIELD_STATS,
};

/** A schema with only 1 property — too small to be a domain model candidate */
const TINY_SCHEMA: InferredSchema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', stats: FIELD_STATS },
  },
  stats: FIELD_STATS,
};

/** A primitive schema — not an object */
const PRIMITIVE_SCHEMA: InferredSchema = {
  type: 'string',
  stats: FIELD_STATS,
};

/** A second user-like schema with a different structure (different fingerprint) */
const USER_ALT_SCHEMA: InferredSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer', stats: FIELD_STATS },
    username: { type: 'string', stats: FIELD_STATS },
    avatar: { type: 'string', format: 'uri', stats: FIELD_STATS },
  },
  required: ['id', 'username'],
  stats: FIELD_STATS,
};

// ---------------------------------------------------------------------------
// discoverDomainModels — empty / trivial inputs
// ---------------------------------------------------------------------------

describe('discoverDomainModels', () => {
  describe('empty and trivial inputs', () => {
    it('returns empty registry for no schemas', () => {
      const registry = discoverDomainModels([]);
      expect(registry.models).toEqual([]);
    });

    it('returns empty registry for a single endpoint (need >= 2 usages)', () => {
      const schemas = [
        makeAggregatedSchema({
          httpMethod: 'GET',
          path: '/users/{userId}',
          responseSchemas: { '200': USER_SCHEMA },
        }),
      ];
      const registry = discoverDomainModels(schemas);
      expect(registry.models).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // Two endpoints with identical response schemas
  // ---------------------------------------------------------------------------

  describe('identical schemas across endpoints', () => {
    it('discovers one domain model from two endpoints with same response schema', () => {
      const schemas = [
        makeAggregatedSchema({
          httpMethod: 'GET',
          path: '/users/{userId}',
          responseSchemas: { '200': USER_SCHEMA },
        }),
        makeAggregatedSchema({
          id: 2,
          httpMethod: 'GET',
          path: '/teams/{teamId}/members/{memberId}',
          responseSchemas: { '200': USER_SCHEMA },
        }),
      ];

      const registry = discoverDomainModels(schemas);
      expect(registry.models).toHaveLength(1);

      const model = registry.models[0];
      expect(model.schema).toBe(USER_SCHEMA);
      expect(model.usages).toHaveLength(2);
    });

    it('discovers multiple domain models from different schema shapes', () => {
      const schemas = [
        makeAggregatedSchema({
          httpMethod: 'GET',
          path: '/users/{userId}',
          responseSchemas: { '200': USER_SCHEMA },
        }),
        makeAggregatedSchema({
          id: 2,
          httpMethod: 'GET',
          path: '/admin/users/{userId}',
          responseSchemas: { '200': USER_SCHEMA },
        }),
        makeAggregatedSchema({
          id: 3,
          httpMethod: 'GET',
          path: '/orders/{orderId}',
          responseSchemas: { '200': ORDER_SCHEMA },
        }),
        makeAggregatedSchema({
          id: 4,
          httpMethod: 'GET',
          path: '/admin/orders/{orderId}',
          responseSchemas: { '200': ORDER_SCHEMA },
        }),
      ];

      const registry = discoverDomainModels(schemas);
      expect(registry.models).toHaveLength(2);

      const names = registry.models.map((m) => m.name).sort();
      expect(names).toEqual(['Order', 'User']);
    });
  });

  // ---------------------------------------------------------------------------
  // Name inference from paths
  // ---------------------------------------------------------------------------

  describe('name inference from paths', () => {
    it('infers "User" from /users/{userId}', () => {
      const schemas = [
        makeAggregatedSchema({
          httpMethod: 'GET',
          path: '/users/{userId}',
          responseSchemas: { '200': USER_SCHEMA },
        }),
        makeAggregatedSchema({
          id: 2,
          httpMethod: 'POST',
          path: '/users',
          requestSchema: USER_SCHEMA,
          responseSchemas: { '201': USER_SCHEMA },
        }),
      ];

      const registry = discoverDomainModels(schemas);
      expect(registry.models).toHaveLength(1);
      expect(registry.models[0].name).toBe('User');
    });

    it('infers "Order" from /orders', () => {
      const schemas = [
        makeAggregatedSchema({
          httpMethod: 'GET',
          path: '/orders/{orderId}',
          responseSchemas: { '200': ORDER_SCHEMA },
        }),
        makeAggregatedSchema({
          id: 2,
          httpMethod: 'GET',
          path: '/orders',
          responseSchemas: { '200': ORDER_SCHEMA },
        }),
      ];

      const registry = discoverDomainModels(schemas);
      expect(registry.models).toHaveLength(1);
      expect(registry.models[0].name).toBe('Order');
    });

    it('infers "Review" from /api/v1/products/{id}/reviews', () => {
      const schemas = [
        makeAggregatedSchema({
          httpMethod: 'GET',
          path: '/api/v1/products/{productId}/reviews',
          responseSchemas: { '200': REVIEW_SCHEMA },
        }),
        makeAggregatedSchema({
          id: 2,
          httpMethod: 'GET',
          path: '/api/v1/products/{productId}/reviews/{reviewId}',
          responseSchemas: { '200': REVIEW_SCHEMA },
        }),
      ];

      const registry = discoverDomainModels(schemas);
      expect(registry.models).toHaveLength(1);
      expect(registry.models[0].name).toBe('Review');
    });

    it('infers "Category" from /categories (ies -> y singularization)', () => {
      const schemas = [
        makeAggregatedSchema({
          httpMethod: 'GET',
          path: '/categories/{categoryId}',
          responseSchemas: { '200': CATEGORY_SCHEMA },
        }),
        makeAggregatedSchema({
          id: 2,
          httpMethod: 'GET',
          path: '/categories',
          responseSchemas: { '200': CATEGORY_SCHEMA },
        }),
      ];

      const registry = discoverDomainModels(schemas);
      expect(registry.models).toHaveLength(1);
      expect(registry.models[0].name).toBe('Category');
    });
  });

  // ---------------------------------------------------------------------------
  // Array-of unwrapping
  // ---------------------------------------------------------------------------

  describe('array-of unwrapping', () => {
    it('discovers same model from array response and object response', () => {
      const arrayOfUsers: InferredSchema = {
        type: 'array',
        items: USER_SCHEMA,
        stats: FIELD_STATS,
      };

      const schemas = [
        makeAggregatedSchema({
          httpMethod: 'GET',
          path: '/users',
          responseSchemas: { '200': arrayOfUsers },
        }),
        makeAggregatedSchema({
          id: 2,
          httpMethod: 'GET',
          path: '/users/{userId}',
          responseSchemas: { '200': USER_SCHEMA },
        }),
      ];

      const registry = discoverDomainModels(schemas);
      expect(registry.models).toHaveLength(1);
      expect(registry.models[0].name).toBe('User');

      // One usage should be isArray: true, the other false
      const arrayUsage = registry.models[0].usages.find((u) => u.isArrayItem);
      const directUsage = registry.models[0].usages.find((u) => !u.isArrayItem);
      expect(arrayUsage).toBeDefined();
      expect(directUsage).toBeDefined();
      expect(arrayUsage!.path).toBe('/users');
      expect(directUsage!.path).toBe('/users/{userId}');
    });

    it('does not unwrap arrays of primitives', () => {
      const arrayOfStrings: InferredSchema = {
        type: 'array',
        items: { type: 'string', stats: FIELD_STATS },
        stats: FIELD_STATS,
      };

      const schemas = [
        makeAggregatedSchema({
          httpMethod: 'GET',
          path: '/tags',
          responseSchemas: { '200': arrayOfStrings },
        }),
        makeAggregatedSchema({
          id: 2,
          httpMethod: 'GET',
          path: '/labels',
          responseSchemas: { '200': arrayOfStrings },
        }),
      ];

      const registry = discoverDomainModels(schemas);
      // Primitives are not domain model candidates
      expect(registry.models).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Naming collision resolution
  // ---------------------------------------------------------------------------

  describe('naming collision resolution', () => {
    it('suffixes colliding names with incrementing numbers', () => {
      // Both map to "User" path-wise, but have different schemas
      const schemas = [
        makeAggregatedSchema({
          httpMethod: 'GET',
          path: '/users/{userId}',
          responseSchemas: { '200': USER_SCHEMA },
        }),
        makeAggregatedSchema({
          id: 2,
          httpMethod: 'GET',
          path: '/admin/users/{userId}',
          responseSchemas: { '200': USER_SCHEMA },
        }),
        // Different schema, also on /users path
        makeAggregatedSchema({
          id: 3,
          httpMethod: 'GET',
          path: '/v2/users/{userId}',
          responseSchemas: { '200': USER_ALT_SCHEMA },
        }),
        makeAggregatedSchema({
          id: 4,
          httpMethod: 'GET',
          path: '/v2/admin/users/{userId}',
          responseSchemas: { '200': USER_ALT_SCHEMA },
        }),
      ];

      const registry = discoverDomainModels(schemas);
      expect(registry.models).toHaveLength(2);

      const names = registry.models.map((m) => m.name).sort();
      // One keeps "User", the other gets "User2"
      expect(names).toEqual(['User', 'User2']);
    });
  });

  // ---------------------------------------------------------------------------
  // Primitive / small schemas excluded
  // ---------------------------------------------------------------------------

  describe('primitive and small schema exclusion', () => {
    it('excludes schemas with fewer than 2 properties', () => {
      const schemas = [
        makeAggregatedSchema({
          httpMethod: 'GET',
          path: '/health',
          responseSchemas: { '200': TINY_SCHEMA },
        }),
        makeAggregatedSchema({
          id: 2,
          httpMethod: 'GET',
          path: '/status',
          responseSchemas: { '200': TINY_SCHEMA },
        }),
      ];

      const registry = discoverDomainModels(schemas);
      expect(registry.models).toHaveLength(0);
    });

    it('excludes primitive schemas', () => {
      const schemas = [
        makeAggregatedSchema({
          httpMethod: 'GET',
          path: '/version',
          responseSchemas: { '200': PRIMITIVE_SCHEMA },
        }),
        makeAggregatedSchema({
          id: 2,
          httpMethod: 'GET',
          path: '/ping',
          responseSchemas: { '200': PRIMITIVE_SCHEMA },
        }),
      ];

      const registry = discoverDomainModels(schemas);
      expect(registry.models).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Request + response sharing
  // ---------------------------------------------------------------------------

  describe('request and response sharing', () => {
    it('counts request body and response body as separate usages across endpoints', () => {
      const schemas = [
        makeAggregatedSchema({
          httpMethod: 'POST',
          path: '/users',
          requestSchema: USER_SCHEMA,
          responseSchemas: { '201': USER_SCHEMA },
        }),
        makeAggregatedSchema({
          id: 2,
          httpMethod: 'GET',
          path: '/users/{userId}',
          responseSchemas: { '200': USER_SCHEMA },
        }),
      ];

      const registry = discoverDomainModels(schemas);
      expect(registry.models).toHaveLength(1);
      expect(registry.models[0].name).toBe('User');

      const roles = registry.models[0].usages.map((u) => u.role).sort();
      expect(roles).toContain('request');
      expect(roles).toContain('response');
    });

    it('tracks statusCode on response usages', () => {
      const schemas = [
        makeAggregatedSchema({
          httpMethod: 'POST',
          path: '/users',
          requestSchema: USER_SCHEMA,
          responseSchemas: { '201': USER_SCHEMA },
        }),
        makeAggregatedSchema({
          id: 2,
          httpMethod: 'GET',
          path: '/users/{userId}',
          responseSchemas: { '200': USER_SCHEMA },
        }),
      ];

      const registry = discoverDomainModels(schemas);
      const responseUsage = registry.models[0].usages.find(
        (u) => u.role === 'response' && u.statusCode === '201',
      );
      expect(responseUsage).toBeDefined();

      const requestUsage = registry.models[0].usages.find((u) => u.role === 'request');
      expect(requestUsage!.statusCode).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Registry.resolve()
  // ---------------------------------------------------------------------------

  describe('Registry.resolve()', () => {
    it('resolves a direct schema match', () => {
      const schemas = [
        makeAggregatedSchema({
          httpMethod: 'GET',
          path: '/users/{userId}',
          responseSchemas: { '200': USER_SCHEMA },
        }),
        makeAggregatedSchema({
          id: 2,
          httpMethod: 'POST',
          path: '/users',
          requestSchema: USER_SCHEMA,
        }),
      ];

      const registry = discoverDomainModels(schemas);
      const result = registry.resolve(USER_SCHEMA);
      expect(result).toBeDefined();
      expect(result!.model.name).toBe('User');
      expect(result!.isArrayItem).toBe(false);
    });

    it('resolves an array-of match', () => {
      const arrayOfUsers: InferredSchema = {
        type: 'array',
        items: USER_SCHEMA,
        stats: FIELD_STATS,
      };

      const schemas = [
        makeAggregatedSchema({
          httpMethod: 'GET',
          path: '/users',
          responseSchemas: { '200': arrayOfUsers },
        }),
        makeAggregatedSchema({
          id: 2,
          httpMethod: 'GET',
          path: '/users/{userId}',
          responseSchemas: { '200': USER_SCHEMA },
        }),
      ];

      const registry = discoverDomainModels(schemas);
      const result = registry.resolve(arrayOfUsers);
      expect(result).toBeDefined();
      expect(result!.model.name).toBe('User');
      expect(result!.isArrayItem).toBe(true);
    });

    it('returns undefined for unknown schema', () => {
      const schemas = [
        makeAggregatedSchema({
          httpMethod: 'GET',
          path: '/users/{userId}',
          responseSchemas: { '200': USER_SCHEMA },
        }),
        makeAggregatedSchema({
          id: 2,
          httpMethod: 'POST',
          path: '/users',
          requestSchema: USER_SCHEMA,
        }),
      ];

      const registry = discoverDomainModels(schemas);
      const result = registry.resolve(ORDER_SCHEMA);
      expect(result).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Registry.getByFingerprint()
  // ---------------------------------------------------------------------------

  describe('Registry.getByFingerprint()', () => {
    it('returns the correct model for a known fingerprint', () => {
      const schemas = [
        makeAggregatedSchema({
          httpMethod: 'GET',
          path: '/users/{userId}',
          responseSchemas: { '200': USER_SCHEMA },
        }),
        makeAggregatedSchema({
          id: 2,
          httpMethod: 'POST',
          path: '/users',
          requestSchema: USER_SCHEMA,
        }),
      ];

      const registry = discoverDomainModels(schemas);
      const model = registry.models[0];
      const result = registry.getByFingerprint(model.fingerprint);
      expect(result).toBe(model);
    });

    it('returns undefined for an unknown fingerprint', () => {
      const schemas = [
        makeAggregatedSchema({
          httpMethod: 'GET',
          path: '/users/{userId}',
          responseSchemas: { '200': USER_SCHEMA },
        }),
        makeAggregatedSchema({
          id: 2,
          httpMethod: 'POST',
          path: '/users',
          requestSchema: USER_SCHEMA,
        }),
      ];

      const registry = discoverDomainModels(schemas);
      const result = registry.getByFingerprint('nonexistent-fingerprint');
      expect(result).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe('edge cases', () => {
    it('handles multiple status codes across endpoints', () => {
      const schemas = [
        makeAggregatedSchema({
          httpMethod: 'GET',
          path: '/users/{userId}',
          responseSchemas: {
            '200': USER_SCHEMA,
            '404': USER_SCHEMA,
          },
        }),
        makeAggregatedSchema({
          id: 2,
          httpMethod: 'POST',
          path: '/users',
          responseSchemas: { '201': USER_SCHEMA },
        }),
      ];

      const registry = discoverDomainModels(schemas);
      expect(registry.models).toHaveLength(1);
      // 3 usages: 200, 404 from GET, 201 from POST
      expect(registry.models[0].usages).toHaveLength(3);
      const statusCodes = registry.models[0].usages.map((u) => u.statusCode).sort();
      expect(statusCodes).toEqual(['200', '201', '404']);
    });

    it('returns models for all discovered domain types', () => {
      const schemas = [
        makeAggregatedSchema({
          httpMethod: 'GET',
          path: '/orders/{orderId}',
          responseSchemas: { '200': ORDER_SCHEMA },
        }),
        makeAggregatedSchema({
          id: 2,
          httpMethod: 'GET',
          path: '/admin/orders/{orderId}',
          responseSchemas: { '200': ORDER_SCHEMA },
        }),
        makeAggregatedSchema({
          id: 3,
          httpMethod: 'GET',
          path: '/users/{userId}',
          responseSchemas: { '200': USER_SCHEMA },
        }),
        makeAggregatedSchema({
          id: 4,
          httpMethod: 'GET',
          path: '/admin/users/{userId}',
          responseSchemas: { '200': USER_SCHEMA },
        }),
      ];

      const registry = discoverDomainModels(schemas);
      const names = registry.models.map((m) => m.name).sort();
      expect(names).toEqual(['Order', 'User']);
    });

    it('does not create domain model from array-of-small-objects', () => {
      const arrayOfTiny: InferredSchema = {
        type: 'array',
        items: TINY_SCHEMA,
        stats: FIELD_STATS,
      };

      const schemas = [
        makeAggregatedSchema({
          httpMethod: 'GET',
          path: '/flags',
          responseSchemas: { '200': arrayOfTiny },
        }),
        makeAggregatedSchema({
          id: 2,
          httpMethod: 'GET',
          path: '/toggles',
          responseSchemas: { '200': arrayOfTiny },
        }),
      ];

      const registry = discoverDomainModels(schemas);
      expect(registry.models).toHaveLength(0);
    });

    it('usages record httpMethod correctly', () => {
      const schemas = [
        makeAggregatedSchema({
          httpMethod: 'GET',
          path: '/users/{userId}',
          responseSchemas: { '200': USER_SCHEMA },
        }),
        makeAggregatedSchema({
          id: 2,
          httpMethod: 'PUT',
          path: '/users/{userId}',
          requestSchema: USER_SCHEMA,
        }),
      ];

      const registry = discoverDomainModels(schemas);
      expect(registry.models).toHaveLength(1);
      const methods = registry.models[0].usages.map((u) => u.httpMethod).sort();
      expect(methods).toEqual(['GET', 'PUT']);
    });
  });
});
