import { describe, expect, it } from 'vitest';
import { inferSchema } from '../inference/engine.js';
import type { Sample } from '../types/index.js';
import { unifyEndpointPaths } from './pipeline.js';

type EndpointMap = Parameters<typeof unifyEndpointPaths>[0];
type Entry = NonNullable<ReturnType<EndpointMap['get']>>;

function entry(path: string, method = 'GET', status = 200, body: unknown = { id: 7 }): Entry {
  const sample: Sample = {
    id: 1,
    sessionId: 'fixture',
    httpMethod: method,
    path,
    normalizedPath: path,
    statusCode: status,
    responseSchema: inferSchema(body),
    capturedAt: '2026-10-28T00:00:00Z',
  };
  return {
    method,
    path,
    statusGroups: new Map([
      [String(status), { responseSchema: sample.responseSchema, samples: [sample] }],
    ]),
    allSamples: [sample],
    requestHeaders: [[{ name: 'x-fixture-request' }]],
    responseHeaders: [[{ name: 'x-fixture-response' }]],
  };
}

function endpoints(...entries: Entry[]): EndpointMap {
  return new Map(entries.map((value) => [`${value.method} ${value.path}`, value]));
}

describe('conservative cross-path unification (finding8)', () => {
  it.each([
    ['/config/theme', '/config/language'],
    ['/preferences/layout', '/preferences/locale'],
    ['/owners/owner_alice', '/owners/owner_bob'],
    ['/config/config_theme', '/config/config_language'],
    ['/settings/display-mode', '/settings/access-policy'],
    ['/api/v1', '/api/v2'],
  ])('preserves uncertain literal siblings %s and %s despite identical responses', (a, b) => {
    const map = endpoints(entry(a), entry(b));
    unifyEndpointPaths(map);
    expect([...map.keys()].sort()).toEqual([`GET ${a}`, `GET ${b}`].sort());
  });

  // These intentionally inject literal normalized paths: compatibility for legacy
  // rows, NOT a claim that fresh captures reach the cross-path pass as literals.
  it.each([
    ['ord_1', 'ord_2'],
    ['123', '456'],
    ['550e8400-e29b-41d4-a716-446655440000', '550e8400-e29b-41d4-a716-446655440001'],
  ])('still groups recognized legacy literal IDs %s and %s', (a, b) => {
    const map = endpoints(entry(`/orders/${a}`), entry(`/orders/${b}`));
    unifyEndpointPaths(map);
    expect([...map.keys()]).toEqual(['GET /orders/{orderId}']);
    const merged = map.get('GET /orders/{orderId}')!;
    expect(merged.allSamples).toHaveLength(2);
    expect(merged.statusGroups.get('200')!.samples).toHaveLength(2);
    expect(merged.requestHeaders).toHaveLength(2);
    expect(merged.responseHeaders).toHaveLength(2);
  });

  it('keeps static legacy siblings while grouping only recognized ID members', () => {
    const map = endpoints(entry('/orders/summary'), entry('/orders/ord_1'), entry('/orders/ord_2'));
    unifyEndpointPaths(map);
    expect([...map.keys()].sort()).toEqual(['GET /orders/summary', 'GET /orders/{orderId}'].sort());
    expect(map.get('GET /orders/summary')!.allSamples).toHaveLength(1);
    expect(map.get('GET /orders/{orderId}')!.allSamples).toHaveLength(2);
  });

  it('does not create a template from just one eligible candidate', () => {
    const map = endpoints(entry('/orders/summary'), entry('/orders/ord_1'));
    unifyEndpointPaths(map);
    expect([...map.keys()].sort()).toEqual(['GET /orders/summary', 'GET /orders/ord_1'].sort());
  });

  it.each<[string, Entry, Entry]>([
    ['method', entry('/orders/ord_1'), entry('/orders/ord_2', 'POST')],
    ['parent', entry('/orders/ord_1'), entry('/users/ord_2')],
    ['shape', entry('/orders/ord_1'), entry('/orders/ord_2', 'GET', 200, { label: 'fixture' })],
    ['no2xx', entry('/orders/ord_1', 'GET', 400), entry('/orders/ord_2', 'GET', 500)],
  ])('preserves existing %s isolation', (_label, a, b) => {
    const map = endpoints(a, b);
    const original = [...map.keys()].sort();
    unifyEndpointPaths(map);
    expect([...map.keys()].sort()).toEqual(original);
  });

  it('retains existing-param error folding without consuming a successful static sibling', () => {
    const map = endpoints(
      entry('/pets/{petId}'),
      entry('/pets/summary'),
      entry('/pets/bad', 'GET', 400, { error: 'fixture' }),
    );
    unifyEndpointPaths(map);
    expect([...map.keys()].sort()).toEqual(['GET /pets/{petId}', 'GET /pets/summary'].sort());
    expect([...map.get('GET /pets/{petId}')!.statusGroups.keys()].sort()).toEqual(['200', '400']);
    expect(map.get('GET /pets/summary')!.allSamples).toHaveLength(1);
  });
});
