import { describe, expect, it } from 'vitest';
import * as normalizer from './path-normalizer.js';

function classify(segment: string): boolean {
  const helper: unknown = Reflect.get(normalizer, 'isIdentifierLikePathSegment');
  expect(helper, 'shared classifier helper exists').toBeTypeOf('function');
  return (helper as (value: string) => boolean)(segment);
}

describe('literal identifier candidates reuse capture classification', () => {
  it.each([
    '123',
    'ord_1',
    'ABC123',
    '550e8400-e29b-41d4-a716-446655440000',
    '2024-01-15',
    '2024-01-15T12:30:00Z',
    'theme',
    'language',
    'owner_alice',
    'display-mode',
    'config_theme',
    'v1',
    '',
  ])('agrees with fresh capture for literal %j without changing capture naming', (segment) => {
    const before = normalizer.normalizePath(`/orders/${segment}`);
    const normalizedLeaf = before.split('/').at(-1)!;
    const captureRecognizesValue = normalizedLeaf.startsWith('{') && normalizedLeaf.endsWith('}');
    expect(classify(segment)).toBe(captureRecognizesValue);
    expect(normalizer.normalizePath(`/orders/${segment}`)).toBe(before);
  });

  it.each(['{id}', '{orderId}'])(
    'does not classify an existing template %s as a literal candidate',
    (segment) => {
      expect(classify(segment)).toBe(false);
    },
  );

  it('preserves contextual Code and Date names rather than adopting unifier Id names', () => {
    expect(normalizer.normalizePath('/orders/ord_1')).toBe('/orders/{orderCode}');
    expect(normalizer.normalizePath('/events/2024-01-15')).toBe('/events/{eventDate}');
  });
});
