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
      // A verification loop is NOT a redundant duplicate: with no retry/
      // redundant_list sequences, wasted_request_count is 0 and the
      // reduce_redundant_call recommendation does not fire.
      wasted_request_count: 0,
      missing_response_fields: ['name', 'price', 'status'],
      common_follow_up_operations: ['GET /products/{id}'],
    });
    expect(post?.recommendations.map((r) => r.kind)).toEqual([
      'enrich_write_response',
      'document_common_next_step',
    ]);
  });

  it('emits reduce_redundant_call from repeated equivalent calls (retry), distinct from verification loops', () => {
    const analysis: SequenceAnalysis = {
      sequences: [
        {
          fromMethod: 'GET',
          fromPath: '/products',
          toMethod: 'GET',
          toPath: '/products',
          avgDelayMs: 50,
          count: 2,
          pattern: 'retry',
        },
      ],
      verificationLoops: [],
      totalRequests: 5,
      wastedRequests: 2,
      redundantCalls: [],
      toolUsage: [{ operationKey: 'GET /products', count: 3, isRedundant: true }],
    };

    const evidence = buildAgentEvidence({
      runName: 'redundant-products',
      sampleCount: 5,
      sequenceAnalysis: analysis,
      completenessReport: { endpoints: [], thinResponses: [], avgCompleteness: 0 },
    });

    const get = evidence.operations.find((op) => op.operation_key === 'GET /products');
    expect(get?.wasted_request_count).toBe(2);
    expect(get?.verification_loop_count).toBe(0);
    expect(get?.recommendations.map((r) => r.kind)).toContain('reduce_redundant_call');
  });

  it('does not fold JSON-RPC protocol redundancy into per-operation wasted_request_count', () => {
    // JSON-RPC sequence detection is windowed, so its counts overcount duplicates.
    // Protocol/tool redundancy is surfaced at the report level (redundantCalls),
    // NOT folded into per-operation evidence here. No reduce_redundant_call fires.
    const analysis: SequenceAnalysis = {
      sequences: [
        {
          fromMethod: 'tools/list',
          fromPath: 'tools/list',
          toMethod: 'tools/list',
          toPath: 'tools/list',
          avgDelayMs: 10,
          count: 2,
          pattern: 'redundant_list',
        },
      ],
      verificationLoops: [],
      totalRequests: 4,
      wastedRequests: 2,
      redundantCalls: [{ operationKey: 'tools/list', count: 3, expectedCount: 1 }],
      toolUsage: [{ operationKey: 'tools/list', count: 3, isRedundant: true }],
    };

    const evidence = buildAgentEvidence({
      runName: 'rpc-redundant',
      sampleCount: 4,
      sequenceAnalysis: analysis,
      completenessReport: { endpoints: [], thinResponses: [], avgCompleteness: 0 },
    });

    const allKinds = evidence.operations.flatMap((o) => o.recommendations.map((r) => r.kind));
    expect(allKinds).not.toContain('reduce_redundant_call');
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
