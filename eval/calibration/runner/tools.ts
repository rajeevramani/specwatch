/**
 * OpenAPI -> function-calling tool conversion (specwatch-ajn).
 *
 * Converts a parsed OpenAPI 3.x spec into ONE function-calling tool per
 * operation. The mapping is intentionally 1:1 so that ablating the spec *is*
 * ablating the tools — clean attribution (calibration design §5, agent surface).
 *
 * Each emitted tool carries:
 *   - `name`     : a stable, Anthropic-compatible identifier derived from the
 *                  operation's `operationId` when present (sanitised), else
 *                  synthesised from method + path. Degraded operationIds (the
 *                  `bad-operationids` variant drops/mangles them) therefore flow
 *                  straight through to degraded tool names — by design.
 *   - `description`: taken STRAIGHT FROM THE SPEC (summary + description). When
 *                  the spec strips descriptions (`no-descriptions` variant) the
 *                  tool description degrades with it — also by design.
 *   - `input_schema`: a JSON Schema object whose properties are the operation's
 *                  path/query/header parameters plus the request-body fields,
 *                  with `$ref`s resolved against `components`.
 *   - `_http`    : private routing metadata (method, pathTemplate, param
 *                  locations) the runner uses to turn a tool call into an HTTP
 *                  request. Stripped before the tool list is sent to the model.
 *
 * No network, no model, no backend here — pure spec -> tools transformation,
 * so it is trivially unit-testable.
 */

const HTTP_VERBS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace'] as const;
export type HttpVerb = (typeof HTTP_VERBS)[number];

/** Where a tool parameter is carried on the wire. */
export type ParamLocation = 'path' | 'query' | 'header' | 'body';

/** Private routing metadata attached to each tool (not sent to the model). */
export interface HttpBinding {
  method: string;
  /** Path template with `{name}` placeholders, e.g. `/orders/{orderId}`. */
  pathTemplate: string;
  /** property-name -> wire location, for path/query/header params. */
  paramLocations: Record<string, ParamLocation>;
  /** Property names that came from the request body (sent as the JSON body). */
  bodyProps: string[];
}

/** A function-calling tool, Anthropic Messages `tools[]` shape, plus binding. */
export interface AgentTool {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: false;
  };
  /** Routing metadata — strip via {@link toWireTools} before sending to the model. */
  _http: HttpBinding;
}

/** Resolve a single `$ref` (only local `#/components/...` refs are supported). */
function resolveRef(spec: any, ref: string): any {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return undefined;
  const parts = ref.slice(2).split('/');
  let node: any = spec;
  for (const part of parts) {
    if (node == null) return undefined;
    // JSON-pointer unescape.
    node = node[part.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  return node;
}

/**
 * Deep-resolve `$ref`s within a schema so the emitted tool schema is
 * self-contained (function-calling has no `$ref` mechanism). Cycles are guarded
 * by a visited set keyed on ref string; a cyclic ref collapses to `{}`.
 */
function resolveSchema(spec: any, schema: any, seen: Set<string> = new Set()): any {
  if (!schema || typeof schema !== 'object') return schema;
  if (typeof schema.$ref === 'string') {
    if (seen.has(schema.$ref)) return {};
    const next = new Set(seen);
    next.add(schema.$ref);
    return resolveSchema(spec, resolveRef(spec, schema.$ref), next);
  }
  if (Array.isArray(schema)) return schema.map((s) => resolveSchema(spec, s, seen));

  const out: any = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'example' || key === 'examples') continue; // not part of the call contract
    out[key] = resolveSchema(spec, value, seen);
  }
  // Flatten a lone `allOf: [X]` wrapper (used by the gold spec for OrderStatus)
  // so the parameter schema is directly usable.
  if (Array.isArray(out.allOf) && out.allOf.length === 1 && typeof out.allOf[0] === 'object') {
    const merged = { ...out.allOf[0], ...out };
    delete merged.allOf;
    return merged;
  }
  return out;
}

/**
 * Sanitise an operationId / fallback into an Anthropic tool name:
 * `^[a-zA-Z0-9_-]{1,64}$`. Non-conforming chars become `_`.
 */
function sanitizeToolName(raw: string): string {
  let name = raw.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (name.length === 0) name = 'op';
  return name.slice(0, 64);
}

/** Synthesise a tool name from method + path when no operationId is present. */
function synthName(method: string, path: string): string {
  const segs = path
    .split('/')
    .filter(Boolean)
    .map((s) => s.replace(/[{}]/g, ''));
  return sanitizeToolName([method.toLowerCase(), ...segs].join('_'));
}

