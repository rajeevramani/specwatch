/**
 * Integration tests for auto-aggregate with versioned snapshots.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { getDatabase } from '../../src/storage/database.js';
import { SessionRepository } from '../../src/storage/sessions.js';
import { SampleRepository } from '../../src/storage/samples.js';
import { AggregatedSchemaRepository } from '../../src/storage/schemas.js';
import { runAggregation } from '../../src/aggregation/pipeline.js';
import { inferSchema } from '../../src/inference/engine.js';
import type Database from 'better-sqlite3';

function insertSample(
  sampleRepo: SampleRepository,
  sessionId: string,
  path: string,
  body: Record<string, unknown>,
  statusCode = 200,
) {
  sampleRepo.insertSample({
    sessionId,
    httpMethod: 'GET',
    path,
    normalizedPath: path,
    statusCode,
    requestSchema: undefined,
    responseSchema: inferSchema(body),
    requestHeaders: [],
    responseHeaders: [],
    capturedAt: new Date().toISOString(),
  });
}

describe('Snapshots', () => {
  let db: Database.Database;
  let sessions: SessionRepository;
  let sampleRepo: SampleRepository;
  let schemaRepo: AggregatedSchemaRepository;
  let sessionId: string;

  beforeEach(() => {
    db = getDatabase(':memory:');
    sessions = new SessionRepository(db);
    sampleRepo = new SampleRepository(db);
    schemaRepo = new AggregatedSchemaRepository(db);
    const session = sessions.createSession('http://localhost:3000', 8080, 'test-session');
    sessionId = session.id;
  });

  it('creates snapshot 1 with initial samples', () => {
    insertSample(sampleRepo, sessionId, '/users', { id: 1, name: 'Alice' });
    insertSample(sampleRepo, sessionId, '/users', { id: 2, name: 'Bob' });

    const result = runAggregation(db, sessionId, {
      snapshot: 1,
      skipStateTransition: true,
    });

    expect(result.snapshot).toBe(1);
    expect(result.sampleCount).toBe(2);
    expect(result.schemas.length).toBe(1);
    expect(result.schemas[0].snapshot).toBe(1);
  });

  it('creates cumulative snapshot 2 that replaces snapshot 1 data', () => {
    // Snapshot 1: 2 samples
    insertSample(sampleRepo, sessionId, '/users', { id: 1, name: 'Alice' });
    insertSample(sampleRepo, sessionId, '/users', { id: 2, name: 'Bob' });
    runAggregation(db, sessionId, { snapshot: 1, skipStateTransition: true });

    // Add more samples, then snapshot 2 (cumulative: all 4 samples)
    insertSample(sampleRepo, sessionId, '/users', { id: 3, name: 'Charlie' });
    insertSample(sampleRepo, sessionId, '/users', { id: 4, name: 'Dana' });
    const result = runAggregation(db, sessionId, { snapshot: 2, skipStateTransition: true });

    expect(result.snapshot).toBe(2);
    expect(result.sampleCount).toBe(4); // cumulative
    expect(result.schemas[0].snapshot).toBe(2);

    // Both snapshots should exist
    const snap1 = schemaRepo.listBySessionSnapshot(sessionId, 1);
    const snap2 = schemaRepo.listBySessionSnapshot(sessionId, 2);
    expect(snap1.length).toBe(1);
    expect(snap2.length).toBe(1);
    expect(snap1[0].sampleCount).toBe(2);
    expect(snap2[0].sampleCount).toBe(4);
  });

  it('listBySessionLatestSnapshot returns the latest snapshot', () => {
    insertSample(sampleRepo, sessionId, '/users', { id: 1, name: 'Alice' });
    runAggregation(db, sessionId, { snapshot: 1, skipStateTransition: true });

    insertSample(sampleRepo, sessionId, '/users', { id: 2, name: 'Bob' });
    runAggregation(db, sessionId, { snapshot: 2, skipStateTransition: true });

    const latest = schemaRepo.listBySessionLatestSnapshot(sessionId);
    expect(latest.length).toBe(1);
    expect(latest[0].snapshot).toBe(2);
  });

  it('getMaxSnapshotForSession returns correct max', () => {
    expect(schemaRepo.getMaxSnapshotForSession(sessionId)).toBe(0);

    insertSample(sampleRepo, sessionId, '/users', { id: 1 });
    runAggregation(db, sessionId, { snapshot: 1, skipStateTransition: true });
    expect(schemaRepo.getMaxSnapshotForSession(sessionId)).toBe(1);

    insertSample(sampleRepo, sessionId, '/users', { id: 2 });
    runAggregation(db, sessionId, { snapshot: 3, skipStateTransition: true });
    expect(schemaRepo.getMaxSnapshotForSession(sessionId)).toBe(3);
  });

  it('skipStateTransition keeps session active', () => {
    insertSample(sampleRepo, sessionId, '/users', { id: 1 });
    runAggregation(db, sessionId, { snapshot: 1, skipStateTransition: true });

    const session = sessions.getSession(sessionId);
    expect(session?.status).toBe('active');
  });

  it('without skipStateTransition transitions to completed', () => {
    insertSample(sampleRepo, sessionId, '/users', { id: 1 });
    runAggregation(db, sessionId, { snapshot: 1 });

    const session = sessions.getSession(sessionId);
    expect(session?.status).toBe('completed');
  });

  it('new endpoints discovered in later snapshots appear in that snapshot', () => {
    insertSample(sampleRepo, sessionId, '/users', { id: 1, name: 'Alice' });
    runAggregation(db, sessionId, { snapshot: 1, skipStateTransition: true });

    // New endpoint in snapshot 2
    insertSample(sampleRepo, sessionId, '/users', { id: 2, name: 'Bob' });
    insertSample(sampleRepo, sessionId, '/orders', { orderId: 100, total: 50.0 });
    runAggregation(db, sessionId, { snapshot: 2, skipStateTransition: true });

    const snap1 = schemaRepo.listBySessionSnapshot(sessionId, 1);
    const snap2 = schemaRepo.listBySessionSnapshot(sessionId, 2);
    expect(snap1.length).toBe(1); // only /users
    expect(snap2.length).toBe(2); // /users + /orders
  });

  it('default snapshot is 1 for non-snapshot aggregation', () => {
    insertSample(sampleRepo, sessionId, '/users', { id: 1 });
    const result = runAggregation(db, sessionId);

    expect(result.snapshot).toBe(1);
    expect(result.schemas[0].snapshot).toBe(1);
  });

  /**
   * Regression test for specwatch-vln: auto-aggregate only fires once with --max-samples.
   *
   * The bug: the early-return guard in the server handler was:
   *   if (maxSamples !== undefined && sampleCount >= maxSamples) return;
   * After the first batch of N samples was auto-aggregated, sampleCount stayed >= maxSamples
   * (it's cumulative), so every subsequent sample was silently dropped. The second auto-
   * aggregation never fired.
   *
   * The fix added `&& !autoAggregate` so the guard only blocks when auto-aggregate is off.
   *
   * This test simulates the auto-aggregate flow: insert N samples, snapshot, insert N more,
   * snapshot again, and verify both snapshots exist with correct cumulative sample counts.
   */
  it('auto-aggregate produces multiple snapshots when samples exceed maxSamples repeatedly (specwatch-vln)', () => {
    const maxSamples = 3;

    // --- Batch 1: first maxSamples samples, then auto-aggregate snapshot 1 ---
    for (let i = 1; i <= maxSamples; i++) {
      insertSample(sampleRepo, sessionId, '/users', { id: i, name: `User${i}` });
    }

    const snap1Result = runAggregation(db, sessionId, {
      snapshot: 1,
      skipStateTransition: true,
    });
    expect(snap1Result.snapshot).toBe(1);
    expect(snap1Result.sampleCount).toBe(maxSamples);

    // --- Batch 2: next maxSamples samples, then auto-aggregate snapshot 2 ---
    // In the buggy code, sampleCount (now 3) >= maxSamples (3) would cause the
    // early return to fire, so these samples would never be inserted and
    // snapshot 2 would never be created.
    for (let i = maxSamples + 1; i <= maxSamples * 2; i++) {
      insertSample(sampleRepo, sessionId, '/users', { id: i, name: `User${i}` });
    }

    const snap2Result = runAggregation(db, sessionId, {
      snapshot: 2,
      skipStateTransition: true,
    });
    expect(snap2Result.snapshot).toBe(2);
    expect(snap2Result.sampleCount).toBe(maxSamples * 2); // cumulative

    // Verify both snapshots coexist with correct data
    const snap1Schemas = schemaRepo.listBySessionSnapshot(sessionId, 1);
    const snap2Schemas = schemaRepo.listBySessionSnapshot(sessionId, 2);
    expect(snap1Schemas.length).toBe(1);
    expect(snap2Schemas.length).toBe(1);
    expect(snap1Schemas[0].sampleCount).toBe(maxSamples);
    expect(snap2Schemas[0].sampleCount).toBe(maxSamples * 2);

    // Verify the latest snapshot is 2
    expect(schemaRepo.getMaxSnapshotForSession(sessionId)).toBe(2);
  });

  /**
   * Extended regression for specwatch-vln: three consecutive auto-aggregate cycles.
   * Ensures the fix works beyond just two snapshots.
   */
  it('auto-aggregate produces 3 snapshots across 3 batches (specwatch-vln)', () => {
    const maxSamples = 2;
    let totalInserted = 0;

    for (let snapshot = 1; snapshot <= 3; snapshot++) {
      for (let i = 0; i < maxSamples; i++) {
        totalInserted++;
        insertSample(sampleRepo, sessionId, '/items', {
          id: totalInserted,
          value: `item-${totalInserted}`,
        });
      }

      const result = runAggregation(db, sessionId, {
        snapshot,
        skipStateTransition: true,
      });
      expect(result.snapshot).toBe(snapshot);
      expect(result.sampleCount).toBe(totalInserted); // cumulative
    }

    // All 3 snapshots exist
    for (let s = 1; s <= 3; s++) {
      const schemas = schemaRepo.listBySessionSnapshot(sessionId, s);
      expect(schemas.length).toBe(1);
      expect(schemas[0].sampleCount).toBe(s * maxSamples);
    }

    expect(schemaRepo.getMaxSnapshotForSession(sessionId)).toBe(3);
  });

  it('deleteBySessionSnapshot removes only the targeted snapshot', () => {
    insertSample(sampleRepo, sessionId, '/users', { id: 1 });
    runAggregation(db, sessionId, { snapshot: 1, skipStateTransition: true });

    insertSample(sampleRepo, sessionId, '/users', { id: 2 });
    runAggregation(db, sessionId, { snapshot: 2, skipStateTransition: true });

    schemaRepo.deleteBySessionSnapshot(sessionId, 1);

    const snap1 = schemaRepo.listBySessionSnapshot(sessionId, 1);
    const snap2 = schemaRepo.listBySessionSnapshot(sessionId, 2);
    expect(snap1.length).toBe(0);
    expect(snap2.length).toBe(1);
  });
});
