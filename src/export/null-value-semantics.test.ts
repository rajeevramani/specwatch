import { describe, expect, it } from 'vitest';
import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import { buildOpenApiDocument, convertSchemaToOpenApi, convertToOpenApi30 } from './openapi.js';
import type { InferredSchema } from '../types/index.js';

type Schema = Record<string, unknown>;
function document(schema: Schema) {
  return {
    openapi: '3.1.0',
    info: { title: 'Owned null semantics', version: '1' },
    paths: {},
    components: { schemas: { Envelope: schema } },
  } as unknown as ReturnType<typeof buildOpenApiDocument>;
}
function validator(schema: Schema, version: '3.1' | '3.0') {
  const raw = document(schema);
  const before = JSON.stringify(raw);
  const doc = version === '3.0' ? convertToOpenApi30(raw) : raw;
  expect(JSON.stringify(raw)).toBe(before);
  const ajv = version === '3.1' ? new Ajv2020({ strict: false }) : new Ajv({ strict: false });
  return ajv.compile({ $ref: '#/components/schemas/Envelope', components: doc.components });
}

describe.each(['3.1', '3.0'] as const)('null value semantics OAS %s', (version) => {
  it.each([
    { type: 'null' },
    { type: ['null'] },
    { type: 'null', description: 'retained annotation' },
  ])('keeps a null-only input null-only: %j', (schema) => {
    const validate = validator(schema, version);
    expect(validate(null)).toBe(true);
    for (const value of ['arbitrary', '', {}, [], 0, false]) {
      expect(validate(value), JSON.stringify(value)).toBe(false);
    }
  });

  it('keeps null exact within a three-way object/array/null union', () => {
    const validate = validator(
      {
        oneOf: [
          { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
          { type: 'array', items: { type: 'integer' } },
          { type: 'null' },
        ],
      },
      version,
    );
    for (const value of [null, { id: 7 }, [], [1, 2]]) expect(validate(value)).toBe(true);
    for (const value of ['arbitrary', {}, { id: 'wrong' }, ['wrong'], 0, false]) {
      expect(validate(value), JSON.stringify(value)).toBe(false);
    }
  });

  it('does not turn overlapping exclusive non-null alternatives into anyOf', () => {
    const validate = validator(
      {
        oneOf: [
          { type: 'object', properties: { id: { type: 'integer' } } },
          { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
          { type: 'null' },
        ],
      },
      version,
    );
    expect(validate(null)).toBe(true);
    expect(validate({})).toBe(true);
    expect(validate({ id: 7 })).toBe(false);
    expect(validate('arbitrary')).toBe(false);
  });

  it('preserves observed null without widening nullable scalar enums', () => {
    const stats = { sampleCount: 30, presenceCount: 30, confidence: 1 };
    const leaf: InferredSchema = {
      type: 'string',
      enum: ['active', 'draft'],
      stats: { ...stats },
    };
    const nullable: InferredSchema = {
      type: 'object',
      stats: { ...stats },
      oneOf: [leaf, { type: 'null', stats: { ...stats } }],
    };
    const before = JSON.stringify(nullable);
    const validate = validator(convertSchemaToOpenApi(nullable), version);
    expect(JSON.stringify(nullable)).toBe(before);
    for (const value of ['active', 'draft', null])
      expect(validate(value), String(value)).toBe(true);
    for (const value of ['unseen', '', {}, 7]) expect(validate(value), String(value)).toBe(false);
    const nonNull = validator(convertSchemaToOpenApi(leaf), version);
    expect(nonNull('active')).toBe(true);
    expect(nonNull(null)).toBe(false);
    expect(leaf.enum).toEqual(['active', 'draft']);
  });
});
