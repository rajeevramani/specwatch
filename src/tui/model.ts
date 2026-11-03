/**
 * DashboardModel — decoupled event store for the live capture TUI.
 *
 * The proxy capture handler feeds events in via record*(); the Ink dashboard
 * subscribes via onChange() and re-renders. Keeps the proxy pipeline free of
 * any UI/React dependency.
 */

import { EventEmitter } from 'node:events';

export interface EndpointRow {
  key: string; // `${method} ${normalizedPath}`
  method: string;
  path: string;
  hits: number;
  statuses: Set<number>;
  lastStatus: number;
}

export interface DashboardState {
  target: string;
  proxyUrl: string;
  sessionId: string;
  sessionName?: string;
  maxSamples?: number;
  autoAggregate: boolean;
  startedAt: number;
  sampleCount: number;
  skippedCount: number;
  snapshot: number;
  samplesSinceSnapshot: number;
  endpoints: Map<string, EndpointRow>;
  lastMessage?: string;
}

export interface DashboardInit {
  target: string;
  proxyUrl: string;
  sessionId: string;
  sessionName?: string;
  maxSamples?: number;
  autoAggregate: boolean;
  startedAt: number;
}

export class DashboardModel extends EventEmitter {
  readonly state: DashboardState;

  constructor(init: DashboardInit) {
    super();
    this.state = {
      ...init,
      sampleCount: 0,
      skippedCount: 0,
      snapshot: 0,
      samplesSinceSnapshot: 0,
      endpoints: new Map(),
    };
  }

  onChange(listener: () => void): () => void {
    this.on('change', listener);
    return () => this.off('change', listener);
  }

  recordSample(method: string, normalizedPath: string, statusCode: number): void {
    const key = `${method} ${normalizedPath}`;
    let row = this.state.endpoints.get(key);
    if (!row) {
      row = { key, method, path: normalizedPath, hits: 0, statuses: new Set(), lastStatus: statusCode };
      this.state.endpoints.set(key, row);
    }
    row.hits += 1;
    row.statuses.add(statusCode);
    row.lastStatus = statusCode;
    this.state.sampleCount += 1;
    this.state.samplesSinceSnapshot += 1;
    this.emit('change');
  }

  recordSkipped(): void {
    this.state.skippedCount += 1;
    this.emit('change');
  }

  recordSnapshot(snapshot: number, message?: string): void {
    this.state.snapshot = snapshot;
    this.state.samplesSinceSnapshot = 0;
    if (message) this.state.lastMessage = message;
    this.emit('change');
  }

  setMessage(message: string): void {
    this.state.lastMessage = message;
    this.emit('change');
  }
}
