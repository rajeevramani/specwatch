/**
 * Unit tests for the aggregation pipeline functions.
 */

import { describe, it, expect } from 'vitest';
import { groupSamples, mergeGroupSchemas, calculateRequiredFields, mergeHeaders, mergeQueryParams, collectPathParamValues, inferEnums, computeSchemaFingerprint, countUniqueResponseShapes } from './pipeline.js';
import type { Sample, InferredSchema, HeaderEntry } from '../types/index.js';

// ============================================================
// Test helpers
// ============================================================

function makeStats(sampleCount = 1, presenceCount = 1) {
  return { sampleCount, presenceCount, confidence: presenceCount / sampleCount };
}

function makeSample(overrides: Partial<Sample> = {}): Sample {
  return {
    id: 1,
    sessionId: 'session-1',
    httpMethod: 'GET',
    path: '/users/1',
    normalizedPath: '/users/{userId}',
    statusCode: 200,
    capturedAt: '2026-03-10T00:00:00Z',
    ...overrides,
  };
}

function makeObjectSchema(
  properties: Record<string, InferredSchema>,
  required: string[] = [],
  sampleCount = 1,
): InferredSchema {
  return {
    type: 'object',
    properties,
    required,
    stats: makeStats(sampleCount, sampleCount),
  };
}

function makeStringSchema(): InferredSchema {
  return { type: 'string', stats: makeStats() };
}

function makeIntegerSchema(): InferredSchema {
  return { type: 'integer', stats: makeStats() };
}

// ============================================================
// Task 4.1 — groupSamples
// ============================================================

describe('groupSamples', () => {
  it('returns empty map for empty input', () => {
    const groups = groupSamples([]);
    expect(groups.size).toBe(0);
  });

  it('groups single sample into its key', () => {
    const sample = makeSample();
    const groups = groupSamples([sample]);
    expect(groups.size).toBe(1);
    const key = 'GET /users/{userId} 200';
    expect(groups.has(key)).toBe(true);
    expect(groups.get(key)).toHaveLength(1);
  });

  it('groups multiple samples for same endpoint together', () => {
    const samples = [
      makeSample({ path: '/users/1' }),
      makeSample({ path: '/users/2' }),
      makeSample({ path: '/users/3' }),
    ];
    const groups = groupSamples(samples);
    expect(groups.size).toBe(1);
    expect(groups.get('GET /users/{userId} 200')).toHaveLength(3);
  });

  it('separates samples by HTTP method', () => {
    const samples = [
      makeSample({ httpMethod: 'GET', normalizedPath: '/users' }),
      makeSample({ httpMethod: 'POST', normalizedPath: '/users' }),
    ];
    const groups = groupSamples(samples);
    expect(groups.size).toBe(2);
    expect(groups.has('GET /users 200')).toBe(true);
    expect(groups.has('POST /users 200')).toBe(true);
  });

  it('separates samples by status code', () => {
    const samples = [
      makeSample({ statusCode: 200 }),
      makeSample({ statusCode: 404 }),
    ];
    const groups = groupSamples(samples);
    expect(groups.size).toBe(2);
    expect(groups.has('GET /users/{userId} 200')).toBe(true);
    expect(groups.has('GET /users/{userId} 404')).toBe(true);
  });

  it('handles undefined status code using 0 as key', () => {
    const sample = makeSample({ statusCode: undefined });
    const groups = groupSamples([sample]);
    expect(groups.has('GET /users/{userId} 0')).toBe(true);
  });

  it('groups by normalized path, not raw path', () => {
    const samples = [
      makeSample({ path: '/users/123', normalizedPath: '/users/{userId}' }),
      makeSample({ path: '/users/456', normalizedPath: '/users/{userId}' }),
    ];
    const groups = groupSamples(samples);
    // Both should be in the same group
    expect(groups.size).toBe(1);
  });

  it('creates separate groups for POST /users 201 vs GET /users 200', () => {
    const samples = [
      makeSample({ httpMethod: 'GET', normalizedPath: '/users', statusCode: 200 }),
      makeSample({ httpMethod: 'POST', normalizedPath: '/users', statusCode: 201 }),
    ];
    const groups = groupSamples(samples);
    expect(groups.size).toBe(2);
    expect(groups.has('GET /users 200')).toBe(true);
    expect(groups.has('POST /users 201')).toBe(true);
  });

  it('uppercases HTTP method in key', () => {
    const sample = makeSample({ httpMethod: 'get' });
    const groups = groupSamples([sample]);
    expect(groups.has('GET /users/{userId} 200')).toBe(true);
  });
});

