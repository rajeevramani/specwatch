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
  /**
   * True when the schema was found nested inside a parent object's properties
   * (e.g. `Order.user`) rather than as the top-level response/request body. The
   * name picker uses this to prefer usages where the schema *is* the body —
   * those are the canonical home of the entity.
   */
  isNested?: boolean;
  /**
   * For nested usages, the parent property name where this schema lives
   * (e.g. `tags` for the inner `{name, color}` shape inside `Pet.tags.items`).
   * The name picker prefers field-name-derived names over path-derived names
   * for nested-only schemas — gets `Tag` instead of suffix-collided `Pet2`.
   */
  fieldName?: string;
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
 * Detect whether a schema is a recognizable structural shape (error, list
 * wrapper, etc.) and return an appropriate name. Returns undefined when the
 * schema does not match any known shape — fall back to path-derived naming.
 *
 * This exists because path-based naming gave wrong results (e.g. naming a
 * `{error, message}` 404 response after a domain entity like "User"). Content
 * is the source of truth for what a shape *means*.
 */
function detectShapeKind(schema: InferredSchema): string | undefined {
  if (schema.type !== 'object' || schema.properties === undefined) return undefined;
  const keys = Object.keys(schema.properties);
  const keySet = new Set(keys);

  // Validation error: { error, details: array }
  if (
    keySet.has('error') &&
    keySet.has('details') &&
    schema.properties['details']?.type === 'array'
  ) {
    return 'ValidationError';
  }
  // Generic error response: { error, message } (with at most a couple extra fields)
  if (keySet.has('error') && keySet.has('message') && keys.length <= 4) {
    return 'ErrorResponse';
  }
  // Message-only error: { message }
  if (keys.length === 1 && keySet.has('message')) {
    return 'MessageResponse';
  }
  // Paginated list wrapper: { data: array, ...pagination } — pagination keys
  // are total/page/limit/hasMore/count/cursor/nextPage. We do not name it after
  // the inner entity because the wrapper itself is the shared shape, and the
  // items will be hoisted as their own domain model.
  const PAGINATION_KEYS = new Set([
    'total',
    'page',
    'limit',
    'hasMore',
    'has_more',
    'count',
    'cursor',
    'nextPage',
    'next_page',
    'pageSize',
    'page_size',
  ]);
  if (keySet.has('data') && schema.properties['data']?.type === 'array') {
    const otherKeys = keys.filter((k) => k !== 'data');
    if (otherKeys.length > 0 && otherKeys.every((k) => PAGINATION_KEYS.has(k))) {
      return 'ListResponse';
    }
  }

  return undefined;
}

/**
 * Choose the best model name from all usages.
 *
 * Strategy:
 *   1. Detect well-known shapes (error, list wrapper) by content — this prevents
 *      naming an error shape after a domain entity, which was the worst class of
 *      mislabel pre-fix.
 *   2. Restrict path-derived naming to successful (2xx) response usages so the
 *      name reflects what the shape *means in success*, not where its first
 *      error happened to be observed.
 *   3. Within the eligible usages, prefer single-resource GETs, then collection
 *      GETs, then any other usage.
 */
function chooseBestName(usages: DomainModelUsage[], schema: InferredSchema): string {
  // Content-based name override for well-known shapes
  const shapeKind = detectShapeKind(schema);
  if (shapeKind !== undefined) return shapeKind;

  // Path naming should reflect the success-path meaning of this shape.
  // Filter out 4xx/5xx response usages; if nothing remains, fall back to all usages
  // (e.g. for shapes that only ever appeared on error responses).
  const successUsages = usages.filter((u) => {
    if (u.role !== 'response') return true;
    if (u.statusCode === undefined) return true;
    return u.statusCode.startsWith('2');
  });
  let pool = successUsages.length > 0 ? successUsages : usages;

  // Prefer usages where this schema IS the body, not where it's embedded inside
  // a parent. /v1/users/{id} returning User is a stronger naming signal than
  // /v1/orders/{id} embedding `user: User`.
  const topLevelUsages = pool.filter((u) => u.isNested !== true);
  if (topLevelUsages.length > 0) {
    pool = topLevelUsages;
  } else {
    // Pure-nested shape: prefer the field name where it lives. Tag (from
    // `tags`), Address (from `address`), etc. — much better than colliding
    // with the parent schema name and getting `Pet2`.
    const fieldNames = new Set(pool.map((u) => u.fieldName).filter((f): f is string => !!f));
    if (fieldNames.size === 1) {
      const [field] = [...fieldNames];
      const fromField = singularizeFieldName(field);
      if (fromField !== undefined) return fromField;
    }
  }

  // Prefer single-resource GET (path ends with a parameter)
  const singleResource = pool.find(
    (u) => u.httpMethod === 'GET' && u.path.match(/\/\{[^}]+\}$/),
  );
  if (singleResource) return deriveModelName(singleResource.path);

  // Then collection GET
  const collection = pool.find((u) => u.httpMethod === 'GET' && u.isArrayItem);
  if (collection) return deriveModelName(collection.path);

  // Fall back to first usage in the pool
  return deriveModelName(pool[0].path);
}

