/** Implementation-blind contract tests: only public types and existing integration tests were read. */
import { describe, expect, it } from 'vitest';
import { Ajv } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { AggregatedSchema, InferredSchema } from '../../src/types/index.js';
import { discoverDomainModels } from '../../src/export/domain-models.js';
import { buildOpenApiDocument, convertToOpenApi30 } from '../../src/export/openapi.js';

type Schema = Record<string, any>;
interface Document {
  openapi: string;
  components: { schemas: Record<string, Schema> };
  paths: Record<string, Record<string, any>>;
}
const stats = { sampleCount: 40, presenceCount: 40, confidence: 1 };
function endpoint(path: string, schema: InferredSchema, method = 'GET'): AggregatedSchema {
  return {
    id: 1,
    sessionId: 'owned-synthetic-contract',
    httpMethod: method,
    path,
    version: 1,
    snapshot: 1,
    sampleCount: 40,
    confidenceScore: 1,
    firstObserved: '2026-01-01T00:00:00.000Z',
    lastObserved: '2026-01-01T00:00:00.000Z',
    ...(method === 'GET' ? { responseSchemas: { '200': schema } } : { requestSchema: schema }),
  };
}
function record(required: string[], values?: string[], format?: 'uuid'): InferredSchema {
  return {
    type: 'object',
    stats: { ...stats },
    required,
    properties: {
      id: { type: 'integer', format: 'int32', stats: { ...stats } },
      label: { type: 'string', stats: { ...stats }, ...(format ? { format } : {}) },
      state: { type: 'string', stats: { ...stats }, ...(values ? { enum: values } : {}) },
    },
  };
}
function document(schemas: AggregatedSchema[], version: '3.1' | '3.0') {
  const before = JSON.stringify(schemas);
  const registry = discoverDomainModels(schemas);
  expect(JSON.stringify(schemas), 'discovery cannot mutate schemas').toBe(before);
  const registryBefore = JSON.stringify(registry);
  const raw = buildOpenApiDocument(schemas, {}, undefined, registry);
  expect(JSON.stringify(schemas), 'export cannot mutate schemas').toBe(before);
  expect(JSON.stringify(registry), 'export cannot mutate registry').toBe(registryBefore);
  const rawBefore = JSON.stringify(raw);
  const doc = (version === '3.0' ? convertToOpenApi30(raw) : raw) as unknown as Document;
  expect(JSON.stringify(raw), 'conversion cannot mutate original document').toBe(rawBefore);
  expect(doc.openapi).toBe(version === '3.1' ? '3.1.0' : '3.0.3');
  return { doc, registry };
}
function response(doc: Document, path: string): Schema {
  return doc.paths[path].get.responses['200'].content['application/json'].schema;
}
function validator(doc: Document, schema: Schema) {
  const ajv = doc.openapi === '3.1.0' ? new Ajv2020({ strict: false }) : new Ajv({ strict: false });
  ajv.addFormat('int32', {
    type: 'number',
    validate: (n: number) => Number.isInteger(n) && n >= -(2 ** 31) && n < 2 ** 31,
  });
  ajv.addFormat('uuid', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  return ajv.compile({ ...schema, components: doc.components });
}
const complete = ['id', 'label', 'state'];
const valid = { id: 7, label: 'plain', state: 'open' };
function pair(label: string, schema: InferredSchema) {
  return [
    endpoint(`/${label}/records`, structuredClone(schema)),
    endpoint(`/${label}/records/{recordId}`, structuredClone(schema)),
  ];
}

describe.each(['3.1', '3.0'] as const)('model contract identity OAS %s', (version) => {
  it.each([
    {
      label: 'requiredness',
      left: record(complete),
      right: record(['id', 'state']),
      witness: { id: 7, state: 'open' },
      leftAccepts: false,
      rightAccepts: true,
    },
    {
      label: 'enum',
      left: record(complete, ['open', 'closed']),
      right: record(complete, ['pending', 'closed']),
      witness: { ...valid, state: 'pending' },
      leftAccepts: false,
      rightAccepts: true,
    },
    {
      label: 'format',
      left: record(complete, undefined, 'uuid'),
      right: record(complete),
      witness: valid,
      leftAccepts: false,
      rightAccepts: true,
    },
  ])(
    'preserves incompatible $label under same-shape/name-colliding usages in both input orders',
    ({ label, left, right, witness, leftAccepts, rightAccepts }) => {
      const schemas = [...pair('alpha', left), ...pair('beta', right)];
      const refsByOrder: string[][] = [];
      for (const ordered of [schemas, [...schemas].reverse()]) {
        const { doc } = document(ordered, version);
        const refs: string[] = [];
        for (const [group, expected] of [
          ['alpha', leftAccepts],
          ['beta', rightAccepts],
        ] as const) {
          const root = response(doc, `/${group}/records`);
          const validate = validator(doc, root);
          // Format-valid/enum-intersection positive control fits both contracts.
          const common = { id: 7, label: '123e4567-e89b-12d3-a456-426614174000', state: 'closed' };
          expect(validate(common), `${label}/${group} valid control`).toBe(true);
          expect(validate({ ...common, id: 'wrong' }), `${label}/${group} wrong type`).toBe(false);
          expect(validate({ ...common, id: 2 ** 31 }), `${label}/${group} int32 range`).toBe(false);
          expect
            .soft(validate(witness), `${label}/${group} preserves distinct accepted values`)
            .toBe(expected);
          expect(root.$ref, 'two identical locations should promote').toBeTypeOf('string');
          expect(response(doc, `/${group}/records/{recordId}`).$ref).toBe(root.$ref);
          refs.push(root.$ref);
        }
        expect
          .soft(refs[0], 'incompatible contracts cannot share a representative')
          .not.toBe(refs[1]);
        refsByOrder.push(refs);
      }
      expect(refsByOrder[1], 'contract-to-name mapping is stable under reversal').toEqual(
        refsByOrder[0],
      );
    },
  );

  it('shares equivalent constraints despite property, required and enum ordering', () => {
    const first = record(complete, ['open', 'closed']);
    const second = record([...complete].reverse(), ['closed', 'open']);
    second.properties = Object.fromEntries(Object.entries(second.properties!).reverse());
    const schemas = [endpoint('/first/records', first), endpoint('/second/records', second)];
    const signatures = [];
    for (const ordered of [schemas, [...schemas].reverse()]) {
      const { doc, registry } = document(ordered, version);
      const a = response(doc, '/first/records');
      expect(a.$ref).toBeTypeOf('string');
      expect(response(doc, '/second/records').$ref).toBe(a.$ref);
      const validate = validator(doc, a);
      expect(validate(valid)).toBe(true);
      expect(validate({ ...valid, state: 'pending' })).toBe(false);
      expect(validate({ id: 7, state: 'open' })).toBe(false);
      signatures.push(
        registry.models
          .map(({ name, fingerprint }) => ({ name, fingerprint }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      );
    }
    expect(signatures[1]).toEqual(signatures[0]);
  });

  it('does not promote a one-location object just because it has many samples', () => {
    const { doc, registry } = document([endpoint('/single/records', record(complete))], version);
    expect(registry.models).toHaveLength(0);
    const validate = validator(doc, response(doc, '/single/records'));
    expect(validate(valid)).toBe(true);
    expect(validate({ ...valid, id: 'wrong' })).toBe(false);
  });

  it('keeps PATCH request fields optional without weakening required POST contracts', () => {
    const full = record(complete);
    const patch = structuredClone(full);
    patch.required = [];
    const schemas = [
      endpoint('/records', full, 'POST'),
      endpoint('/records/{recordId}', patch, 'PATCH'),
    ];
    const { doc } = document(schemas, version);
    const request = (path: string, method: string) =>
      doc.paths[path][method].requestBody.content['application/json'].schema;
    const post = validator(doc, request('/records', 'post'));
    const update = validator(doc, request('/records/{recordId}', 'patch'));
    expect(post(valid)).toBe(true);
    expect(post({})).toBe(false);
    expect(update({})).toBe(true);
    expect(update({ label: 'changed' })).toBe(true);
    expect(update({ id: 'wrong' })).toBe(false);
  });
});
