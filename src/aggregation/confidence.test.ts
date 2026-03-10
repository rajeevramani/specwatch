/**
 * Unit tests for confidence scoring calculations.
 */

import { describe, it, expect } from 'vitest';
import {
  calculateConfidence,
  sampleSizeScore,
  fieldConsistencyScore,
  typeStabilityScore,
  countTotalFields,
  countStableFields,
  countRequiredFields,
  calculateSchemaConfidence,
} from './confidence.js';
import type { InferredSchema } from '../types/index.js';

// ============================================================
// sampleSizeScore
// ============================================================

describe('sampleSizeScore', () => {
  it('returns 0 for 0 samples', () => {
    expect(sampleSizeScore(0)).toBe(0);
  });

  it('returns 0 for negative samples', () => {
    expect(sampleSizeScore(-1)).toBe(0);
  });

  it('returns near 0 for 1 sample', () => {
    // ln(1) / ln(100) = 0 / 4.605 = 0
    expect(sampleSizeScore(1)).toBe(0);
  });

  it('returns ~0.5 for 10 samples', () => {
    // ln(10) / ln(100) = 2.303 / 4.605 ≈ 0.5
    const score = sampleSizeScore(10);
    expect(score).toBeCloseTo(0.5, 2);
  });

  it('returns 1.0 for 100 samples', () => {
    expect(sampleSizeScore(100)).toBe(1.0);
  });

  it('returns 1.0 for more than 100 samples (clamped)', () => {
    expect(sampleSizeScore(1000)).toBe(1.0);
  });

  it('returns ~0.75 for ~31 samples', () => {
    // ln(31.6) / ln(100) ≈ 0.75
    const score = sampleSizeScore(32);
    expect(score).toBeGreaterThan(0.74);
    expect(score).toBeLessThan(0.77);
  });
});

// ============================================================
// fieldConsistencyScore
// ============================================================

describe('fieldConsistencyScore', () => {
  it('returns 1.0 for no fields (empty schema)', () => {
    expect(fieldConsistencyScore(0, 0)).toBe(1.0);
  });

  it('returns 1.0 when all fields are required', () => {
    expect(fieldConsistencyScore(5, 5)).toBe(1.0);
  });

  it('returns 0.5 when half the fields are required', () => {
    expect(fieldConsistencyScore(3, 6)).toBeCloseTo(0.5, 5);
  });

  it('returns 0.0 when no fields are required', () => {
    expect(fieldConsistencyScore(0, 5)).toBe(0.0);
  });

  it('clamps to 1.0 if requiredFields > totalFields', () => {
    // Should not happen in practice, but clamping is defensive
    expect(fieldConsistencyScore(10, 5)).toBe(1.0);
  });
});

// ============================================================
// typeStabilityScore
// ============================================================

describe('typeStabilityScore', () => {
  it('returns 1.0 for no fields', () => {
    expect(typeStabilityScore(0, 0)).toBe(1.0);
  });

  it('returns 1.0 when all fields are stable (no oneOf)', () => {
    expect(typeStabilityScore(5, 5)).toBe(1.0);
  });

  it('returns 0.5 when half the fields are stable', () => {
    expect(typeStabilityScore(3, 6)).toBeCloseTo(0.5, 5);
  });

  it('returns 0.0 when no fields are stable', () => {
    expect(typeStabilityScore(0, 5)).toBe(0.0);
  });
});

// ============================================================
// calculateConfidence
// ============================================================

