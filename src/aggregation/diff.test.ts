/**
 * Unit tests for breaking change detection.
 * Ported from Flowplane's schema_diff.rs test cases.
 */

import { describe, it, expect } from 'vitest';
import { detectBreakingChanges } from './diff.js';
import type { InferredSchema } from '../types/index.js';

function makeStats(sampleCount = 10, presenceCount = 10) {
  return { sampleCount, presenceCount, confidence: presenceCount / sampleCount };
}

function makeObjectSchema(
  properties: Record<string, InferredSchema>,
  required: string[] = [],
): InferredSchema {
  return {
    type: 'object',
    properties,
    required,
    stats: makeStats(),
  };
}

function makeStringSchema(format?: string): InferredSchema {
  const schema: InferredSchema = { type: 'string', stats: makeStats() };
  if (format !== undefined) {
    schema.format = format as InferredSchema['format'];
  }
  return schema;
}

function makeIntegerSchema(): InferredSchema {
  return { type: 'integer', stats: makeStats() };
}

function makeNumberSchema(): InferredSchema {
  return { type: 'number', stats: makeStats() };
}

function makeNullSchema(): InferredSchema {
  return { type: 'null', stats: makeStats() };
}

function makeArraySchema(items?: InferredSchema): InferredSchema {
  const schema: InferredSchema = { type: 'array', stats: makeStats() };
  if (items !== undefined) schema.items = items;
  return schema;
}

function makeOneOfSchema(...variants: InferredSchema[]): InferredSchema {
  return {
    type: 'object', // ignored when oneOf present
    oneOf: variants,
    stats: makeStats(),
  };
}

// ============================================================
// No changes
// ============================================================

describe('detectBreakingChanges — no changes', () => {
  it('returns empty diff for identical schemas', () => {
    const schema = makeObjectSchema(
      { id: makeIntegerSchema(), name: makeStringSchema() },
      ['id', 'name'],
    );
    const diff = detectBreakingChanges(schema, schema);
    expect(diff.breakingChanges).toHaveLength(0);
    expect(diff.nonBreakingChanges).toHaveLength(0);
  });

  it('returns empty diff for identical primitive schemas', () => {
    const schema = makeStringSchema();
    const diff = detectBreakingChanges(schema, schema);
    expect(diff.breakingChanges).toHaveLength(0);
  });
});

// ============================================================
// required_field_removed
// ============================================================

describe('detectBreakingChanges — required_field_removed', () => {
  it('detects required field removal', () => {
    const oldSchema = makeObjectSchema(
      { id: makeIntegerSchema(), email: makeStringSchema() },
      ['id', 'email'],
    );
    const newSchema = makeObjectSchema(
      { id: makeIntegerSchema() },
      ['id'],
    );

    const diff = detectBreakingChanges(oldSchema, newSchema);
    expect(diff.breakingChanges).toHaveLength(1);
    expect(diff.breakingChanges[0].type).toBe('required_field_removed');
    expect(diff.breakingChanges[0].path).toBe('$.email');
  });

  it('includes path in breaking change', () => {
    const oldSchema = makeObjectSchema(
      { name: makeStringSchema() },
      ['name'],
    );
    const newSchema = makeObjectSchema({});

    const diff = detectBreakingChanges(oldSchema, newSchema);
    expect(diff.breakingChanges[0].path).toBe('$.name');
    expect(diff.breakingChanges[0].oldValue).toBe('name');
  });
});

// ============================================================
// required_field_added
// ============================================================

describe('detectBreakingChanges — required_field_added', () => {
  it('detects new required field added', () => {
    const oldSchema = makeObjectSchema({ id: makeIntegerSchema() }, ['id']);
    const newSchema = makeObjectSchema(
      { id: makeIntegerSchema(), phone: makeStringSchema() },
      ['id', 'phone'],
    );

    const diff = detectBreakingChanges(oldSchema, newSchema);
    expect(diff.breakingChanges).toHaveLength(1);
    expect(diff.breakingChanges[0].type).toBe('required_field_added');
    expect(diff.breakingChanges[0].path).toBe('$.phone');
  });

  it('does not flag new optional fields as breaking', () => {
    const oldSchema = makeObjectSchema({ id: makeIntegerSchema() }, ['id']);
    const newSchema = makeObjectSchema(
      { id: makeIntegerSchema(), optionalNote: makeStringSchema() },
      ['id'],
    );

    const diff = detectBreakingChanges(oldSchema, newSchema);
    expect(diff.breakingChanges).toHaveLength(0);
    expect(diff.nonBreakingChanges.some((c) => c.includes('optionalNote'))).toBe(true);
  });
});

