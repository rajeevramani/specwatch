/** Implementation-blind nested graph contracts; no production implementation was read. */
import { describe, expect, it } from 'vitest';
import { Ajv } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { AggregatedSchema, InferredSchema } from '../../src/types/index.js';
import { inferSchema } from '../../src/inference/engine.js';
import { getDatabase } from '../../src/storage/database.js';
import { SessionRepository } from '../../src/storage/sessions.js';
import { SampleRepository } from '../../src/storage/samples.js';
import { runAggregation } from '../../src/aggregation/pipeline.js';
import { discoverDomainModels } from '../../src/export/domain-models.js';
import { buildOpenApiDocument, convertToOpenApi30 } from '../../src/export/openapi.js';

type Schema = Record<string, any>;
interface Document {
  openapi: string;
  components: { schemas: Record<string, Schema> };
  paths: Record<string, Record<string, any>>;
}
const CHILD = { id: 17, name: 'fixture', active: true };
const BODY = { owner: CHILD, entries: [CHILD], nullable: CHILD, title: 'fixture' };
function endpoint(path: string, schema: InferredSchema, confidenceScore = 1): AggregatedSchema {
  return {
    id: 1,
    sessionId: 'owned-nested-contract',
    httpMethod: 'GET',
    path,
    version: 1,
    snapshot: 1,
    sampleCount: 40,
    confidenceScore,
    firstObserved: '2026-01-01T00:00:00.000Z',
    lastObserved: '2026-01-01T00:00:00.000Z',
    responseSchemas: { '200': schema },
  };
}
function fixtures(): AggregatedSchema[] {
  const db = getDatabase(':memory:');
  try {
    const sessions = new SessionRepository(db);
    const samples = new SampleRepository(db);
    const session = sessions.createSession('http://127.0.0.1:1', 1, 'owned-nested-contract');
    // No top-level child response: exporter must include transitive model closure.
    for (let index = 0; index < 40; index++) {
      for (const path of ['/teams', '/teams/{teamId}']) {
        samples.insertSample({
          sessionId: session.id,
          httpMethod: 'GET',
          path,
          normalizedPath: path,
          statusCode: 200,
          responseSchema: inferSchema({ ...BODY, nullable: index % 2 === 0 ? CHILD : null }),
          capturedAt: '2026-01-01T00:00:00.000Z',
        });
        sessions.incrementSampleCount(session.id);
      }
    }
    expect(samples.countBySession(session.id)).toBe(80);
    return runAggregation(db, session.id).schemas;
  } finally {
    db.close();
  }
}
function document(schemas: AggregatedSchema[], version: '3.1' | '3.0', minConfidence = 0) {
  const before = JSON.stringify(schemas);
  const registry = discoverDomainModels(schemas);
  expect(JSON.stringify(schemas), 'discovery must not mutate input').toBe(before);
  const registryBefore = JSON.stringify(registry);
  const raw = buildOpenApiDocument(schemas, { minConfidence }, undefined, registry);
  expect(JSON.stringify(schemas), 'export must not mutate input').toBe(before);
  expect(JSON.stringify(registry), 'export must not mutate registry').toBe(registryBefore);
  const original = JSON.stringify(raw);
  const doc = (version === '3.0' ? convertToOpenApi30(raw) : raw) as unknown as Document;
  expect(JSON.stringify(raw), 'conversion must not mutate input').toBe(original);
  expect(doc.openapi).toBe(version === '3.1' ? '3.1.0' : '3.0.3');
  return { doc, registry };
}
function response(doc: Document, path: string): Schema {
  return doc.paths[path].get.responses['200'].content['application/json'].schema;
}
function refs(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(refs);
  const object = value as Record<string, unknown>;
  return [
    ...(typeof object.$ref === 'string' ? [object.$ref] : []),
    ...Object.entries(object)
      .filter(([key]) => key !== '$ref')
      .flatMap(([, child]) => refs(child)),
  ];
}
function target(doc: Document, ref: string): Schema {
  expect(ref).toMatch(/^#\/components\/schemas\/[^/]+$/);
  const name = ref.slice('#/components/schemas/'.length).replace(/~1/g, '/').replace(/~0/g, '~');
  const schema = doc.components.schemas[name];
  expect(schema, `local reference must resolve: ${ref}`).toBeDefined();
  return schema;
}
function graphControls(doc: Document) {
  for (const ref of refs(doc)) target(doc, ref);
  for (const [name, schema] of Object.entries(doc.components.schemas)) {
    expect(schema.$ref, `${name} cannot degenerate to a root self-reference`).not.toBe(
      `#/components/schemas/${name.replace(/~/g, '~0').replace(/\//g, '~1')}`,
    );
  }
}
function validator(doc: Document, schema: Schema) {
  const ajv = doc.openapi === '3.1.0' ? new Ajv2020({ strict: false }) : new Ajv({ strict: false });
  ajv.addFormat('int32', {
    type: 'number',
    validate: (n: number) => Number.isInteger(n) && n >= -(2 ** 31) && n < 2 ** 31,
  });
  return ajv.compile({ ...schema, components: doc.components });
}
function parentModel(doc: Document) {
  const root = response(doc, '/teams');
  expect(root.$ref, 'repeated parent is promoted').toBeTypeOf('string');
  expect(response(doc, '/teams/{teamId}').$ref).toBe(root.$ref);
  return target(doc, root.$ref);
}

describe.each(['3.1', '3.0'] as const)('nested domain model graph OAS %s', (version) => {
  it('uses child refs inside promoted parent bodies, arrays and nullable wrappers with full closure', () => {
    const { doc, registry } = document(fixtures(), version);
    graphControls(doc);
    expect(
      registry.models.length,
      'both repeated parent and child are discoverable',
    ).toBeGreaterThanOrEqual(2);
    const parent = parentModel(doc);
    const owner = parent.properties.owner;
    expect(
      owner.$ref,
      'parent model body references shared child instead of inlining it',
    ).toBeTypeOf('string');
    const child = target(doc, owner.$ref);
    expect(child.properties).toHaveProperty('id');
    expect(refs(parent.properties.entries.items), 'array item reuses same child').toContain(
      owner.$ref,
    );
    expect(
      refs(parent.properties.nullable),
      'nullable wrapper reuses same non-null child',
    ).toContain(owner.$ref);
    const validate = validator(doc, { $ref: owner.$ref });
    expect(validate(CHILD)).toBe(true);
    expect(validate(null), 'nullable usage cannot weaken shared child').toBe(false);
    expect(validate({ ...CHILD, id: 'wrong' })).toBe(false);
    expect(validate({ id: 17, name: 'fixture' })).toBe(false);
  });

  it('preserves actual nested accepted/rejected instances in full document component context', () => {
    const { doc } = document(fixtures(), version);
    graphControls(doc);
    parentModel(doc);
    const validate = validator(doc, response(doc, '/teams'));
    expect(validate(BODY), 'valid non-null parent').toBe(true);
    for (const invalid of [
      { ...BODY, owner: null },
      { ...BODY, owner: { ...CHILD, id: 'wrong' } },
      { ...BODY, entries: [{ ...CHILD, id: 2 ** 31 }] },
      { ...BODY, entries: [null] },
      { ...BODY, nullable: { id: 17, name: 'fixture' } },
      { owner: CHILD, entries: [CHILD], title: 'fixture' },
    ])
      expect(validate(invalid), `reject malformed nested value ${JSON.stringify(invalid)}`).toBe(
        false,
      );
    expect(validate({ ...BODY, nullable: null }), 'observed nullable wrapper accepts null').toBe(
      true,
    );
  });

  it('retains only reachable components after confidence filtering, including child-only dependencies', () => {
    const low = inferSchema({ secretCode: 'fixture', retired: true, weight: 1 });
    const schemas = [
      ...fixtures(),
      endpoint('/hidden', low, 0.1),
      endpoint('/hidden/{hiddenId}', structuredClone(low), 0.1),
    ];
    const { doc } = document(schemas, version, 0.8);
    expect(Object.keys(doc.paths).sort()).toEqual(['/teams', '/teams/{teamId}']);
    graphControls(doc);
    const reachable = new Set<string>();
    const pending = refs(doc.paths);
    while (pending.length) {
      const ref = pending.pop()!;
      if (reachable.has(ref)) continue;
      reachable.add(ref);
      pending.push(...refs(target(doc, ref)));
    }
    const emitted = Object.keys(doc.components.schemas)
      .map((name) => `#/components/schemas/${name.replace(/~/g, '~0').replace(/\//g, '~1')}`)
      .sort();
    expect(emitted, 'no models belonging solely to filtered endpoints').toEqual(
      [...reachable].sort(),
    );
    const parent = parentModel(doc);
    expect(
      parent.properties.owner.$ref,
      'retained parent keeps its transitive child reference',
    ).toBeTypeOf('string');
    expect(reachable.has(parent.properties.owner.$ref)).toBe(true);
    const validate = validator(doc, response(doc, '/teams'));
    expect(validate(BODY)).toBe(true);
    expect(validate({ ...BODY, owner: 7 })).toBe(false);
  });

  it('keeps nested contract names and references stable under input reversal', () => {
    const schemas = fixtures();
    const first = document(schemas, version).doc;
    const reversed = document([...schemas].reverse(), version).doc;
    graphControls(first);
    graphControls(reversed);
    expect(Object.keys(reversed.components.schemas).sort()).toEqual(
      Object.keys(first.components.schemas).sort(),
    );
    expect(response(reversed, '/teams')).toEqual(response(first, '/teams'));
    expect(reversed.components.schemas).toEqual(first.components.schemas);
  });
});
