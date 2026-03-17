import { describe, it, expect } from 'vitest';
import {
  analyzeCompleteness,
  findMatchingGetPath,
} from '../../src/analysis/completeness.js';
import type { AggregatedSchema, InferredSchema } from '../../src/types/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeObjectSchema(fields: string[]): InferredSchema {
  const properties: Record<string, InferredSchema> = {};
  for (const field of fields) {
    properties[field] = { type: 'string', stats: { sampleCount: 1, presenceCount: 1, confidence: 1 } };
  }
  return {
    type: 'object',
    properties,
    stats: { sampleCount: 1, presenceCount: 1, confidence: 1 },
  };
}

function makeSchema(
  overrides: Partial<AggregatedSchema> & { httpMethod: string; path: string },
): AggregatedSchema {
  return {
    id: 1,
    sessionId: 'test-session',
    version: 1,
    snapshot: 1,
    sampleCount: 10,
    confidenceScore: 0.9,
    firstObserved: '2026-01-01T00:00:00Z',
    lastObserved: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Response Completeness Scoring', () => {
  describe('analyzeCompleteness', () => {
    it('POST with 2 fields vs GET with 10 fields → score 0.2', () => {
      const schemas: AggregatedSchema[] = [
        makeSchema({
          httpMethod: 'POST',
          path: '/users',
          responseSchemas: { '201': makeObjectSchema(['id', 'ok']) },
        }),
        makeSchema({
          httpMethod: 'GET',
          path: '/users/{userId}',
          responseSchemas: {
            '200': makeObjectSchema([
              'id', 'name', 'email', 'phone', 'address',
              'createdAt', 'updatedAt', 'role', 'status', 'avatar',
            ]),
          },
        }),
      ];

      const report = analyzeCompleteness(schemas);

      expect(report.endpoints).toHaveLength(1);
      expect(report.endpoints[0].completenessScore).toBe(0.2);
      expect(report.endpoints[0].writeFieldCount).toBe(2);
      expect(report.endpoints[0].readFieldCount).toBe(10);
      expect(report.thinResponses).toHaveLength(1);
    });

    it('POST returning full object → score 1.0', () => {
      const fields = ['id', 'name', 'email', 'createdAt'];
      const schemas: AggregatedSchema[] = [
        makeSchema({
          httpMethod: 'POST',
          path: '/users',
          responseSchemas: { '201': makeObjectSchema(fields) },
        }),
        makeSchema({
          httpMethod: 'GET',
          path: '/users/{userId}',
          responseSchemas: { '200': makeObjectSchema(fields) },
        }),
      ];

      const report = analyzeCompleteness(schemas);

      expect(report.endpoints).toHaveLength(1);
      expect(report.endpoints[0].completenessScore).toBe(1.0);
      expect(report.endpoints[0].missingFields).toEqual([]);
      expect(report.thinResponses).toHaveLength(0);
    });

    it('missing fields correctly identified', () => {
      const schemas: AggregatedSchema[] = [
        makeSchema({
          httpMethod: 'POST',
          path: '/users',
          responseSchemas: { '201': makeObjectSchema(['id', 'name']) },
        }),
        makeSchema({
          httpMethod: 'GET',
          path: '/users/{userId}',
          responseSchemas: {
            '200': makeObjectSchema(['id', 'name', 'email', 'phone', 'address']),
          },
        }),
      ];

      const report = analyzeCompleteness(schemas);

      expect(report.endpoints[0].missingFields).toEqual(['email', 'phone', 'address']);
    });

    it('PUT and PATCH also analyzed', () => {
      const schemas: AggregatedSchema[] = [
        makeSchema({
          httpMethod: 'PUT',
          path: '/users/{userId}',
          responseSchemas: { '200': makeObjectSchema(['id', 'ok']) },
        }),
        makeSchema({
          httpMethod: 'PATCH',
          path: '/users/{userId}',
          responseSchemas: { '200': makeObjectSchema(['id']) },
        }),
        makeSchema({
          httpMethod: 'GET',
          path: '/users/{userId}',
          responseSchemas: {
            '200': makeObjectSchema(['id', 'name', 'email', 'phone', 'createdAt']),
          },
        }),
      ];

      const report = analyzeCompleteness(schemas);

      expect(report.endpoints).toHaveLength(2);
      const methods = report.endpoints.map((e) => e.method).sort();
      expect(methods).toEqual(['PATCH', 'PUT']);
    });

    it('no matching GET → endpoint skipped', () => {
      const schemas: AggregatedSchema[] = [
        makeSchema({
          httpMethod: 'POST',
          path: '/webhooks',
          responseSchemas: { '201': makeObjectSchema(['id']) },
        }),
        // No GET /webhooks/{webhookId}
      ];

      const report = analyzeCompleteness(schemas);

      expect(report.endpoints).toHaveLength(0);
      expect(report.thinResponses).toHaveLength(0);
    });

    it('empty schemas → empty report', () => {
      const report = analyzeCompleteness([]);

      expect(report.endpoints).toHaveLength(0);
      expect(report.thinResponses).toHaveLength(0);
      expect(report.avgCompleteness).toBe(0);
    });

    it('calculates average completeness across multiple endpoints', () => {
      const schemas: AggregatedSchema[] = [
        makeSchema({
          httpMethod: 'POST',
          path: '/users',
          responseSchemas: { '201': makeObjectSchema(['id']) },
        }),
        makeSchema({
          httpMethod: 'POST',
          path: '/orders',
          responseSchemas: { '201': makeObjectSchema(['id', 'status', 'total', 'items']) },
        }),
        makeSchema({
          httpMethod: 'GET',
          path: '/users/{userId}',
          responseSchemas: { '200': makeObjectSchema(['id', 'name', 'email', 'phone', 'address']) },
        }),
        makeSchema({
          httpMethod: 'GET',
          path: '/orders/{orderId}',
          responseSchemas: { '200': makeObjectSchema(['id', 'status', 'total', 'items']) },
        }),
      ];

      const report = analyzeCompleteness(schemas);

      expect(report.endpoints).toHaveLength(2);
      // POST /users: 1/5 = 0.2, POST /orders: 4/4 = 1.0
      expect(report.avgCompleteness).toBe(0.6);
    });

    it('handles write response with no response schema', () => {
      const schemas: AggregatedSchema[] = [
        makeSchema({
          httpMethod: 'POST',
          path: '/users',
          // no responseSchemas
        }),
        makeSchema({
          httpMethod: 'GET',
          path: '/users/{userId}',
          responseSchemas: { '200': makeObjectSchema(['id', 'name']) },
        }),
      ];

      const report = analyzeCompleteness(schemas);
      expect(report.endpoints).toHaveLength(0);
    });

    it('handles GET response with non-object schema', () => {
      const schemas: AggregatedSchema[] = [
        makeSchema({
          httpMethod: 'POST',
          path: '/users',
          responseSchemas: { '201': makeObjectSchema(['id']) },
        }),
        makeSchema({
          httpMethod: 'GET',
          path: '/users/{userId}',
          responseSchemas: {
            '200': {
              type: 'string',
              stats: { sampleCount: 1, presenceCount: 1, confidence: 1 },
            },
          },
        }),
      ];

      const report = analyzeCompleteness(schemas);
      // GET has 0 fields (not object) → skipped
      expect(report.endpoints).toHaveLength(0);
    });

    it('caps completeness score at 1.0 when write has more fields', () => {
      const schemas: AggregatedSchema[] = [
        makeSchema({
          httpMethod: 'PUT',
          path: '/users/{userId}',
          responseSchemas: {
            '200': makeObjectSchema(['id', 'name', 'email', 'extra1', 'extra2']),
          },
        }),
        makeSchema({
          httpMethod: 'GET',
          path: '/users/{userId}',
          responseSchemas: {
            '200': makeObjectSchema(['id', 'name', 'email']),
          },
        }),
      ];

      const report = analyzeCompleteness(schemas);
      expect(report.endpoints[0].completenessScore).toBe(1.0);
    });

    it('prefers 200 response, falls back to 201 and other 2xx', () => {
      const schemas: AggregatedSchema[] = [
        makeSchema({
          httpMethod: 'POST',
          path: '/users',
          responseSchemas: {
            '201': makeObjectSchema(['id', 'name']),
            '400': makeObjectSchema(['error']),
          },
        }),
        makeSchema({
          httpMethod: 'GET',
          path: '/users/{userId}',
          responseSchemas: {
            '200': makeObjectSchema(['id', 'name', 'email', 'phone']),
          },
        }),
      ];

      const report = analyzeCompleteness(schemas);
      expect(report.endpoints[0].completenessScore).toBe(0.5);
    });
  });

  describe('findMatchingGetPath', () => {
    it('POST /users matches GET /users/{userId}', () => {
      const result = findMatchingGetPath('/users', 'POST', ['/users/{userId}']);
      expect(result).toBe('/users/{userId}');
    });

    it('POST /users/{userId}/orders matches GET /users/{userId}/orders/{orderId}', () => {
      const result = findMatchingGetPath(
        '/users/{userId}/orders',
        'POST',
        ['/users/{userId}/orders/{orderId}'],
      );
      expect(result).toBe('/users/{userId}/orders/{orderId}');
    });

    it('PUT /users/{userId} matches GET /users/{userId}', () => {
      const result = findMatchingGetPath(
        '/users/{userId}',
        'PUT',
        ['/users/{userId}'],
      );
      expect(result).toBe('/users/{userId}');
    });

    it('PATCH /users/{userId} matches GET /users/{userId}', () => {
      const result = findMatchingGetPath(
        '/users/{userId}',
        'PATCH',
        ['/users/{userId}'],
      );
      expect(result).toBe('/users/{userId}');
    });

    it('returns undefined when no match', () => {
      const result = findMatchingGetPath('/webhooks', 'POST', ['/users/{userId}']);
      expect(result).toBeUndefined();
    });

    it('does not match non-parameterized trailing segments', () => {
      const result = findMatchingGetPath('/users', 'POST', ['/users/active']);
      expect(result).toBeUndefined();
    });
  });
});