// ============================================================
// Task 4.2 — mergeGroupSchemas
// ============================================================

describe('mergeGroupSchemas', () => {
  it('returns empty for no samples', () => {
    const result = mergeGroupSchemas([]);
    expect(result.requestSchema).toBeUndefined();
    expect(result.responseSchema).toBeUndefined();
  });

  it('returns single schema when only one sample', () => {
    const responseSchema = makeObjectSchema({ id: makeIntegerSchema() });
    const sample = makeSample({ responseSchema });
    const result = mergeGroupSchemas([sample]);
    expect(result.responseSchema).toBeDefined();
    expect(result.responseSchema?.type).toBe('object');
  });

  it('merges request schemas from multiple samples', () => {
    const samples = [
      makeSample({
        requestSchema: makeObjectSchema({ name: makeStringSchema() }),
      }),
      makeSample({
        requestSchema: makeObjectSchema({ name: makeStringSchema(), email: makeStringSchema() }),
      }),
    ];
    const result = mergeGroupSchemas(samples);
    expect(result.requestSchema).toBeDefined();
    expect(result.requestSchema?.properties).toHaveProperty('name');
    expect(result.requestSchema?.properties).toHaveProperty('email');
  });

  it('handles samples with no schemas', () => {
    const samples = [
      makeSample({ requestSchema: undefined, responseSchema: undefined }),
    ];
    const result = mergeGroupSchemas(samples);
    expect(result.requestSchema).toBeUndefined();
    expect(result.responseSchema).toBeUndefined();
  });

  it('fixes field stats to reflect actual presence', () => {
    // 3 samples, but 'email' only present in 2
    const samples = [
      makeSample({
        responseSchema: makeObjectSchema({ id: makeIntegerSchema(), email: makeStringSchema() }),
      }),
      makeSample({
        responseSchema: makeObjectSchema({ id: makeIntegerSchema(), email: makeStringSchema() }),
      }),
      makeSample({
        responseSchema: makeObjectSchema({ id: makeIntegerSchema() }),
      }),
    ];
    const result = mergeGroupSchemas(samples);
    expect(result.responseSchema).toBeDefined();
    const emailField = result.responseSchema?.properties?.['email'];
    expect(emailField).toBeDefined();
    // email was in 2 out of 3 samples
    expect(emailField!.stats.presenceCount).toBe(2);
    expect(emailField!.stats.sampleCount).toBe(3);
  });

  it('marks field with 3/3 presence as having sampleCount=3, presenceCount=3', () => {
    const samples = [
      makeSample({ responseSchema: makeObjectSchema({ id: makeIntegerSchema() }) }),
      makeSample({ responseSchema: makeObjectSchema({ id: makeIntegerSchema() }) }),
      makeSample({ responseSchema: makeObjectSchema({ id: makeIntegerSchema() }) }),
    ];
    const result = mergeGroupSchemas(samples);
    const idField = result.responseSchema?.properties?.['id'];
    expect(idField?.stats.presenceCount).toBe(3);
    expect(idField?.stats.sampleCount).toBe(3);
  });
});

// ============================================================
// Task 4.3 — calculateRequiredFields
// ============================================================

