/**
 * Tests for schema merging (Task 2.5)
 * 15+ test cases including Flowplane bug fixes
 */

import { describe, it, expect } from 'vitest';
import { mergeSchemas } from './merge.js';
import type { InferredSchema } from '../types/index.js';

// Helper to create a minimal schema
function makeSchema(overrides: Partial<InferredSchema>): InferredSchema {
  return {
    type: 'string',
    stats: { sampleCount: 1, presenceCount: 1, confidence: 1.0 },
    ...overrides,
  };
}

describe('mergeSchemas', () => {
  // ===========================================================================
  // Same type merges
  // ===========================================================================
  describe('same type merges', () => {
    it('merges two string schemas', () => {
      const a = makeSchema({ type: 'string' });
      const b = makeSchema({ type: 'string' });
      const result = mergeSchemas(a, b);
      expect(result.type).toBe('string');
      expect(result.oneOf).toBeUndefined();
    });

    it('merges two integer schemas', () => {
      const a = makeSchema({ type: 'integer' });
      const b = makeSchema({ type: 'integer' });
      const result = mergeSchemas(a, b);
      expect(result.type).toBe('integer');
      expect(result.oneOf).toBeUndefined();
    });

    it('merges two null schemas', () => {
      const a = makeSchema({ type: 'null' });
      const b = makeSchema({ type: 'null' });
      const result = mergeSchemas(a, b);
      expect(result.type).toBe('null');
      expect(result.oneOf).toBeUndefined();
    });

    it('merges two boolean schemas', () => {
      const a = makeSchema({ type: 'boolean' });
      const b = makeSchema({ type: 'boolean' });
      const result = mergeSchemas(a, b);
      expect(result.type).toBe('boolean');
    });
  });

  // ===========================================================================
  // Stats accumulation
  // ===========================================================================
  describe('stats accumulation', () => {
    it('sums sampleCount and presenceCount', () => {
      const a = makeSchema({ type: 'string', stats: { sampleCount: 3, presenceCount: 2, confidence: 0.667 } });
      const b = makeSchema({ type: 'string', stats: { sampleCount: 5, presenceCount: 4, confidence: 0.8 } });
      const result = mergeSchemas(a, b);
      expect(result.stats.sampleCount).toBe(8);
      expect(result.stats.presenceCount).toBe(6);
    });

    it('recalculates confidence as presenceCount / sampleCount', () => {
      const a = makeSchema({ type: 'string', stats: { sampleCount: 4, presenceCount: 4, confidence: 1.0 } });
      const b = makeSchema({ type: 'string', stats: { sampleCount: 6, presenceCount: 3, confidence: 0.5 } });
      const result = mergeSchemas(a, b);
      expect(result.stats.sampleCount).toBe(10);
      expect(result.stats.presenceCount).toBe(7);
      expect(result.stats.confidence).toBeCloseTo(0.7);
    });
  });

  // ===========================================================================
  // Different type merges → oneOf
  // ===========================================================================
  describe('different types create oneOf union', () => {
    it('creates oneOf for string + integer', () => {
      const a = makeSchema({ type: 'string' });
      const b = makeSchema({ type: 'integer' });
      const result = mergeSchemas(a, b);
      expect(result.oneOf).toBeDefined();
      expect(result.oneOf?.length).toBe(2);
      const types = result.oneOf?.map((v) => v.type);
      expect(types).toContain('string');
      expect(types).toContain('integer');
    });

    it('creates oneOf for string + null', () => {
      const a = makeSchema({ type: 'string', format: 'uuid' });
      const b = makeSchema({ type: 'null' });
      const result = mergeSchemas(a, b);
      expect(result.oneOf).toBeDefined();
      const types = result.oneOf?.map((v) => v.type);
      expect(types).toContain('string');
      expect(types).toContain('null');
    });

    it('preserves full schema details in oneOf variants (Flowplane bug fix)', () => {
      const a = makeSchema({ type: 'string', format: 'uuid' });
      const b = makeSchema({ type: 'null' });
      const result = mergeSchemas(a, b);
      // Each variant should be a complete InferredSchema, not just a type name
      const stringVariant = result.oneOf?.find((v) => v.type === 'string');
      expect(stringVariant?.format).toBe('uuid');
      expect(stringVariant?.stats).toBeDefined();
    });

    it('creates oneOf for boolean + number', () => {
      const a = makeSchema({ type: 'boolean' });
      const b = makeSchema({ type: 'number' });
      const result = mergeSchemas(a, b);
      expect(result.oneOf).toBeDefined();
    });
  });

  // ===========================================================================
  // Format conflict resolution (Flowplane bug fixes)
  // ===========================================================================
  describe('format conflicts', () => {
    it('keeps format when both schemas have same format', () => {
      const a = makeSchema({ type: 'string', format: 'uuid' });
      const b = makeSchema({ type: 'string', format: 'uuid' });
      const result = mergeSchemas(a, b);
      expect(result.format).toBe('uuid');
    });

    it('drops format when schemas have different formats', () => {
      const a = makeSchema({ type: 'string', format: 'uuid' });
      const b = makeSchema({ type: 'string', format: 'email' });
      const result = mergeSchemas(a, b);
      expect(result.format).toBeUndefined();
    });

    it('drops format when one has format and other does not', () => {
      const a = makeSchema({ type: 'string', format: 'uuid' });
      const b = makeSchema({ type: 'string' }); // no format
      const result = mergeSchemas(a, b);
      expect(result.format).toBeUndefined();
    });

    it('no format when neither schema has format', () => {
      const a = makeSchema({ type: 'string' });
      const b = makeSchema({ type: 'string' });
      const result = mergeSchemas(a, b);
      expect(result.format).toBeUndefined();
    });
  });

  // ===========================================================================
  // Object property merging
  // ===========================================================================
  describe('object property merging', () => {
    it('merges two objects: new fields added, existing merged', () => {
      const a = makeSchema({
        type: 'object',
        properties: {
          id: makeSchema({ type: 'integer' }),
          name: makeSchema({ type: 'string' }),
        },
        required: [],
      });
      const b = makeSchema({
        type: 'object',
        properties: {
          id: makeSchema({ type: 'integer' }),
          email: makeSchema({ type: 'string', format: 'email' }),
        },
        required: [],
      });
      const result = mergeSchemas(a, b);
      expect(result.type).toBe('object');
      expect(result.properties?.id).toBeDefined();
      expect(result.properties?.name).toBeDefined();
      expect(result.properties?.email).toBeDefined();
      expect(result.properties?.email.format).toBe('email');
    });

    it('merges conflicting field types into oneOf', () => {
      const a = makeSchema({
        type: 'object',
        properties: {
          value: makeSchema({ type: 'string' }),
        },
        required: [],
      });
      const b = makeSchema({
        type: 'object',
        properties: {
          value: makeSchema({ type: 'integer' }),
        },
        required: [],
      });
      const result = mergeSchemas(a, b);
      expect(result.properties?.value.oneOf).toBeDefined();
    });
  });

  // ===========================================================================
  // Array items merging
  // ===========================================================================
  describe('array items merging', () => {
    it('merges array items schemas', () => {
      const a = makeSchema({ type: 'array', items: makeSchema({ type: 'integer' }) });
      const b = makeSchema({ type: 'array', items: makeSchema({ type: 'integer' }) });
      const result = mergeSchemas(a, b);
      expect(result.type).toBe('array');
      expect(result.items?.type).toBe('integer');
    });

    it('creates oneOf for mixed-type array items', () => {
      const a = makeSchema({ type: 'array', items: makeSchema({ type: 'integer' }) });
      const b = makeSchema({ type: 'array', items: makeSchema({ type: 'string' }) });
      const result = mergeSchemas(a, b);
      expect(result.items?.oneOf).toBeDefined();
    });

    it('handles arrays with no items', () => {
      const a = makeSchema({ type: 'array' });
      const b = makeSchema({ type: 'array', items: makeSchema({ type: 'string' }) });
      const result = mergeSchemas(a, b);
      expect(result.type).toBe('array');
      expect(result.items?.type).toBe('string');
    });
  });

  // ===========================================================================
  // Integer + number widening
  // ===========================================================================
  describe('integer + number widening', () => {
    it('integer + number → number (no oneOf)', () => {
      const a = makeSchema({ type: 'integer' });
      const b = makeSchema({ type: 'number' });
      const result = mergeSchemas(a, b);
      expect(result.type).toBe('number');
      expect(result.oneOf).toBeUndefined();
    });

    it('number + integer → number (no oneOf)', () => {
      const a = makeSchema({ type: 'number' });
      const b = makeSchema({ type: 'integer' });
      const result = mergeSchemas(a, b);
      expect(result.type).toBe('number');
      expect(result.oneOf).toBeUndefined();
    });

    it('accumulates stats correctly when widening integer + number', () => {
      const a = makeSchema({
        type: 'integer',
        stats: { sampleCount: 3, presenceCount: 3, confidence: 1.0 },
      });
      const b = makeSchema({
        type: 'number',
        stats: { sampleCount: 2, presenceCount: 1, confidence: 0.5 },
      });
      const result = mergeSchemas(a, b);
      expect(result.type).toBe('number');
      expect(result.stats.sampleCount).toBe(5);
      expect(result.stats.presenceCount).toBe(4);
      expect(result.stats.confidence).toBeCloseTo(0.8);
    });

    it('collapses integer to number when adding integer to oneOf containing number', () => {
      // Create oneOf [string, number]
      const initial = mergeSchemas(
        makeSchema({ type: 'string' }),
        makeSchema({ type: 'number' }),
      );
      // Add integer — should collapse with number, not add a new variant
      const result = mergeSchemas(initial, makeSchema({ type: 'integer' }));
      expect(result.oneOf).toBeDefined();
      const types = result.oneOf!.map((v) => v.type);
      expect(types).toContain('string');
      expect(types).toContain('number');
      expect(types).not.toContain('integer');
      expect(result.oneOf!.length).toBe(2);
    });

    it('collapses number into integer when adding number to oneOf containing integer', () => {
      // Create oneOf [string, integer]
      const initial = mergeSchemas(
        makeSchema({ type: 'string' }),
        makeSchema({ type: 'integer' }),
      );
      // Add number — should replace integer with number
      const result = mergeSchemas(initial, makeSchema({ type: 'number' }));
      expect(result.oneOf).toBeDefined();
      const types = result.oneOf!.map((v) => v.type);
      expect(types).toContain('string');
      expect(types).toContain('number');
      expect(types).not.toContain('integer');
      expect(result.oneOf!.length).toBe(2);
    });

    it('integer + integer still merges as integer', () => {
      const a = makeSchema({ type: 'integer' });
      const b = makeSchema({ type: 'integer' });
      const result = mergeSchemas(a, b);
      expect(result.type).toBe('integer');
      expect(result.oneOf).toBeUndefined();
    });

    it('number + number still merges as number', () => {
      const a = makeSchema({ type: 'number' });
      const b = makeSchema({ type: 'number' });
      const result = mergeSchemas(a, b);
      expect(result.type).toBe('number');
      expect(result.oneOf).toBeUndefined();
    });
  });

  // ===========================================================================
  // Numeric format merging
  // ===========================================================================
  describe('numeric format merging', () => {
    it('keeps int32 when merging two int32 integers', () => {
      const a = makeSchema({ type: 'integer', format: 'int32' });
      const b = makeSchema({ type: 'integer', format: 'int32' });
      const result = mergeSchemas(a, b);
      expect(result.type).toBe('integer');
      expect(result.format).toBe('int32');
    });

    it('drops format when merging int32 + int64', () => {
      const a = makeSchema({ type: 'integer', format: 'int32' });
      const b = makeSchema({ type: 'integer', format: 'int64' });
      const result = mergeSchemas(a, b);
      expect(result.type).toBe('integer');
      expect(result.format).toBeUndefined();
    });

    it('keeps double when merging two doubles', () => {
      const a = makeSchema({ type: 'number', format: 'double' });
      const b = makeSchema({ type: 'number', format: 'double' });
      const result = mergeSchemas(a, b);
      expect(result.type).toBe('number');
      expect(result.format).toBe('double');
    });

    it('drops format when merging integer with format + integer without format (legacy)', () => {
      const a = makeSchema({ type: 'integer', format: 'int32' });
      const b = makeSchema({ type: 'integer' }); // no format (legacy data)
      const result = mergeSchemas(a, b);
      expect(result.type).toBe('integer');
      expect(result.format).toBeUndefined();
    });

    it('drops format when merging number with format + number without format (legacy)', () => {
      const a = makeSchema({ type: 'number', format: 'double' });
      const b = makeSchema({ type: 'number' }); // no format (legacy data)
      const result = mergeSchemas(a, b);
      expect(result.type).toBe('number');
      expect(result.format).toBeUndefined();
    });
  });

  // ===========================================================================
  // OneOf deduplication
  // ===========================================================================
  describe('oneOf deduplication', () => {
    it('deduplicates types when adding to existing oneOf', () => {
      // Create initial oneOf with string and integer
      const initial = mergeSchemas(
        makeSchema({ type: 'string' }),
        makeSchema({ type: 'integer' }),
      );
      // Merge with another string — should not duplicate string variant
      const result = mergeSchemas(initial, makeSchema({ type: 'string' }));
      expect(result.oneOf).toBeDefined();
      const types = result.oneOf!.map((v) => v.type);
      const stringCount = types.filter((t) => t === 'string').length;
      expect(stringCount).toBe(1);
    });

    it('adds new type to existing oneOf', () => {
      const initial = mergeSchemas(
        makeSchema({ type: 'string' }),
        makeSchema({ type: 'integer' }),
      );
      const result = mergeSchemas(initial, makeSchema({ type: 'null' }));
      expect(result.oneOf).toBeDefined();
      const types = result.oneOf!.map((v) => v.type);
      expect(types).toContain('string');
      expect(types).toContain('integer');
      expect(types).toContain('null');
      expect(result.oneOf!.length).toBe(3);
    });

    it('merges two oneOf schemas by combining variants', () => {
      const union1 = mergeSchemas(makeSchema({ type: 'string' }), makeSchema({ type: 'integer' }));
      const union2 = mergeSchemas(makeSchema({ type: 'boolean' }), makeSchema({ type: 'null' }));
      const result = mergeSchemas(union1, union2);
      expect(result.oneOf).toBeDefined();
      expect(result.oneOf!.length).toBe(4);
    });
  });

  // ===========================================================================
  // _observedValues merging for enum inference
  // ===========================================================================
  describe('_observedValues merging', () => {
    it('combines _observedValues from both schemas', () => {
      const a = makeSchema({ type: 'string', _observedValues: ['active'] });
      const b = makeSchema({ type: 'string', _observedValues: ['inactive'] });
      const result = mergeSchemas(a, b);
      expect(result._observedValues).toBeDefined();
      expect(result._observedValues).toContain('active');
      expect(result._observedValues).toContain('inactive');
    });

    it('deduplicates _observedValues', () => {
      const a = makeSchema({ type: 'string', _observedValues: ['active'] });
      const b = makeSchema({ type: 'string', _observedValues: ['active'] });
      const result = mergeSchemas(a, b);
      expect(result._observedValues).toEqual(['active']);
    });

    it('handles one schema with _observedValues and one without', () => {
      const a = makeSchema({ type: 'string', _observedValues: ['active'] });
      const b = makeSchema({ type: 'string' });
      const result = mergeSchemas(a, b);
      expect(result._observedValues).toEqual(['active']);
    });

    it('does not include _observedValues when neither schema has them', () => {
      const a = makeSchema({ type: 'string' });
      const b = makeSchema({ type: 'string' });
      const result = mergeSchemas(a, b);
      expect(result._observedValues).toBeUndefined();
    });

    it('caps _observedValues at 100 unique values', () => {
      const valuesA = Array.from({ length: 60 }, (_, i) => `val-a-${i}`);
      const valuesB = Array.from({ length: 60 }, (_, i) => `val-b-${i}`);
      const a = makeSchema({ type: 'string', _observedValues: valuesA });
      const b = makeSchema({ type: 'string', _observedValues: valuesB });
      const result = mergeSchemas(a, b);
      // 120 unique values > 100, so _observedValues should be dropped
      expect(result._observedValues).toBeUndefined();
    });
  });
});
