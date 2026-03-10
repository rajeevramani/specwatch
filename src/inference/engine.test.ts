/**
 * Tests for the schema inference engine: inferType() and inferSchema()
 */

import { describe, it, expect } from 'vitest';
import { inferType, inferSchema } from './engine.js';

// =============================================================================
// Task 2.2: inferType() — Type Detection
// =============================================================================

describe('inferType', () => {
  describe('null', () => {
    it('detects null', () => {
      expect(inferType(null)).toBe('null');
    });
  });

  describe('boolean', () => {
    it('detects true', () => {
      expect(inferType(true)).toBe('boolean');
    });

    it('detects false', () => {
      expect(inferType(false)).toBe('boolean');
    });
  });

  describe('integer', () => {
    it('detects positive integer', () => {
      expect(inferType(42)).toBe('integer');
    });

    it('detects zero as integer', () => {
      expect(inferType(0)).toBe('integer');
    });

    it('detects negative integer', () => {
      expect(inferType(-7)).toBe('integer');
    });

    it('detects large integer', () => {
      expect(inferType(1000000)).toBe('integer');
    });
  });

  describe('number (float)', () => {
    it('detects positive float', () => {
      expect(inferType(3.14)).toBe('number');
    });

    it('detects negative float', () => {
      expect(inferType(-2.718)).toBe('number');
    });

    it('detects float with trailing zero', () => {
      expect(inferType(1.0)).toBe('integer'); // 1.0 is integer in JS
    });

    it('detects small float', () => {
      expect(inferType(0.001)).toBe('number');
    });
  });

  describe('string', () => {
    it('detects empty string', () => {
      expect(inferType('')).toBe('string');
    });

    it('detects regular string', () => {
      expect(inferType('hello')).toBe('string');
    });

    it('detects numeric-looking string', () => {
      expect(inferType('42')).toBe('string');
    });

    it('detects UUID string', () => {
      expect(inferType('550e8400-e29b-41d4-a716-446655440000')).toBe('string');
    });
  });

  describe('array', () => {
    it('detects empty array', () => {
      expect(inferType([])).toBe('array');
    });

    it('detects array of integers', () => {
      expect(inferType([1, 2, 3])).toBe('array');
    });

    it('detects array of objects', () => {
      expect(inferType([{ id: 1 }, { id: 2 }])).toBe('array');
    });

    it('detects mixed array', () => {
      expect(inferType([1, 'two', true])).toBe('array');
    });
  });

  describe('object', () => {
    it('detects empty object', () => {
      expect(inferType({})).toBe('object');
    });

    it('detects object with properties', () => {
      expect(inferType({ id: 1, name: 'Alice' })).toBe('object');
    });

    it('detects nested object', () => {
      expect(inferType({ user: { name: 'Alice' } })).toBe('object');
    });
  });
});

// =============================================================================
// Task 2.4: inferSchema() — Recursive Schema Inference
// =============================================================================

