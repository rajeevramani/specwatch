/** Implementation-blind SDK contract: only public types and the identity integration fixture were read. */
import { describe, expect, it } from 'vitest';
import { Ajv } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { AggregatedSchema, InferredSchema } from '../../src/types/index.js';
import { discoverDomainModels } from '../../src/export/domain-models.js';
import { buildOpenApiDocument, convertToOpenApi30 } from '../../src/export/openapi.js';

type Schema = Record<string, any>;
type Document = {
  openapi: string;
  components: { schemas: Record<string, Schema> };
  paths: Record<string, Record<string, any>>;
};
type Usage = {
  path: string;
  method?: 'GET' | 'POST';
  status?: string;
  array?: boolean;
  field?: string;
};
const stats = { sampleCount: 40, presenceCount: 40, confidence: 1 };
const required = ['id', 'label', 'state'];
const valid = { id: 7, label: 'synthetic', state: 'open' };
const permutations = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
];
function record(): InferredSchema {
  return {
    type: 'object',
    stats: { ...stats },
    required: [...required],
    properties: {
      id: { type: 'integer', stats: { ...stats } },
      label: { type: 'string', stats: { ...stats } },
      state: { type: 'string', enum: ['open', 'closed'], stats: { ...stats } },
    },
  };
}
function endpoint(usage: Usage, id: number): AggregatedSchema {
  let schema = record();
  if (usage.array) schema = { type: 'array', items: schema, stats: { ...stats } };
  if (usage.field)
    schema = {
      type: 'object',
      properties: { [usage.field]: schema },
      required: [usage.field],
      stats: { ...stats },
    };
  return {
    id,
    sessionId: 'owned-synthetic-naming-order',
    httpMethod: usage.method ?? 'GET',
    path: usage.path,
    version: 1,
    snapshot: 1,
    sampleCount: 40,
    confidenceScore: 1,
    firstObserved: '2026-01-01T00:00:00.000Z',
    lastObserved: '2026-01-01T00:00:00.000Z',
    ...(usage.method === 'POST'
      ? { requestSchema: schema }
      : {
          responseSchemas: { [usage.status ?? '200']: schema },
        }),
  };
}
function selectedSchema(doc: Document, usage: Usage): Schema {
  const operation = doc.paths[usage.path][(usage.method ?? 'GET').toLowerCase()];
  let schema =
    usage.method === 'POST'
      ? operation.requestBody.content['application/json'].schema
      : operation.responses[usage.status ?? '200'].content['application/json'].schema;
  // Resolve envelopes in their original document context before selecting a child.
  const resolve = (value: Schema): Schema => {
    while (value.$ref) value = pointer(doc, value.$ref) as Schema;
    return value;
  };
  if (usage.field) schema = resolve(schema).properties[usage.field];
  if (usage.array) schema = resolve(schema).items;
  return schema;
}
function pointer(root: unknown, ref: string): unknown {
  expect(ref, 'only local references are expected').toMatch(/^#\//);
  return ref
    .slice(2)
    .split('/')
    .reduce<unknown>((value, token) => {
      const key = token.replace(/~1/g, '/').replace(/~0/g, '~');
      expect(value, `reference parent for ${ref}`).toBeTypeOf('object');
      expect(value, `reference target for ${ref}`).toHaveProperty(key);
      return (value as Record<string, unknown>)[key];
    }, root);
}
function allRefsResolve(doc: Document): void {
  const walk = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if ('$ref' in value) pointer(doc, (value as Schema).$ref);
    for (const child of Object.values(value)) walk(child);
  };
  walk(doc);
}
function assertConstraints(doc: Document, root: Schema): void {
  const schema = root.$ref ? (pointer(doc, root.$ref) as Schema) : root;
  expect(schema.type).toBe('object');
  expect(new Set(schema.required)).toEqual(new Set(required));
  expect(schema.properties.id.type).toBe('integer');
  expect(schema.properties.label.type).toBe('string');
  expect(schema.properties.state.type).toBe('string');
  expect(new Set(schema.properties.state.enum)).toEqual(new Set(['open', 'closed']));
  const ajv = doc.openapi === '3.1.0' ? new Ajv2020({ strict: false }) : new Ajv({ strict: false });
  const validate = ajv.compile({ ...root, components: doc.components });
  for (const state of ['open', 'closed']) expect(validate({ ...valid, state })).toBe(true);
  expect(validate({ ...valid, state: 'pending' }), 'enum remains closed').toBe(false);
  for (const field of required) {
    const missing: Record<string, unknown> = { ...valid };
    delete missing[field];
    expect(validate(missing), `${field} remains required`).toBe(false);
  }
  for (const wrong of [{ id: '7' }, { id: 1.5 }, { label: 7 }, { state: 7 }]) {
    expect(validate({ ...valid, ...wrong }), 'wrong field types remain rejected').toBe(false);
  }
}
function exercise(usages: Usage[], order: number[], version: '3.1' | '3.0', expected: string) {
  // Preserve endpoint identities while permuting discovery order.
  const original = usages.map(endpoint);
  const schemas = order.map((index) => original[index]);
  const before = structuredClone(schemas);
  const registry = discoverDomainModels(schemas);
  expect(schemas, 'discovery does not mutate inputs').toEqual(before);
  const registryBefore = structuredClone(registry);
  const raw = buildOpenApiDocument(schemas, {}, undefined, registry);
  const rawBefore = structuredClone(raw);
  const doc = (version === '3.0' ? convertToOpenApi30(raw) : raw) as unknown as Document;
  expect(raw, 'conversion does not mutate OAS 3.1 input').toEqual(rawBefore);
  expect(schemas, 'export does not mutate inputs').toEqual(before);
  expect(registry, 'export/conversion does not mutate registry').toEqual(registryBefore);
  expect(doc.openapi).toBe(version === '3.1' ? '3.1.0' : '3.0.3');
  allRefsResolve(doc);
  const refs = usages.map((usage) => selectedSchema(doc, usage));
  for (const root of refs) {
    expect(root.$ref, 'repeated object is promoted').toBeTypeOf('string');
    assertConstraints(doc, root);
  }
  // Soft naming assertions let every independent semantic oracle execute on RED.
  const expectedRef = `#/components/schemas/${expected}`;
  for (const root of refs) expect.soft(root.$ref).toBe(expectedRef);
  const model = registry.models.find(
    ({ fingerprint }) =>
      fingerprint === registry.models.find(({ name }) => name === expected)?.fingerprint,
  );
  expect.soft(registry.models.map(({ name }) => name)).toContain(expected);
  if (model) {
    expect(model.openApiSchema).toEqual(doc.components.schemas[expected]);
    expect(model.fingerprint).toBeTypeOf('string');
  }
  return {
    models: registry.models.map(({ name, fingerprint, openApiSchema }) => ({
      name,
      fingerprint,
      openApiSchema,
    })),
    refs: refs.map((root) => root.$ref),
  };
}