describe('calculateRequiredFields', () => {
  it('marks field as required when presenceCount equals totalSamples', () => {
    const schema = makeObjectSchema({
      id: { type: 'integer', stats: { sampleCount: 5, presenceCount: 5, confidence: 1.0 } },
      name: { type: 'string', stats: { sampleCount: 5, presenceCount: 5, confidence: 1.0 } },
    });

    const result = calculateRequiredFields(schema, 5);
    expect(result.required).toContain('id');
    expect(result.required).toContain('name');
  });

  it('does not mark field as required when presenceCount < totalSamples', () => {
    const schema = makeObjectSchema({
      id: { type: 'integer', stats: { sampleCount: 5, presenceCount: 5, confidence: 1.0 } },
      notes: { type: 'string', stats: { sampleCount: 5, presenceCount: 3, confidence: 0.6 } },
    });

    const result = calculateRequiredFields(schema, 5);
    expect(result.required).toContain('id');
    expect(result.required).not.toContain('notes');
  });

  it('returns alphabetically sorted required fields', () => {
    const schema = makeObjectSchema({
      zebra: { type: 'string', stats: { sampleCount: 3, presenceCount: 3, confidence: 1.0 } },
      alpha: { type: 'string', stats: { sampleCount: 3, presenceCount: 3, confidence: 1.0 } },
      middle: { type: 'string', stats: { sampleCount: 3, presenceCount: 3, confidence: 1.0 } },
    });

    const result = calculateRequiredFields(schema, 3);
    expect(result.required).toEqual(['alpha', 'middle', 'zebra']);
  });

  it('handles empty schema gracefully', () => {
    const schema: InferredSchema = {
      type: 'object',
      stats: makeStats(),
    };

    const result = calculateRequiredFields(schema, 1);
    expect(result.required).toBeUndefined();
  });

  it('recurses into nested objects', () => {
    const nestedSchema = makeObjectSchema({
      value: { type: 'string', stats: { sampleCount: 3, presenceCount: 3, confidence: 1.0 } },
    });
    nestedSchema.stats = { sampleCount: 5, presenceCount: 5, confidence: 1.0 };

    const schema = makeObjectSchema({
      user: {
        type: 'object',
        properties: {
          id: { type: 'integer', stats: { sampleCount: 5, presenceCount: 5, confidence: 1.0 } },
          nickname: { type: 'string', stats: { sampleCount: 5, presenceCount: 2, confidence: 0.4 } },
        },
        stats: { sampleCount: 5, presenceCount: 5, confidence: 1.0 },
      },
    });

    const result = calculateRequiredFields(schema, 5);
    const userField = result.properties?.['user'];
    expect(userField?.required).toContain('id');
    expect(userField?.required).not.toContain('nickname');
  });

  it('handles non-object schema without modification', () => {
    const schema = makeStringSchema();
    const result = calculateRequiredFields(schema, 5);
    expect(result.type).toBe('string');
  });

  it('all fields optional when none have 100% presence', () => {
    const schema = makeObjectSchema({
      id: { type: 'integer', stats: { sampleCount: 5, presenceCount: 4, confidence: 0.8 } },
      name: { type: 'string', stats: { sampleCount: 5, presenceCount: 3, confidence: 0.6 } },
    });

    const result = calculateRequiredFields(schema, 5);
    expect(result.required).toHaveLength(0);
  });

  it('PATCH requests: no fields are marked required even with 100% presence', () => {
    const schema = makeObjectSchema({
      id: { type: 'integer', stats: { sampleCount: 5, presenceCount: 5, confidence: 1.0 } },
      name: { type: 'string', stats: { sampleCount: 5, presenceCount: 5, confidence: 1.0 } },
    });

    const result = calculateRequiredFields(schema, 5, 'PATCH');
    expect(result.required).toHaveLength(0);
  });

  it('PATCH method is case-insensitive', () => {
    const schema = makeObjectSchema({
      id: { type: 'integer', stats: { sampleCount: 3, presenceCount: 3, confidence: 1.0 } },
      name: { type: 'string', stats: { sampleCount: 3, presenceCount: 3, confidence: 1.0 } },
    });

    const resultLower = calculateRequiredFields(schema, 3, 'patch');
    expect(resultLower.required).toHaveLength(0);

    const resultMixed = calculateRequiredFields(schema, 3, 'Patch');
    expect(resultMixed.required).toHaveLength(0);
  });

  it('POST requests still mark 100% presence fields as required', () => {
    const schema = makeObjectSchema({
      id: { type: 'integer', stats: { sampleCount: 5, presenceCount: 5, confidence: 1.0 } },
      name: { type: 'string', stats: { sampleCount: 5, presenceCount: 5, confidence: 1.0 } },
    });

    const result = calculateRequiredFields(schema, 5, 'POST');
    expect(result.required).toContain('id');
    expect(result.required).toContain('name');
  });

  it('PUT requests still mark 100% presence fields as required', () => {
    const schema = makeObjectSchema({
      id: { type: 'integer', stats: { sampleCount: 5, presenceCount: 5, confidence: 1.0 } },
      name: { type: 'string', stats: { sampleCount: 5, presenceCount: 5, confidence: 1.0 } },
    });

    const result = calculateRequiredFields(schema, 5, 'PUT');
    expect(result.required).toContain('id');
    expect(result.required).toContain('name');
  });

  it('PATCH with nested objects: nested fields also not required', () => {
    const schema = makeObjectSchema({
      user: {
        type: 'object',
        properties: {
          id: { type: 'integer', stats: { sampleCount: 5, presenceCount: 5, confidence: 1.0 } },
          email: { type: 'string', stats: { sampleCount: 5, presenceCount: 5, confidence: 1.0 } },
        },
        stats: { sampleCount: 5, presenceCount: 5, confidence: 1.0 },
      },
    });

    const result = calculateRequiredFields(schema, 5, 'PATCH');
    expect(result.required).toHaveLength(0);
    const userField = result.properties?.['user'];
    expect(userField?.required).toHaveLength(0);
  });
});

