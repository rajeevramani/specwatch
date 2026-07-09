/**
 * Unit tests for the live-capture Ink dashboard (App). Uses ink-testing-library
 * to render the component over a DashboardModel and assert on the frame text.
 * Locks the existing prototype behavior (S1 baseline) before later slices add
 * scrolling (S2) and hotkeys (S3).
 */

import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render } from 'ink-testing-library';
import { App } from '../../src/tui/App.js';
import { DashboardModel, type DashboardInit } from '../../src/tui/model.js';

function makeModel(over: Partial<DashboardInit> = {}): DashboardModel {
  return new DashboardModel({
    target: 'https://api.example.com',
    proxyUrl: 'http://localhost:8080',
    sessionId: 'abcdef1234',
    sessionName: 'my-api',
    autoAggregate: false,
    startedAt: 1_000_000,
    ...over,
  });
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function renderApp(model: DashboardModel) {
  const r = render(React.createElement(App, { model, onQuit: () => {} }));
  cleanups.push(() => r.unmount());
  return r;
}

describe('TUI App (live dashboard)', () => {
  it('renders the header with session name, proxy, and target', () => {
    const { lastFrame } = renderApp(makeModel());
    const frame = lastFrame()!;
    expect(frame).toContain('specwatch');
    expect(frame).toContain('my-api');
    expect(frame).toContain('http://localhost:8080');
    expect(frame).toContain('api.example.com');
  });

  it('shows the waiting message when no traffic captured yet', () => {
    const { lastFrame } = renderApp(makeModel());
    expect(lastFrame()).toContain('Waiting for traffic');
  });

  it('renders an endpoint row and sample count after samples recorded', () => {
    const model = makeModel();
    model.recordSample('GET', '/users/{userId}', 200);
    model.recordSample('GET', '/users/{userId}', 200);
    const { lastFrame } = renderApp(model);
    const frame = lastFrame()!;
    expect(frame).toContain('GET');
    expect(frame).toContain('/users/{userId}');
    expect(frame).toContain('Samples');
    expect(frame).toContain('2');
  });

  it('renders /max when maxSamples is set', () => {
    const model = makeModel({ maxSamples: 100 });
    model.recordSample('GET', '/a', 200);
    const { lastFrame } = renderApp(model);
    expect(lastFrame()).toContain('/100');
  });

  it('caps the table at 15 rows and shows an "…and N more" affordance (current behavior)', () => {
    const model = makeModel();
    for (let i = 0; i < 20; i++) {
      // decreasing hits so sort order is stable and deterministic
      const hits = 20 - i;
      for (let h = 0; h < hits; h++)
        model.recordSample('GET', `/r${String(i).padStart(2, '0')}`, 200);
    }
    const { lastFrame } = renderApp(model);
    const frame = lastFrame()!;
    expect(frame).toContain('…and 5 more');
    // top endpoint (most hits) is shown, the least-hit one is hidden
    expect(frame).toContain('/r00');
    expect(frame).not.toContain('/r19');
  });

  it('renders lastMessage in the footer when set', () => {
    const model = makeModel();
    model.setMessage('Snapshot 1 created');
    const { lastFrame } = renderApp(model);
    expect(lastFrame()).toContain('Snapshot 1 created');
  });

  it('shows the quit hint in the footer when no message', () => {
    const { lastFrame } = renderApp(makeModel());
    expect(lastFrame()).toContain('stop & aggregate');
  });

  it('unmounts cleanly — a late model change after unmount does not throw into the shutdown path', () => {
    const model = makeModel();
    model.recordSample('GET', '/a', 200);
    const r = render(React.createElement(App, { model, onQuit: () => {} }));
    r.unmount();
    // The SIGINT path unmounts the dashboard before aggregation prints. A sample
    // that lands during teardown must never throw back into the shutdown/
    // aggregation sequence (recordSample is O(1) and side-effect-safe).
    expect(() => model.recordSample('GET', '/b', 200)).not.toThrow();
  });

  it('routes "q" to onQuit (the hook the SIGINT/unmount-then-aggregate path uses)', async () => {
    const model = makeModel();
    let quit = 0;
    const r = render(
      React.createElement(App, {
        model,
        onQuit: () => {
          quit += 1;
        },
      }),
    );
    cleanups.push(() => r.unmount());
    r.stdin.write('q');
    // allow Ink's input handler + effect flush
    await new Promise((res) => setTimeout(res, 20));
    expect(quit).toBe(1);
  });
});
