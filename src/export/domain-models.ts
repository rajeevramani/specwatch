/**
 * Domain model discovery for OpenAPI export.
 *
 * Analyzes aggregated schemas across endpoints to find structurally identical
 * schemas that represent shared domain models (e.g., "User", "Account").
 * These become shared `$ref` entries in `components/schemas` instead of
 * duplicated per-operation schemas.
 */

import type { AggregatedSchema, InferredSchema } from '../types/index.js';
import { computeSchemaFingerprint } from '../aggregation/pipeline.js';
import { convertSchemaToOpenApi } from './openapi.js';

// ============================================================
// Types
// ============================================================

/** A usage site where a domain model was found */
export interface DomainModelUsage {
  /** HTTP method of the endpoint */
  httpMethod: string;
  /** Template path of the endpoint */
  path: string;
  /** Whether the schema was found as request or response */
  role: 'request' | 'response';
  /** HTTP status code (only for responses) */
  statusCode?: string;
  /** Whether the schema appeared as array items (the endpoint returns an array of this model) */
  isArrayItem: boolean;
}

/** A discovered domain model — a schema shared across multiple endpoints */
export interface DomainModel {
  /** PascalCase name derived from usage context (e.g., "User", "Account") */
  name: string;
  /** The canonical InferredSchema for this model */
  schema: InferredSchema;
  /** Converted OpenAPI schema object */
  openApiSchema: Record<string, unknown>;
  /** Structural fingerprint (for identity comparisons) */
  fingerprint: string;
  /** All endpoint locations where this model appears */
  usages: DomainModelUsage[];
}

/** Result of resolving a schema against the registry */
export interface DomainModelMatch {
  /** The matched domain model */
  model: DomainModel;
  /** Whether the match was on the schema directly or on array items */
  isArrayItem: boolean;
}

// ============================================================
// Name Derivation
// ============================================================

/**
 * Derive a domain model name from path context.
 *
 * Strategy: use the last meaningful (non-parameter) path segment, singularized.
 * Examples:
 *   /users/{userId}     -> "User"
 *   /accounts/{id}      -> "Account"
 *   /users              -> "User"
 *   /api/v1/orders      -> "Order"
 *   /products/{id}/reviews -> "Review"
 */
function deriveModelName(path: string): string {
  const segments = path
    .split('/')
    .filter((s) => s.length > 0)
    .filter((s) => !s.startsWith('{'));

  if (segments.length === 0) return 'Model';

  // Use the last non-parameter segment
  const lastSegment = segments[segments.length - 1];
  const pascalCase = lastSegment.charAt(0).toUpperCase() + lastSegment.slice(1);

  // Simple singularization: strip trailing 's' if present (covers most REST APIs)
  if (pascalCase.endsWith('ies')) {
    return pascalCase.slice(0, -3) + 'y';
  }
  if (pascalCase.endsWith('ses') || pascalCase.endsWith('xes') || pascalCase.endsWith('zes')) {
    return pascalCase.slice(0, -2);
  }
  if (pascalCase.endsWith('s') && !pascalCase.endsWith('ss')) {
    return pascalCase.slice(0, -1);
  }

  return pascalCase;
}

/**
 * Choose the best model name from all usages. Prefer names from:
 * 1. Single-resource GET endpoints (GET /users/{id} → "User")
 * 2. Collection endpoints (GET /users → "User")
 * 3. Any other usage
 */
function chooseBestName(usages: DomainModelUsage[]): string {
  // Prefer single-resource GET (path ends with a parameter)
  const singleResource = usages.find(
    (u) => u.httpMethod === 'GET' && u.path.match(/\/\{[^}]+\}$/),
  );
  if (singleResource) return deriveModelName(singleResource.path);

  // Then collection GET
  const collection = usages.find(
    (u) => u.httpMethod === 'GET' && u.isArrayItem,
  );
  if (collection) return deriveModelName(collection.path);

  // Fall back to first usage
  return deriveModelName(usages[0].path);
}

// ============================================================
// Domain Model Registry
// ============================================================

export class DomainModelRegistry {
  /** All discovered domain models, keyed by fingerprint */
  private readonly _models: Map<string, DomainModel> = new Map();

  get models(): DomainModel[] {
    return Array.from(this._models.values());
  }

  /** Look up a domain model by its structural fingerprint */
  getByFingerprint(fingerprint: string): DomainModel | undefined {
    return this._models.get(fingerprint);
  }

