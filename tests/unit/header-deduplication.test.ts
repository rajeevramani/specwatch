/**
 * Tests for global header deduplication in OpenAPI export.
 *
 * Verifies that headers appearing in ALL endpoints with identical values
 * are factored out of individual operations and optionally reported via
 * x-specwatch-global-headers metadata extension.
 */

import { describe, it, expect } from 'vitest';
import {
  extractGlobalHeaders,
  buildOpenApiDocument,
  buildOperationObject,
} from '../../src/export/openapi.js';
import type { AggregatedSchema, HeaderEntry } from '../../src/inference/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSchema(
  overrides: Partial<AggregatedSchema> = {},
): AggregatedSchema {
  return {
    id: 1,
    sessionId: 'session-1',
    httpMethod: 'GET',
    path: '/users',
    version: 1,
    sampleCount: 10,
    confidenceScore: 0.9,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// extractGlobalHeaders
// ---------------------------------------------------------------------------

describe('extractGlobalHeaders', () => {
  it('returns empty array for empty schemas', () => {
    expect(extractGlobalHeaders([])).toEqual([]);
  });

  it('returns headers present in all schemas with identical values', () => {
    const commonHeader: HeaderEntry = { name: 'X-Request-Id', example: 'abc-123' };
    const schemas = [
      makeSchema({
        path: '/users',
        requestHeaders: [commonHeader, { name: 'X-Custom', example: 'val1' }],
      }),
      makeSchema({
        path: '/orders',
        requestHeaders: [commonHeader, { name: 'X-Other', example: 'val2' }],
      }),
    ];

    const globals = extractGlobalHeaders(schemas);
    expect(globals).toEqual([{ name: 'X-Request-Id', example: 'abc-123' }]);
  });

  it('returns empty array when headers differ in value across schemas', () => {
    const schemas = [
      makeSchema({
        path: '/users',
        requestHeaders: [{ name: 'X-Request-Id', example: 'abc' }],
      }),
      makeSchema({
        path: '/orders',
        requestHeaders: [{ name: 'X-Request-Id', example: 'def' }],
      }),
    ];

    expect(extractGlobalHeaders(schemas)).toEqual([]);
  });

  it('returns empty array when a schema has no headers', () => {
    const schemas = [
      makeSchema({
        path: '/users',
        requestHeaders: [{ name: 'X-Request-Id', example: 'abc' }],
      }),
      makeSchema({ path: '/orders' }),
    ];

    expect(extractGlobalHeaders(schemas)).toEqual([]);
  });

  it('excludes auth and transport headers from global extraction', () => {
    const schemas = [
      makeSchema({
        path: '/users',
        requestHeaders: [
          { name: 'Content-Type', example: 'application/json' },
          { name: 'Authorization', example: 'Bearer token' },
          { name: 'X-Custom', example: 'shared' },
        ],
      }),
      makeSchema({
        path: '/orders',
        requestHeaders: [
          { name: 'Content-Type', example: 'application/json' },
          { name: 'Authorization', example: 'Bearer token' },
          { name: 'X-Custom', example: 'shared' },
        ],
      }),
    ];

    const globals = extractGlobalHeaders(schemas);
    // Only X-Custom should be global (Content-Type is transport, Authorization is auth)
    expect(globals).toEqual([{ name: 'X-Custom', example: 'shared' }]);
  });

  it('handles case-insensitive header name matching', () => {
    const schemas = [
      makeSchema({
        path: '/users',
        requestHeaders: [{ name: 'X-Request-Id', example: 'abc' }],
      }),
      makeSchema({
        path: '/orders',
        requestHeaders: [{ name: 'x-request-id', example: 'abc' }],
      }),
    ];

    const globals = extractGlobalHeaders(schemas);
    expect(globals).toHaveLength(1);
    expect(globals[0].example).toBe('abc');
  });

  it('returns multiple global headers when all match', () => {
    const schemas = [
      makeSchema({
        path: '/users',
        requestHeaders: [
          { name: 'X-Request-Id', example: 'abc' },
          { name: 'X-Trace', example: 'trace-1' },
        ],
      }),
      makeSchema({
        path: '/orders',
        requestHeaders: [
          { name: 'X-Request-Id', example: 'abc' },
          { name: 'X-Trace', example: 'trace-1' },
        ],
      }),
    ];

    const globals = extractGlobalHeaders(schemas);
    expect(globals).toHaveLength(2);
  });

  it('single schema — returns empty (deduplication requires 2+ schemas)', () => {
    const schemas = [
      makeSchema({
        requestHeaders: [
          { name: 'X-Custom', example: 'val' },
          { name: 'X-Other', example: 'val2' },
        ],
      }),
    ];

    const globals = extractGlobalHeaders(schemas);
    expect(globals).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// buildOperationObject — global header exclusion
// ---------------------------------------------------------------------------

describe('buildOperationObject with globalHeaders', () => {
  it('excludes global headers from operation parameters', () => {
    const schema = makeSchema({
      requestHeaders: [
        { name: 'X-Request-Id', example: 'abc' },
        { name: 'X-Custom', example: 'val' },
      ],
    });

    const globalHeaders = new Set(['x-request-id']);
    const operation = buildOperationObject(schema, {}, globalHeaders);
    const params = operation['parameters'] as Array<Record<string, unknown>>;

    // Only X-Custom should remain
    const headerParams = params.filter((p) => p['in'] === 'header');
    expect(headerParams).toHaveLength(1);
    expect(headerParams[0]['name']).toBe('X-Custom');
  });

  it('includes all headers when globalHeaders is empty', () => {
    const schema = makeSchema({
      requestHeaders: [
        { name: 'X-Request-Id', example: 'abc' },
        { name: 'X-Custom', example: 'val' },
      ],
    });

    const operation = buildOperationObject(schema, {});
    const params = operation['parameters'] as Array<Record<string, unknown>>;
    const headerParams = params.filter((p) => p['in'] === 'header');
    expect(headerParams).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// buildOpenApiDocument — integration
// ---------------------------------------------------------------------------

describe('buildOpenApiDocument — header deduplication', () => {
  const sharedHeader: HeaderEntry = { name: 'X-Request-Id', example: 'abc-123' };
  const uniqueHeader: HeaderEntry = { name: 'X-Custom', example: 'unique-val' };

  const schemas: AggregatedSchema[] = [
    makeSchema({
      id: 1,
      path: '/users',
      httpMethod: 'GET',
      requestHeaders: [sharedHeader, uniqueHeader],
      responseSchemas: { '200': { type: 'object' } },
    }),
    makeSchema({
      id: 2,
      path: '/orders',
      httpMethod: 'GET',
      requestHeaders: [sharedHeader],
      responseSchemas: { '200': { type: 'object' } },
    }),
  ];

  it('removes global headers from individual operations', () => {
    const doc = buildOpenApiDocument(schemas);
    const paths = doc['paths'] as Record<string, Record<string, Record<string, unknown>>>;

    // X-Request-Id is global — should not appear in any operation
    for (const [, methods] of Object.entries(paths)) {
      for (const [, operation] of Object.entries(methods)) {
        const params = (operation['parameters'] as Array<Record<string, unknown>>) ?? [];
        const headerParams = params.filter((p) => p['in'] === 'header');
        const headerNames = headerParams.map((p) => (p['name'] as string).toLowerCase());
        expect(headerNames).not.toContain('x-request-id');
      }
    }
  });

  it('keeps non-global headers on their operations', () => {
    const doc = buildOpenApiDocument(schemas);
    const paths = doc['paths'] as Record<string, Record<string, Record<string, unknown>>>;
    const usersGet = paths['/users']['get'];
    const params = usersGet['parameters'] as Array<Record<string, unknown>>;
    const headerParams = params.filter((p) => p['in'] === 'header');
    // X-Custom is only on /users, not global, so it stays
    expect(headerParams).toHaveLength(1);
    expect(headerParams[0]['name']).toBe('X-Custom');
  });

  it('adds x-specwatch-global-headers when includeMetadata is true', () => {
    const doc = buildOpenApiDocument(schemas, { includeMetadata: true });
    const globalHeaders = doc['x-specwatch-global-headers'] as Array<{
      name: string;
      example: string;
    }>;
    expect(globalHeaders).toBeDefined();
    expect(globalHeaders).toHaveLength(1);
    expect(globalHeaders[0].name).toBe('X-Request-Id');
    expect(globalHeaders[0].example).toBe('abc-123');
  });

  it('does not add x-specwatch-global-headers when includeMetadata is false', () => {
    const doc = buildOpenApiDocument(schemas);
    expect(doc['x-specwatch-global-headers']).toBeUndefined();
  });

  it('does not add x-specwatch-global-headers when there are no global headers', () => {
    const noGlobalSchemas: AggregatedSchema[] = [
      makeSchema({
        id: 1,
        path: '/users',
        httpMethod: 'GET',
        requestHeaders: [{ name: 'X-Custom', example: 'a' }],
        responseSchemas: { '200': { type: 'object' } },
      }),
      makeSchema({
        id: 2,
        path: '/orders',
        httpMethod: 'GET',
        requestHeaders: [{ name: 'X-Other', example: 'b' }],
        responseSchemas: { '200': { type: 'object' } },
      }),
    ];

    const doc = buildOpenApiDocument(noGlobalSchemas, { includeMetadata: true });
    expect(doc['x-specwatch-global-headers']).toBeUndefined();
  });
});
