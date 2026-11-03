/** Independent observable-contract regressions; no production implementation reads. */
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

type Schema = Record<string, unknown>;
interface Document {
  openapi: string;
  components?: { schemas: Record<string, Schema> };
  paths: Record<
    string,
    Record<
      string,
      {
        responses: Record<string, { content: Record<string, { schema: Schema }> }>;
        requestBody?: { content: Record<string, { schema: Schema }> };
      }
    >
  >;
}
const USER = { id: 123, name: 'fixture', email: 'fixture' };
const EXTRA = { ...USER, alias: 'fixture' };
const PATCH = {
  profile: { label: 'fixture', active: true },
  entries: [{ code: 123, label: 'fixture' }],
};

function fixture(reverse: boolean, promoted: boolean, version: string): Document {
  const db = getDatabase(':memory:');
  try {
    const sessions = new SessionRepository(db);
    const samples = new SampleRepository(db);
    const session = sessions.createSession('http://127.0.0.1:1', 1, 'requiredness-populations');
    const observations: Array<{ path: string; body: unknown; request?: unknown }> = [];
    for (let index = 0; index < 40; index++) {
      observations.push(
        { path: '/users', body: index % 2 ? USER : EXTRA },
        { path: '/users/{userId}', body: index % 2 ? EXTRA : USER },
        { path: '/nullable', body: { user: index % 2 ? null : USER } },
        // Missing an object is different from observing a null object.
        { path: '/nested', body: index % 2 ? {} : { profile: { label: 'fixture', active: true } } },
        {
          path: '/nested-optional',
          body: { profile: index % 2 ? { label: 'fixture' } : { label: 'fixture', active: true } },
        },
        // 4 objects per 3 requests, including an empty array. Neither element
        // count nor presence of an element can be inferred from request count.
        {
          path: '/arrays',
          body: index % 3 === 0 ? [] : index % 3 === 1 ? [EXTRA, USER, EXTRA] : [USER],
        },
        { path: '/patch', body: { ok: true }, request: PATCH },
      );
    }
    if (reverse) observations.reverse();
    for (const observation of observations) {
      const before = JSON.stringify(observation);
      const responseSchema = inferSchema(observation.body);
      const requestSchema =
        observation.request === undefined ? undefined : inferSchema(observation.request);
      expect(JSON.stringify(observation), 'inference preserves source values').toBe(before);
      const inferred = JSON.stringify({ responseSchema, requestSchema });
      samples.insertSample({
        sessionId: session.id,
        httpMethod: observation.request ? 'PATCH' : 'GET',
        path: observation.path,
        normalizedPath: observation.path,
        statusCode: 200,
        responseSchema,
        requestSchema,
        capturedAt: new Date().toISOString(),
      });
      expect(
        JSON.stringify({ responseSchema, requestSchema }),
        'storage preserves inferred input',
      ).toBe(inferred);
      sessions.incrementSampleCount(session.id);
    }
    const schemas = runAggregation(db, session.id).schemas;
    const beforeDiscovery = JSON.stringify(schemas);
    const registry = promoted ? discoverDomainModels(schemas) : undefined;
    expect(JSON.stringify(schemas), 'discovery preserves aggregated input').toBe(beforeDiscovery);
    if (registry)
      expect(registry.models.length, 'exercise actual model promotion').toBeGreaterThan(0);
    const beforeExport = JSON.stringify({ schemas, registry });
    const raw = buildOpenApiDocument(schemas, {}, undefined, registry);
    expect(JSON.stringify({ schemas, registry }), 'export preserves input').toBe(beforeExport);
    const beforeConversion = JSON.stringify(raw);
    const result = version === '3.0' ? convertToOpenApi30(raw) : raw;
    expect(JSON.stringify(raw), 'conversion preserves 3.1 source').toBe(beforeConversion);
    return result as unknown as Document;
  } finally {
    db.close();
  }
}
function validator(doc: Document, path: string, request = false) {
  const operation = doc.paths[path][request ? 'patch' : 'get'];
  const schema = request
    ? operation.requestBody!.content['application/json'].schema
    : operation.responses['200'].content['application/json'].schema;
  const ajv = doc.openapi === '3.1.0' ? new Ajv2020({ strict: false }) : new Ajv({ strict: false });
  ajv.addFormat('int32', {
    type: 'number',
    validate: (value: number) => Number.isInteger(value) && value >= -(2 ** 31) && value < 2 ** 31,
  });
  return ajv.compile({ ...schema, components: doc.components });
}
function check(doc: Document, path: string, value: unknown, accepted: boolean, request = false) {
  const validate = validator(doc, path, request);
  const actual = validate(value);
  expect
    .soft(
      actual,
      `${doc.openapi} ${request ? 'PATCH request' : 'GET response'} ${path} ${JSON.stringify(value)} expected=${accepted}; errors=${JSON.stringify(validate.errors)}`,
    )
    .toBe(accepted);
}

