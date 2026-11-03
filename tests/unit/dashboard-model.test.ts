/**
 * Unit tests for DashboardModel — the decoupled event store the live-capture
 * TUI subscribes to. Verifies counters, endpoint aggregation, and change events.
 */

import { describe, it, expect, vi } from 'vitest';
import { DashboardModel, type DashboardInit } from '../../src/tui/model.js';

function makeModel(over: Partial<DashboardInit> = {}): DashboardModel {
  return new DashboardModel({
    target: 'https://api.example.com',
    proxyUrl: 'http://localhost:8080',
    sessionId: 'abcdef1234',
    autoAggregate: false,
    startedAt: 1_000_000,
    ...over,
  });
}

describe('DashboardModel', () => {
  it('initializes counters to zero and no endpoints', () => {
    const m = makeModel();
    expect(m.state.sampleCount).toBe(0);
    expect(m.state.skippedCount).toBe(0);
    expect(m.state.snapshot).toBe(0);
    expect(m.state.samplesSinceSnapshot).toBe(0);
    expect(m.state.endpoints.size).toBe(0);
  });

  it('recordSample increments sample counters and emits change', () => {
    const m = makeModel();
    const spy = vi.fn();
    m.onChange(spy);
    m.recordSample('GET', '/users/{userId}', 200);
    expect(m.state.sampleCount).toBe(1);
    expect(m.state.samplesSinceSnapshot).toBe(1);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('aggregates repeated calls to the same endpoint into one row', () => {
    const m = makeModel();
    m.recordSample('GET', '/users/{userId}', 200);
    m.recordSample('GET', '/users/{userId}', 404);
    m.recordSample('GET', '/users/{userId}', 200);
    expect(m.state.endpoints.size).toBe(1);
    const row = m.state.endpoints.get('GET /users/{userId}')!;
    expect(row.hits).toBe(3);
    expect([...row.statuses].sort()).toEqual([200, 404]);
    expect(row.lastStatus).toBe(200);
    expect(m.state.sampleCount).toBe(3);
  });

  it('keeps distinct method+path as distinct rows', () => {
    const m = makeModel();
    m.recordSample('GET', '/users', 200);
    m.recordSample('POST', '/users', 201);
    expect(m.state.endpoints.size).toBe(2);
    expect(m.state.endpoints.has('GET /users')).toBe(true);
    expect(m.state.endpoints.has('POST /users')).toBe(true);
  });

  it('recordSkipped increments skippedCount without touching sampleCount', () => {
    const m = makeModel();
    const spy = vi.fn();
    m.onChange(spy);
    m.recordSkipped();
    expect(m.state.skippedCount).toBe(1);
    expect(m.state.sampleCount).toBe(0);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('recordSnapshot sets snapshot, resets samplesSinceSnapshot, stores message', () => {
    const m = makeModel();
    m.recordSample('GET', '/a', 200);
    m.recordSample('GET', '/b', 200);
    expect(m.state.samplesSinceSnapshot).toBe(2);
    m.recordSnapshot(1, 'Snapshot 1 created');
    expect(m.state.snapshot).toBe(1);
    expect(m.state.samplesSinceSnapshot).toBe(0);
    expect(m.state.lastMessage).toBe('Snapshot 1 created');
    // cumulative sample count is not reset by a snapshot
    expect(m.state.sampleCount).toBe(2);
  });

  it('setMessage updates lastMessage and emits change', () => {
    const m = makeModel();
    const spy = vi.fn();
    m.onChange(spy);
    m.setMessage('Reached max samples (100). Stopping…');
    expect(m.state.lastMessage).toBe('Reached max samples (100). Stopping…');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('onChange returns an unsubscribe that stops further notifications', () => {
    const m = makeModel();
    const spy = vi.fn();
    const off = m.onChange(spy);
    m.recordSample('GET', '/a', 200);
    off();
    m.recordSample('GET', '/b', 200);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
