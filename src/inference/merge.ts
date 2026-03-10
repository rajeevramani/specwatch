/**
 * Schema merging logic for the Specwatch schema inference engine.
 *
 * Key design decisions (fixes from Flowplane):
 * - oneOf holds full InferredSchema[] (not just type names) — prevents data loss
 * - Format conflicts: same type + different formats → drop format entirely
 * - Same type + one has format + other doesn't → drop format
 */

import type { InferredSchema, FieldStats, StringFormat } from '../types/index.js';

/**
 * Merge two FieldStats by summing sampleCount and presenceCount.
 * Confidence is recalculated as presenceCount / sampleCount.
 */
function mergeStats(a: FieldStats, b: FieldStats): FieldStats {
  const sampleCount = a.sampleCount + b.sampleCount;
  const presenceCount = a.presenceCount + b.presenceCount;
  return {
    sampleCount,
    presenceCount,
    confidence: sampleCount > 0 ? presenceCount / sampleCount : 0,
  };
}

/**
 * Merge two object property maps recursively.
 * Fields present in either schema are included; existing fields are merged.
 */
function mergeProperties(
  aProps: Record<string, InferredSchema>,
  bProps: Record<string, InferredSchema>,
): Record<string, InferredSchema> {
  const result: Record<string, InferredSchema> = {};

  // All keys from a
  for (const key of Object.keys(aProps)) {
    if (key in bProps) {
      result[key] = mergeSchemas(aProps[key], bProps[key]);
    } else {
      result[key] = aProps[key];
    }
  }

  // Keys only in b
  for (const key of Object.keys(bProps)) {
    if (!(key in result)) {
      result[key] = bProps[key];
    }
  }

  return result;
}

/**
 * Resolve format for same-type merges:
 * - Both have same format → keep it
 * - One or both have different/missing format → drop format entirely
 */
function resolveFormat(
  aFormat: StringFormat | undefined,
  bFormat: StringFormat | undefined,
): StringFormat | undefined {
  if (aFormat === undefined && bFormat === undefined) return undefined;
  if (aFormat === bFormat) return aFormat;
  // Different formats OR one missing — drop format
  return undefined;
}

/**
 * Merge two schemas of the same type.
 * Deepens objects, widens arrays, resolves format conflicts.
 */
function mergeSameType(a: InferredSchema, b: InferredSchema): InferredSchema {
  const stats = mergeStats(a.stats, b.stats);

  switch (a.type) {
    case 'object': {
      const aProps = a.properties ?? {};
      const bProps = b.properties ?? {};
      const properties = mergeProperties(aProps, bProps);
      // Required fields: intersection of both required arrays (fields present in 100% of both)
      // We preserve each field's stats; required calculation happens in aggregation
      const required: string[] = [];
      return { type: 'object', properties, required, stats };
    }

    case 'array': {
      if (a.items === undefined && b.items === undefined) {
        return { type: 'array', stats };
      }
      if (a.items === undefined) {
        return { type: 'array', items: b.items, stats };
      }
      if (b.items === undefined) {
        return { type: 'array', items: a.items, stats };
      }
      const items = mergeSchemas(a.items, b.items);
      return { type: 'array', items, stats };
    }

    case 'string': {
      const format = resolveFormat(a.format, b.format);
      const schema: InferredSchema = { type: 'string', stats };
      if (format !== undefined) schema.format = format;
      // Combine observed values for enum inference (cap at 100 unique values)
      if (a._observedValues !== undefined || b._observedValues !== undefined) {
        const combined = new Set<string>([
          ...(a._observedValues ?? []),
          ...(b._observedValues ?? []),
        ]);
        if (combined.size <= 100) {
          schema._observedValues = [...combined];
        }
      }
      return schema;
    }

    default: {
      // For null, boolean, integer, number — merge stats and resolve format
      const format = resolveFormat(a.format, b.format);
      const schema: InferredSchema = { type: a.type, stats };
      if (format !== undefined) schema.format = format;
      return schema;
    }
  }
}

/**
 * Add a new schema variant to an existing oneOf list.
 * Deduplicates by type — if a variant with the same type already exists, merge them.
 */
function addToOneOf(variants: InferredSchema[], newVariant: InferredSchema): InferredSchema[] {
  // If newVariant itself has oneOf, flatten its variants into the list
  if (newVariant.oneOf !== undefined) {
    let result = [...variants];
    for (const v of newVariant.oneOf) {
      result = addToOneOf(result, v);
    }
    return result;
  }

  // Check if a variant with this type already exists
  const existingIdx = variants.findIndex(
    (v) => v.oneOf === undefined && v.type === newVariant.type,
  );

  if (existingIdx >= 0) {
    // Merge with existing variant of same type
    const updated = [...variants];
    updated[existingIdx] = mergeSameType(updated[existingIdx], newVariant);
    return updated;
  }

  // integer + number widening: collapse to number within oneOf
  if (newVariant.type === 'number' || newVariant.type === 'integer') {
    const counterpart = newVariant.type === 'number' ? 'integer' : 'number';
    const counterIdx = variants.findIndex(
      (v) => v.oneOf === undefined && v.type === counterpart,
    );
    if (counterIdx >= 0) {
      const updated = [...variants];
      const merged = mergeStats(updated[counterIdx].stats, newVariant.stats);
      updated[counterIdx] = { type: 'number', stats: merged };
      return updated;
    }
  }

  return [...variants, newVariant];
}

/**
 * Merge two InferredSchema instances into a single consensus schema.
 *
 * Rules:
 * - Same type → merge (deepen objects, widen arrays, resolve format conflicts)
 * - Different types → create oneOf union with FULL schemas as variants
 * - OneOf + new type → add to existing union (deduplicated by type)
 * - Stats accumulation: sampleCount and presenceCount are summed
 */
export function mergeSchemas(a: InferredSchema, b: InferredSchema): InferredSchema {
  const stats = mergeStats(a.stats, b.stats);

  // Case 1: Both are oneOf unions — merge all variants together
  if (a.oneOf !== undefined && b.oneOf !== undefined) {
    let variants = [...a.oneOf];
    for (const variant of b.oneOf) {
      variants = addToOneOf(variants, variant);
    }
    return { type: a.type, oneOf: variants, stats };
  }

  // Case 2: a is oneOf, b is a concrete schema — add b to a's variants
  if (a.oneOf !== undefined) {
    const variants = addToOneOf(a.oneOf, b);
    return { type: a.type, oneOf: variants, stats };
  }

  // Case 3: b is oneOf, a is a concrete schema — add a to b's variants
  if (b.oneOf !== undefined) {
    const variants = addToOneOf(b.oneOf, a);
    return { type: b.type, oneOf: variants, stats };
  }

  // Case 4: Same type — merge directly
  if (a.type === b.type) {
    return mergeSameType(a, b);
  }

  // Case 4.5: integer + number → widen to number (integer is a subset of number)
  if (
    (a.type === 'integer' && b.type === 'number') ||
    (a.type === 'number' && b.type === 'integer')
  ) {
    return { type: 'number', stats };
  }

  // Case 5: Different types — create oneOf union with full schemas
  return {
    type: a.type, // type is ignored when oneOf is present, but required by interface
    oneOf: [a, b],
    stats,
  };
}
