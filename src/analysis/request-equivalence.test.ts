import { describe, expect, it } from 'vitest';
import { getDatabase } from '../storage/database.js';
import { SessionRepository } from '../storage/sessions.js';
import { SampleRepository } from '../storage/samples.js';
import { detectSequences } from './sequences.js';

function analyze(calls: Array<{ path?: string; query?: Record<string, string> }>) {
  const db = getDatabase(':memory:');
  try {
    const sessions = new SessionRepository(db);
    const samples = new SampleRepository(db);
    const session = sessions.createSession(
      'http://127.0.0.1:1',
      1,
      'owned-equivalence',
      undefined,
      'agent',
    );
    calls.forEach((call, i) => {
      samples.insertSample({
        sessionId: session.id,
        httpMethod: 'GET',
        path: call.path ?? '/items',
        normalizedPath: call.path ? '/items/{itemId}' : '/items',
        queryParams: call.query,
        statusCode: 200,
        capturedAt: new Date(Date.UTC(2026, 9, 28, 0, 0, i)).toISOString(),
      });
      sessions.incrementSampleCount(session.id);
    });
    return detectSequences(db, session.id);
  } finally {
    db.close();
  }
}

describe('captured REST request equivalence', () => {
  it('keeps equal and unequal query transitions in separate buckets', () => {
    const result = analyze([
      { query: { q: 'cats' } },
      { query: { q: 'dogs' } },
      { query: { q: 'dogs' } },
      { query: { q: 'birds' } },
    ]);
    expect(result.sequences.filter((s) => s.pattern === 'retry').map((s) => s.count)).toEqual([1]);
    expect(result.sequences.filter((s) => s.pattern === 'unknown').map((s) => s.count)).toEqual([
      2,
    ]);
    expect(result.totalRequests).toBe(4);
    expect(result.toolUsage[0].count).toBe(4);
    expect(result.wastedRequests).toBe(1);
    const output = JSON.stringify(result);
    for (const value of ['cats', 'dogs', 'birds', 'queryEquivalent', 'equivalentCapturedRequest']) {
      expect(output).not.toContain(value);
    }
  });
  it('does not collapse distinct concrete IDs into repeated calls', () => {
    const result = analyze([{ path: '/items/1' }, { path: '/items/2' }, { path: '/items/2' }]);
    expect(result.sequences.filter((s) => s.pattern === 'retry').map((s) => s.count)).toEqual([1]);
    expect(result.sequences.filter((s) => s.pattern === 'unknown').map((s) => s.count)).toEqual([
      1,
    ]);
    expect(result.toolUsage).toEqual([
      { operationKey: 'GET /items/{itemId}', count: 3, isRedundant: false },
    ]);
  });
  it('compares key sets and values rather than insertion order', () => {
    expect(
      analyze([{ query: { a: '1', b: '2' } }, { query: { b: '2', a: '1' } }]).sequences[0].pattern,
    ).toBe('retry');
    expect(analyze([{ query: { q: '' } }, {}]).sequences[0].pattern).toBe('unknown');
    expect(analyze([{ query: { q: 'cats' } }, { query: { q: 'dogs' } }]).sequences[0].pattern).toBe(
      'unknown',
    );
    expect(analyze([{}, { query: {} }]).sequences[0].pattern).toBe('retry');
  });
});
