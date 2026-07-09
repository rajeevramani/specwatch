/**
 * Unit tests for the live-dashboard scroll affordance (S2). With more endpoints
 * than fit the 15-row viewport, the user can scroll the window with ↑/↓ (or k/j)
 * and the above/below indicators track the hidden counts.
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

function modelWith(n: number): DashboardModel {
  const model = new DashboardModel({
    target: 'https://api.example.com',
    proxyUrl: 'http://localhost:8080',
    sessionId: 'abcdef1234',
    autoAggregate: false,
    startedAt: 1_000_000,
  });
  // Decreasing hits => deterministic sort order r00 (most) .. r(n-1) (least).
  for (let i = 0; i < n; i++) {
    const hits = n - i;
    for (let h = 0; h < hits; h++)
      model.recordSample('GET', `/r${String(i).padStart(2, '0')}`, 200);
  }
  return model;
}

function renderApp(model: DashboardModel) {
  const r = render(React.createElement(App, { model, onQuit: () => {} }));
  cleanups.push(() => r.unmount());
  return r;
}

const tick = () => new Promise((res) => setTimeout(res, 20));

describe('TUI scroll affordance', () => {
  it('shows no scroll indicators when endpoints fit the viewport (<=15)', () => {
    const { lastFrame } = renderApp(modelWith(10));
    const frame = lastFrame()!;
    expect(frame).not.toContain('more below');
    expect(frame).not.toContain('more above');
    // no scroll hint in the footer when everything fits
    expect(frame).not.toContain('j/k scroll');
  });

  it('shows a scroll hint and "more below" when endpoints exceed the viewport', () => {
    const { lastFrame } = renderApp(modelWith(20));
    const frame = lastFrame()!;
    expect(frame).toContain('▼ 5 more below');
    expect(frame).toContain('j/k scroll');
  });

  it('scrolling down reveals rows below and surfaces an "above" indicator', async () => {
    const r = renderApp(modelWith(20));
    expect(r.lastFrame()).not.toContain('/r19');
    // scroll down past the full 5 hidden rows (arrow key)
    for (let i = 0; i < 5; i++) {
      r.stdin.write('[B'); // Down arrow
      await tick();
    }
    const frame = r.lastFrame()!;
    expect(frame).toContain('/r19'); // last endpoint now visible
    expect(frame).toContain('▲ 5 more above');
    expect(frame).not.toContain('more below'); // reached the bottom
  });

  it('supports vim-style j/k and clamps at the top', async () => {
    const r = renderApp(modelWith(20));
    r.stdin.write('j'); // down
    await tick();
    expect(r.lastFrame()).toContain('▲ 1 more above');
    r.stdin.write('k'); // up
    await tick();
    r.stdin.write('k'); // up again — should clamp at offset 0, not go negative
    await tick();
    const frame = r.lastFrame()!;
    expect(frame).not.toContain('more above');
    expect(frame).toContain('▼ 5 more below');
  });
});