// ============================================================
// Task 4.5 — mergeHeaders
// ============================================================

describe('mergeHeaders', () => {
  it('returns undefined for empty input', () => {
    expect(mergeHeaders([])).toBeUndefined();
  });

  it('returns undefined when all arrays are undefined', () => {
    expect(mergeHeaders([undefined, undefined])).toBeUndefined();
  });

  it('returns headers from single array', () => {
    const headers: HeaderEntry[] = [
      { name: 'Content-Type', example: 'application/json' },
    ];
    const result = mergeHeaders([headers]);
    expect(result).toHaveLength(1);
    expect(result![0].name).toBe('Content-Type');
  });

  it('deduplicates headers by name (case-insensitive)', () => {
    const h1: HeaderEntry[] = [{ name: 'Content-Type', example: 'application/json' }];
    const h2: HeaderEntry[] = [{ name: 'content-type', example: 'text/plain' }];

    const result = mergeHeaders([h1, h2]);
    expect(result).toHaveLength(1);
    // Keeps the first value seen
    expect(result![0].example).toBe('application/json');
  });

  it('keeps example value from first occurrence', () => {
    const h1: HeaderEntry[] = [{ name: 'X-Request-ID', example: 'abc-123' }];
    const h2: HeaderEntry[] = [{ name: 'X-Request-ID', example: 'def-456' }];

    const result = mergeHeaders([h1, h2]);
    expect(result![0].example).toBe('abc-123');
  });

  it('sorts headers alphabetically by name', () => {
    const h1: HeaderEntry[] = [
      { name: 'Z-Header', example: 'z' },
      { name: 'A-Header', example: 'a' },
      { name: 'M-Header', example: 'm' },
    ];

    const result = mergeHeaders([h1]);
    expect(result![0].name).toBe('A-Header');
    expect(result![1].name).toBe('M-Header');
    expect(result![2].name).toBe('Z-Header');
  });

  it('merges headers from multiple samples', () => {
    const h1: HeaderEntry[] = [
      { name: 'Content-Type', example: 'application/json' },
      { name: 'Accept', example: 'application/json' },
    ];
    const h2: HeaderEntry[] = [
      { name: 'Content-Type', example: 'application/json' },
      { name: 'X-Request-ID', example: 'abc-123' },
    ];
    const h3: HeaderEntry[] = [
      { name: 'Authorization', example: 'Bearer ***' },
    ];

    const result = mergeHeaders([h1, h2, h3]);
    expect(result).toHaveLength(4);
    const names = result!.map((h) => h.name);
    expect(names).toContain('Accept');
    expect(names).toContain('Authorization');
    expect(names).toContain('Content-Type');
    expect(names).toContain('X-Request-ID');
  });

  it('handles mix of undefined and real arrays', () => {
    const headers: HeaderEntry[] = [{ name: 'X-Custom', example: 'value' }];
    const result = mergeHeaders([undefined, headers, undefined]);
    expect(result).toHaveLength(1);
    expect(result![0].name).toBe('X-Custom');
  });

  it('returns undefined for arrays with no headers (empty arrays)', () => {
    const result = mergeHeaders([[], []]);
    expect(result).toBeUndefined();
  });
});

