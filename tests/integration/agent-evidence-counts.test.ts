/**
 * Spec-driven integration tests for bead specwatch-ag5.1.
 *
 * These tests treat `buildAgentEvidence` as a black box defined purely by the
 * acceptance criteria. The central contract under test:
 *
 *   - verification_loop_count comes from read-after-write loops
 *     (a write op followed by a read of the same resource).
 *   - wasted_request_count comes from repeated/duplicate equivalent calls.
 *
 * These two counts MUST come from distinct signals, and a verification loop
 * must NOT, by itself, count as a wasted/redundant request.
 */
import { describe, expect, it } from 'vitest';
import { buildAgentEvidence } from '../../src/analysis/agent-evidence.js';
import type { CompletenessReport } from '../../src/analysis/completeness.js';
import type { OperationSequence, SequenceAnalysis } from '../../src/analysis/sequences.js';

const EMPTY_COMPLETENESS: CompletenessReport = {
  endpoints: [],
  thinResponses: [],
  avgCompleteness: 0,
};

/** A retry/duplicate of GET /things -> GET /things. */
function retrySequence(): OperationSequence {
  return {
    fromMethod: 'GET',
    fromPath: '/things',
    toMethod: 'GET',
    toPath: '/things',
    avgDelayMs: 40,
    count: 2,
    pattern: 'retry',
  };
}

/** A read-after-write loop: POST /widgets -> GET /widgets/{id}. */
function verificationLoopSequence(): OperationSequence {
  return {
    fromMethod: 'POST',
    fromPath: '/widgets',
    toMethod: 'GET',
    toPath: '/widgets/{id}',
    avgDelayMs: 120,
    count: 3,
    pattern: 'verification_loop',
  };
}

