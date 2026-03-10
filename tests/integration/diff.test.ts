/**
 * Breaking change detection (diff) integration tests.
 *
 * These tests verify the schema diff logic catches all 5 breaking change types
 * and correctly identifies non-breaking changes.
 *
 * NOTE (Phase A/B): The tests that can run now validate fixture shapes for
 * diff scenarios. Full diff integration tests (Phase C) require the
 * aggregation/diff.ts module to be implemented.
 *
 * Breaking change types (from PLAN.md section 7.3):
 *   1. required_field_removed   — field in old required[], absent from new properties
 *   2. incompatible_type_change — field type changed to incompatible type
 *   3. required_field_added     — new field in new required[], absent from old properties
 *   4. field_became_required    — field existed as optional, now in required array
 *   5. schema_type_changed      — root schema type changed (object → array)
 *
 * Type compatibility rules:
 *   - integer → number: compatible (widening)
 *   - number → integer: BREAKING (narrowing — fixes Flowplane bug)
 *   - X → oneOf[..., X, ...]: compatible (widening includes original)
 *   - All other type changes: incompatible
 */

import { describe, it, expect } from 'vitest';
import {
  SCHEMA_V1,
  SCHEMA_V2_REMOVED_FIELD,
  SCHEMA_V2_TYPE_CHANGED,
  SCHEMA_V2_ADDED_REQUIRED,
  SCHEMA_V2_FIELD_BECAME_REQUIRED,
  SCHEMA_V1_OBJECT,
  SCHEMA_V2_TYPE_CHANGED_ROOT,
  SCHEMA_V2_INTEGER_TO_NUMBER,
  SCHEMA_V1_NUMBER,
  SCHEMA_V2_NUMBER_TO_INTEGER,
  INTEGER_SCHEMA,
  NUMBER_SCHEMA,
  DEFAULT_STATS,
} from '../helpers/fixtures.js';
import type { InferredSchema } from '../../src/inference/types.js';
import { detectBreakingChanges } from '../../src/aggregation/diff.js';

// ---------------------------------------------------------------------------
// Fixture shape validation — diff scenarios
// ---------------------------------------------------------------------------