// ============================================================
// field_became_required
// ============================================================

describe('detectBreakingChanges — field_became_required', () => {
  it('detects field becoming required', () => {
    const oldSchema = makeObjectSchema(
      { id: makeIntegerSchema(), email: makeStringSchema() },
      ['id'],
    );
    const newSchema = makeObjectSchema(
      { id: makeIntegerSchema(), email: makeStringSchema() },
      ['id', 'email'],
    );

    const diff = detectBreakingChanges(oldSchema, newSchema);
    expect(diff.breakingChanges).toHaveLength(1);
    expect(diff.breakingChanges[0].type).toBe('field_became_required');
    expect(diff.breakingChanges[0].path).toBe('$.email');
    expect(diff.breakingChanges[0].oldValue).toBe('optional');
    expect(diff.breakingChanges[0].newValue).toBe('required');
  });

  it('field becoming optional is non-breaking', () => {
    const oldSchema = makeObjectSchema(
      { id: makeIntegerSchema(), email: makeStringSchema() },
      ['id', 'email'],
    );
    const newSchema = makeObjectSchema(
      { id: makeIntegerSchema(), email: makeStringSchema() },
      ['id'],
    );

    const diff = detectBreakingChanges(oldSchema, newSchema);
    expect(diff.breakingChanges).toHaveLength(0);
    expect(diff.nonBreakingChanges.some((c) => c.includes('email'))).toBe(true);
  });
});

// ============================================================
// incompatible_type_change
// ============================================================

describe('detectBreakingChanges — incompatible_type_change', () => {
  it('detects string to integer as breaking', () => {
    const oldSchema = makeObjectSchema(
      { value: makeStringSchema() },
      ['value'],
    );
    const newSchema = makeObjectSchema(
      { value: makeIntegerSchema() },
      ['value'],
    );

    const diff = detectBreakingChanges(oldSchema, newSchema);
    expect(diff.breakingChanges).toHaveLength(1);
    expect(diff.breakingChanges[0].type).toBe('incompatible_type_change');
    expect(diff.breakingChanges[0].path).toBe('$.value');
  });

  it('detects number to integer as BREAKING (fixes Flowplane bug)', () => {
    const oldSchema = makeObjectSchema(
      { price: makeNumberSchema() },
      ['price'],
    );
    const newSchema = makeObjectSchema(
      { price: makeIntegerSchema() },
      ['price'],
    );

    const diff = detectBreakingChanges(oldSchema, newSchema);
    expect(diff.breakingChanges).toHaveLength(1);
    expect(diff.breakingChanges[0].type).toBe('incompatible_type_change');
    expect(diff.breakingChanges[0].oldValue).toBe('number');
    expect(diff.breakingChanges[0].newValue).toBe('integer');
  });

  it('integer to number is COMPATIBLE (widening)', () => {
    const oldSchema = makeObjectSchema(
      { count: makeIntegerSchema() },
      ['count'],
    );
    const newSchema = makeObjectSchema(
      { count: makeNumberSchema() },
      ['count'],
    );

    const diff = detectBreakingChanges(oldSchema, newSchema);
    // integer -> number is widening, not breaking
    const incompatible = diff.breakingChanges.filter(
      (c) => c.type === 'incompatible_type_change',
    );
    expect(incompatible).toHaveLength(0);
    // Should be in non-breaking changes
    expect(diff.nonBreakingChanges.some((c) => c.includes('widened'))).toBe(true);
  });

  it('integer to integer is compatible (same type)', () => {
    const oldSchema = makeObjectSchema(
      { count: makeIntegerSchema() },
      ['count'],
    );
    const newSchema = makeObjectSchema(
      { count: makeIntegerSchema() },
      ['count'],
    );

    const diff = detectBreakingChanges(oldSchema, newSchema);
    expect(diff.breakingChanges).toHaveLength(0);
  });
});

