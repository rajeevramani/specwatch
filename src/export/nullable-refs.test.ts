import { describe, expect, it } from 'vitest';
import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import type { InferredSchema } from '../types/index.js';
import { convertSchemaToOpenApi, convertToOpenApi30 } from './openapi.js';

const stats = { sampleCount: 2, presenceCount: 2, confidence: 1 };
const user: InferredSchema = {
  type: 'object',
  properties: { id: { type: 'integer', stats }, name: { type: 'string', stats } },
  required: ['id', 'name'],
  stats,
};
const nullSchema: InferredSchema = { type: 'null', stats };
const union = (...variants: InferredSchema[]): InferredSchema => ({
  type: 'object',
  oneOf: variants,
  stats,
});
const ref = { $ref: '#/components/schemas/User' };
type Collector = NonNullable<Parameters<typeof convertSchemaToOpenApi>[1]>;

// Isolate the converter's resolver boundary; independent integration tests use
// real discovery/storage instead. Only this exact non-null variant resolves.
function collector(variant: InferredSchema, resolved: Record<string, unknown> = ref): Collector {
  return {
    register: () => {
      throw new Error('Unexpected registration in converter unit test');
    },
    getSchemas: () => ({}),
    resolveWithDomainModel: (schema) => (schema === variant ? resolved : undefined),
  };
}
function document(schema: Record<string, unknown>) {
  return {
    openapi: '3.1.0',
    info: { title: 'fixture', version: '1' },
    paths: {},
    components: { schemas: { User: convertSchemaToOpenApi(user), Envelope: schema } },
  };
}
function schemas(doc: Record<string, unknown>): Record<string, Record<string, unknown>> {
  return (doc.components as { schemas: Record<string, Record<string, unknown>> }).schemas;
}

describe('nullable reference conversion (finding5)', () => {
  it('retains the null branch when the non-null variant resolves to a ref', () => {
    const input = union(user, nullSchema);
    const before = JSON.stringify(input);
    expect(convertSchemaToOpenApi(input, collector(user))).toEqual({
      oneOf: [ref, { type: 'null' }],
    });
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each([['string'], ['string', 'null']])(
    'deduplicates null in resolved type array %j',
    (...types) => {
      const variant: InferredSchema = { type: 'string', stats };
      const resolved = { type: types };
      const before = JSON.stringify(resolved);
      expect(
        convertSchemaToOpenApi(union(variant, nullSchema), collector(variant, resolved)),
      ).toEqual({ type: ['string', 'null'] });
      expect(JSON.stringify(resolved)).toBe(before);
    },
  );

  it('keeps a composite non-null union nested alongside its null alternative', () => {
    const composite = union({ type: 'integer', stats }, { type: 'string', stats });
    expect(convertSchemaToOpenApi(union(composite, nullSchema))).toEqual({
      oneOf: [{ oneOf: [{ type: 'integer' }, { type: 'string' }] }, { type: 'null' }],
    });
  });

  it('does not duplicate a null-only nested type', () => {
    expect(convertSchemaToOpenApi(union(union(nullSchema), nullSchema))).toEqual({ type: 'null' });
  });

  it.each(['3.1', '3.0'])('validates actual local nullable ref semantics in %s', (version) => {
    const nullable = convertSchemaToOpenApi(union(user, nullSchema), collector(user));
    const raw = document({ type: 'object', required: ['user'], properties: { user: nullable } });
    const before = JSON.stringify(raw);
    const doc = version === '3.0' ? convertToOpenApi30(raw) : raw;
    expect(JSON.stringify(raw)).toBe(before);
    const ajv = version === '3.0' ? new Ajv({ strict: false }) : new Ajv2020({ strict: false });
    const context = doc.components;
    const validate = ajv.compile({ $ref: '#/components/schemas/Envelope', components: context });
    expect(validate({ user: { id: 7, name: 'fixture' } })).toBe(true);
    for (const value of [
      {},
      { user: { id: 'wrong', name: 'fixture' } },
      { user: {} },
      { user: false },
      { user: 'wrong' },
    ]) {
      expect(validate(value), JSON.stringify(value)).toBe(false);
    }
    expect(validate({ user: null }), 'observed null is accepted').toBe(true);
    const shared = ajv.compile({ ...ref, components: context });
    expect(shared(null), 'shared non-null User remains non-null').toBe(false);
  });

  it('preserves annotations and only-null membership in the 3.0 pair conversion', () => {
    const raw = document({
      description: 'fixture annotation',
      oneOf: [ref, { type: 'null' }],
      default: null,
    });
    const result = schemas(convertToOpenApi30(raw)).Envelope;
    expect(result).toEqual({
      description: 'fixture annotation',
      anyOf: [ref, { type: 'object', nullable: true, enum: [null] }],
      default: null,
    });
  });

  it('preserves an existing sibling anyOf constraint rather than overwriting it', () => {
    const raw = document({ oneOf: [ref, { type: 'null' }], anyOf: [{ enum: [null] }] });
    const converted = convertToOpenApi30(raw);
    expect(schemas(converted).Envelope.anyOf).toEqual([{ enum: [null] }]);
    const validate = new Ajv({ strict: false }).compile({
      $ref: '#/components/schemas/Envelope',
      components: converted.components,
    });
    expect(validate(null)).toBe(true);
    expect(validate({ id: 7, name: 'fixture' })).toBe(false);
    expect(validate('wrong')).toBe(false);
  });

  it('does not treat an annotated or constrained null branch as the pure generated pair', () => {
    const raw = document({ oneOf: [ref, { type: 'null', description: 'retained annotation' }] });
    const result = schemas(convertToOpenApi30(raw)).Envelope;
    expect(result.anyOf).toBeUndefined();
    expect(result.oneOf).toEqual([
      ref,
      { type: 'string', nullable: true, description: 'retained annotation' },
    ]);
  });
});