  /**
   * Resolve an InferredSchema to a domain model match.
   *
   * Checks for:
   * 1. Direct match: the schema itself matches a domain model
   * 2. Array-of match: the schema is an array whose items match a domain model
   *
   * Returns undefined if no match.
   */
  resolve(schema: InferredSchema): DomainModelMatch | undefined {
    const fingerprint = computeSchemaFingerprint(schema);

    // Direct match
    const directModel = this._models.get(fingerprint);
    if (directModel) {
      return { model: directModel, isArrayItem: false };
    }

    // Array-of match: check if this is an array whose items match a model
    if (schema.type === 'array' && schema.items !== undefined) {
      const itemFingerprint = computeSchemaFingerprint(schema.items);
      const itemModel = this._models.get(itemFingerprint);
      if (itemModel) {
        return { model: itemModel, isArrayItem: true };
      }
    }

    return undefined;
  }

  /** Register a model (internal, used during discovery) */
  _register(model: DomainModel): void {
    this._models.set(model.fingerprint, model);
  }
}

// ============================================================
// Discovery
// ============================================================

/**
 * Discover domain models from aggregated schemas.
 *
 * A schema qualifies as a domain model when it is an object schema that appears
 * (structurally identical) across 2+ different endpoints. Array-of-object responses
 * also contribute — the item schema is compared.
 *
 * @param schemas - All aggregated schemas to analyze
 * @returns A registry of discovered domain models
 */
export function discoverDomainModels(schemas: AggregatedSchema[]): DomainModelRegistry {
  const registry = new DomainModelRegistry();

  // Accumulate: fingerprint → { schema, usages[] }
  const candidates: Map<
    string,
    { schema: InferredSchema; usages: DomainModelUsage[] }
  > = new Map();

  function trackSchema(
    schema: InferredSchema,
    usage: DomainModelUsage,
  ): void {
    // Only consider object schemas as domain models
    if (schema.type !== 'object') return;
    // Must have properties to be meaningful
    if (schema.properties === undefined || Object.keys(schema.properties).length < 2) return;

    const fingerprint = computeSchemaFingerprint(schema);
    const existing = candidates.get(fingerprint);
    if (existing) {
      existing.usages.push(usage);
    } else {
      candidates.set(fingerprint, { schema, usages: [usage] });
    }
  }

  for (const aggSchema of schemas) {
    // Track request schemas
    if (aggSchema.requestSchema !== undefined) {
      const usage: DomainModelUsage = {
        httpMethod: aggSchema.httpMethod,
        path: aggSchema.path,
        role: 'request',
        isArrayItem: false,
      };

      if (aggSchema.requestSchema.type === 'array' && aggSchema.requestSchema.items !== undefined) {
        trackSchema(aggSchema.requestSchema.items, { ...usage, isArrayItem: true });
      } else {
        trackSchema(aggSchema.requestSchema, usage);
      }
    }

    // Track response schemas (per status code)
    if (aggSchema.responseSchemas !== undefined) {
      for (const [statusCode, responseSchema] of Object.entries(aggSchema.responseSchemas)) {
        const usage: DomainModelUsage = {
          httpMethod: aggSchema.httpMethod,
          path: aggSchema.path,
          role: 'response',
          statusCode,
          isArrayItem: false,
        };

        if (responseSchema.type === 'array' && responseSchema.items !== undefined) {
          trackSchema(responseSchema.items, { ...usage, isArrayItem: true });
        } else {
          trackSchema(responseSchema, usage);
        }
      }
    }
  }

  // Only promote schemas that appear in 2+ distinct endpoints to domain models
  const usedNames = new Set<string>();

  for (const [fingerprint, { schema, usages }] of candidates) {
    // Count distinct endpoints (unique method+path combos)
    const distinctEndpoints = new Set(usages.map((u) => `${u.httpMethod} ${u.path}`));
    if (distinctEndpoints.size < 2) continue;

    let name = chooseBestName(usages);

    // Handle name collisions
    if (usedNames.has(name)) {
      let suffix = 2;
      while (usedNames.has(`${name}${suffix}`)) {
        suffix++;
      }
      name = `${name}${suffix}`;
    }
    usedNames.add(name);

    registry._register({
      name,
      schema,
      openApiSchema: convertSchemaToOpenApi(schema),
      fingerprint,
      usages,
    });
  }

  return registry;
}
