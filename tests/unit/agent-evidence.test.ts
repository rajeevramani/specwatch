import { describe, expect, it } from 'vitest';
import {
  buildAgentEvidence,
  JSON_RPC_EVIDENCE_WARNING,
} from '../../src/analysis/agent-evidence.js';
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
      common_follow_up_operations: [{ operation: 'GET /products/{id}', count: 3 }],
    });
    expect(post?.recommendations.map((r) => r.kind)).toEqual([
      'enrich_write_response',
      'document_common_next_step',
    ]);
  });

  it('carries follow-up counts, ordered by observed frequency, excluding self-follow-ups', () => {
    const analysis: SequenceAnalysis = {
      sequences: [
        {
          fromMethod: 'POST',
          fromPath: '/orders',
          toMethod: 'GET',
          toPath: '/orders/{id}',
          avgDelayMs: 100,
          count: 2,
          pattern: 'verification_loop',
        },
        {
          fromMethod: 'POST',
          fromPath: '/orders',
          toMethod: 'GET',
          toPath: '/invoices',
          avgDelayMs: 100,
          count: 5,
          pattern: 'unknown',
        },
        {
          fromMethod: 'POST',
          fromPath: '/orders',
          toMethod: 'POST',
          toPath: '/orders',
          avgDelayMs: 100,
          count: 4,
          pattern: 'unknown',
        },
      ],
      verificationLoops: [],
      totalRequests: 12,
      wastedRequests: 0,
      redundantCalls: [],
      toolUsage: [{ operationKey: 'POST /orders', count: 8, isRedundant: false }],
    };

    const evidence = buildAgentEvidence({
      runName: 'r',
      sampleCount: 12,
      sequenceAnalysis: analysis,
      completenessReport: { endpoints: [], thinResponses: [], avgCompleteness: 0 },
    });

    const post = evidence.operations.find((op) => op.operation_key === 'POST /orders');
    expect(post?.common_follow_up_operations).toEqual([
      { operation: 'GET /invoices', count: 5 },
      { operation: 'GET /orders/{id}', count: 2 },
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

  it('adds a run-level REST-only warning for JSON-RPC sessions', () => {
    const analysis: SequenceAnalysis = {
      sequences: [],
      verificationLoops: [],
      totalRequests: 4,
      wastedRequests: 0,
      redundantCalls: [],
      toolUsage: [{ operationKey: 'tools/call:cp_create_cluster', count: 4, isRedundant: false }],
    };

    const evidence = buildAgentEvidence({
      runName: 'mcp-run',
      sampleCount: 4,
      sequenceAnalysis: analysis,
      completenessReport: { endpoints: [], thinResponses: [], avgCompleteness: 0 },
      isJsonRpc: true,
    });

    // JSON-RPC keys are not method+path shaped, so operations[] is empty —
    // the run-level warning is what tells the consumer why.
    expect(evidence.operations).toEqual([]);
    expect(evidence.warnings).toEqual([JSON_RPC_EVIDENCE_WARNING]);

    const restEvidence = buildAgentEvidence({
      runName: 'rest-run',
      sampleCount: 4,
      sequenceAnalysis: analysis,
      completenessReport: { endpoints: [], thinResponses: [], avgCompleteness: 0 },
    });
    expect(restEvidence.warnings).toBeUndefined();
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

  it('keeps an ambiguous match in operations[] with a warning but excludes it from unmatched', () => {
    // Two template candidates for GET /products/{id}: an ambiguous match.
    const ambiguousSpec = {
      openapi: '3.1.0',
      paths: {
        '/products': { post: { operationId: 'createProduct' } },
        '/products/{productId}': { get: { operationId: 'getByProductId' } },
        '/products/{slug}': { get: { operationId: 'getBySlug' } },
      },
    };
    const evidence = buildAgentEvidence({
      runName: 'thin-products',
      sampleCount: 8,
      sequenceAnalysis: sequenceAnalysis(),
      completenessReport: completenessReport(),
      specOperations: collectOpenApiOperations(ambiguousSpec),
    });

    const get = evidence.operations.find((op) => op.operation_key === 'GET /products/{id}');
    expect(get).toBeDefined();
    expect(get?.operation_id).toBeUndefined();
    expect(get?.warnings?.[0]).toContain('Ambiguous');
    // Ambiguous matches are NOT summarized in unmatched_observations.
    const unmatchedKeys = (evidence.unmatched_observations ?? []).map((u) => u.operation_key);
    expect(unmatchedKeys).not.toContain('GET /products/{id}');
    // The POST mapped cleanly; only it should be absent from unmatched too.
    expect(unmatchedKeys).toEqual([]);
  });

  it('hashes the provided spec content without a second file read', async () => {
    const { createHash } = await import('node:crypto');
    const content = 'openapi: "3.1.0"\npaths: {}\n';
    const evidence = buildAgentEvidence({
      runName: 'thin-products',
      sampleCount: 8,
      sequenceAnalysis: sequenceAnalysis(),
      completenessReport: completenessReport(),
      // specSource is a label only; a non-existent path must NOT be read because
      // specContent is supplied.
      specSource: '/does/not/exist.yaml',
      specContent: content,
    });

    const expected = `sha256:${createHash('sha256').update(content).digest('hex')}`;
    expect(evidence.spec).toEqual({ source: '/does/not/exist.yaml', hash: expected });
  });
});

describe('phase-1 recommendation rules', () => {
  function emptyCompleteness(): CompletenessReport {
    return { endpoints: [], thinResponses: [], avgCompleteness: 0 };
  }
  function emptyAnalysis(overrides: Partial<SequenceAnalysis> = {}): SequenceAnalysis {
    return {
      sequences: [],
      verificationLoops: [],
      totalRequests: 0,
      wastedRequests: 0,
      redundantCalls: [],
      toolUsage: [],
      ...overrides,
    };
  }
  function recsFor(operationKey: string, opts: Parameters<typeof buildAgentEvidence>[0]) {
    const evidence = buildAgentEvidence(opts);
    return evidence.operations.find((o) => o.operation_key === operationKey)?.recommendations ?? [];
  }

  it('document_common_next_step fires from observed follow-ups, not verification loops', () => {
    // A plain next-step (POST /a -> GET /b), no verification loop, no completeness.
    const analysis = emptyAnalysis({
      sequences: [
        {
          fromMethod: 'POST',
          fromPath: '/a',
          toMethod: 'GET',
          toPath: '/b',
          avgDelayMs: 100,
          count: 4,
          pattern: 'unknown',
        },
      ],
    });
    const recs = recsFor('POST /a', {
      runName: 'r',
      sampleCount: 50,
      sequenceAnalysis: analysis,
      completenessReport: emptyCompleteness(),
    });
    const next = recs.find((r) => r.kind === 'document_common_next_step');
    expect(next).toBeDefined();
    expect(next?.message).toContain('GET /b');
    expect(recs.map((r) => r.kind)).not.toContain('enrich_write_response');
  });

  it('document_common_next_step does NOT fire for a one-off follow-up (count below threshold)', () => {
    const analysis = emptyAnalysis({
      sequences: [
        {
          fromMethod: 'POST',
          fromPath: '/a',
          toMethod: 'GET',
          toPath: '/b',
          avgDelayMs: 100,
          count: 1,
          pattern: 'unknown',
        },
      ],
    });
    const evidence = buildAgentEvidence({
      runName: 'r',
      sampleCount: 50,
      sequenceAnalysis: analysis,
      completenessReport: emptyCompleteness(),
    });
    const post = evidence.operations.find((o) => o.operation_key === 'POST /a');
    // The one-off still appears in the evidence field with its count...
    expect(post?.common_follow_up_operations).toEqual([{ operation: 'GET /b', count: 1 }]);
    // ...but the recommendation requires repetition.
    expect(post?.recommendations.map((r) => r.kind)).not.toContain('document_common_next_step');
  });

  it('document_common_next_step fires at the repetition threshold (count = 2)', () => {
    const analysis = emptyAnalysis({
      sequences: [
        {
          fromMethod: 'POST',
          fromPath: '/a',
          toMethod: 'GET',
          toPath: '/b',
          avgDelayMs: 100,
          count: 2,
          pattern: 'unknown',
        },
      ],
    });
    const recs = recsFor('POST /a', {
      runName: 'r',
      sampleCount: 50,
      sequenceAnalysis: analysis,
      completenessReport: emptyCompleteness(),
    });
    expect(recs.map((r) => r.kind)).toContain('document_common_next_step');
  });

  it('enrich_write_response fires on low completeness OR on verification loops', () => {
    const thinOnly = recsFor('POST /p', {
      runName: 'r',
      sampleCount: 50,
      sequenceAnalysis: emptyAnalysis(),
      completenessReport: {
        endpoints: [
          {
            method: 'POST',
            path: '/p',
            writeFieldCount: 1,
            readFieldCount: 5,
            completenessScore: 0.2,
            missingFields: ['a'],
          },
        ],
        thinResponses: [],
        avgCompleteness: 0.2,
      },
    });
    expect(thinOnly.map((r) => r.kind)).toContain('enrich_write_response');

    const loopOnly = recsFor('POST /q', {
      runName: 'r',
      sampleCount: 50,
      sequenceAnalysis: emptyAnalysis({
        sequences: [
          {
            fromMethod: 'POST',
            fromPath: '/q',
            toMethod: 'GET',
            toPath: '/q/{id}',
            avgDelayMs: 50,
            count: 1,
            pattern: 'verification_loop',
          },
        ],
      }),
      completenessReport: emptyCompleteness(),
    });
    expect(loopOnly.map((r) => r.kind)).toContain('enrich_write_response');
  });

  it('never emits the deferred phase-2 kinds', () => {
    // A thin write response with a verification loop and a follow-up read.
    const recs = recsFor('POST /products', {
      runName: 'r',
      sampleCount: 5,
      sequenceAnalysis: sequenceAnalysis(),
      completenessReport: completenessReport(),
    });
    const kinds = new Set(recs.map((r) => r.kind));
    expect(kinds).not.toContain('standardize_error_response');
    expect(kinds).not.toContain('add_operation_metadata');
    for (const k of kinds) {
      expect([
        'enrich_write_response',
        'document_common_next_step',
        'reduce_redundant_call',
      ]).toContain(k);
    }
  });

  it('scales language with confidence and flags low sample counts', () => {
    function enrich(verificationLoopCount: number, sampleCount: number) {
      const sequences = Array.from({ length: verificationLoopCount }, () => ({
        fromMethod: 'POST',
        fromPath: '/x',
        toMethod: 'GET',
        toPath: '/x/{id}',
        avgDelayMs: 50,
        count: 1,
        pattern: 'verification_loop' as const,
      }));
      return recsFor('POST /x', {
        runName: 'r',
        sampleCount,
        sequenceAnalysis: emptyAnalysis({ sequences }),
        completenessReport: emptyCompleteness(),
      }).find((r) => r.kind === 'enrich_write_response');
    }

    const weak = enrich(1, 50);
    expect(weak?.severity).toBe('medium');
    expect(weak?.message).toContain('Consider');
    expect(weak?.message).not.toContain('weak signal');

    const strong = enrich(3, 5);
    expect(strong?.severity).toBe('high');
    expect(strong?.message).toContain('may reduce');
    expect(strong?.message).toContain('weak signal'); // sampleCount 5 < threshold
  });
});
