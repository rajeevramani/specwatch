/**
 * Confidence scoring calculations for aggregated schemas.
 *
 * Formula:
 *   confidence = (sampleScore * 0.4) + (fieldConsistency * 0.4) + (typeStability * 0.2)
 *
 * where:
 *   sampleScore      = clamp(ln(sampleCount) / ln(100), 0, 1)
 *   fieldConsistency = requiredFields / totalFields     (1.0 if no fields)
 *   typeStability    = stableFields / totalFields       (1.0 if no fields)
 *   stableField      = field with a single concrete type (not oneOf)
 */

import type { InferredSchema } from '../types/index.js';

/**
 * Clamp a number to [min, max].
 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Sample size score: logarithmic scale from 0 to 1.
 * ln(1)/ln(100) ≈ 0, ln(10)/ln(100) ≈ 0.5, ln(100)/ln(100) = 1.0
 */
export function sampleSizeScore(sampleCount: number): number {
  if (sampleCount <= 0) return 0;
  return clamp(Math.log(sampleCount) / Math.log(100), 0, 1);
}

/**
 * Field consistency score: ratio of required fields to total fields.
 * Returns 1.0 if there are no fields (no fields to be inconsistent about).
 */
export function fieldConsistencyScore(requiredFields: number, totalFields: number): number {
  if (totalFields === 0) return 1.0;
  return clamp(requiredFields / totalFields, 0, 1);
}

/**
 * Type stability score: ratio of stable fields (single concrete type) to total fields.
 * A stable field does NOT have a oneOf union — it has a single concrete type.
 * Returns 1.0 if there are no fields.
 */
export function typeStabilityScore(stableFields: number, totalFields: number): number {
  if (totalFields === 0) return 1.0;
  return clamp(stableFields / totalFields, 0, 1);
}

/**
 * Calculate the overall confidence score for an aggregated schema.
 *
 * @param sampleCount - Total number of samples contributing to this schema
 * @param requiredFields - Number of fields present in 100% of samples
 * @param totalFields - Total number of unique fields observed
 * @param stableFields - Number of fields with a single concrete type (not oneOf)
 * @param totalFieldsForStability - Total fields for stability calculation (same as totalFields)
 * @returns Confidence score in [0.0, 1.0]
 */
export function calculateConfidence(
  sampleCount: number,
  requiredFields: number,
  totalFields: number,
  stableFields: number,
  totalFieldsForStability: number,
): number {
  const ss = sampleSizeScore(sampleCount);
  const fc = fieldConsistencyScore(requiredFields, totalFields);
  const ts = typeStabilityScore(stableFields, totalFieldsForStability);

  const score = ss * 0.4 + fc * 0.4 + ts * 0.2;
  return clamp(score, 0, 1);
}

/**
 * Count the total number of top-level properties in a schema.
 * Returns 0 if the schema has no properties (non-object, or empty object).
 */
export function countTotalFields(schema: InferredSchema): number {
  if (schema.oneOf !== undefined) {
    // For oneOf schemas, count fields in object variants
    let total = 0;
    for (const variant of schema.oneOf) {
      if (variant.type === 'object' && variant.properties !== undefined) {
        total += Object.keys(variant.properties).length;
      }
    }
    return total;
  }

  if (schema.type === 'object' && schema.properties !== undefined) {
    return Object.keys(schema.properties).length;
  }

  return 0;
}

/**
 * Count the number of fields with a single concrete type (not oneOf unions).
 * A stable field is one whose schema has no oneOf variants.
 */
export function countStableFields(schema: InferredSchema): number {
  if (schema.oneOf !== undefined) {
    // For oneOf schemas, count stable fields in object variants
    let stable = 0;
    for (const variant of schema.oneOf) {
      if (variant.type === 'object' && variant.properties !== undefined) {
        for (const fieldSchema of Object.values(variant.properties)) {
          if (fieldSchema.oneOf === undefined) {
            stable++;
          }
        }
      }
    }
    return stable;
  }

  if (schema.type === 'object' && schema.properties !== undefined) {
    let stable = 0;
    for (const fieldSchema of Object.values(schema.properties)) {
      if (fieldSchema.oneOf === undefined) {
        stable++;
      }
    }
    return stable;
  }

  return 0;
}

/**
 * Count required fields from a schema's required array.
 */
export function countRequiredFields(schema: InferredSchema): number {
  if (schema.oneOf !== undefined) {
    // For oneOf schemas, sum required from object variants
    let required = 0;
    for (const variant of schema.oneOf) {
      if (variant.type === 'object' && variant.required !== undefined) {
        required += variant.required.length;
      }
    }
    return required;
  }

  if (schema.type === 'object' && schema.required !== undefined) {
    return schema.required.length;
  }

  return 0;
}

/**
 * Compute the confidence score for a schema given its sample count.
 * This is a convenience function that computes all metrics from the schema.
 */
export function calculateSchemaConfidence(schema: InferredSchema, sampleCount: number): number {
  const totalFields = countTotalFields(schema);
  const stableFields = countStableFields(schema);
  const requiredFields = countRequiredFields(schema);

  return calculateConfidence(sampleCount, requiredFields, totalFields, stableFields, totalFields);
}