describe('inferSchema', () => {
  describe('initial stats', () => {
    it('initializes stats with sampleCount=1, presenceCount=1, confidence=1.0', () => {
      const schema = inferSchema(42);
      expect(schema.stats).toEqual({ sampleCount: 1, presenceCount: 1, confidence: 1.0 });
    });
  });

  describe('primitive values', () => {
    it('infers null schema', () => {
      const schema = inferSchema(null);
      expect(schema.type).toBe('null');
      expect(schema.format).toBeUndefined();
      expect(schema.properties).toBeUndefined();
    });

    it('infers boolean schema', () => {
      const schema = inferSchema(true);
      expect(schema.type).toBe('boolean');
    });

    it('infers integer schema', () => {
      const schema = inferSchema(42);
      expect(schema.type).toBe('integer');
    });

    it('infers float schema', () => {
      const schema = inferSchema(3.14);
      expect(schema.type).toBe('number');
    });

    it('infers plain string schema without format', () => {
      const schema = inferSchema('hello world');
      expect(schema.type).toBe('string');
      expect(schema.format).toBeUndefined();
    });

    it('infers string schema with uuid format', () => {
      const schema = inferSchema('550e8400-e29b-41d4-a716-446655440000');
      expect(schema.type).toBe('string');
      expect(schema.format).toBe('uuid');
    });

    it('infers string schema with email format', () => {
      const schema = inferSchema('alice@example.com');
      expect(schema.type).toBe('string');
      expect(schema.format).toBe('email');
    });

    it('infers string schema with date-time format', () => {
      const schema = inferSchema('2024-01-15T10:30:00Z');
      expect(schema.type).toBe('string');
      expect(schema.format).toBe('date-time');
    });

    it('infers string schema with date format', () => {
      const schema = inferSchema('2024-01-15');
      expect(schema.type).toBe('string');
      expect(schema.format).toBe('date');
    });

    it('infers string schema with uri format', () => {
      const schema = inferSchema('https://example.com/api');
      expect(schema.type).toBe('string');
      expect(schema.format).toBe('uri');
    });
  });

  describe('simple objects', () => {
    it('infers empty object schema', () => {
      const schema = inferSchema({});
      expect(schema.type).toBe('object');
      expect(schema.properties).toEqual({});
      expect(schema.required).toEqual([]);
    });

    it('infers object with integer and string fields', () => {
      const schema = inferSchema({ id: 1, name: 'Alice' });
      expect(schema.type).toBe('object');
      expect(schema.properties?.id.type).toBe('integer');
      expect(schema.properties?.name.type).toBe('string');
    });

    it('infers object with boolean field', () => {
      const schema = inferSchema({ active: true });
      expect(schema.properties?.active.type).toBe('boolean');
    });

    it('infers object with null field', () => {
      const schema = inferSchema({ x: null });
      expect(schema.type).toBe('object');
      expect(schema.properties?.x.type).toBe('null');
    });

    it('infers object with uuid field', () => {
      const schema = inferSchema({ id: '550e8400-e29b-41d4-a716-446655440000' });
      expect(schema.properties?.id.type).toBe('string');
      expect(schema.properties?.id.format).toBe('uuid');
    });
  });

  describe('nested objects', () => {
    it('infers singly nested object', () => {
      const schema = inferSchema({ user: { name: 'Alice', age: 30 } });
      expect(schema.type).toBe('object');
      const userSchema = schema.properties?.user;
      expect(userSchema?.type).toBe('object');
      expect(userSchema?.properties?.name.type).toBe('string');
      expect(userSchema?.properties?.age.type).toBe('integer');
    });

    it('infers 3-level deep nesting', () => {
      const schema = inferSchema({
        a: { b: { c: { value: 42 } } },
      });
      const cSchema = schema.properties?.a.properties?.b.properties?.c;
      expect(cSchema?.type).toBe('object');
      expect(cSchema?.properties?.value.type).toBe('integer');
    });

    it('infers 5-level deep nesting', () => {
      const schema = inferSchema({
        l1: { l2: { l3: { l4: { l5: 'deep' } } } },
      });
      const l4 = schema.properties?.l1.properties?.l2.properties?.l3.properties?.l4;
      expect(l4?.type).toBe('object');
      expect(l4?.properties?.l5.type).toBe('string');
    });

    it('infers API response structure', () => {
      const schema = inferSchema({
        data: {
          user: {
            id: '550e8400-e29b-41d4-a716-446655440000',
            email: 'alice@example.com',
            createdAt: '2024-01-15T10:30:00Z',
          },
        },
        meta: { total: 100, page: 1 },
      });
      const userSchema = schema.properties?.data.properties?.user;
      expect(userSchema?.properties?.id.format).toBe('uuid');
      expect(userSchema?.properties?.email.format).toBe('email');
      expect(userSchema?.properties?.createdAt.format).toBe('date-time');
      expect(schema.properties?.meta.properties?.total.type).toBe('integer');
    });
  });

  describe('arrays', () => {
    it('infers empty array schema', () => {
      const schema = inferSchema([]);
      expect(schema.type).toBe('array');
      expect(schema.items).toBeUndefined();
    });

    it('infers array of integers', () => {
      const schema = inferSchema([1, 2, 3]);
      expect(schema.type).toBe('array');
      expect(schema.items?.type).toBe('integer');
    });

    it('infers array of strings', () => {
      const schema = inferSchema(['a', 'b', 'c']);
      expect(schema.type).toBe('array');
      expect(schema.items?.type).toBe('string');
    });

    it('infers array of objects', () => {
      const schema = inferSchema([{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }]);
      expect(schema.type).toBe('array');
      expect(schema.items?.type).toBe('object');
      expect(schema.items?.properties?.id.type).toBe('integer');
      expect(schema.items?.properties?.name.type).toBe('string');
    });

    it('infers mixed array (int + string) → oneOf items', () => {
      const schema = inferSchema([1, 'two']);
      expect(schema.type).toBe('array');
      expect(schema.items?.oneOf).toBeDefined();
      const types = schema.items?.oneOf?.map((v) => v.type);
      expect(types).toContain('integer');
      expect(types).toContain('string');
    });

    it('infers mixed array with boolean → oneOf items', () => {
      const schema = inferSchema([1, 'two', true]);
      expect(schema.type).toBe('array');
      expect(schema.items?.oneOf).toBeDefined();
    });

    it('infers nested array of objects with UUID fields', () => {
      const schema = inferSchema([
        { id: '550e8400-e29b-41d4-a716-446655440000', score: 99 },
        { id: '6ba7b810-9dad-11d1-80b4-00c04fd430c8', score: 88 },
      ]);
      expect(schema.items?.properties?.id.format).toBe('uuid');
    });

    it('infers array with null element', () => {
      const schema = inferSchema([null, 1]);
      expect(schema.type).toBe('array');
      expect(schema.items?.oneOf).toBeDefined();
    });

    it('infers single-element array', () => {
      const schema = inferSchema([42]);
      expect(schema.type).toBe('array');
      expect(schema.items?.type).toBe('integer');
    });
  });

  describe('numeric format detection', () => {
    it('infers int32 format for small integer', () => {
      const schema = inferSchema(42);
      expect(schema.type).toBe('integer');
      expect(schema.format).toBe('int32');
    });

    it('infers int32 format for zero', () => {
      const schema = inferSchema(0);
      expect(schema.type).toBe('integer');
      expect(schema.format).toBe('int32');
    });

    it('infers int32 format for max int32 value', () => {
      const schema = inferSchema(2147483647);
      expect(schema.type).toBe('integer');
      expect(schema.format).toBe('int32');
    });

    it('infers int32 format for min int32 value', () => {
      const schema = inferSchema(-2147483648);
      expect(schema.type).toBe('integer');
      expect(schema.format).toBe('int32');
    });

    it('infers int64 format for large positive integer', () => {
      const schema = inferSchema(2147483648);
      expect(schema.type).toBe('integer');
      expect(schema.format).toBe('int64');
    });

    it('infers int64 format for large negative integer', () => {
      const schema = inferSchema(-2147483649);
      expect(schema.type).toBe('integer');
      expect(schema.format).toBe('int64');
    });

    it('infers double format for float', () => {
      const schema = inferSchema(3.14);
      expect(schema.type).toBe('number');
      expect(schema.format).toBe('double');
    });

    it('infers double format for negative float', () => {
      const schema = inferSchema(-2.718);
      expect(schema.type).toBe('number');
      expect(schema.format).toBe('double');
    });

    it('does not regress inferType for integers', () => {
      expect(inferType(42)).toBe('integer');
      expect(inferType(0)).toBe('integer');
      expect(inferType(-7)).toBe('integer');
      expect(inferType(2147483648)).toBe('integer');
    });

    it('does not regress inferType for floats', () => {
      expect(inferType(3.14)).toBe('number');
      expect(inferType(-2.718)).toBe('number');
    });
  });

  describe('complex real-world shapes', () => {
    it('infers a paginated list response', () => {
      const schema = inferSchema({
        items: [
          { id: 1, name: 'Widget', price: 9.99 },
          { id: 2, name: 'Gadget', price: 24.99 },
        ],
        page: 1,
        limit: 10,
        total: 42,
      });
      expect(schema.type).toBe('object');
      expect(schema.properties?.items.type).toBe('array');
      expect(schema.properties?.items.items?.type).toBe('object');
      expect(schema.properties?.items.items?.properties?.price.type).toBe('number');
    });

    it('infers a user creation request', () => {
      const schema = inferSchema({
        username: 'alice',
        email: 'alice@example.com',
        birthdate: '1990-01-15',
        active: true,
      });
      expect(schema.properties?.email.format).toBe('email');
      expect(schema.properties?.birthdate.format).toBe('date');
      expect(schema.properties?.active.type).toBe('boolean');
    });

    it('each property has its own stats', () => {
      const schema = inferSchema({ a: 1, b: 'hello' });
      expect(schema.properties?.a.stats).toEqual({ sampleCount: 1, presenceCount: 1, confidence: 1.0 });
      expect(schema.properties?.b.stats).toEqual({ sampleCount: 1, presenceCount: 1, confidence: 1.0 });
    });
  });

  describe('_observedValues tracking for enum inference', () => {
    it('tracks _observedValues for plain strings', () => {
      const schema = inferSchema('active');
      expect(schema._observedValues).toEqual(['active']);
    });

    it('does not track _observedValues for strings with uuid format', () => {
      const schema = inferSchema('550e8400-e29b-41d4-a716-446655440000');
      expect(schema._observedValues).toBeUndefined();
    });

    it('does not track _observedValues for strings with email format', () => {
      const schema = inferSchema('alice@example.com');
      expect(schema._observedValues).toBeUndefined();
    });

    it('does not track _observedValues for strings with date-time format', () => {
      const schema = inferSchema('2024-01-15T10:30:00Z');
      expect(schema._observedValues).toBeUndefined();
    });

    it('does not track _observedValues for strings with date format', () => {
      const schema = inferSchema('2024-01-15');
      expect(schema._observedValues).toBeUndefined();
    });

    it('does not track _observedValues for strings with uri format', () => {
      const schema = inferSchema('https://example.com/api');
      expect(schema._observedValues).toBeUndefined();
    });

    it('does not track _observedValues for strings longer than 100 chars', () => {
      const longString = 'a'.repeat(101);
      const schema = inferSchema(longString);
      expect(schema._observedValues).toBeUndefined();
    });

    it('tracks _observedValues for strings exactly 100 chars', () => {
      const exactString = 'a'.repeat(100);
      const schema = inferSchema(exactString);
      expect(schema._observedValues).toEqual([exactString]);
    });

    it('tracks _observedValues in nested object string fields', () => {
      const schema = inferSchema({ status: 'active' });
      expect(schema.properties?.status._observedValues).toEqual(['active']);
    });
  });
});