/** Build the human-facing tool description straight from the spec operation. */
function buildDescription(op: any, method: string, path: string): string {
  const parts: string[] = [];
  if (typeof op.summary === 'string' && op.summary.trim()) parts.push(op.summary.trim());
  if (typeof op.description === 'string' && op.description.trim()) parts.push(op.description.trim());
  const text = parts.join('\n\n').trim();
  // Always anchor with the HTTP route so a description-stripped variant still
  // identifies *which* endpoint the tool hits (the route is structural, not a
  // "description" — stripping descriptions must not make tools unidentifiable
  // by route, only by prose).
  return text ? `${text}\n\n(${method.toUpperCase()} ${path})` : `${method.toUpperCase()} ${path}`;
}

/** Convert one operation into an AgentTool. */
function operationToTool(spec: any, path: string, method: string, op: any): AgentTool {
  const name =
    typeof op.operationId === 'string' && op.operationId.trim()
      ? sanitizeToolName(op.operationId.trim())
      : synthName(method, path);

  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  const paramLocations: Record<string, ParamLocation> = {};
  const bodyProps: string[] = [];

  // Path / query / header parameters.
  for (const rawParam of op.parameters ?? []) {
    const param = rawParam?.$ref ? resolveRef(spec, rawParam.$ref) : rawParam;
    if (!param || typeof param.name !== 'string') continue;
    const loc = param.in as ParamLocation;
    if (loc !== 'path' && loc !== 'query' && loc !== 'header') continue;
    const schema = resolveSchema(spec, param.schema ?? { type: 'string' });
    if (typeof param.description === 'string' && param.description.trim() && !schema.description) {
      schema.description = param.description.trim();
    }
    properties[param.name] = schema;
    paramLocations[param.name] = loc;
    if (param.required || loc === 'path') required.push(param.name);
  }

  // Request body (application/json only — the only media type the backend uses).
  const bodySchemaRaw = op.requestBody?.content?.['application/json']?.schema;
  if (bodySchemaRaw) {
    const bodySchema = resolveSchema(spec, bodySchemaRaw);
    if (bodySchema && bodySchema.type === 'object' && bodySchema.properties) {
      for (const [propName, propSchema] of Object.entries<any>(bodySchema.properties)) {
        properties[propName] = propSchema;
        paramLocations[propName] = 'body';
        bodyProps.push(propName);
      }
      for (const req of bodySchema.required ?? []) {
        if (!required.includes(req)) required.push(req);
      }
    }
  }

  return {
    name,
    description: buildDescription(op, method, path),
    input_schema: {
      type: 'object',
      properties,
      required,
      additionalProperties: false,
    },
    _http: { method: method.toUpperCase(), pathTemplate: path, paramLocations, bodyProps },
  };
}

/**
 * Convert a parsed OpenAPI spec into one tool per operation.
 *
 * Tool-name collisions (which the `bad-operationids` variant deliberately
 * induces by mangling several ops to the same id) are disambiguated with a
 * numeric suffix so the resulting tool list is always valid for the API — the
 * *degradation* (non-descriptive, duplicated names) is preserved, but the list
 * stays sendable.
 */
export function specToTools(spec: any): AgentTool[] {
  const tools: AgentTool[] = [];
  const usedNames = new Map<string, number>();

  for (const [path, item] of Object.entries<any>(spec.paths ?? {})) {
    if (!item || typeof item !== 'object') continue;
    for (const verb of HTTP_VERBS) {
      const op = item[verb];
      if (!op || typeof op !== 'object') continue;
      const tool = operationToTool(spec, path, verb, op);
      // Disambiguate duplicate names while preserving the degraded base name.
      const seen = usedNames.get(tool.name);
      if (seen === undefined) {
        usedNames.set(tool.name, 0);
      } else {
        const next = seen + 1;
        usedNames.set(tool.name, next);
        tool.name = sanitizeToolName(`${tool.name}_${next}`);
      }
      tools.push(tool);
    }
  }
  return tools;
}

/** Strip private `_http` metadata, yielding the exact shape sent to the model. */
export function toWireTools(tools: AgentTool[]): Array<{
  name: string;
  description: string;
  input_schema: AgentTool['input_schema'];
}> {
  return tools.map(({ name, description, input_schema }) => ({ name, description, input_schema }));
}
