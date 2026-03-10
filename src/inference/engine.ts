/**
 * Schema inference engine — core type detection and recursive schema inference.
 * Ported from Flowplane's Rust inference module.
 */

import type { SchemaType, StringFormat, FieldStats, InferredSchema } from '../types/index.js';
import { detectStringFormat } from './formats.js';
import { mergeSchemas } from './merge.js';

/**
 * Detect the SchemaType of a JSON value.
 *
 * - null → 'null'
 * - boolean → 'boolean'
 * - integer (whole number) → 'integer'
 * - float (non-integer number) → 'number'
 * - string → 'string'
 * - array → 'array'
 * - object → 'object'
 */
export function inferType(value: unknown): SchemaType {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  if (typeof value === 'string') return 'string';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  // Fallback for undefined, symbol, function, bigint — treat as string
  return 'string';
}

/**
 * Create a default FieldStats for a freshly inferred schema node.
 * sampleCount=1, presenceCount=1, confidence=1.0
 */
function defaultStats(): FieldStats {
  return { sampleCount: 1, presenceCount: 1, confidence: 1.0 };
}

/**
 * Recursively infer an InferredSchema from an arbitrary JSON value.
 *
 * - Objects: create property map, recurse into each value
 * - Arrays: infer items schema by merging all element schemas
 * - Primitives: type + optional format
 *
 * All newly inferred nodes start with stats { sampleCount: 1, presenceCount: 1, confidence: 1.0 }
 */
export function inferSchema(value: unknown): InferredSchema {
  const type = inferType(value);

  switch (type) {
    case 'null':
    case 'boolean':
      return { type, stats: defaultStats() };

    case 'integer': {
      const numValue = value as number;
      const format: StringFormat = (numValue > 2147483647 || numValue < -2147483648) ? 'int64' : 'int32';
      return { type: 'integer', format, stats: defaultStats() };
    }

    case 'number':
      return { type: 'number', format: 'double' as StringFormat, stats: defaultStats() };

    case 'string': {
      const strValue = value as string;
      const format: StringFormat | undefined = detectStringFormat(strValue);
      const schema: InferredSchema = { type: 'string', stats: defaultStats() };
      if (format !== undefined) {
        schema.format = format;
      } else if (strValue.length <= 100) {
        // Track observed values for enum inference (plain strings only, no format)
        schema._observedValues = [strValue];
      }
      return schema;
    }

    case 'object': {
      const obj = value as Record<string, unknown>;
      const properties: Record<string, InferredSchema> = {};
      for (const [key, val] of Object.entries(obj)) {
        properties[key] = inferSchema(val);
      }
      return {
        type: 'object',
        properties,
        required: [],
        stats: defaultStats(),
      };
    }

    case 'array': {
      const arr = value as unknown[];
      if (arr.length === 0) {
        return { type: 'array', stats: defaultStats() };
      }
      // Merge all element schemas into a single items schema
      let items: InferredSchema = inferSchema(arr[0]);
      for (let i = 1; i < arr.length; i++) {
        items = mergeSchemas(items, inferSchema(arr[i]));
      }
      return { type: 'array', items, stats: defaultStats() };
    }

    default:
      return { type: 'string', stats: defaultStats() };
  }
}
