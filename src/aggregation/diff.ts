/**
 * Breaking change detection between two InferredSchema versions.
 *
 * Five breaking change types (ported from Flowplane's schema_diff.rs):
 *   - required_field_removed: Field in old required array, absent from new properties
 *   - incompatible_type_change: Field type changed to incompatible type
 *   - required_field_added: New field in new required array, absent from old properties
 *   - field_became_required: Field existed as optional, now in required array
 *   - schema_type_changed: Root schema type changed (e.g., object->array)
 *
 * Type compatibility (fixes Flowplane bug):
 *   - integer -> number: COMPATIBLE (widening — integer is subset of number)
 *   - number -> integer: BREAKING (narrowing — rejects values like 3.14)
 *   - X -> oneOf[..., X, ...]: COMPATIBLE (widening includes original)
 *   - All other type changes: INCOMPATIBLE
 */

import type { InferredSchema, SchemaDiff, BreakingChange, SchemaType } from '../types/index.js';

/**
 * Check if a type change is compatible (non-breaking).
 *
 * Compatible cases:
 *   - Same type (trivially compatible)
 *   - integer -> number (widening)
 */
function isTypeCompatible(oldType: SchemaType, newType: SchemaType): boolean {
  if (oldType === newType) return true;
  // integer -> number is widening (compatible)
  if (oldType === 'integer' && newType === 'number') return true;
  // All other type changes are breaking
  return false;
}

/**
 * Check if a new oneOf schema is compatible with an old concrete type.
 * Compatible if the old type is among the new oneOf variants.
 */
function isCompatibleWithOneOf(oldType: SchemaType, newOneOf: InferredSchema[]): boolean {
  for (const variant of newOneOf) {
    if (variant.oneOf !== undefined) {
      if (isCompatibleWithOneOf(oldType, variant.oneOf)) return true;
    } else if (isTypeCompatible(oldType, variant.type)) {
      return true;
    }
  }
  return false;
}

/**
 * Determine if a type transition from old to new schema is compatible.
 * This accounts for oneOf expansion.
 */
function isSchemaTypeCompatible(oldSchema: InferredSchema, newSchema: InferredSchema): boolean {
  const oldIsOneOf = oldSchema.oneOf !== undefined;
  const newIsOneOf = newSchema.oneOf !== undefined;

  if (!oldIsOneOf && !newIsOneOf) {
    // Both concrete — check direct type compatibility
    return isTypeCompatible(oldSchema.type, newSchema.type);
  }

  if (!oldIsOneOf && newIsOneOf) {
    // Old is concrete, new is oneOf — compatible if old type is in new oneOf
    return isCompatibleWithOneOf(oldSchema.type, newSchema.oneOf!);
  }

  if (oldIsOneOf && !newIsOneOf) {
    // Old is oneOf, new is concrete — generally breaking (narrowing from union to single)
    // But if new type is compatible with ALL old variants, it could be ok.
    // By convention: oneOf -> concrete is breaking (removes flexibility)
    return false;
  }

  // Both are oneOf — not handled here; treat as compatible if no type changes
  return true;
}

/**
 * Recursively detect breaking changes between old and new schemas.
 *
 * @param oldSchema - Previous schema version
 * @param newSchema - New schema version
 * @param jsonPath - Current JSON path for error messages (e.g., "$.user.email")
 * @returns SchemaDiff with breaking and non-breaking changes
 */
