import { describe, it, expect } from 'vitest';
import {
  analyzeCompleteness,
  analyzeJsonRpcCompleteness,
  findMatchingGetPath,
  findMatchingReadTool,
  isWriteTool,
  isReadTool,
} from '../../src/analysis/completeness.js';
import type { AggregatedSchema, InferredSchema, Sample } from '../../src/types/index.js';

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

// ---------------------------------------------------------------------------
// JSON-RPC completeness
// ---------------------------------------------------------------------------

function makeJsonRpcSample(
  toolName: string,
  responseFields: string[],
  overrides: Partial<Sample> = {},
): Sample {
  return {
    id: 1,
    sessionId: 'sess-1',
    httpMethod: 'POST',
    path: '/api/v1/mcp',
    normalizedPath: '/api/v1/mcp',
    statusCode: 200,
    capturedAt: '2024-01-01T00:00:00Z',
    jsonrpcMethod: 'tools/call',
    jsonrpcTool: toolName,
    responseSchema: makeObjectSchema(responseFields),
    ...overrides,
  };
}

describe('JSON-RPC completeness', () => {
  describe('isWriteTool / isReadTool', () => {
    it('identifies write tool prefixes', () => {
      expect(isWriteTool('create_cluster')).toBe(true);
      expect(isWriteTool('update_user')).toBe(true);
      expect(isWriteTool('set_config')).toBe(true);
      expect(isWriteTool('delete_item')).toBe(true);
      expect(isWriteTool('add_member')).toBe(true);
    });

    it('identifies read tool prefixes', () => {
      expect(isReadTool('get_cluster')).toBe(true);
      expect(isReadTool('query_users')).toBe(true);
      expect(isReadTool('list_items')).toBe(true);
      expect(isReadTool('describe_resource')).toBe(true);
      expect(isReadTool('fetch_data')).toBe(true);
    });

    it('rejects non-matching names', () => {
      expect(isWriteTool('run_task')).toBe(false);
      expect(isReadTool('run_task')).toBe(false);
    });
  });

  describe('findMatchingReadTool', () => {
    it('matches create_cluster → get_cluster', () => {
      expect(findMatchingReadTool('create_cluster', ['get_cluster', 'list_users'])).toBe(
        'get_cluster',
      );
    });

    it('matches update_user → query_user', () => {
      expect(findMatchingReadTool('update_user', ['query_user'])).toBe('query_user');
    });

    it('returns undefined when no match', () => {
      expect(findMatchingReadTool('create_cluster', ['get_user'])).toBeUndefined();
    });
  });

  describe('analyzeJsonRpcCompleteness', () => {
    it('compares create tool vs get tool responses', () => {
      const samples: Sample[] = [
        makeJsonRpcSample('create_cluster', ['id', 'name']),
        makeJsonRpcSample('get_cluster', [
          'id', 'name', 'status', 'region', 'ports', 'createdAt',
        ]),
      ];

      const report = analyzeJsonRpcCompleteness(samples);

      expect(report.endpoints).toHaveLength(1);
      expect(report.endpoints[0].path).toBe('tools/call:create_cluster');
      expect(report.endpoints[0].writeFieldCount).toBe(2);
      expect(report.endpoints[0].readFieldCount).toBe(6);
      expect(report.endpoints[0].completenessScore).toBeCloseTo(0.333, 2);
      expect(report.endpoints[0].missingFields).toEqual(['status', 'region', 'ports', 'createdAt']);
      expect(report.thinResponses).toHaveLength(1);
    });

    it('full completeness when write returns same fields as read', () => {
      const fields = ['id', 'name', 'status'];
      const samples: Sample[] = [
        makeJsonRpcSample('create_item', fields),
        makeJsonRpcSample('get_item', fields),
      ];

      const report = analyzeJsonRpcCompleteness(samples);
      expect(report.endpoints[0].completenessScore).toBe(1.0);
      expect(report.thinResponses).toHaveLength(0);
    });

    it('skips tools with no matching read tool', () => {
      const samples: Sample[] = [
        makeJsonRpcSample('create_cluster', ['id']),
        // No get_cluster or query_cluster
      ];

      const report = analyzeJsonRpcCompleteness(samples);
      expect(report.endpoints).toHaveLength(0);
    });

    it('skips non-tools/call samples', () => {
      const sample: Sample = {
        id: 1,
        sessionId: 'sess-1',
        httpMethod: 'POST',
        path: '/api/v1/mcp',
        normalizedPath: '/api/v1/mcp',
        statusCode: 200,
        capturedAt: '2024-01-01T00:00:00Z',
        jsonrpcMethod: 'tools/list',
        responseSchema: makeObjectSchema(['tools']),
      };

      const report = analyzeJsonRpcCompleteness([sample]);
      expect(report.endpoints).toHaveLength(0);
    });

    it('calculates average completeness', () => {
      const samples: Sample[] = [
        makeJsonRpcSample('create_cluster', ['id']),
        makeJsonRpcSample('get_cluster', ['id', 'name', 'status', 'region']),
        makeJsonRpcSample('create_user', ['id', 'name']),
        makeJsonRpcSample('get_user', ['id', 'name']),
      ];

      const report = analyzeJsonRpcCompleteness(samples);
      expect(report.endpoints).toHaveLength(2);
      // create_cluster: 1/4 = 0.25, create_user: 2/2 = 1.0 → avg = 0.625
      expect(report.avgCompleteness).toBe(0.625);
    });
  });
});
