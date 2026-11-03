import { describe, expect, it } from 'vitest';
import type { AggregatedSchema, InferredSchema } from '../types/index.js';
import { discoverDomainModels } from './domain-models.js';
const stats = { sampleCount: 20, presenceCount: 20, confidence: 1 };
function endpoint(path: string, schema: InferredSchema): AggregatedSchema {
  return {
    id: 1,
    sessionId: 'owned-naming-control',
    httpMethod: 'GET',
    path,
    version: 1,
    snapshot: 1,
    responseSchemas: { '200': schema },
    sampleCount: 20,
    confidenceScore: 1,
    firstObserved: '2026-01-01',
    lastObserved: '2026-01-01',
  };
}
const leaf = (): InferredSchema => ({ type: 'string', stats: { ...stats } });
const ordinary = (): InferredSchema => ({
  type: 'object',
  stats: { ...stats },
  properties: { left: leaf(), right: leaf() },
});
describe('naming tie-break controls', () => {
  it.each([
    ['/Zebra/{id}', '/alpha/{id}'],
    ['/zebra/{id}', '/éclair/{id}'],
  ])('uses a fixed non-locale lexical order for %s and %s', (first, second) => {
    for (const paths of [
      [first, second],
      [second, first],
    ]) {
      const schemas = paths.map((path) => endpoint(path, ordinary()));
      const before = structuredClone(schemas);
      expect(discoverDomainModels(schemas).models.map((m) => m.name)).toEqual(['Zebra']);
      expect(schemas).toEqual(before);
    }
  });
  it('retains known error-shape precedence over path-derived naming', () => {
    const error: InferredSchema = {
      type: 'object',
      stats: { ...stats },
      properties: { error: leaf(), message: leaf() },
    };
    const schemas = ['/alpha/{id}', '/zebra/{id}'].map((path) => endpoint(path, error));
    for (const ordered of [schemas, [...schemas].reverse()])
      expect(discoverDomainModels(ordered).models.map((m) => m.name)).toEqual(['ErrorResponse']);
  });
});
