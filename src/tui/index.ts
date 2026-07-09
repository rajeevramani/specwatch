/**
 * Entry point for the live capture TUI. Renders the Ink dashboard over a
 * DashboardModel and returns an unmount handle.
 *
 * Gate on TTY at the call site — this must not be used when stdout is piped.
 */

import React from 'react';
import { render } from 'ink';
import { App } from './App.js';
import { DashboardModel } from './model.js';

export { DashboardModel } from './model.js';
export type { DashboardInit } from './model.js';

export interface DashboardHandle {
  unmount: () => void;
}

export function renderDashboard(
  model: DashboardModel,
  opts: { onQuit: () => void; onAggregate?: () => void; onExport?: () => void },
): DashboardHandle {
  const instance = render(
    React.createElement(App, {
      model,
      onQuit: opts.onQuit,
      onAggregate: opts.onAggregate,
      onExport: opts.onExport,
    }),
    {
      // Our SIGINT/quit path runs aggregation; don't let Ink hard-exit first.
      exitOnCtrlC: false,
    },
  );
  return {
    unmount: () => instance.unmount(),
  };
}