export function detectBreakingChanges(
  oldSchema: InferredSchema,
  newSchema: InferredSchema,
  jsonPath: string = '$',
): SchemaDiff {
  const breakingChanges: BreakingChange[] = [];
  const nonBreakingChanges: string[] = [];

  // Check for root-level type change
  const oldIsOneOf = oldSchema.oneOf !== undefined;
  const newIsOneOf = newSchema.oneOf !== undefined;

  if (!oldIsOneOf && !newIsOneOf) {
    // Both concrete types
    if (oldSchema.type !== newSchema.type) {
      if (!isSchemaTypeCompatible(oldSchema, newSchema)) {
        // For root schema type changes (object->array, etc.) use schema_type_changed
        // For field type changes that are incompatible, use incompatible_type_change
        const changeType =
          (oldSchema.type === 'object' || oldSchema.type === 'array') &&
          (newSchema.type === 'object' || newSchema.type === 'array')
            ? 'schema_type_changed'
            : 'incompatible_type_change';

        breakingChanges.push({
          type: changeType,
          path: jsonPath,
          description: `Type changed from '${oldSchema.type}' to '${newSchema.type}'`,
          oldValue: oldSchema.type,
          newValue: newSchema.type,
        });
        // If root type changed to incompatible type, we can't recurse into properties
        return { breakingChanges, nonBreakingChanges };
      }
      // Compatible type change (integer -> number) — non-breaking
      nonBreakingChanges.push(
        `${jsonPath}: type widened from '${oldSchema.type}' to '${newSchema.type}'`,
      );
    }
  } else if (!oldIsOneOf && newIsOneOf) {
    // Old was concrete, new is oneOf — check compatibility
    if (!isCompatibleWithOneOf(oldSchema.type, newSchema.oneOf!)) {
      breakingChanges.push({
        type: 'incompatible_type_change',
        path: jsonPath,
        description: `Type changed from '${oldSchema.type}' to a oneOf union that does not include '${oldSchema.type}'`,
        oldValue: oldSchema.type,
        newValue: 'oneOf',
      });
      return { breakingChanges, nonBreakingChanges };
    }
    // Compatible expansion to oneOf
    nonBreakingChanges.push(`${jsonPath}: type expanded to oneOf union`);
  } else if (oldIsOneOf && !newIsOneOf) {
    // Old was oneOf, new is concrete — breaking (narrowing)
    breakingChanges.push({
      type: 'incompatible_type_change',
      path: jsonPath,
      description: `Type narrowed from oneOf union to '${newSchema.type}'`,
      oldValue: 'oneOf',
      newValue: newSchema.type,
    });
    return { breakingChanges, nonBreakingChanges };
  }

  // Compare object properties if both are objects
  if (
    !oldIsOneOf &&
    !newIsOneOf &&
    oldSchema.type === 'object' &&
    newSchema.type === 'object'
  ) {
    const oldProps = oldSchema.properties ?? {};
    const newProps = newSchema.properties ?? {};
    const oldRequired = new Set(oldSchema.required ?? []);
    const newRequired = new Set(newSchema.required ?? []);

    // Check required fields from old that are removed in new
    for (const field of oldRequired) {
      if (!(field in newProps)) {
        breakingChanges.push({
          type: 'required_field_removed',
          path: `${jsonPath}.${field}`,
          description: `Required field '${field}' was removed`,
          oldValue: field,
        });
      }
    }

    // Check new required fields that didn't exist in old
    for (const field of newRequired) {
      if (!(field in oldProps)) {
        breakingChanges.push({
          type: 'required_field_added',
          path: `${jsonPath}.${field}`,
          description: `New required field '${field}' was added`,
          newValue: field,
        });
      }
    }

    // Check fields that became required (existed as optional before)
    for (const field of newRequired) {
      if (field in oldProps && !oldRequired.has(field)) {
        breakingChanges.push({
          type: 'field_became_required',
          path: `${jsonPath}.${field}`,
          description: `Field '${field}' changed from optional to required`,
          oldValue: 'optional',
          newValue: 'required',
        });
      }
    }

    // Check fields that became optional (were required before) — non-breaking
    for (const field of oldRequired) {
      if (field in newProps && !newRequired.has(field)) {
        nonBreakingChanges.push(
          `${jsonPath}.${field}: field changed from required to optional`,
        );
      }
    }

    // Check new optional fields — non-breaking
    for (const field of Object.keys(newProps)) {
      if (!(field in oldProps) && !newRequired.has(field)) {
        nonBreakingChanges.push(`${jsonPath}.${field}: new optional field added`);
      }
    }

    // Check removed optional fields — non-breaking
    for (const field of Object.keys(oldProps)) {
      if (!(field in newProps) && !oldRequired.has(field)) {
        nonBreakingChanges.push(`${jsonPath}.${field}: optional field removed`);
      }
    }

    // Recurse into common fields
    for (const field of Object.keys(oldProps)) {
      if (field in newProps) {
        const fieldPath = `${jsonPath}.${field}`;
        const nested = detectBreakingChanges(oldProps[field], newProps[field], fieldPath);
        breakingChanges.push(...nested.breakingChanges);
        nonBreakingChanges.push(...nested.nonBreakingChanges);
      }
    }
  }

  // Recurse into array items
  if (
    !oldIsOneOf &&
    !newIsOneOf &&
    oldSchema.type === 'array' &&
    newSchema.type === 'array' &&
    oldSchema.items !== undefined &&
    newSchema.items !== undefined
  ) {
    const itemsPath = `${jsonPath}[]`;
    const nested = detectBreakingChanges(oldSchema.items, newSchema.items, itemsPath);
    breakingChanges.push(...nested.breakingChanges);
    nonBreakingChanges.push(...nested.nonBreakingChanges);
  }

  return { breakingChanges, nonBreakingChanges };
}