// ============================================================
// mergeQueryParams
// ============================================================

describe('mergeQueryParams', () => {
  it('returns undefined when no samples have query params', () => {
    const samples = [makeSample(), makeSample()];
    expect(mergeQueryParams(samples)).toBeUndefined();
  });

  it('returns undefined for empty samples array', () => {
    expect(mergeQueryParams([])).toBeUndefined();
  });

  it('collects query params from multiple samples', () => {
    const samples = [
      makeSample({ queryParams: { page: '1', limit: '10' } }),
      makeSample({ queryParams: { page: '2', limit: '20' } }),
    ];
    const result = mergeQueryParams(samples);
    expect(result).toEqual({
      page: ['1', '2'],
      limit: ['10', '20'],
    });
  });

  it('deduplicates values across samples', () => {
    const samples = [
      makeSample({ queryParams: { page: '1' } }),
      makeSample({ queryParams: { page: '1' } }),
      makeSample({ queryParams: { page: '2' } }),
    ];
    const result = mergeQueryParams(samples);
    expect(result).toEqual({ page: ['1', '2'] });
  });

  it('merges params from samples where only some have query params', () => {
    const samples = [
      makeSample({ queryParams: { sort: 'name' } }),
      makeSample(),
      makeSample({ queryParams: { sort: 'date', page: '1' } }),
    ];
    const result = mergeQueryParams(samples);
    expect(result).toEqual({
      sort: ['date', 'name'],
      page: ['1'],
    });
  });
});

// ============================================================
// collectPathParamValues
// ============================================================

describe('collectPathParamValues', () => {
  it('extracts values from single path parameter', () => {
    const samples = [
      makeSample({ path: '/users/1', normalizedPath: '/users/{userId}' }),
      makeSample({ path: '/users/2', normalizedPath: '/users/{userId}' }),
      makeSample({ path: '/users/3', normalizedPath: '/users/{userId}' }),
    ];
    const result = collectPathParamValues(samples);
    expect(result).toEqual({ userId: ['1', '2', '3'] });
  });

  it('extracts values from multiple path parameters', () => {
    const samples = [
      makeSample({ path: '/users/1/orders/100', normalizedPath: '/users/{userId}/orders/{orderId}' }),
      makeSample({ path: '/users/2/orders/200', normalizedPath: '/users/{userId}/orders/{orderId}' }),
    ];
    const result = collectPathParamValues(samples);
    expect(result).toEqual({ userId: ['1', '2'], orderId: ['100', '200'] });
  });

  it('returns undefined when no path parameters exist', () => {
    const samples = [
      makeSample({ path: '/users', normalizedPath: '/users' }),
    ];
    const result = collectPathParamValues(samples);
    expect(result).toBeUndefined();
  });

  it('returns undefined for empty samples', () => {
    const result = collectPathParamValues([]);
    expect(result).toBeUndefined();
  });

  it('strips query strings from raw paths before comparison', () => {
    const samples = [
      makeSample({ path: '/users/1?page=1', normalizedPath: '/users/{userId}' }),
      makeSample({ path: '/users/2?page=2&sort=name', normalizedPath: '/users/{userId}' }),
    ];
    const result = collectPathParamValues(samples);
    expect(result).toEqual({ userId: ['1', '2'] });
  });

  it('deduplicates observed values', () => {
    const samples = [
      makeSample({ path: '/users/1', normalizedPath: '/users/{userId}' }),
      makeSample({ path: '/users/1', normalizedPath: '/users/{userId}' }),
      makeSample({ path: '/users/2', normalizedPath: '/users/{userId}' }),
    ];
    const result = collectPathParamValues(samples);
    expect(result).toEqual({ userId: ['1', '2'] });
  });
});