/**
 * PascalCase + singularize a field name. Returns undefined if the field name
 * is too short or doesn't yield a meaningful identifier name.
 */
function singularizeFieldName(field: string): string | undefined {
  if (field.length < 2) return undefined;
  const pascal = field.charAt(0).toUpperCase() + field.slice(1);
  if (pascal.endsWith('ies') && pascal.length > 3) return pascal.slice(0, -3) + 'y';
  if (pascal.endsWith('ses') || pascal.endsWith('xes') || pascal.endsWith('zes')) {
    return pascal.slice(0, -2);
  }
  if (pascal.endsWith('s') && !pascal.endsWith('ss')) return pascal.slice(0, -1);
  return pascal;
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
    // Only consider object schemas with ≥2 properties as domain models. Tiny
    // shapes (≤1 property) and primitives are not meaningful candidates.
    if (schema.type !== 'object') return;
    if (schema.properties === undefined || Object.keys(schema.properties).length < 2) return;

    const fingerprint = computeSchemaFingerprint(schema);
    const existing = candidates.get(fingerprint);
    if (existing) {
      existing.usages.push(usage);
    } else {
      candidates.set(fingerprint, { schema, usages: [usage] });
    }
  }

  // Recursively walk a schema and call trackSchema on every object subtree we
  // encounter. This is what enables embedded entities (User inside Order.user,
  // User inside ListResponse.data[]) to be discovered and promoted to domain
  // models — without it, only top-level schemas qualify.
  //
  // The `depth` parameter tracks how far inside the parent body we are: depth 0
  // is the top-level body itself, depth ≥1 marks the schema as nested. The name
  // picker uses this to prefer top-level usages when choosing a model name.
  //
  // `fieldName` is the parent property name at the nesting site, used by the
  // name picker for nested-only shapes (e.g. tag-inner-object → `Tag`).
  function walkAndTrack(
    schema: InferredSchema,
    usage: DomainModelUsage,
    depth: number,
    fieldName?: string,
  ): void {
    if (schema.type === 'object' && schema.properties !== undefined) {
      const positionedUsage: DomainModelUsage =
        depth === 0 ? usage : { ...usage, isNested: true, fieldName };
      trackSchema(schema, positionedUsage);
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        walkAndTrack(propSchema, usage, depth + 1, key);
      }
      return;
    }
    if (schema.type === 'array' && schema.items !== undefined) {
      // Array items inherit the parent's usage but are flagged as array items —
      // the resolver uses this to decide whether to emit an array wrapper $ref.
      // Top-level arrays (depth 0) keep their items as still-top-level for
      // naming purposes. Field name flows through unchanged so a `tags` array
      // exposes its item shape as `Tag`.
      walkAndTrack(schema.items, { ...usage, isArrayItem: true }, depth, fieldName);
      return;
    }
    if (schema.oneOf !== undefined) {
      for (const variant of schema.oneOf) {
        walkAndTrack(variant, usage, depth, fieldName);
      }
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
      walkAndTrack(aggSchema.requestSchema, usage, 0);
    }

    // Track response schemas (per status code)
    if (aggSchema.responseSchemas !== undefined) {
      for (const [statusCode, responseSchema] of Object.entries(aggSchema.responseSchemas)) {
        // Skip status codes with no body (null sentinel for 204, 304, etc.)
        if (responseSchema === null) continue;

        const usage: DomainModelUsage = {
          httpMethod: aggSchema.httpMethod,
          path: aggSchema.path,
          role: 'response',
          statusCode,
          isArrayItem: false,
        };
        walkAndTrack(responseSchema, usage, 0);
      }
    }
  }

  // Only promote schemas that appear in 2+ distinct endpoints to domain models
  const usedNames = new Set<string>();

  for (const [fingerprint, { schema, usages }] of candidates) {
    // Count distinct endpoints (unique method+path combos)
    const distinctEndpoints = new Set(usages.map((u) => `${u.httpMethod} ${u.path}`));
    if (distinctEndpoints.size < 2) continue;

    let name = chooseBestName(usages, schema);

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