const tierCases: { label: string; usages: Usage[]; expected: string }[] = [
  {
    label: 'success response beats lexically earlier failed response',
    expected: 'Zebra',
    usages: [
      { path: '/alpha/{id}', status: '400' },
      { path: '/zebra/{id}', status: '200' },
    ],
  },
  {
    label: 'top-level usage beats lexically earlier embedded usage',
    expected: 'Zebra',
    usages: [{ path: '/alpha/{id}', field: 'payload' }, { path: '/zebra/{id}' }],
  },
  {
    label: 'unique nested field name beats path naming',
    expected: 'Payload',
    usages: [
      { path: '/alpha/{id}', field: 'payload' },
      { path: '/zebra/{id}', field: 'payload' },
    ],
  },
  {
    label: 'single-resource GET beats lexically earlier collection GET',
    expected: 'Zebra',
    usages: [{ path: '/alpha', array: true }, { path: '/zebra/{id}' }],
  },
  {
    label: 'collection GET beats lexically earlier request fallback',
    expected: 'Zebra',
    usages: [
      { path: '/alpha', method: 'POST' },
      { path: '/zebra', array: true },
    ],
  },
];

describe.each(['3.1', '3.0'] as const)('deterministic promoted model naming OAS %s', (version) => {
  for (const kind of [
    'single-resource GET',
    'collection-array GET',
    'request POST fallback',
  ] as const) {
    it.each(permutations)(`${kind} chooses Alpha for input order %j/%j/%j`, (...order) => {
      const usages: Usage[] = ['alpha', 'beta', 'gamma'].map((name) => ({
        path: kind === 'single-resource GET' ? `/${name}/{id}` : `/${name}`,
        ...(kind === 'collection-array GET' ? { array: true } : {}),
        ...(kind === 'request POST fallback' ? { method: 'POST' as const } : {}),
      }));
      const canonical = exercise(usages, [0, 1, 2], version, 'Alpha');
      expect(
        exercise(usages, order, version, 'Alpha'),
        'names, fingerprints, schemas and refs are order invariant',
      ).toEqual(canonical);
    });
  }
  it.each(tierCases)('$label in both discovery orders', ({ usages, expected }) => {
    const forward = exercise(usages, [0, 1], version, expected);
    expect(exercise(usages, [1, 0], version, expected)).toEqual(forward);
  });
});
