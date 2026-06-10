import { describe, expect, it } from 'vitest';
import { buildAgentEvidence } from '../../src/analysis/agent-evidence.js';
import type { BuildAgentEvidenceOptions } from '../../src/analysis/agent-evidence.js';
import type { CompletenessReport } from '../../src/analysis/completeness.js';
import type { OperationSequence, SequenceAnalysis } from '../../src/analysis/sequences.js';

// ---------------------------------------------------------------------------
// Spec-driven input builders.
//
// These tests are written purely against the PHASE-1 recommendation-rule
// acceptance criteria for bead specwatch-ag5.2. The `buildRecommendations`
// implementation is treated as a black box: we only construct the documented
// input shapes and assert on the documented `kind`/`message` behavior.
// ---------------------------------------------------------------------------

const emptyCompleteness: CompletenessReport = {
  endpoints: [],
  thinResponses: [],
  avgCompleteness: 0,
};

function analysis(overrides: Partial<SequenceAnalysis> = {}): SequenceAnalysis {
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

function seq(partial: OperationSequence): OperationSequence {
  return partial;
}

function recsFor(operationKey: string, opts: BuildAgentEvidenceOptions) {
  const evidence = buildAgentEvidence(opts);
  return evidence.operations.find((o) => o.operation_key === operationKey)?.recommendations ?? [];
}

const PHASE1_KINDS = new Set([
  'enrich_write_response',
  'document_common_next_step',
  'reduce_redundant_call',
]);

describe('phase-1 recommendation rules (spec-driven)', () => {
  it('1. thin completeness endpoint with NO sequences => enrich_write_response', () => {
    const completenessReport: CompletenessReport = {
      endpoints: [
        {
          method: 'POST',
          path: '/widgets',
          writeFieldCount: 1,
          readFieldCount: 5,
          completenessScore: 0.2,
          missingFields: ['name', 'price', 'status', 'createdAt'],
        },
      ],
      thinResponses: [],
      avgCompleteness: 0.2,
    };

    const recs = recsFor('POST /widgets', {
      runName: 'thin-no-seq',
      sampleCount: 50,
      sequenceAnalysis: analysis(),
      completenessReport,
    });

    expect(recs.map((r) => r.kind)).toContain('enrich_write_response');
  });

  it('2. from of a verification_loop => enrich_write_response AND document_common_next_step (message references the next op)', () => {
    const sequenceAnalysis = analysis({
      sequences: [
        seq({
          fromMethod: 'POST',
          fromPath: '/orders',
          toMethod: 'GET',
          toPath: '/orders/{id}',
          avgDelayMs: 100,
          count: 3,
          pattern: 'verification_loop',
        }),
      ],
      verificationLoops: [
        seq({
          fromMethod: 'POST',
          fromPath: '/orders',
          toMethod: 'GET',
          toPath: '/orders/{id}',
          avgDelayMs: 100,
          count: 3,
          pattern: 'verification_loop',
        }),
      ],
    });

    const recs = recsFor('POST /orders', {
      runName: 'verif-loop',
      sampleCount: 50,
      sequenceAnalysis,
      completenessReport: emptyCompleteness,
    });

    const kinds = recs.map((r) => r.kind);
    expect(kinds).toContain('enrich_write_response');
    expect(kinds).toContain('document_common_next_step');

    const next = recs.find((r) => r.kind === 'document_common_next_step');
    expect(next?.message).toContain('GET /orders/{id}');
  });

  it('3. non-loop next-step (POST /a -> GET /b, unknown) with no completeness => document_common_next_step (refs GET /b) but NOT enrich_write_response', () => {
    const sequenceAnalysis = analysis({
      sequences: [
        seq({
          fromMethod: 'POST',
          fromPath: '/a',
          toMethod: 'GET',
          toPath: '/b',
          avgDelayMs: 80,
          count: 4,
          pattern: 'unknown',
        }),
      ],
    });

    const recs = recsFor('POST /a', {
      runName: 'next-step',
      sampleCount: 50,
      sequenceAnalysis,
      completenessReport: emptyCompleteness,
    });

    const next = recs.find((r) => r.kind === 'document_common_next_step');
    expect(next).toBeDefined();
    expect(next?.message).toContain('GET /b');
    expect(recs.map((r) => r.kind)).not.toContain('enrich_write_response');
  });

  it('4. retry (GET /things -> GET /things) => reduce_redundant_call and NOT document_common_next_step (self-follow-up excluded)', () => {
    const sequenceAnalysis = analysis({
      sequences: [
        seq({
          fromMethod: 'GET',
          fromPath: '/things',
          toMethod: 'GET',
          toPath: '/things',
          avgDelayMs: 40,
          count: 2,
          pattern: 'retry',
        }),
      ],
      totalRequests: 5,
      wastedRequests: 2,
      toolUsage: [{ operationKey: 'GET /things', count: 3, isRedundant: true }],
    });

    const recs = recsFor('GET /things', {
      runName: 'retry',
      sampleCount: 5,
      sequenceAnalysis,
      completenessReport: emptyCompleteness,
    });

    const kinds = recs.map((r) => r.kind);
    expect(kinds).toContain('reduce_redundant_call');
    expect(kinds).not.toContain('document_common_next_step');
  });

  it('5. combined input triggering all three rules => emitted kinds subset of phase-1 set, never phase-2 kinds', () => {
    // POST /orders: thin completeness + verification loop + a distinct next step.
    // GET /things: retry (wasted requests > 0).
    const sequenceAnalysis = analysis({
      sequences: [
        seq({
          fromMethod: 'POST',
          fromPath: '/orders',
          toMethod: 'GET',
          toPath: '/orders/{id}',
          avgDelayMs: 100,
          count: 3,
          pattern: 'verification_loop',
        }),
        seq({
          fromMethod: 'POST',
          fromPath: '/orders',
          toMethod: 'POST',
          toPath: '/payments',
          avgDelayMs: 200,
          count: 2,
          pattern: 'unknown',
        }),
        seq({
          fromMethod: 'GET',
          fromPath: '/things',
          toMethod: 'GET',
          toPath: '/things',
          avgDelayMs: 30,
          count: 2,
          pattern: 'retry',
        }),
      ],
      verificationLoops: [
        seq({
          fromMethod: 'POST',
          fromPath: '/orders',
          toMethod: 'GET',
          toPath: '/orders/{id}',
          avgDelayMs: 100,
          count: 3,
          pattern: 'verification_loop',
        }),
      ],
      totalRequests: 12,
      wastedRequests: 5,
      toolUsage: [
        { operationKey: 'POST /orders', count: 3, isRedundant: false },
        { operationKey: 'GET /things', count: 3, isRedundant: true },
      ],
    });

    const completenessReport: CompletenessReport = {
      endpoints: [
        {
          method: 'POST',
          path: '/orders',
          writeFieldCount: 1,
          readFieldCount: 6,
          completenessScore: 0.16,
          missingFields: ['status', 'total', 'items', 'createdAt', 'customer'],
        },
      ],
      thinResponses: [],
      avgCompleteness: 0.16,
    };

    const evidence = buildAgentEvidence({
      runName: 'combined',
      sampleCount: 40,
      sequenceAnalysis,
      completenessReport,
    });

    const allKinds = evidence.operations.flatMap((o) => o.recommendations.map((r) => r.kind));

    // All three phase-1 rules should have fired somewhere in the run.
    expect(allKinds).toContain('enrich_write_response');
    expect(allKinds).toContain('document_common_next_step');
    expect(allKinds).toContain('reduce_redundant_call');

    // The emitted set must be a subset of the phase-1 kinds...
    for (const kind of allKinds) {
      expect(PHASE1_KINDS.has(kind)).toBe(true);
    }
    // ...and must never include the deferred phase-2 kinds.
    expect(allKinds).not.toContain('standardize_error_response');
    expect(allKinds).not.toContain('add_operation_metadata');
  });
});
