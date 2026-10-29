import { describe, expect, it } from 'vitest';
import { inferEnums } from './pipeline.js';
import type { InferredSchema } from '../types/index.js';

function infer(field: string, values: string[], count = 20): InferredSchema {
  const schema: InferredSchema = {
    type: 'string',
    stats: { sampleCount: count, presenceCount: count, confidence: 1 },
    _observedValues: values,
  };
  const before = JSON.stringify(schema);
  const result = inferEnums(schema, count, field);
  expect(JSON.stringify(schema)).toBe(before);
  expect(result._observedValues).toBeUndefined();
  return result;
}

describe('alphabetic code suffix enums', () => {
  it.each(['countryCode', 'currencyCode', 'errorCode'])(
    'does not suppress %s categoricals',
    (field) => {
      expect(infer(field, ['NZ', 'AU']).enum).toEqual(['AU', 'NZ']);
    },
  );
  it('keeps exact code and unrelated name guards', () => {
    for (const field of ['code', 'id', 'name', 'accountName', 'q']) {
      expect(infer(field, ['alpha', 'beta']).enum).toBeUndefined();
    }
  });
  it.each([
    ['200', '404'],
    ['123e4567-e89b-12d3-a456-426614174000', '123e4567-e89b-12d3-a456-426614174001'],
    ['aabbccddeeff0011', '0011223344556677'],
    ['https://example.invalid/a', 'https://example.invalid/b'],
  ])('still excludes continuous and identifier-like code values %j', (...values) => {
    expect(infer('countryCode', values).enum).toBeUndefined();
  });
  it('preserves minimum observation and cardinality thresholds', () => {
    expect(infer('countryCode', ['AU', 'NZ'], 9).enum).toBeUndefined();
    expect(
      infer(
        'countryCode',
        Array.from({ length: 11 }, (_, i) => `category_${i}`),
      ).enum,
    ).toBeUndefined();
  });
});