describe('agent evidence: verification_loop_count vs wasted_request_count are distinct signals', () => {
  it('1. a retry/duplicate sequence yields wasted_request_count > 0, verification_loop_count === 0, and a reduce_redundant_call recommendation', () => {
    const seq = retrySequence();
    const analysis: SequenceAnalysis = {
      sequences: [seq],
      verificationLoops: [],
      totalRequests: 4,
      wastedRequests: 2,
      redundantCalls: [],
      toolUsage: [{ operationKey: 'GET /things', count: 3, isRedundant: true }],
    };

    const evidence = buildAgentEvidence({
      runName: 'retry-only',
      sampleCount: 4,
      sequenceAnalysis: analysis,
      completenessReport: EMPTY_COMPLETENESS,
    });

    const op = evidence.operations.find((o) => o.operation_key === 'GET /things');
    expect(op, 'expected an operation for GET /things').toBeDefined();
    expect(op!.wasted_request_count).toBeGreaterThan(0);
    expect(op!.verification_loop_count).toBe(0);
    expect(op!.recommendations.map((r) => r.kind)).toContain('reduce_redundant_call');
  });

  it('2. a verification-loop-only sequence is NOT a redundant duplicate: wasted_request_count === 0 and no reduce_redundant_call', () => {
    const seq = verificationLoopSequence();
    const analysis: SequenceAnalysis = {
      sequences: [seq],
      verificationLoops: [seq],
      totalRequests: 6,
      // Even though the existing pipeline labels verification-loop traffic as
      // "wasted", the per-operation wasted_request_count must NOT be driven by
      // verification loops — it is a distinct, duplicate-call signal.
      wastedRequests: 3,
      redundantCalls: [],
      toolUsage: [
        { operationKey: 'POST /widgets', count: 3, isRedundant: false },
        { operationKey: 'GET /widgets/{id}', count: 3, isRedundant: false },
      ],
    };

    const evidence = buildAgentEvidence({
      runName: 'verification-only',
      sampleCount: 6,
      sequenceAnalysis: analysis,
      completenessReport: EMPTY_COMPLETENESS,
    });

    const post = evidence.operations.find((o) => o.operation_key === 'POST /widgets');
    expect(post, 'expected an operation for POST /widgets').toBeDefined();
    // The write op should record the verification loop...
    expect(post!.verification_loop_count).toBeGreaterThan(0);
    // ...but a verification loop is not a duplicate/redundant call.
    expect(post!.wasted_request_count).toBe(0);
    expect(post!.recommendations.map((r) => r.kind)).not.toContain('reduce_redundant_call');

    // No operation anywhere should claim a wasted request from this input.
    for (const op of evidence.operations) {
      expect(
        op.wasted_request_count,
        `operation ${op.operation_key} should have wasted_request_count 0 (verification loops are not redundant)`,
      ).toBe(0);
      expect(op.recommendations.map((r) => r.kind)).not.toContain('reduce_redundant_call');
    }
  });

  it('3. with BOTH a verification loop and a retry, each count lands on the correct operation independently', () => {
    const vloop = verificationLoopSequence();
    const retry = retrySequence();
    const analysis: SequenceAnalysis = {
      sequences: [vloop, retry],
      verificationLoops: [vloop],
      totalRequests: 10,
      wastedRequests: 5,
      redundantCalls: [],
      toolUsage: [
        { operationKey: 'POST /widgets', count: 3, isRedundant: false },
        { operationKey: 'GET /widgets/{id}', count: 3, isRedundant: false },
        { operationKey: 'GET /things', count: 3, isRedundant: true },
      ],
    };

    const evidence = buildAgentEvidence({
      runName: 'mixed',
      sampleCount: 10,
      sequenceAnalysis: analysis,
      completenessReport: EMPTY_COMPLETENESS,
    });

    const post = evidence.operations.find((o) => o.operation_key === 'POST /widgets');
    const things = evidence.operations.find((o) => o.operation_key === 'GET /things');
    expect(post, 'expected an operation for POST /widgets').toBeDefined();
    expect(things, 'expected an operation for GET /things').toBeDefined();

    // Verification loop attaches to the write op only.
    expect(post!.verification_loop_count).toBeGreaterThan(0);
    expect(post!.wasted_request_count).toBe(0);
    expect(post!.recommendations.map((r) => r.kind)).not.toContain('reduce_redundant_call');

    // Redundant/retry attaches to the retried op only.
    expect(things!.wasted_request_count).toBeGreaterThan(0);
    expect(things!.verification_loop_count).toBe(0);
    expect(things!.recommendations.map((r) => r.kind)).toContain('reduce_redundant_call');
  });

  it('4. in a single mixed input the two counts are genuinely distinct (not forced equal)', () => {
    // Verification loop count 3 on the write op; retry count 2 on a different op.
    // If the implementation conflated the two signals, the write op would show a
    // non-zero wasted_request_count equal to (or derived from) its loop count.
    const vloop = verificationLoopSequence(); // count 3
    const retry = retrySequence(); // count 2
    const analysis: SequenceAnalysis = {
      sequences: [vloop, retry],
      verificationLoops: [vloop],
      totalRequests: 12,
      wastedRequests: 5,
      redundantCalls: [],
      toolUsage: [
        { operationKey: 'POST /widgets', count: 3, isRedundant: false },
        { operationKey: 'GET /widgets/{id}', count: 3, isRedundant: false },
        { operationKey: 'GET /things', count: 2, isRedundant: true },
      ],
    };

    const evidence = buildAgentEvidence({
      runName: 'distinct-counts',
      sampleCount: 12,
      sequenceAnalysis: analysis,
      completenessReport: EMPTY_COMPLETENESS,
    });

    const post = evidence.operations.find((o) => o.operation_key === 'POST /widgets')!;
    const things = evidence.operations.find((o) => o.operation_key === 'GET /things')!;
    expect(post).toBeDefined();
    expect(things).toBeDefined();

    // The op that has a verification loop must NOT inherit a wasted count from it.
    expect(post.verification_loop_count).toBeGreaterThan(0);
    expect(post.wasted_request_count).not.toBe(post.verification_loop_count);
    expect(post.wasted_request_count).toBe(0);

    // The op that has a retry must NOT inherit a verification loop from it.
    expect(things.wasted_request_count).toBeGreaterThan(0);
    expect(things.verification_loop_count).not.toBe(things.wasted_request_count);
    expect(things.verification_loop_count).toBe(0);
  });
});