// ============================================================
// schema_type_changed
// ============================================================

describe('detectBreakingChanges — schema_type_changed', () => {
  it('detects object to array as schema_type_changed', () => {
    const oldSchema = makeObjectSchema(
      { id: makeIntegerSchema() },
      ['id'],
    );
    const newSchema = makeArraySchema(makeIntegerSchema());

    const diff = detectBreakingChanges(oldSchema, newSchema);
    expect(diff.breakingChanges).toHaveLength(1);
    expect(diff.breakingChanges[0].type).toBe('schema_type_changed');
    expect(diff.breakingChanges[0].oldValue).toBe('object');
    expect(diff.breakingChanges[0].newValue).toBe('array');
  });

  it('detects string to boolean as incompatible_type_change at root', () => {
    const oldSchema = makeStringSchema();
    const newSchema = { type: 'boolean' as const, stats: makeStats() };

    const diff = detectBreakingChanges(oldSchema, newSchema);
    expect(diff.breakingChanges).toHaveLength(1);
    expect(diff.breakingChanges[0].type).toBe('incompatible_type_change');
    expect(diff.breakingChanges[0].path).toBe('$');
  });
});

// ============================================================
// oneOf compatibility
// ============================================================

describe('detectBreakingChanges — oneOf compatibility', () => {
  it('X -> oneOf[..., X, ...] is compatible', () => {
    const oldSchema = makeStringSchema();
    const newSchema = makeOneOfSchema(makeStringSchema(), makeNullSchema());

    const diff = detectBreakingChanges(oldSchema, newSchema);
    expect(diff.breakingChanges).toHaveLength(0);
    expect(diff.nonBreakingChanges.some((c) => c.includes('expanded'))).toBe(true);
  });

  it('X -> oneOf that does not include X is breaking', () => {
    const oldSchema = makeStringSchema();
    const newSchema = makeOneOfSchema(makeIntegerSchema(), makeNullSchema());

    const diff = detectBreakingChanges(oldSchema, newSchema);
    expect(diff.breakingChanges).toHaveLength(1);
    expect(diff.breakingChanges[0].type).toBe('incompatible_type_change');
  });

  it('oneOf -> concrete type is breaking (narrowing)', () => {
    const oldSchema = makeOneOfSchema(makeStringSchema(), makeNullSchema());
    const newSchema = makeStringSchema();

    const diff = detectBreakingChanges(oldSchema, newSchema);
    expect(diff.breakingChanges).toHaveLength(1);
    expect(diff.breakingChanges[0].type).toBe('incompatible_type_change');
  });

  it('integer -> oneOf[integer, null] is compatible', () => {
    const oldSchema = makeIntegerSchema();
    const newSchema = makeOneOfSchema(makeIntegerSchema(), makeNullSchema());

    const diff = detectBreakingChanges(oldSchema, newSchema);
    expect(diff.breakingChanges).toHaveLength(0);
  });
});

// ============================================================
// Recursive / nested comparison
// ============================================================

