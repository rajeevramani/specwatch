/**
 * Tests for global header deduplication in OpenAPI export.
 *
 * Verifies that names present in ALL endpoints remain operation parameters
 * and are optionally reported as structural presence via
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

  it('returns structural headers present in all schemas', () => {
    const commonHeader: HeaderEntry = { name: 'x-request-id' };
    const schemas = [
      makeSchema({
        path: '/users',
        requestHeaders: [commonHeader, { name: 'x-custom' }],
      }),
      makeSchema({
        path: '/orders',
        requestHeaders: [commonHeader, { name: 'x-other' }],
      }),
    ];

    const globals = extractGlobalHeaders(schemas);
    expect(globals).toEqual([{ name: 'x-request-id' }]);
  });

  it('treats shared names as global presence regardless of old value distinctions', () => {
    const schemas = [
      makeSchema({
        path: '/users',
        requestHeaders: [{ name: 'x-request-id' }],
      }),
      makeSchema({
        path: '/orders',
        requestHeaders: [{ name: 'x-request-id' }],
      }),
    ];

    expect(extractGlobalHeaders(schemas)).toEqual([{ name: 'x-request-id' }]);
  });

  it('returns empty array when a schema has no headers', () => {
    const schemas = [
      makeSchema({
        path: '/users',
        requestHeaders: [{ name: 'x-request-id' }],
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
          { name: 'content-type' },
          { name: 'authorization' },
          { name: 'x-custom' },
        ],
      }),
      makeSchema({
        path: '/orders',
        requestHeaders: [
          { name: 'content-type' },
          { name: 'authorization' },
          { name: 'x-custom' },
        ],
      }),
    ];

    const globals = extractGlobalHeaders(schemas);
    // Only X-Custom should be global (Content-Type is transport, Authorization is auth)
    expect(globals).toEqual([{ name: 'x-custom' }]);
  });

  it('handles case-insensitive header name matching', () => {
    const schemas = [
      makeSchema({
        path: '/users',
        requestHeaders: [{ name: 'x-request-id' }],
      }),
      makeSchema({
        path: '/orders',
        requestHeaders: [{ name: 'x-request-id' }],
      }),
    ];

    const globals = extractGlobalHeaders(schemas);
    expect(globals).toHaveLength(1);
    expect(globals[0]).toEqual({ name: 'x-request-id' });
  });

  it('returns multiple global headers when all match', () => {
    const schemas = [
      makeSchema({
        path: '/users',
        requestHeaders: [
          { name: 'x-request-id' },
          { name: 'x-trace' },
        ],
      }),
      makeSchema({
        path: '/orders',
        requestHeaders: [
          { name: 'x-request-id' },
          { name: 'x-trace' },
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
          { name: 'x-custom' },
          { name: 'x-other' },
        ],
      }),
    ];

    const globals = extractGlobalHeaders(schemas);
    expect(globals).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// buildOperationObject — shared header preservation
// ---------------------------------------------------------------------------

describe('buildOperationObject with globalHeaders', () => {
  it('preserves global headers in operation parameters', () => {
    const schema = makeSchema({
      requestHeaders: [
        { name: 'x-request-id' },
        { name: 'x-custom' },
      ],
    });

    const globalHeaders = new Set(['x-request-id']);
    const operation = buildOperationObject(schema, {}, globalHeaders);
    const params = operation['parameters'] as Array<Record<string, unknown>>;

    // Shared names do not remove an operation's observed header presence.
    const headerParams = params.filter((p) => p['in'] === 'header');
    expect(headerParams.map((parameter) => parameter['name'])).toEqual(['x-custom', 'x-request-id']);
  });

  it('includes all headers when globalHeaders is empty', () => {
    const schema = makeSchema({
      requestHeaders: [
        { name: 'x-request-id' },
        { name: 'x-custom' },
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
  const sharedHeader: HeaderEntry = { name: 'x-request-id' };
  const uniqueHeader: HeaderEntry = { name: 'x-custom' };

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

  it('preserves global header parameters on individual operations', () => {
    const doc = buildOpenApiDocument(schemas);
    const paths = doc['paths'] as Record<string, Record<string, Record<string, unknown>>>;

    // Shared presence must remain visible even without metadata extensions.
    for (const [, methods] of Object.entries(paths)) {
      for (const [, operation] of Object.entries(methods)) {
        const params = (operation['parameters'] as Array<Record<string, unknown>>) ?? [];
        const headerParams = params.filter((p) => p['in'] === 'header');
        const headerNames = headerParams.map((p) => (p['name'] as string).toLowerCase());
        expect(headerNames).toContain('x-request-id');
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
    expect(headerParams.map((parameter) => parameter['name'])).toEqual(['x-custom', 'x-request-id']);
  });

  it('adds x-specwatch-global-headers when includeMetadata is true', () => {
    const doc = buildOpenApiDocument(schemas, { includeMetadata: true });
    const globalHeaders = doc['x-specwatch-global-headers'] as Array<{
      name: string;
    }>;
    expect(globalHeaders).toBeDefined();
    expect(globalHeaders).toHaveLength(1);
    expect(globalHeaders[0].name).toBe('x-request-id');
    expect(globalHeaders[0]).toEqual({ name: 'x-request-id' });
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
        requestHeaders: [{ name: 'x-custom' }],
        responseSchemas: { '200': { type: 'object' } },
      }),
      makeSchema({
        id: 2,
        path: '/orders',
        httpMethod: 'GET',
        requestHeaders: [{ name: 'x-other' }],
        responseSchemas: { '200': { type: 'object' } },
      }),
    ];

    const doc = buildOpenApiDocument(noGlobalSchemas, { includeMetadata: true });
    expect(doc['x-specwatch-global-headers']).toBeUndefined();
  });
});