describe('calculateConfidence', () => {
  it('returns near 0 for 1 sample', () => {
    // sampleScore = 0 (ln(1)/ln(100) = 0)
    // fieldConsistency = 1.0 (no fields)
    // typeStability = 1.0 (no fields)
    // score = 0*0.4 + 1.0*0.4 + 1.0*0.2 = 0.6
    // But with actual fields: sampleScore=0, fieldConsistency=1.0, typeStability=1.0 => 0.6
    const score = calculateConfidence(1, 0, 0, 0, 0);
    expect(score).toBeCloseTo(0.6, 2); // 0*0.4 + 1.0*0.4 + 1.0*0.2 = 0.6
  });

  it('returns near 0.0 when sample count is 1 and fields are all inconsistent', () => {
    // sampleScore = 0, fieldConsistency = 0 (0 required / 3 total), typeStability = 0
    const score = calculateConfidence(1, 0, 3, 0, 3);
    expect(score).toBeCloseTo(0.0, 2); // 0*0.4 + 0*0.4 + 0*0.2 = 0.0
  });

  it('returns ~0.7 for 10 samples with all consistent fields', () => {
    // sampleScore ≈ 0.5, fieldConsistency = 1.0, typeStability = 1.0
    // score = 0.5*0.4 + 1.0*0.4 + 1.0*0.2 = 0.2 + 0.4 + 0.2 = 0.8
    const score = calculateConfidence(10, 5, 5, 5, 5);
    expect(score).toBeCloseTo(0.8, 1);
  });

  it('returns ~0.7 for 10 samples no fields', () => {
    // sampleScore ≈ 0.5 (ln(10)/ln(100))
    // fieldConsistency = 1.0 (no fields)
    // typeStability = 1.0 (no fields)
    // score = 0.5*0.4 + 1.0*0.4 + 1.0*0.2 = 0.2 + 0.4 + 0.2 = 0.8
    const score = calculateConfidence(10, 0, 0, 0, 0);
    expect(score).toBeGreaterThan(0.75);
    expect(score).toBeLessThan(0.85);
  });

  it('returns ~1.0 for 100 samples with all consistent fields', () => {
    // sampleScore = 1.0, fieldConsistency = 1.0, typeStability = 1.0
    // score = 1.0
    const score = calculateConfidence(100, 5, 5, 5, 5);
    expect(score).toBeCloseTo(1.0, 5);
  });

  it('returns ~0.7 for 100 samples with many optional fields', () => {
    // sampleScore = 1.0, fieldConsistency = 0.3 (3 required / 10 total), typeStability = 1.0
    // score = 1.0*0.4 + 0.3*0.4 + 1.0*0.2 = 0.4 + 0.12 + 0.2 = 0.72
    const score = calculateConfidence(100, 3, 10, 10, 10);
    expect(score).toBeCloseTo(0.72, 2);
  });

  it('returns ~0.8 for 100 samples with type conflicts', () => {
    // sampleScore = 1.0, fieldConsistency = 1.0, typeStability = 0.5
    // score = 1.0*0.4 + 1.0*0.4 + 0.5*0.2 = 0.4 + 0.4 + 0.1 = 0.9
    const score = calculateConfidence(100, 5, 5, 2, 4);
    // sampleScore=1.0, fieldConsistency = 5/5=1.0, typeStability = 2/4=0.5
    // score = 1.0*0.4 + 1.0*0.4 + 0.5*0.2 = 0.9
    expect(score).toBeGreaterThan(0.85);
    expect(score).toBeLessThan(0.95);
  });

  it('always returns score in [0.0, 1.0]', () => {
    const score1 = calculateConfidence(0, 0, 0, 0, 0);
    expect(score1).toBeGreaterThanOrEqual(0);
    expect(score1).toBeLessThanOrEqual(1);

    const score2 = calculateConfidence(1000, 100, 100, 100, 100);
    expect(score2).toBeGreaterThanOrEqual(0);
    expect(score2).toBeLessThanOrEqual(1);
  });
});

// ============================================================
// countTotalFields / countStableFields / countRequiredFields
// ============================================================