// ============================================================
// inferEnums
// ============================================================

describe('inferEnums', () => {
  it('promotes string field to enum when ≤10 values and ≥10 samples', () => {
    const schema: InferredSchema = {
      type: 'string',
      _observedValues: ['active', 'inactive', 'pending'],
      stats: makeStats(10, 10),
    };
    const result = inferEnums(schema, 10);
    expect(result.enum).toEqual(['active', 'inactive', 'pending']);
    expect(result._observedValues).toBeUndefined();
  });

  it('does not promote when too many distinct values (>10)', () => {
    const values = Array.from({ length: 11 }, (_, i) => `val-${i}`);
    const schema: InferredSchema = {
      type: 'string',
      _observedValues: values,
      stats: makeStats(15, 15),
    };
    const result = inferEnums(schema, 15);
    expect(result.enum).toBeUndefined();
    expect(result._observedValues).toBeUndefined();
  });

  it('does not promote when too few samples (<10)', () => {
    const schema: InferredSchema = {
      type: 'string',
      _observedValues: ['active', 'inactive'],
      stats: makeStats(5, 5),
    };
    const result = inferEnums(schema, 5);
    expect(result.enum).toBeUndefined();
    expect(result._observedValues).toBeUndefined();
  });

  it('returns sorted enum values', () => {
    const schema: InferredSchema = {
      type: 'string',
      _observedValues: ['zebra', 'alpha', 'middle'],
      stats: makeStats(10, 10),
    };
    const result = inferEnums(schema, 10);
    expect(result.enum).toEqual(['alpha', 'middle', 'zebra']);
  });

  it('recurses into object properties', () => {
    const schema = makeObjectSchema({
      status: {
        type: 'string',
        _observedValues: ['active', 'inactive'],
        stats: makeStats(12, 12),
      },
      name: makeStringSchema(),
    });
    const result = inferEnums(schema, 12);
    expect(result.properties?.status.enum).toEqual(['active', 'inactive']);
    expect(result.properties?.status._observedValues).toBeUndefined();
    expect(result.properties?.name.enum).toBeUndefined();
  });

  it('recurses into array items', () => {
    const schema: InferredSchema = {
      type: 'array',
      items: {
        type: 'string',
        _observedValues: ['red', 'green', 'blue'],
        stats: makeStats(10, 10),
      },
      stats: makeStats(10, 10),
    };
    const result = inferEnums(schema, 10);
    expect(result.items?.enum).toEqual(['blue', 'green', 'red']);
  });

  it('recurses into oneOf variants', () => {
    const schema: InferredSchema = {
      type: 'string',
      oneOf: [
        {
          type: 'string',
          _observedValues: ['yes', 'no'],
          stats: makeStats(10, 10),
        },
        { type: 'null', stats: makeStats(10, 10) },
      ],
      stats: makeStats(10, 10),
    };
    const result = inferEnums(schema, 10);
    expect(result.oneOf![0].enum).toEqual(['no', 'yes']);
    expect(result.oneOf![0]._observedValues).toBeUndefined();
  });

  it('strips _observedValues even when enum not promoted', () => {
    const schema: InferredSchema = {
      type: 'string',
      _observedValues: ['a', 'b'],
      stats: makeStats(5, 5),
    };
    const result = inferEnums(schema, 5);
    expect(result._observedValues).toBeUndefined();
    expect(result.enum).toBeUndefined();
  });
});

