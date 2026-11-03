import { describe, expect, it } from 'vitest';
import { buildAgentEvidence } from '../../src/analysis/agent-evidence.js';
import { collectOpenApiOperations } from '../../src/analysis/spec-mapper.js';
import type { CompletenessReport } from '../../src/analysis/completeness.js';
import type { SequenceAnalysis } from '../../src/analysis/sequences.js';

/**
 * Spec-driven integration tests for the observed-operation -> OpenAPI mapping
 * contract (bead specwatch-ag5.3). Written purely from the acceptance criteria,
 * treating buildAgentEvidence / collectOpenApiOperations as black boxes.
 *
 * Mapping contract:
 *  - Every observed operation appears exactly ONCE in evidence.operations[].
 *  - EXACT or TEMPLATE match -> operation_id + spec_location set, no warning.
 *  - NO-MATCH -> op stays in operations[] with a warning, AND a summary entry
 *    { operation_key, reason } appears in unmatched_observations[].
 *  - AMBIGUOUS match -> op stays in operations[] with an 'Ambiguous' warning,
 *    NO operation_id, and is EXCLUDED from unmatched_observations[].
 *  - unmatched_observations holds ONLY key+reason (never the full op record).
 */

const emptyCompleteness: CompletenessReport = {
  endpoints: [],
  thinResponses: [],
  avgCompleteness: 0,
};

/**
 * Build a minimal SequenceAnalysis that introduces observed operations via
 * toolUsage.operationKey ("METHOD path"). Pass the literal observed paths.
 */
function analysisFromToolUsage(operationKeys: string[]): SequenceAnalysis {
  return {
    sequences: [],
    verificationLoops: [],
    totalRequests: operationKeys.length,
    wastedRequests: 0,
    redundantCalls: [],
    toolUsage: operationKeys.map((operationKey) => ({
      operationKey,
      count: 1,
      isRedundant: false,
    })),
  };
}

