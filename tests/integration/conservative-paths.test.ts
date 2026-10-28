/** Spec-first b0e.1 boundary tests. No aggregation/normalizer/export implementation reads.
 * Literal normalizedPath IDs below deliberately represent legacy/manual rows, NOT fresh capture.
 */
import { describe, expect, it } from 'vitest';
import { getDatabase } from '../../src/storage/database.js';
import { SessionRepository } from '../../src/storage/sessions.js';
import { SampleRepository } from '../../src/storage/samples.js';
import { inferSchema } from '../../src/inference/engine.js';
import { normalizePath } from '../../src/inference/path-normalizer.js';
import { runAggregation } from '../../src/aggregation/pipeline.js';
import { buildOpenApiDocument, convertToOpenApi30 } from '../../src/export/openapi.js';

interface Observation {
  path: string;
  method?: string;
  status?: number;
  body?: unknown;
  repeat?: number;
}
const BODY = { enabled: true, label: 'synthetic' };

function aggregate(observations: Observation[]) {
  const db = getDatabase(':memory:');
  try {
    const session = new SessionRepository(db).createSession('http://127.0.0.1:1', 1);
    const samples = new SampleRepository(db);
    let count = 0;
    for (const observation of observations) {
      for (let i = 0; i < (observation.repeat ?? 1); i++) {
        samples.insertSample({
          sessionId: session.id,
          httpMethod: observation.method ?? 'GET',
          path: observation.path,
          normalizedPath: observation.path,
          statusCode: observation.status ?? 200,
          responseSchema: inferSchema(observation.body ?? BODY),
          capturedAt: '2026-10-28T00:00:00.000Z',
        });
        count++;
      }
    }
    expect(samples.countBySession(session.id)).toBe(count);
    const result = runAggregation(db, session.id);
    expect(result.sampleCount).toBe(count);
    expect(result.schemas.reduce((sum, schema) => sum + schema.sampleCount, 0)).toBe(count);
    return result.schemas;
  } finally {
    db.close();
  }
}

function assertExports(schemas: ReturnType<typeof aggregate>, expectedPaths: string[]) {
  const doc = buildOpenApiDocument(schemas, {});
  for (const exported of [doc, convertToOpenApi30(doc)] as Array<{
    openapi: string;
    paths: Record<string, { get?: { responses?: Record<string, unknown> } }>;
  }>) {
    expect
      .soft(Object.keys(exported.paths).sort(), exported.openapi)
      .toEqual([...expectedPaths].sort());
    for (const path of expectedPaths) {
      expect
        .soft(exported.paths[path]?.get?.responses ?? {}, `${exported.openapi} ${path}`)
        .toHaveProperty('200');
    }
  }
}

describe('conservative grouping through real repositories, aggregation and export', () => {
  it.each([
    ['/config/theme', '/config/language'],
    ['/arbitrary/cobalt', '/arbitrary/meadow'],
    ['/owners/owner_alice', '/owners/owner_bob'],
  ])('keeps same-shaped uncertain literals %s and %s separate', (left, right) => {
    const schemas = aggregate([
      { path: left, repeat: 2 },
      { path: right, repeat: 3 },
    ]);
    expect.soft(schemas.map((schema) => schema.path).sort()).toEqual([left, right].sort());
    expect.soft(schemas.find((schema) => schema.path === left)?.sampleCount).toBe(2);
    expect.soft(schemas.find((schema) => schema.path === right)?.sampleCount).toBe(3);
    assertExports(schemas, [left, right]);
  });

  it('retains legacy/manual digit-bearing ID grouping, counts and inferred fields', () => {
    const schemas = aggregate([
      { path: '/orders/ord_1', repeat: 2 },
      { path: '/orders/ord_2', repeat: 3 },
    ]);
    expect(schemas).toHaveLength(1);
    expect(schemas[0]).toMatchObject({
      path: '/orders/{orderId}',
      sampleCount: 5,
      responseSchemas: {
        '200': {
          type: 'object',
          properties: { enabled: { type: 'boolean' }, label: { type: 'string' } },
        },
      },
    });
    assertExports(schemas, ['/orders/{orderId}']);
  });

  it('keeps a static sibling while grouping only the two eligible legacy IDs', () => {
    const schemas = aggregate([
      { path: '/orders/summary', repeat: 2 },
      { path: '/orders/ord_1' },
      { path: '/orders/ord_2' },
    ]);
    expect
      .soft(schemas.map((schema) => schema.path).sort())
      .toEqual(['/orders/summary', '/orders/{orderId}'].sort());
    expect.soft(schemas.find((schema) => schema.path === '/orders/summary')?.sampleCount).toBe(2);
    expect.soft(schemas.find((schema) => schema.path === '/orders/{orderId}')?.sampleCount).toBe(2);
    assertExports(schemas, ['/orders/summary', '/orders/{orderId}']);
  });

  it('requires at least two eligible IDs, not one ID plus a same-shaped static word', () => {
    const paths = ['/orders/summary', '/orders/ord_1'];
    const schemas = aggregate(paths.map((path) => ({ path })));
    expect.soft(schemas.map((schema) => schema.path).sort()).toEqual([...paths].sort());
    assertExports(schemas, paths);
  });

  it('does not cross method, parent, response-shape or unsuccessful-only boundaries', () => {
    const observations: Observation[] = [
      { path: '/method/ord_1', method: 'GET' },
      { path: '/method/ord_2', method: 'POST' },
      { path: '/parentA/ord_1' },
      { path: '/parentB/ord_2' },
      { path: '/shape/ord_1' },
      { path: '/shape/ord_2', body: { total: 7 } },
      { path: '/failed/ord_1', status: 404 },
      { path: '/failed/ord_2', status: 404 },
    ];
    const schemas = aggregate(observations);
    expect(schemas.map((schema) => `${schema.httpMethod} ${schema.path}`).sort()).toEqual(
      observations.map((item) => `${item.method ?? 'GET'} ${item.path}`).sort(),
    );
  });

  it('preserves capture normalization separately from legacy grouping', () => {
    for (const path of [
      '/config/theme',
      '/config/language',
      '/owners/owner_alice',
      '/owners/owner_bob',
      '/api/v1',
      '/api/v2',
    ]) {
      expect(normalizePath(path), path).toBe(path);
    }
    for (const [path, expected] of [
      ['/orders/ord_1', '/orders/{orderCode}'],
      ['/orders/ord_2', '/orders/{orderCode}'],
      ['/users/123', '/users/{userId}'],
      ['/users/456', '/users/{userId}'],
      ['/users/550e8400-e29b-41d4-a716-446655440000', '/users/{userId}'],
    ])
      expect(normalizePath(path), path).toBe(expected);
  });
});
