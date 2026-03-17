import { describe, it, expect } from 'vitest';
import { buildAgentExtensions } from '../../src/analysis/agent-extensions.js';
import { buildOpenApiDocument } from '../../src/export/openapi.js';
import type { SequenceAnalysis, OperationSequence } from '../../src/analysis/sequences.js';
import type { CompletenessReport, ResponseCompleteness } from '../../src/analysis/completeness.js';
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

function emptySequenceAnalysis(): SequenceAnalysis {
  return { sequences: [], verificationLoops: [], totalRequests: 0, wastedRequests: 0 };
}

function emptyCompletenessReport(): CompletenessReport {
  return { endpoints: [], thinResponses: [], avgCompleteness: 0 };
}

// ---------------------------------------------------------------------------
// buildAgentExtensions
// ---------------------------------------------------------------------------

describe('buildAgentExtensions', () => {
  it('returns empty record when both analyses are empty', () => {
    const result = buildAgentExtensions(emptySequenceAnalysis(), emptyCompletenessReport());
    expect(result).toEqual({});
  });

  it('includes responseCompleteness and missingFields from completeness report', () => {
    const report: CompletenessReport = {
      endpoints: [
        {
          method: 'POST',
          path: '/users',
          writeFieldCount: 2,
          readFieldCount: 10,
          completenessScore: 0.2,
          missingFields: ['email', 'phone', 'address'],
        },
      ],
      thinResponses: [],
      avgCompleteness: 0.2,
    };

    const result = buildAgentExtensions(emptySequenceAnalysis(), report);
    expect(result['POST /users']).toBeDefined();
    expect(result['POST /users'].responseCompleteness).toBe(0.2);
    expect(result['POST /users'].missingFields).toEqual(['email', 'phone', 'address']);
  });

  it('omits missingFields when empty', () => {
    const report: CompletenessReport = {
      endpoints: [
        {
          method: 'PUT',
          path: '/users/{userId}',
          writeFieldCount: 10,
          readFieldCount: 10,
          completenessScore: 1.0,
          missingFields: [],
        },
      ],
      thinResponses: [],
      avgCompleteness: 1.0,
    };

    const result = buildAgentExtensions(emptySequenceAnalysis(), report);
    expect(result['PUT /users/{userId}'].missingFields).toBeUndefined();
  });

  it('includes verification loop data from sequence analysis', () => {
    const seqAnalysis: SequenceAnalysis = {
      sequences: [
        {
          fromMethod: 'POST',
          fromPath: '/clusters',
          toMethod: 'GET',
          toPath: '/clusters/{clusterId}',
          avgDelayMs: 100,
          count: 5,
          pattern: 'verification_loop',
        },
      ],
      verificationLoops: [
        {
          fromMethod: 'POST',
          fromPath: '/clusters',
          toMethod: 'GET',
          toPath: '/clusters/{clusterId}',
          avgDelayMs: 100,
          count: 5,
          pattern: 'verification_loop',
        },
      ],
      totalRequests: 20,
      wastedRequests: 5,
    };

    const result = buildAgentExtensions(seqAnalysis, emptyCompletenessReport());
    expect(result['POST /clusters'].verificationLoopDetected).toBe(true);
    expect(result['POST /clusters'].verificationLoopCount).toBe(5);
  });

  it('includes commonNextSteps derived from sequence analysis', () => {
    const seqAnalysis: SequenceAnalysis = {
      sequences: [
        {
          fromMethod: 'POST',
          fromPath: '/users',
          toMethod: 'GET',
          toPath: '/users/{userId}',
          avgDelayMs: 100,
          count: 3,
          pattern: 'verification_loop',
        },
        {
          fromMethod: 'POST',
          fromPath: '/users',
          toMethod: 'GET',
          toPath: '/users',
          avgDelayMs: 200,
          count: 1,
          pattern: 'list_after_create',
        },
      ],
      verificationLoops: [
        {
          fromMethod: 'POST',
          fromPath: '/users',
          toMethod: 'GET',
          toPath: '/users/{userId}',
          avgDelayMs: 100,
          count: 3,
          pattern: 'verification_loop',
        },
      ],
      totalRequests: 10,
      wastedRequests: 3,
    };

    const result = buildAgentExtensions(seqAnalysis, emptyCompletenessReport());
    expect(result['POST /users'].commonNextSteps).toEqual([
      'GET /users/{userId}',
      'GET /users',
    ]);
  });

  it('merges completeness and sequence data for same endpoint', () => {
    const seqAnalysis: SequenceAnalysis = {
      sequences: [
        {
          fromMethod: 'POST',
          fromPath: '/orders',
          toMethod: 'GET',
          toPath: '/orders/{orderId}',
          avgDelayMs: 50,
          count: 4,
          pattern: 'verification_loop',
        },
      ],
      verificationLoops: [
        {
          fromMethod: 'POST',
          fromPath: '/orders',
          toMethod: 'GET',
          toPath: '/orders/{orderId}',
          avgDelayMs: 50,
          count: 4,
          pattern: 'verification_loop',
        },
      ],
      totalRequests: 10,
      wastedRequests: 4,
    };

    const report: CompletenessReport = {
      endpoints: [
        {
          method: 'POST',
          path: '/orders',
          writeFieldCount: 3,
          readFieldCount: 8,
          completenessScore: 0.375,
          missingFields: ['status', 'total', 'items'],
        },
      ],
      thinResponses: [],
      avgCompleteness: 0.375,
    };

    const result = buildAgentExtensions(seqAnalysis, report);
    const ext = result['POST /orders'];
    expect(ext.responseCompleteness).toBe(0.38); // rounded
    expect(ext.missingFields).toEqual(['status', 'total', 'items']);
    expect(ext.verificationLoopDetected).toBe(true);
    expect(ext.verificationLoopCount).toBe(4);
    expect(ext.commonNextSteps).toEqual(['GET /orders/{orderId}']);
  });

  it('endpoints with no analysis data have no extension', () => {
    const seqAnalysis: SequenceAnalysis = {
      sequences: [
        {
          fromMethod: 'POST',
          fromPath: '/users',
          toMethod: 'GET',
          toPath: '/users/{userId}',
          avgDelayMs: 100,
          count: 2,
          pattern: 'verification_loop',
        },
      ],
      verificationLoops: [
        {
          fromMethod: 'POST',
          fromPath: '/users',
          toMethod: 'GET',
          toPath: '/users/{userId}',
          avgDelayMs: 100,
          count: 2,
          pattern: 'verification_loop',
        },
      ],
      totalRequests: 10,
      wastedRequests: 2,
    };

    const result = buildAgentExtensions(seqAnalysis, emptyCompletenessReport());
    // GET /orders should not appear
    expect(result['GET /orders']).toBeUndefined();
    // Only POST /users should have data
    expect(result['POST /users']).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// OpenAPI export integration
// ---------------------------------------------------------------------------

describe('OpenAPI export with agent extensions', () => {
  it('agent session export includes x-specwatch-agent on endpoints with analysis data', () => {
    const schemas: AggregatedSchema[] = [
      makeSchema({
        httpMethod: 'POST',
        path: '/users',
        requestSchema: makeObjectSchema(['name']),
        responseSchemas: { '201': makeObjectSchema(['id', 'name']) },
      }),
      makeSchema({
        httpMethod: 'GET',
        path: '/users/{userId}',
        responseSchemas: { '200': makeObjectSchema(['id', 'name', 'email', 'phone']) },
      }),
    ];

    const agentExtensions = {
      'POST /users': {
        responseCompleteness: 0.5,
        missingFields: ['email', 'phone'],
        verificationLoopDetected: true,
        verificationLoopCount: 3,
        commonNextSteps: ['GET /users/{userId}'],
      },
    };

    const doc = buildOpenApiDocument(schemas, {}, agentExtensions);
    const paths = doc['paths'] as Record<string, Record<string, Record<string, unknown>>>;

    // POST /users should have x-specwatch-agent
    const postOp = paths['/users']['post'];
    expect(postOp['x-specwatch-agent']).toEqual({
      responseCompleteness: 0.5,
      missingFields: ['email', 'phone'],
      verificationLoopDetected: true,
      verificationLoopCount: 3,
      commonNextSteps: ['GET /users/{userId}'],
    });

    // GET /users/{userId} should NOT have x-specwatch-agent
    const getOp = paths['/users/{userId}']['get'];
    expect(getOp['x-specwatch-agent']).toBeUndefined();
  });

  it('human session export does NOT include x-specwatch-agent', () => {
    const schemas: AggregatedSchema[] = [
      makeSchema({
        httpMethod: 'POST',
        path: '/users',
        responseSchemas: { '201': makeObjectSchema(['id']) },
      }),
    ];

    // No agent extensions passed (human session)
    const doc = buildOpenApiDocument(schemas, {});
    const paths = doc['paths'] as Record<string, Record<string, Record<string, unknown>>>;
    const postOp = paths['/users']['post'];
    expect(postOp['x-specwatch-agent']).toBeUndefined();
  });

  it('does not emit x-specwatch-agent when extension would be empty', () => {
    const schemas: AggregatedSchema[] = [
      makeSchema({
        httpMethod: 'GET',
        path: '/health',
        responseSchemas: { '200': makeObjectSchema(['status']) },
      }),
    ];

    // Pass agent extensions that don't match any endpoint
    const agentExtensions = {
      'POST /users': { verificationLoopDetected: true, verificationLoopCount: 1 },
    };

    const doc = buildOpenApiDocument(schemas, {}, agentExtensions);
    const paths = doc['paths'] as Record<string, Record<string, Record<string, unknown>>>;
    const getOp = paths['/health']['get'];
    expect(getOp['x-specwatch-agent']).toBeUndefined();
  });

  it('empty agent extensions map produces no x-specwatch-agent', () => {
    const schemas: AggregatedSchema[] = [
      makeSchema({
        httpMethod: 'GET',
        path: '/health',
        responseSchemas: { '200': makeObjectSchema(['status']) },
      }),
    ];

    const doc = buildOpenApiDocument(schemas, {}, {});
    const paths = doc['paths'] as Record<string, Record<string, Record<string, unknown>>>;
    const getOp = paths['/health']['get'];
    expect(getOp['x-specwatch-agent']).toBeUndefined();
  });
});