describe('detectBreakingChanges — nested objects', () => {
  it('detects breaking changes in nested objects', () => {
    const oldSchema = makeObjectSchema(
      {
        user: makeObjectSchema(
          { id: makeIntegerSchema(), email: makeStringSchema() },
          ['id', 'email'],
        ),
      },
      ['user'],
    );

    const newSchema = makeObjectSchema(
      {
        user: makeObjectSchema(
          { id: makeIntegerSchema() },
          ['id'],
        ),
      },
      ['user'],
    );

    const diff = detectBreakingChanges(oldSchema, newSchema);
    expect(diff.breakingChanges).toHaveLength(1);
    expect(diff.breakingChanges[0].type).toBe('required_field_removed');
    expect(diff.breakingChanges[0].path).toBe('$.user.email');
  });

  it('uses correct JSON path for deeply nested changes', () => {
    const deepOld = makeObjectSchema(
      {
        level1: makeObjectSchema(
          {
            level2: makeObjectSchema(
              { value: makeStringSchema() },
              ['value'],
            ),
          },
          ['level2'],
        ),
      },
      ['level1'],
    );

    const deepNew = makeObjectSchema(
      {
        level1: makeObjectSchema(
          {
            level2: makeObjectSchema(
              { value: makeIntegerSchema() },
              ['value'],
            ),
          },
          ['level2'],
        ),
      },
      ['level1'],
    );

    const diff = detectBreakingChanges(deepOld, deepNew);
    expect(diff.breakingChanges).toHaveLength(1);
    expect(diff.breakingChanges[0].path).toBe('$.level1.level2.value');
  });

  it('detects breaking changes in array items', () => {
    const oldSchema = makeArraySchema(makeStringSchema());
    const newSchema = makeArraySchema(makeIntegerSchema());

    const diff = detectBreakingChanges(oldSchema, newSchema);
    expect(diff.breakingChanges).toHaveLength(1);
    expect(diff.breakingChanges[0].path).toBe('$[]');
  });
});

// ============================================================
// Non-breaking changes tracking
// ============================================================

describe('detectBreakingChanges — non-breaking changes', () => {
  it('tracks new optional fields as non-breaking', () => {
    const oldSchema = makeObjectSchema({ id: makeIntegerSchema() }, ['id']);
    const newSchema = makeObjectSchema(
      { id: makeIntegerSchema(), notes: makeStringSchema() },
      ['id'],
    );

    const diff = detectBreakingChanges(oldSchema, newSchema);
    expect(diff.breakingChanges).toHaveLength(0);
    expect(diff.nonBreakingChanges).toHaveLength(1);
    expect(diff.nonBreakingChanges[0]).toContain('notes');
  });

  it('tracks removed optional fields as non-breaking', () => {
    const oldSchema = makeObjectSchema(
      { id: makeIntegerSchema(), notes: makeStringSchema() },
      ['id'],
    );
    const newSchema = makeObjectSchema({ id: makeIntegerSchema() }, ['id']);

    const diff = detectBreakingChanges(oldSchema, newSchema);
    expect(diff.breakingChanges).toHaveLength(0);
    expect(diff.nonBreakingChanges).toHaveLength(1);
    expect(diff.nonBreakingChanges[0]).toContain('notes');
  });

  it('tracks integer to number widening as non-breaking', () => {
    const oldSchema = makeObjectSchema({ count: makeIntegerSchema() }, ['count']);
    const newSchema = makeObjectSchema({ count: makeNumberSchema() }, ['count']);

    const diff = detectBreakingChanges(oldSchema, newSchema);
    expect(diff.breakingChanges).toHaveLength(0);
    expect(diff.nonBreakingChanges).toHaveLength(1);
    expect(diff.nonBreakingChanges[0]).toContain('widened');
  });

  it('tracks field becoming optional as non-breaking', () => {
    const oldSchema = makeObjectSchema(
      { id: makeIntegerSchema(), email: makeStringSchema() },
      ['id', 'email'],
    );
    const newSchema = makeObjectSchema(
      { id: makeIntegerSchema(), email: makeStringSchema() },
      ['id'],
    );

    const diff = detectBreakingChanges(oldSchema, newSchema);
    expect(diff.breakingChanges).toHaveLength(0);
    expect(diff.nonBreakingChanges).toHaveLength(1);
    expect(diff.nonBreakingChanges[0]).toContain('optional');
  });
});

// ============================================================
// Custom path prefix
// ============================================================

describe('detectBreakingChanges — custom path', () => {
  it('uses provided path prefix for error messages', () => {
    const oldSchema = makeObjectSchema(
      { name: makeStringSchema() },
      ['name'],
    );
    const newSchema = makeObjectSchema({});

    const diff = detectBreakingChanges(oldSchema, newSchema, '$.response');
    expect(diff.breakingChanges[0].path).toBe('$.response.name');
  });
});
