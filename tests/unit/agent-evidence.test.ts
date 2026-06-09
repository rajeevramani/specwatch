import { describe, expect, it } from 'vitest';
import { buildAgentEvidence } from '../../src/analysis/agent-evidence.js';
import { collectOpenApiOperations } from '../../src/analysis/spec-mapper.js';
import type { CompletenessReport } from '../../src/analysis/completeness.js';
import type { SequenceAnalysis } from '../../src/analysis/sequences.js';

function sequenceAnalysis(): SequenceAnalysis {
  return {
    sequences: [
      {
        fromMethod: 'POST',
        fromPath: '/products',
        toMethod: 'GET',
        toPath: '/products/{id}',
        avgDelayMs: 100,
        count: 3,
        pattern: 'verification_loop',
      },
    ],
    verificationLoops: [
      {
        fromMethod: 'POST',
        fromPath: '/products',
        toMethod: 'GET',
        toPath: '/products/{id}',
        avgDelayMs: 100,
        count: 3,
        pattern: 'verification_loop',
      },
    ],
    totalRequests: 8,
    wastedRequests: 3,
    redundantCalls: [],
    toolUsage: [
      {
        operationKey: 'POST /products',
        count: 3,
        isRedundant: false,
      },
      {
        operationKey: 'GET /products/{id}',
        count: 3,
        isRedundant: false,
      },
    ],
  };
}

function completenessReport(): CompletenessReport {
  return {
    endpoints: [
      {
        method: 'POST',
        path: '/products',
        writeFieldCount: 1,
        readFieldCount: 4,
        completenessScore: 0.25,
        missingFields: ['name', 'price', 'status'],
      },
    ],
    thinResponses: [],
    avgCompleteness: 0.25,
  };
}

describe('agent evidence builder', () => {
  it('builds operation-level runtime evidence and recommendations', () => {
    const evidence = buildAgentEvidence({
      runName: 'thin-products',
      sampleCount: 8,
      sequenceAnalysis: sequenceAnalysis(),
      completenessReport: completenessReport(),
    });

    expect(evidence.schema_version).toBe('specwatch.agent_evidence.v1');
    expect(evidence.run).toEqual({
      name: 'thin-products',
      consumer: 'agent',
      sample_count: 8,
    });

    const post = evidence.operations.find((op) => op.operation_key === 'POST /products');
    expect(post).toMatchObject({
      method: 'POST',
      path: '/products',
      observed_count: 3,
      response_completeness: 0.25,
      verification_loop_count: 3,
      wasted_request_count: 3,
      missing_response_fields: ['name', 'price', 'status'],
      common_follow_up_operations: ['GET /products/{id}'],
    });
    expect(post?.recommendations.map((r) => r.kind)).toEqual([
      'enrich_write_response',
      'document_common_next_step',
    ]);
  });

  it('maps evidence to OpenAPI operation IDs and spec locations', () => {
    const spec = {
      openapi: '3.1.0',
      paths: {
        '/products': {
          post: { operationId: 'createProduct' },
        },
        '/products/{productId}': {
          get: { operationId: 'getProduct' },
        },
      },
    };

    const evidence = buildAgentEvidence({
      runName: 'thin-products',
      sampleCount: 8,
      sequenceAnalysis: sequenceAnalysis(),
      completenessReport: completenessReport(),
      specOperations: collectOpenApiOperations(spec),
    });

    const post = evidence.operations.find((op) => op.operation_key === 'POST /products');
    expect(post?.operation_id).toBe('createProduct');
    expect(post?.spec_location).toBe('#/paths/~1products/post');

    const get = evidence.operations.find((op) => op.operation_key === 'GET /products/{id}');
    expect(get?.operation_id).toBe('getProduct');
    expect(get?.spec_location).toBe('#/paths/~1products~1{productId}/get');
  });

  it('records unmatched observations when spec mapping fails', () => {
    const evidence = buildAgentEvidence({
      runName: 'thin-products',
      sampleCount: 8,
      sequenceAnalysis: sequenceAnalysis(),
      completenessReport: completenessReport(),
      specOperations: collectOpenApiOperations({ openapi: '3.1.0', paths: {} }),
    });

    expect(evidence.unmatched_observations).toEqual([
      {
        operation_key: 'POST /products',
        reason: 'No OpenAPI operation matched POST /products',
      },
      {
        operation_key: 'GET /products/{id}',
        reason: 'No OpenAPI operation matched GET /products/{id}',
      },
    ]);
  });
});
