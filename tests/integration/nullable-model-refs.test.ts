/** Independent acceptance5 contract; production implementations were not read. */
import { describe, expect, it } from 'vitest';
import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import { getDatabase } from '../../src/storage/database.js';
import { SessionRepository } from '../../src/storage/sessions.js';
import { SampleRepository } from '../../src/storage/samples.js';
import { inferSchema } from '../../src/inference/engine.js';
import { runAggregation } from '../../src/aggregation/pipeline.js';
import { discoverDomainModels } from '../../src/export/domain-models.js';
import { buildOpenApiDocument, convertToOpenApi30 } from '../../src/export/openapi.js';

interface Schema {
  $ref?: string;
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  oneOf?: Schema[];
  anyOf?: Schema[];
  allOf?: Schema[];
}
interface Document {
  openapi: string;
  components: { schemas: Record<string, Schema> };
  paths: Record<
    string,
    { get: { responses: Record<string, { content: Record<string, { schema: Schema }> }> } }
  >;
}
const USER = { id: 123, name: 'fixture', email: 'fixture' };

function response(doc: Document, path: string): Schema {
  return doc.paths[path].get.responses['200'].content['application/json'].schema;
}
function resolve(doc: Document, schema: Schema): Schema {
  if (!schema.$ref) return schema;
  expect(schema.$ref).toMatch(/^#\/components\/schemas\//);
  const name = schema.$ref.split('/').at(-1)!.replace(/~1/g, '/').replace(/~0/g, '~');
  const target = doc.components.schemas[name];
  expect(target, `resolvable ${schema.$ref}`).toBeDefined();
  return resolve(doc, target);
}
function refs(schema: Schema): string[] {
  return [
    ...(schema.$ref ? [schema.$ref] : []),
    ...Object.values(schema.properties ?? {}).flatMap(refs),
    ...(schema.items ? refs(schema.items) : []),
    ...[...(schema.oneOf ?? []), ...(schema.anyOf ?? []), ...(schema.allOf ?? [])].flatMap(refs),
  ];
}
function fixture(version: '3.1' | '3.0'): Document {
  const db = getDatabase(':memory:');
  try {
    const sessions = new SessionRepository(db);
    const samples = new SampleRepository(db);
    const session = sessions.createSession('http://127.0.0.1:1', 1, 'nullable-model-fixture');
    // Actual inference/storage/aggregation, including both observed null and User.
    for (let index = 0; index < 40; index++) {
      const bodies: Array<[string, unknown]> = [
        ['/users', USER],
        ['/users/{userId}', USER],
        ['/nullable', { user: index % 2 === 0 ? USER : null }],
        ['/nested', { envelope: { user: index % 2 === 0 ? USER : null } }],
        ['/collection', { entries: [USER, null] }],
        ['/primitive', { label: index % 2 === 0 ? 'fixture' : null, active: true }],
      ];
      for (const [path, body] of bodies) {
        samples.insertSample({
          sessionId: session.id,
          httpMethod: 'GET',
          path,
          normalizedPath: path,
          statusCode: 200,
          responseSchema: inferSchema(body),
          capturedAt: new Date().toISOString(),
        });
        sessions.incrementSampleCount(session.id);
      }
    }
    expect(samples.countBySession(session.id)).toBe(240);
    const schemas = runAggregation(db, session.id).schemas;

    const registry = discoverDomainModels(schemas);
    expect(registry.models.length, 'real discovery must promote a shared User').toBeGreaterThan(0);
    const before = JSON.stringify({ schemas, registry });
    const raw = buildOpenApiDocument(schemas, {}, undefined, registry);
    expect(JSON.stringify({ schemas, registry }), 'export must not mutate its inputs').toBe(before);
    const original = JSON.stringify(raw);
    const output = version === '3.0' ? convertToOpenApi30(raw) : raw;
    expect(JSON.stringify(raw), 'conversion must not mutate the 3.1 document').toBe(original);
    return output as unknown as Document;
  } finally {
    db.close();
  }
}
function validator(doc: Document, schema: Schema) {
  const ajv = doc.openapi === '3.1.0' ? new Ajv2020({ strict: false }) : new Ajv({ strict: false });
  // OpenAPI's signed int32 format is not built into AJV; validate it rather
  // than silently ignoring the generated numeric constraint.
  ajv.addFormat('int32', {
    type: 'number',
    validate: (value: number) => Number.isInteger(value) && value >= -(2 ** 31) && value < 2 ** 31,
  });
  // Keep original #/components references, constraints and component context intact.
  return ajv.compile({ ...schema, components: doc.components });
}
function sharedUserRef(doc: Document): string {
  const single = response(doc, '/users/{userId}');
  expect(single.$ref, 'non-null User must use a shared component').toBeDefined();
  expect(response(doc, '/users').$ref, 'both non-null usages share component identity').toBe(
    single.$ref,
  );
  return single.$ref!;
}
function controls(doc: Document): string {
  const ref = sharedUserRef(doc);

  const validate = validator(doc, { $ref: ref });
  expect(validate(USER), 'shared User accepts valid non-null body').toBe(true);
  for (const value of [
    null,
    { ...USER, id: 'wrong' },
    { id: 123, name: 'fixture' },
    7,
    'fixture',
  ]) {
    expect(validate(value), `shared User rejects ${JSON.stringify(value)}`).toBe(false);
  }
  return ref;
}

describe.each(['3.1', '3.0'] as const)('nullable promoted model references OAS %s', (version) => {
  it('accepts observed null locally while preserving requiredness, model constraints and identity', () => {
    const doc = fixture(version);
    expect(doc.openapi).toBe(version === '3.1' ? '3.1.0' : '3.0.3');
    const userRef = controls(doc);
    const schema = resolve(doc, response(doc, '/nullable'));
    expect(schema.required).toContain('user');
    expect(refs(schema.properties!.user)).toContain(userRef);
    const validate = validator(doc, response(doc, '/nullable'));
    expect(validate({ user: USER }), 'nullable usage accepts valid non-null User').toBe(true);
    for (const value of [
      {},
      { user: { ...USER, id: 'wrong' } },
      { user: { id: 123, name: 'fixture' } },
      { user: 7 },
      { user: 'fixture' },
      { user: false },
    ]) {
      expect(validate(value), `nullable usage rejects ${JSON.stringify(value)}`).toBe(false);
    }
    const acceptsNull = validate({ user: null });
    console.info(
      `OAS ${version}: shared/non-null/required/malformed controls passed; observed-null=${acceptsNull}; errors=${JSON.stringify(validate.errors)}`,
    );
    expect(acceptsNull, `OAS ${version} must accept observed {user:null}`).toBe(true);
  });

  it('preserves observed null in nested properties and array items without globally weakening User', () => {
    const doc = fixture(version);
    const userRef = controls(doc);
    const nested = resolve(doc, response(doc, '/nested'));
    const envelope = resolve(doc, nested.properties!.envelope);
    expect(refs(envelope.properties!.user)).toContain(userRef);
    const collection = resolve(doc, response(doc, '/collection'));
    const entries = resolve(doc, collection.properties!.entries);
    expect(refs(entries.items!)).toContain(userRef);
    for (const [path, valid, invalid, nullable] of [
      [
        '/nested',
        { envelope: { user: USER } },
        { envelope: { user: { ...USER, id: 'wrong' } } },
        { envelope: { user: null } },
      ],
      [
        '/collection',
        { entries: [USER] },
        { entries: [{ ...USER, id: 'wrong' }] },
        { entries: [USER, null] },
      ],
    ] as const) {
      const validate = validator(doc, response(doc, path));
      expect(validate(valid), `${path} non-null control`).toBe(true);
      expect(validate(invalid), `${path} malformed User control`).toBe(false);
      const accepted = validate(nullable);
      console.info(
        `OAS ${version} ${path}: non-null/malformed controls passed; observed-null=${accepted}`,
      );
      expect.soft(accepted, `${path} must retain observed null`).toBe(true);
    }
  });

  it('preserves ordinary primitive-null and non-null controls', () => {
    const doc = fixture(version);
    controls(doc);
    const validate = validator(doc, response(doc, '/primitive'));
    expect(validate({ label: null, active: true })).toBe(true);
    expect(validate({ label: 'fixture', active: true })).toBe(true);
    expect(validate({ label: 7, active: true })).toBe(false);
    expect(validate({ label: null, active: null })).toBe(false);
    expect(validate({ active: true })).toBe(false);
  });
});