// ============================================================
// Response Shape Fingerprinting
// ============================================================

describe('computeSchemaFingerprint', () => {
  it('returns <empty> for undefined schema', () => {
    expect(computeSchemaFingerprint(undefined)).toBe('<empty>');
  });

  it('returns type name for primitive schemas', () => {
    expect(computeSchemaFingerprint(makeStringSchema())).toBe('string');
    expect(computeSchemaFingerprint(makeIntegerSchema())).toBe('integer');
  });

  it('produces sorted field fingerprint for objects', () => {
    const schema = makeObjectSchema({
      name: makeStringSchema(),
      age: makeIntegerSchema(),
    });
    expect(computeSchemaFingerprint(schema)).toBe('{age:integer,name:string}');
  });

  it('produces same fingerprint for objects with same fields regardless of order', () => {
    const schema1 = makeObjectSchema({
      a: makeStringSchema(),
      b: makeIntegerSchema(),
    });
    const schema2 = makeObjectSchema({
      b: makeIntegerSchema(),
      a: makeStringSchema(),
    });
    expect(computeSchemaFingerprint(schema1)).toBe(computeSchemaFingerprint(schema2));
  });

  it('produces different fingerprints for objects with different fields', () => {
    const schema1 = makeObjectSchema({ name: makeStringSchema() });
    const schema2 = makeObjectSchema({ email: makeStringSchema() });
    expect(computeSchemaFingerprint(schema1)).not.toBe(computeSchemaFingerprint(schema2));
  });

  it('handles array schemas', () => {
    const schema: InferredSchema = {
      type: 'array',
      items: makeStringSchema(),
      stats: makeStats(),
    };
    expect(computeSchemaFingerprint(schema)).toBe('[string]');
  });

  it('handles oneOf schemas', () => {
    const schema: InferredSchema = {
      type: 'object',
      oneOf: [makeStringSchema(), makeIntegerSchema()],
      stats: makeStats(),
    };
    expect(computeSchemaFingerprint(schema)).toBe('oneOf(integer|string)');
  });
});

describe('countUniqueResponseShapes', () => {
  it('returns 1 for samples with identical response shapes', () => {
    const responseSchema = makeObjectSchema({ id: makeIntegerSchema(), name: makeStringSchema() });
    const samples = [
      makeSample({ responseSchema }),
      makeSample({ responseSchema }),
      makeSample({ responseSchema }),
    ];
    expect(countUniqueResponseShapes(samples)).toBe(1);
  });

  it('returns count of distinct response shapes', () => {
    const shape1 = makeObjectSchema({ id: makeIntegerSchema(), name: makeStringSchema() });
    const shape2 = makeObjectSchema({ id: makeIntegerSchema(), error: makeStringSchema() });
    const samples = [
      makeSample({ responseSchema: shape1 }),
      makeSample({ responseSchema: shape1 }),
      makeSample({ responseSchema: shape2 }),
    ];
    expect(countUniqueResponseShapes(samples)).toBe(2);
  });

  it('counts undefined response schema as a distinct shape', () => {
    const shape1 = makeObjectSchema({ id: makeIntegerSchema() });
    const samples = [
      makeSample({ responseSchema: shape1 }),
      makeSample({ responseSchema: undefined }),
    ];
    expect(countUniqueResponseShapes(samples)).toBe(2);
  });

  it('returns 1 for single sample', () => {
    const samples = [makeSample({ responseSchema: makeStringSchema() })];
    expect(countUniqueResponseShapes(samples)).toBe(1);
  });
});