describe('Diff fixtures — structural validation', () => {
  it('SCHEMA_V1 has required fields: id, name, email', () => {
    expect(SCHEMA_V1.type).toBe('object');
    expect(SCHEMA_V1.required).toContain('id');
    expect(SCHEMA_V1.required).toContain('name');
    expect(SCHEMA_V1.required).toContain('email');
  });

  it('SCHEMA_V2_REMOVED_FIELD is missing email (breaking: required_field_removed)', () => {
    expect(SCHEMA_V2_REMOVED_FIELD.type).toBe('object');
    expect(SCHEMA_V2_REMOVED_FIELD.properties).not.toHaveProperty('email');
    expect(SCHEMA_V2_REMOVED_FIELD.required).not.toContain('email');
    // Has a new optional field
    expect(SCHEMA_V2_REMOVED_FIELD.properties).toHaveProperty('avatar');
  });

  it('SCHEMA_V2_TYPE_CHANGED has email as integer (incompatible_type_change)', () => {
    expect(SCHEMA_V2_TYPE_CHANGED.type).toBe('object');
    expect(SCHEMA_V2_TYPE_CHANGED.properties!['email'].type).toBe('integer');
    // Previously email was type string
    expect(SCHEMA_V1.properties!['email'].type).toBe('string');
  });

  it('SCHEMA_V2_ADDED_REQUIRED has phoneNumber as required (required_field_added)', () => {
    expect(SCHEMA_V2_ADDED_REQUIRED.type).toBe('object');
    expect(SCHEMA_V2_ADDED_REQUIRED.required).toContain('phoneNumber');
    // phoneNumber was absent from V1
    expect(SCHEMA_V1.properties).not.toHaveProperty('phoneNumber');
  });

  it('SCHEMA_V2_FIELD_BECAME_REQUIRED has avatar as required (field_became_required)', () => {
    expect(SCHEMA_V2_FIELD_BECAME_REQUIRED.type).toBe('object');
    expect(SCHEMA_V2_FIELD_BECAME_REQUIRED.required).toContain('avatar');
    // avatar was absent from V1 required list
    expect(SCHEMA_V1.required).not.toContain('avatar');
    // but avatar is present in V1 properties (it would be optional there in the fixture)
  });

  it('SCHEMA_V1_OBJECT is object; SCHEMA_V2_TYPE_CHANGED_ROOT is array (schema_type_changed)', () => {
    expect(SCHEMA_V1_OBJECT.type).toBe('object');
    expect(SCHEMA_V2_TYPE_CHANGED_ROOT.type).toBe('array');
  });

  it('SCHEMA_V2_INTEGER_TO_NUMBER widens id from integer to number (compatible)', () => {
    expect(SCHEMA_V1.properties!['id'].type).toBe('integer');
    expect(SCHEMA_V2_INTEGER_TO_NUMBER.properties!['id'].type).toBe('number');
  });

  it('SCHEMA_V2_NUMBER_TO_INTEGER narrows price from number to integer (BREAKING — fixes Flowplane bug)', () => {
    expect(SCHEMA_V1_NUMBER.properties!['price'].type).toBe('number');
    expect(SCHEMA_V2_NUMBER_TO_INTEGER.properties!['price'].type).toBe('integer');
  });

  it('INTEGER_SCHEMA and NUMBER_SCHEMA have the expected types', () => {
    expect(INTEGER_SCHEMA.type).toBe('integer');
    expect(NUMBER_SCHEMA.type).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// Type compatibility rules (logic-level, no src/ dependency needed)
// ---------------------------------------------------------------------------

describe('Type compatibility rules (documented contracts)', () => {
  /**
   * These tests document the expected behavior of the diff module
   * without importing the actual implementation. They serve as
   * specification-level tests that the Aggregation Engineer's implementation
   * must satisfy.
   */

  it('integer → number is a widening (compatible) change', () => {
    // integer is a subset of number — changing from integer to number is
    // not breaking because existing integer values are valid numbers too.
    const oldType = 'integer';
    const newType = 'number';
    // Widening: every integer is a number
    expect(isWideningTypeChange(oldType, newType)).toBe(true);
  });

  it('number → integer is a narrowing (BREAKING) change', () => {
    // number → integer is breaking because 3.14 (valid number) becomes invalid integer
    const oldType = 'number';
    const newType = 'integer';
    expect(isNarrowingTypeChange(oldType, newType)).toBe(true);
  });

  it('string → integer is an incompatible change', () => {
    const oldType = 'string';
    const newType = 'integer';
    expect(isIncompatibleTypeChange(oldType, newType)).toBe(true);
  });

  it('string → null is an incompatible change', () => {
    const oldType = 'string';
    const newType = 'null';
    expect(isIncompatibleTypeChange(oldType, newType)).toBe(true);
  });

  it('object → array is a schema_type_changed (root type)', () => {
    const oldType = 'object';
    const newType = 'array';
    expect(isIncompatibleTypeChange(oldType, newType)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Breaking change detection fixture completeness
// ---------------------------------------------------------------------------

describe('Diff scenario coverage', () => {
  it('all 5 breaking change types are represented in fixtures', () => {
    // 1. required_field_removed: SCHEMA_V1 → SCHEMA_V2_REMOVED_FIELD
    const v1HasEmail = SCHEMA_V1.required!.includes('email');
    const v2MissingEmail = !('email' in (SCHEMA_V2_REMOVED_FIELD.properties ?? {}));
    expect(v1HasEmail && v2MissingEmail).toBe(true);

    // 2. incompatible_type_change: email string → integer
    const emailWasString = SCHEMA_V1.properties!['email'].type === 'string';
    const emailNowInteger = SCHEMA_V2_TYPE_CHANGED.properties!['email'].type === 'integer';
    expect(emailWasString && emailNowInteger).toBe(true);

    // 3. required_field_added: phoneNumber not in V1, required in V2
    const phoneNotInV1 = !('phoneNumber' in (SCHEMA_V1.properties ?? {}));
    const phoneRequiredInV2 = SCHEMA_V2_ADDED_REQUIRED.required!.includes('phoneNumber');
    expect(phoneNotInV1 && phoneRequiredInV2).toBe(true);

    // 4. field_became_required: avatar optional → required
    const avatarNotRequiredInV1 = !SCHEMA_V1.required!.includes('avatar');
    const avatarRequiredInV2 = SCHEMA_V2_FIELD_BECAME_REQUIRED.required!.includes('avatar');
    expect(avatarNotRequiredInV1 && avatarRequiredInV2).toBe(true);

    // 5. schema_type_changed: object → array
    const wasObject = SCHEMA_V1_OBJECT.type === 'object';
    const nowArray = SCHEMA_V2_TYPE_CHANGED_ROOT.type === 'array';
    expect(wasObject && nowArray).toBe(true);
  });

  it('integer → number widening is captured as non-breaking', () => {
    // V1 has id: integer, V2 has id: number — this should NOT be breaking
    expect(SCHEMA_V1.properties!['id'].type).toBe('integer');
    expect(SCHEMA_V2_INTEGER_TO_NUMBER.properties!['id'].type).toBe('number');
  });

  it('number → integer narrowing is captured as breaking (Flowplane bug fix)', () => {
    // V1 has price: number, V2 has price: integer — BREAKING
    expect(SCHEMA_V1_NUMBER.properties!['price'].type).toBe('number');
    expect(SCHEMA_V2_NUMBER_TO_INTEGER.properties!['price'].type).toBe('integer');
  });
});

// ---------------------------------------------------------------------------
// Phase C: Full diff integration tests
// ---------------------------------------------------------------------------

describe('Diff (Phase C — integration)', () => {
  it('two sessions with different schemas → diff → breaking changes detected', () => {
    const result = detectBreakingChanges(SCHEMA_V1, SCHEMA_V2_REMOVED_FIELD);
    expect(result.breakingChanges.length).toBeGreaterThan(0);
  });

  it('detects required_field_removed', () => {
    const result = detectBreakingChanges(SCHEMA_V1, SCHEMA_V2_REMOVED_FIELD);
    const emailChange = result.breakingChanges.find(
      (c) => c.type === 'required_field_removed' && c.path === '$.email',
    );
    expect(emailChange).toBeDefined();
    expect(emailChange!.type).toBe('required_field_removed');
    expect(emailChange!.path).toBe('$.email');
  });

  it('detects incompatible_type_change (string → integer)', () => {
    const result = detectBreakingChanges(SCHEMA_V1, SCHEMA_V2_TYPE_CHANGED);
    const emailChange = result.breakingChanges.find(
      (c) => c.type === 'incompatible_type_change' && c.path === '$.email',
    );
    expect(emailChange).toBeDefined();
    expect(emailChange!.type).toBe('incompatible_type_change');
    expect(emailChange!.oldValue).toBe('string');
    expect(emailChange!.newValue).toBe('integer');
  });

  it('detects required_field_added', () => {
    const result = detectBreakingChanges(SCHEMA_V1, SCHEMA_V2_ADDED_REQUIRED);
    const phoneChange = result.breakingChanges.find(
      (c) => c.type === 'required_field_added' && c.path === '$.phoneNumber',
    );
    expect(phoneChange).toBeDefined();
    expect(phoneChange!.type).toBe('required_field_added');
    expect(phoneChange!.newValue).toBe('phoneNumber');
  });

  it('detects field_became_required', () => {
    // SCHEMA_V1 does not have avatar in properties, so we create a V1 variant
    // that has avatar as an optional property (present in properties, absent
    // from required). This lets detectBreakingChanges fire field_became_required
    // when comparing against SCHEMA_V2_FIELD_BECAME_REQUIRED where avatar is required.
    const v1WithOptionalAvatar: InferredSchema = {
      type: 'object',
      properties: {
        id: { type: 'integer', stats: DEFAULT_STATS },
        name: { type: 'string', stats: DEFAULT_STATS },
        email: { type: 'string', format: 'email', stats: DEFAULT_STATS },
        avatar: { type: 'string', format: 'uri', stats: DEFAULT_STATS },
      },
      required: ['email', 'id', 'name'], // avatar NOT required
      stats: DEFAULT_STATS,
    };
    const result = detectBreakingChanges(v1WithOptionalAvatar, SCHEMA_V2_FIELD_BECAME_REQUIRED);
    const avatarChange = result.breakingChanges.find(
      (c) => c.type === 'field_became_required' && c.path === '$.avatar',
    );
    expect(avatarChange).toBeDefined();
    expect(avatarChange!.type).toBe('field_became_required');
    expect(avatarChange!.oldValue).toBe('optional');
    expect(avatarChange!.newValue).toBe('required');
  });

  it('detects schema_type_changed (object → array)', () => {
    const result = detectBreakingChanges(SCHEMA_V1_OBJECT, SCHEMA_V2_TYPE_CHANGED_ROOT);
    const typeChange = result.breakingChanges.find((c) => c.type === 'schema_type_changed');
    expect(typeChange).toBeDefined();
    expect(typeChange!.type).toBe('schema_type_changed');
    expect(typeChange!.oldValue).toBe('object');
    expect(typeChange!.newValue).toBe('array');
  });

  it('does NOT flag integer → number as breaking (compatible widening)', () => {
    const result = detectBreakingChanges(SCHEMA_V1, SCHEMA_V2_INTEGER_TO_NUMBER);
    // No breaking change for the id field (integer -> number is widening)
    const idBreaking = result.breakingChanges.find((c) => c.path === '$.id');
    expect(idBreaking).toBeUndefined();
    // The widening should appear as a non-breaking change
    const idNonBreaking = result.nonBreakingChanges.find((msg) => msg.includes('$.id'));
    expect(idNonBreaking).toBeDefined();
  });

  it('DOES flag number → integer as breaking (fixes Flowplane bug)', () => {
    const result = detectBreakingChanges(SCHEMA_V1_NUMBER, SCHEMA_V2_NUMBER_TO_INTEGER);
    const priceChange = result.breakingChanges.find(
      (c) => c.type === 'incompatible_type_change' && c.path === '$.price',
    );
    expect(priceChange).toBeDefined();
    expect(priceChange!.oldValue).toBe('number');
    expect(priceChange!.newValue).toBe('integer');
  });

  it('detects nested field changes recursively', () => {
    const oldSchema: InferredSchema = {
      type: 'object',
      properties: {
        user: {
          type: 'object',
          properties: {
            profile: {
              type: 'object',
              properties: {
                age: { type: 'integer', stats: DEFAULT_STATS },
              },
              required: ['age'],
              stats: DEFAULT_STATS,
            },
          },
          required: ['profile'],
          stats: DEFAULT_STATS,
        },
      },
      required: ['user'],
      stats: DEFAULT_STATS,
    };
    const newSchema: InferredSchema = {
      type: 'object',
      properties: {
        user: {
          type: 'object',
          properties: {
            profile: {
              type: 'object',
              properties: {
                age: { type: 'string', stats: DEFAULT_STATS }, // incompatible: integer -> string
              },
              required: ['age'],
              stats: DEFAULT_STATS,
            },
          },
          required: ['profile'],
          stats: DEFAULT_STATS,
        },
      },
      required: ['user'],
      stats: DEFAULT_STATS,
    };
    const result = detectBreakingChanges(oldSchema, newSchema);
    const nestedChange = result.breakingChanges.find(
      (c) => c.type === 'incompatible_type_change' && c.path === '$.user.profile.age',
    );
    expect(nestedChange).toBeDefined();
    expect(nestedChange!.oldValue).toBe('integer');
    expect(nestedChange!.newValue).toBe('string');
  });

  it('new optional fields are reported as non-breaking', () => {
    const newSchemaWithExtraOptional: InferredSchema = {
      type: 'object',
      properties: {
        id: { type: 'integer', stats: DEFAULT_STATS },
        name: { type: 'string', stats: DEFAULT_STATS },
        email: { type: 'string', format: 'email', stats: DEFAULT_STATS },
        nickname: { type: 'string', stats: DEFAULT_STATS }, // new optional field
      },
      required: ['email', 'id', 'name'], // nickname is NOT required
      stats: DEFAULT_STATS,
    };
    const result = detectBreakingChanges(SCHEMA_V1, newSchemaWithExtraOptional);
    expect(result.breakingChanges).toHaveLength(0);
    const nicknameNonBreaking = result.nonBreakingChanges.find((msg) =>
      msg.includes('$.nickname'),
    );
    expect(nicknameNonBreaking).toBeDefined();
  });

  it('new endpoints are non-breaking at the schema level — identical schemas produce empty diff', () => {
    // detectBreakingChanges operates at the schema level, not the endpoint level.
    // New endpoints would be detected during aggregation by comparing endpoint sets
    // across sessions. At the schema level, comparing identical schemas must produce
    // zero breaking and zero non-breaking changes.
    const result = detectBreakingChanges(SCHEMA_V1, SCHEMA_V1);
    expect(result.breakingChanges).toHaveLength(0);
    expect(result.nonBreakingChanges).toHaveLength(0);
  });

  it('removed endpoints are handled at the CLI level — detectBreakingChanges on same schema is a no-op', () => {
    // detectBreakingChanges works per-schema-node, not across endpoint maps.
    // Removed endpoints are caught by the aggregation pipeline comparing old and
    // new endpoint sets. At the schema level, comparing two identical schemas
    // returns an empty diff.
    const result = detectBreakingChanges(SCHEMA_V1_OBJECT, SCHEMA_V1_OBJECT);
    expect(result.breakingChanges).toHaveLength(0);
    expect(result.nonBreakingChanges).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Type compatibility helper functions (pure logic, no src/ dependency)
// These encode the documented rules from PLAN.md section 7.3
// ---------------------------------------------------------------------------

function isWideningTypeChange(oldType: string, newType: string): boolean {
  // integer → number is the only widening pair per spec
  return oldType === 'integer' && newType === 'number';
}

function isNarrowingTypeChange(oldType: string, newType: string): boolean {
  // number → integer is narrowing (breaking)
  return oldType === 'number' && newType === 'integer';
}

function isIncompatibleTypeChange(oldType: string, newType: string): boolean {
  if (oldType === newType) return false;
  if (isWideningTypeChange(oldType, newType)) return false;
  return true;
}