describe('countTotalFields', () => {
  const makeStats = () => ({ sampleCount: 1, presenceCount: 1, confidence: 1.0 });

  it('returns 0 for non-object schema', () => {
    const schema: InferredSchema = { type: 'string', stats: makeStats() };
    expect(countTotalFields(schema)).toBe(0);
  });

  it('returns 0 for object with no properties', () => {
    const schema: InferredSchema = { type: 'object', stats: makeStats() };
    expect(countTotalFields(schema)).toBe(0);
  });

  it('returns field count for object schema', () => {
    const schema: InferredSchema = {
      type: 'object',
      properties: {
        id: { type: 'integer', stats: makeStats() },
        name: { type: 'string', stats: makeStats() },
        email: { type: 'string', stats: makeStats() },
      },
      stats: makeStats(),
    };
    expect(countTotalFields(schema)).toBe(3);
  });

  it('counts fields in oneOf object variants', () => {
    const schema: InferredSchema = {
      type: 'object',
      oneOf: [
        {
          type: 'object',
          properties: {
            id: { type: 'integer', stats: makeStats() },
            name: { type: 'string', stats: makeStats() },
          },
          stats: makeStats(),
        },
        { type: 'null', stats: makeStats() },
      ],
      stats: makeStats(),
    };
    expect(countTotalFields(schema)).toBe(2);
  });
});

describe('countStableFields', () => {
  const makeStats = () => ({ sampleCount: 1, presenceCount: 1, confidence: 1.0 });

  it('returns 0 for non-object schema', () => {
    const schema: InferredSchema = { type: 'string', stats: makeStats() };
    expect(countStableFields(schema)).toBe(0);
  });

  it('counts all fields as stable when no oneOf', () => {
    const schema: InferredSchema = {
      type: 'object',
      properties: {
        id: { type: 'integer', stats: makeStats() },
        name: { type: 'string', stats: makeStats() },
      },
      stats: makeStats(),
    };
    expect(countStableFields(schema)).toBe(2);
  });

  it('does not count oneOf fields as stable', () => {
    const schema: InferredSchema = {
      type: 'object',
      properties: {
        id: { type: 'integer', stats: makeStats() },
        // This field has oneOf — unstable
        value: {
          type: 'string',
          oneOf: [
            { type: 'string', stats: makeStats() },
            { type: 'null', stats: makeStats() },
          ],
          stats: makeStats(),
        },
      },
      stats: makeStats(),
    };
    expect(countStableFields(schema)).toBe(1);
  });
});

describe('countRequiredFields', () => {
  const makeStats = () => ({ sampleCount: 1, presenceCount: 1, confidence: 1.0 });

  it('returns 0 for non-object schema', () => {
    const schema: InferredSchema = { type: 'string', stats: makeStats() };
    expect(countRequiredFields(schema)).toBe(0);
  });

  it('returns 0 for object with no required array', () => {
    const schema: InferredSchema = { type: 'object', stats: makeStats() };
    expect(countRequiredFields(schema)).toBe(0);
  });

  it('returns count of required fields', () => {
    const schema: InferredSchema = {
      type: 'object',
      properties: {
        id: { type: 'integer', stats: makeStats() },
        name: { type: 'string', stats: makeStats() },
        optional: { type: 'string', stats: makeStats() },
      },
      required: ['id', 'name'],
      stats: makeStats(),
    };
    expect(countRequiredFields(schema)).toBe(2);
  });
});

// ============================================================
// calculateSchemaConfidence
// ============================================================

describe('calculateSchemaConfidence', () => {
  const makeStats = (sampleCount = 1, presenceCount = 1) => ({
    sampleCount,
    presenceCount,
    confidence: presenceCount / sampleCount,
  });

  it('returns valid score for a simple schema', () => {
    const schema: InferredSchema = {
      type: 'object',
      properties: {
        id: { type: 'integer', stats: makeStats() },
        name: { type: 'string', stats: makeStats() },
      },
      required: ['id', 'name'],
      stats: makeStats(),
    };
    const score = calculateSchemaConfidence(schema, 10);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('returns higher score for more samples', () => {
    const schema: InferredSchema = {
      type: 'object',
      properties: {
        id: { type: 'integer', stats: makeStats() },
      },
      required: ['id'],
      stats: makeStats(),
    };
    const score10 = calculateSchemaConfidence(schema, 10);
    const score100 = calculateSchemaConfidence(schema, 100);
    expect(score100).toBeGreaterThan(score10);
  });
});
