/**
 * Unit tests for the live-dashboard hotkeys (S3): `a` aggregate-now, `e` export,
 * and `q` acting as a single Ctrl+C. Uses ink-testing-library stdin to drive keys.
 */

import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render } from 'ink-testing-library';
import { App } from '../../src/tui/App.js';
import { DashboardModel } from '../../src/tui/model.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function makeModel(): DashboardModel {
  return new DashboardModel({
    target: 'https://api.example.com',
    proxyUrl: 'http://localhost:8080',
    sessionId: 'abcdef1234',
    autoAggregate: false,
    startedAt: 1_000_000,
  });
}

const tick = () => new Promise((res) => setTimeout(res, 20));

describe('TUI hotkeys', () => {
  it('"a" invokes onAggregate', async () => {
    let aggregate = 0;
    const r = render(
      React.createElement(App, {
        model: makeModel(),
        onQuit: () => {},
        onAggregate: () => (aggregate += 1),
      }),
    );
    cleanups.push(() => r.unmount());
    r.stdin.write('a');
    await tick();
    expect(aggregate).toBe(1);
  });

  it('"e" invokes onExport', async () => {
    let exp = 0;
    const r = render(
      React.createElement(App, {
        model: makeModel(),
        onQuit: () => {},
        onExport: () => (exp += 1),
      }),
    );
    cleanups.push(() => r.unmount());
    r.stdin.write('e');
    await tick();
    expect(exp).toBe(1);
  });

  it('"q" invokes onQuit (single Ctrl+C equivalent) and does not fire aggregate/export', async () => {
    let quit = 0;
    let aggregate = 0;
    let exp = 0;
    const r = render(
      React.createElement(App, {
        model: makeModel(),
        onQuit: () => (quit += 1),
        onAggregate: () => (aggregate += 1),
        onExport: () => (exp += 1),
      }),
    );
    cleanups.push(() => r.unmount());
    r.stdin.write('q');
    await tick();
    expect(quit).toBe(1);
    expect(aggregate).toBe(0);
    expect(exp).toBe(0);
  });

  it('hotkeys are no-ops (no throw) when the host did not wire handlers', async () => {
    const r = render(React.createElement(App, { model: makeModel(), onQuit: () => {} }));
    cleanups.push(() => r.unmount());
    expect(() => {
      r.stdin.write('a');
      r.stdin.write('e');
    }).not.toThrow();
    await tick();
  });

  it('advertises a/e in the footer only when handlers are wired', () => {
    const wired = render(
      React.createElement(App, {
        model: makeModel(),
        onQuit: () => {},
        onAggregate: () => {},
        onExport: () => {},
      }),
    );
    cleanups.push(() => wired.unmount());
    const wiredFrame = wired.lastFrame()!;
    expect(wiredFrame).toContain('a aggregate');
    expect(wiredFrame).toContain('e export');

    const bare = render(React.createElement(App, { model: makeModel(), onQuit: () => {} }));
    cleanups.push(() => bare.unmount());
    const bareFrame = bare.lastFrame()!;
    expect(bareFrame).not.toContain('a aggregate');
    expect(bareFrame).not.toContain('e export');
  });
});