for (const reverse of [false, true]) {
  for (const promoted of [false, true]) {
    describe.each(['3.1', '3.0'])(
      `requiredness reverse=${reverse} promoted=${promoted} OAS %s`,
      (version) => {
        it('requires universally observed User fields but permits genuinely missing fields', () => {
          const doc = fixture(reverse, promoted, version);
          expect(doc.openapi).toBe(version === '3.1' ? '3.1.0' : '3.0.3');
          for (const path of ['/users', '/users/{userId}']) {
            check(doc, path, USER, true);
            check(doc, path, EXTRA, true);
            for (const key of Object.keys(USER)) {
              check(
                doc,
                path,
                Object.fromEntries(Object.entries(USER).filter(([name]) => name !== key)),
                false,
              );
            }
            check(doc, path, null, false);
            check(doc, path, { ...USER, id: 'wrong' }, false);
            check(doc, path, { ...USER, id: 2 ** 31 }, false);
          }
        });
        it('counts only actual objects for nullable and missing nested populations', () => {
          const doc = fixture(reverse, promoted, version);
          check(doc, '/nullable', { user: null }, true);
          check(doc, '/nullable', { user: USER }, true);
          check(doc, '/nullable', {}, false);
          for (const key of Object.keys(USER)) {
            check(
              doc,
              '/nullable',
              { user: Object.fromEntries(Object.entries(USER).filter(([name]) => name !== key)) },
              false,
            );
          }
          check(doc, '/nullable', { user: { ...USER, id: 'wrong' } }, false);
          check(doc, '/nested', {}, true);
          check(doc, '/nested', { profile: { label: 'fixture', active: true } }, true);
          check(doc, '/nested', { profile: {} }, false);
          check(doc, '/nested', { profile: null }, false);
          check(doc, '/nested-optional', { profile: { label: 'fixture' } }, true);
          check(doc, '/nested-optional', { profile: { label: 'fixture', active: true } }, true);
          check(doc, '/nested-optional', { profile: {} }, false);
          check(doc, '/nested-optional', {}, false);
        });
        it('uses array element populations, not request counts, for required fields', () => {
          const doc = fixture(reverse, promoted, version);
          for (const value of [[], [USER], [EXTRA, USER, EXTRA]])
            check(doc, '/arrays', value, true);
          for (const key of Object.keys(USER)) {
            const missing = Object.fromEntries(
              Object.entries(USER).filter(([name]) => name !== key),
            );
            check(doc, '/arrays', [USER, missing, EXTRA], false);
          }
          check(doc, '/arrays', [null], false);
          check(doc, '/arrays', [{ ...USER, id: 'wrong' }], false);
        });
        it('keeps PATCH request properties optional recursively without disabling types', () => {
          const doc = fixture(reverse, promoted, version);
          for (const value of [
            PATCH,
            {},
            { profile: {} },
            { profile: { active: true } },
            { entries: [{}] },
            { entries: [{ code: 123 }] },
          ]) {
            check(doc, '/patch', value, true, true);
          }
          for (const value of [
            { profile: null },
            { profile: { active: 'wrong' } },
            { entries: [{ code: 'wrong' }] },
            { entries: [null] },
          ]) {
            check(doc, '/patch', value, false, true);
          }
        });
      },
    );
  }
}