describe('observed-operation -> OpenAPI mapping (spec-driven)', () => {
  it('exact match: sets operation_id, no warning, empty unmatched_observations', () => {
    const spec = {
      openapi: '3.1.0',
      paths: {
        '/products': { post: { operationId: 'createProduct' } },
      },
    };

    const evidence = buildAgentEvidence({
      runName: 'exact',
      sampleCount: 1,
      sequenceAnalysis: analysisFromToolUsage(['POST /products']),
      completenessReport: emptyCompleteness,
      specOperations: collectOpenApiOperations(spec),
    });

    const matches = evidence.operations.filter((op) => op.operation_key === 'POST /products');
    expect(matches).toHaveLength(1);
    const post = matches[0];
    expect(post.operation_id).toBe('createProduct');
    expect(post.warnings ?? []).toEqual([]);
    expect(evidence.unmatched_observations ?? []).toEqual([]);
  });

  it('template match: concrete observed path resolves to a spec template', () => {
    const spec = {
      openapi: '3.1.0',
      paths: {
        '/products/{productId}': { get: { operationId: 'getProduct' } },
      },
    };

    const evidence = buildAgentEvidence({
      runName: 'template',
      sampleCount: 1,
      sequenceAnalysis: analysisFromToolUsage(['GET /products/prod_1']),
      completenessReport: emptyCompleteness,
      specOperations: collectOpenApiOperations(spec),
    });

    const matches = evidence.operations.filter((op) => op.operation_key === 'GET /products/prod_1');
    expect(matches).toHaveLength(1);
    const get = matches[0];
    expect(get.operation_id).toBe('getProduct');
    expect(get.spec_location).toBe('#/paths/~1products~1{productId}/get');
    expect(get.warnings ?? []).toEqual([]);
    expect(evidence.unmatched_observations ?? []).toEqual([]);
  });

  it('no-match: op stays in operations[] with a warning and a key+reason-only unmatched entry', () => {
    const spec = {
      openapi: '3.1.0',
      paths: {
        '/products/{productId}': { get: { operationId: 'getProduct' } },
      },
    };

    const evidence = buildAgentEvidence({
      runName: 'no-match',
      sampleCount: 1,
      sequenceAnalysis: analysisFromToolUsage(['DELETE /widgets/1']),
      completenessReport: emptyCompleteness,
      specOperations: collectOpenApiOperations(spec),
    });

    // Present exactly once in operations[], with a warning, no operation_id.
    const matches = evidence.operations.filter((op) => op.operation_key === 'DELETE /widgets/1');
    expect(matches).toHaveLength(1);
    const del = matches[0];
    expect(del.operation_id).toBeUndefined();
    expect(del.warnings?.length).toBeGreaterThan(0);

    // A summary entry exists in unmatched_observations.
    const unmatched = evidence.unmatched_observations ?? [];
    const entry = unmatched.find((u) => u.operation_key === 'DELETE /widgets/1');
    expect(entry).toBeDefined();
    expect(entry?.reason).toContain('No OpenAPI operation matched');

    // The unmatched entry carries ONLY operation_key + reason — not the full record.
    expect(Object.keys(entry as object).sort()).toEqual(['operation_key', 'reason']);
  });

  it('ambiguous: op stays in operations[] with an Ambiguous warning, no operation_id, excluded from unmatched', () => {
    const spec = {
      openapi: '3.1.0',
      paths: {
        '/products/{productId}': { get: { operationId: 'getByProductId' } },
        '/products/{slug}': { get: { operationId: 'getBySlug' } },
      },
    };

    const evidence = buildAgentEvidence({
      runName: 'ambiguous',
      sampleCount: 1,
      sequenceAnalysis: analysisFromToolUsage(['GET /products/123']),
      completenessReport: emptyCompleteness,
      specOperations: collectOpenApiOperations(spec),
    });

    const matches = evidence.operations.filter((op) => op.operation_key === 'GET /products/123');
    expect(matches).toHaveLength(1);
    const get = matches[0];
    expect(get.operation_id).toBeUndefined();
    expect(get.warnings?.[0]).toContain('Ambiguous');

    const unmatchedKeys = (evidence.unmatched_observations ?? []).map((u) => u.operation_key);
    expect(unmatchedKeys).not.toContain('GET /products/123');
  });

  it('mixed: matched + no-match + ambiguous in one call; unmatched holds only the no-match key', () => {
    const spec = {
      openapi: '3.1.0',
      paths: {
        // Exact match target.
        '/products': { post: { operationId: 'createProduct' } },
        // Ambiguous template pair for GET /products/123.
        '/products/{productId}': { get: { operationId: 'getByProductId' } },
        '/products/{slug}': { get: { operationId: 'getBySlug' } },
        // (No path matches DELETE /widgets/1 — the no-match.)
      },
    };

    const observed = ['POST /products', 'DELETE /widgets/1', 'GET /products/123'];
    const evidence = buildAgentEvidence({
      runName: 'mixed',
      sampleCount: 3,
      sequenceAnalysis: analysisFromToolUsage(observed),
      completenessReport: emptyCompleteness,
      specOperations: collectOpenApiOperations(spec),
    });

    // All three observed operations appear exactly once each.
    for (const key of observed) {
      expect(evidence.operations.filter((op) => op.operation_key === key)).toHaveLength(1);
    }

    const matched = evidence.operations.find((op) => op.operation_key === 'POST /products');
    expect(matched?.operation_id).toBe('createProduct');
    expect(matched?.warnings ?? []).toEqual([]);

    const ambiguous = evidence.operations.find((op) => op.operation_key === 'GET /products/123');
    expect(ambiguous?.operation_id).toBeUndefined();
    expect(ambiguous?.warnings?.[0]).toContain('Ambiguous');

    // unmatched_observations contains ONLY the no-match key.
    const unmatched = evidence.unmatched_observations ?? [];
    expect(unmatched.map((u) => u.operation_key)).toEqual(['DELETE /widgets/1']);
    expect(unmatched[0]?.reason).toContain('No OpenAPI operation matched');
    expect(Object.keys(unmatched[0] as object).sort()).toEqual(['operation_key', 'reason']);
  });
});
