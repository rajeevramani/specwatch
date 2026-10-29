import { describe, expect, it } from 'vitest';
import { getDatabase } from '../storage/database.js';
import { SessionRepository } from '../storage/sessions.js';
import { SampleRepository } from '../storage/samples.js';
import { inferSchema } from '../inference/engine.js';
import { calculateRequiredFields, runAggregation } from './pipeline.js';
import type { InferredSchema } from '../types/index.js';

const user = { id: 123, name: 'fixture', email: 'fixture' };

function aggregate(bodies: unknown[], method: 'GET' | 'PATCH' = 'GET'): InferredSchema {
  const db = getDatabase(':memory:');
  try {
    const sessions = new SessionRepository(db);
    const samples = new SampleRepository(db);
    const session = sessions.createSession('http://127.0.0.1:1', 1, 'requiredness-populations');
    for (const body of bodies) {
      samples.insertSample({
        sessionId: session.id,
        httpMethod: method,
        path: '/records',
        normalizedPath: '/records',
        statusCode: 200,
        requestSchema: method === 'PATCH' ? inferSchema(body) : undefined,
        responseSchema: inferSchema(body),
        capturedAt: '2026-10-28T00:00:00Z',
      });
      sessions.incrementSampleCount(session.id);
    }
    const result = runAggregation(db, session.id).schemas[0];
    return method === 'PATCH' ? result.requestSchema! : result.responseSchemas!['200']!;
  } finally {
    db.close();
  }
}

function objectVariant(schema: InferredSchema): InferredSchema {
  return schema.oneOf!.find((variant) => variant.type === 'object')!;
}

function checkPatch(schema: InferredSchema): void {
  if (schema.properties) {
    expect(schema.required ?? []).toEqual([]);
    Object.values(schema.properties).forEach(checkPatch);
  }
  if (schema.items) checkPatch(schema.items);
  schema.oneOf?.forEach(checkPatch);
}

describe('requiredness follows observed object populations', () => {
  it('does not infer required fields from an empty observation population', () => {
    const schema = inferSchema(user);
    schema.stats = { sampleCount: 0, presenceCount: 0, confidence: 0 };
    for (const property of Object.values(schema.properties!)) {
      property.stats = { sampleCount: 0, presenceCount: 0, confidence: 0 };
    }
    const before = JSON.stringify(schema);
    expect(calculateRequiredFields(schema, 0).required).toEqual([]);
    expect(JSON.stringify(schema)).toBe(before);
  });

  it('requires nullable-object fields present in every non-null observation', () => {
    const schema = aggregate(Array.from({ length: 40 }, (_, i) => ({ user: i % 2 ? null : user })));
    const child = objectVariant(schema.properties!['user']);
    expect(child.stats.presenceCount).toBe(20);
    expect(child.required).toEqual(['email', 'id', 'name']);
    expect(schema.required).toEqual(['user']);
  });

  it('keeps fields missing from some non-null observations optional', () => {
    const schema = aggregate([
      { user },
      { user: null },
      { user: { id: 456, name: 'fixture' } },
      { user: null },
    ]);
    const child = objectVariant(schema.properties!['user']);
    expect(child.required).toEqual(['id', 'name']);
    expect(child.required).not.toContain('email');
  });

  it('uses element observations rather than request count for top-level arrays', () => {
    const schema = aggregate(
      Array.from({ length: 20 }, () => [user, { id: 456, name: 'fixture' }]),
    );
    expect(schema.items!.stats.presenceCount).toBe(40);
    expect(schema.items!.required).toEqual(['id', 'name']);
    expect(schema.items!.required).not.toContain('email');
  });

  it('uses element observations for nested arrays, including empty responses', () => {
    const schema = aggregate([
      { rows: [user, { id: 456, name: 'fixture' }] },
      { rows: [] },
      { rows: [user, user] },
    ]);
    const items = schema.properties!['rows'].items!;
    expect(items.stats.presenceCount).toBe(4);
    expect(items.required).toEqual(['id', 'name']);
  });

  it('retains the existing conditional population for absent parent objects', () => {
    const schema = aggregate([{ details: user }, {}, { details: user }]);
    expect(schema.required).not.toContain('details');
    expect(schema.properties!['details'].required).toEqual(['email', 'id', 'name']);
  });

  it('does not make nullable or array-contained PATCH request fields required', () => {
    const schema = aggregate(
      [
        { user, rows: [user, { id: 456, name: 'fixture' }] },
        { user: null, rows: [] },
      ],
      'PATCH',
    );
    checkPatch(schema);
  });
});
