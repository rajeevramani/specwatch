/**
 * Live capture dashboard (Ink). Subscribes to a DashboardModel and re-renders
 * as the proxy records samples. TTY-only — see src/tui/index.ts for the gate.
 */

import React, { useEffect, useReducer, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import Spinner from 'ink-spinner';
import type { DashboardModel, EndpointRow } from './model.js';

const MAX_ROWS = 15;

function fmtUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return hh > 0 ? `${pad(hh)}:${pad(mm)}:${pad(ss)}` : `${pad(mm)}:${pad(ss)}`;
}

function statusColor(code: number): string {
  if (code >= 500) return 'red';
  if (code >= 400) return 'yellow';
  if (code >= 300) return 'cyan';
  if (code >= 200) return 'green';
  return 'gray';
}

function ProgressBar({ value, max, width = 24 }: { value: number; max: number; width?: number }) {
  const ratio = max > 0 ? Math.min(1, value / max) : 0;
  const filled = Math.round(ratio * width);
  return (
    <Text>
      <Text color="cyan">{'▓'.repeat(filled)}</Text>
      <Text dimColor>{'░'.repeat(width - filled)}</Text>
      <Text> {Math.round(ratio * 100)}%</Text>
    </Text>
  );
}

function Row({ row }: { row: EndpointRow }) {
  const statuses = [...row.statuses].sort((a, b) => a - b);
  return (
    <Box>
      <Box width={7}>
        <Text color="magenta">{row.method.padEnd(6)}</Text>
      </Box>
      <Box width={40}>
        <Text>{row.path.length > 39 ? row.path.slice(0, 38) + '…' : row.path}</Text>
      </Box>
      <Box width={7}>
        <Text color="white">{String(row.hits).padStart(5)}</Text>
      </Box>
      <Box>
        <Text>
          {statuses.map((s, i) => (
            <Text key={s} color={statusColor(s)}>
              {i > 0 ? ' ' : ''}
              {s}
            </Text>
          ))}
        </Text>
      </Box>
    </Box>
  );
}

export interface AppProps {
  model: DashboardModel;
  onQuit: () => void;
}

export function App({ model, onQuit }: AppProps) {
  const { exit } = useApp();
  const [, force] = useReducer((n: number) => n + 1, 0);
  const [now, setNow] = useState(model.state.startedAt);
  const [scrollOffset, setScrollOffset] = useState(0);

  // Re-render on model changes.
  useEffect(() => model.onChange(force), [model]);

  // Uptime tick.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const s = model.state;
  const rows = [...s.endpoints.values()].sort((a, b) => b.hits - a.hits);
  // Windowed scroll: the viewport shows MAX_ROWS rows starting at scrollOffset.
  // Clamp against the current row count so the window stays valid as endpoints
  // appear/disappear under a live-updating table.
  const maxOffset = Math.max(0, rows.length - MAX_ROWS);
  const offset = Math.min(scrollOffset, maxOffset);
  const shown = rows.slice(offset, offset + MAX_ROWS);
  const hiddenAbove = offset;
  const hiddenBelow = rows.length - (offset + shown.length);

  useInput((input, key) => {
    if (input === 'q' || (key.ctrl && input === 'c')) {
      exit();
      onQuit();
      return;
    }
    // Scroll the endpoint viewport. Up/Down arrows or k/j (vim-style).
    if (key.downArrow || input === 'j') {
      setScrollOffset((o) => Math.min(o + 1, maxOffset));
    } else if (key.upArrow || input === 'k') {
      setScrollOffset((o) => Math.max(o - 1, 0));
    }
  });

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Box>
        <Text color="cyan" bold>
          <Spinner type="dots" /> specwatch
        </Text>
        <Text> {s.sessionName ?? s.sessionId.slice(0, 8)}</Text>
        <Text dimColor>
          {'   '}
          {s.proxyUrl} → {s.target}
        </Text>
      </Box>

      {/* Stats line */}
      <Box marginTop={1}>
        <Text dimColor>Uptime </Text>
        <Text>{fmtUptime(now - s.startedAt)}</Text>
        <Text dimColor> Endpoints </Text>
        <Text>{s.endpoints.size}</Text>
        <Text dimColor> Samples </Text>
        <Text color="green">{s.sampleCount}</Text>
        {s.maxSamples !== undefined && <Text dimColor>/{s.maxSamples}</Text>}
        {s.skippedCount > 0 && <Text dimColor> Skipped {s.skippedCount}</Text>}
        {s.autoAggregate && (
          <Text>
            <Text dimColor> Snapshot </Text>
            <Text color="yellow">{s.snapshot}</Text>
          </Text>
        )}
      </Box>

      {/* Progress bar toward next snapshot / max */}
      {s.maxSamples !== undefined && (
        <Box marginTop={1}>
          <ProgressBar value={s.samplesSinceSnapshot} max={s.maxSamples} />
        </Box>
      )}

      {/* Table header */}
      <Box marginTop={1}>
        <Box width={7}>
          <Text dimColor bold>
            METHOD
          </Text>
        </Box>
        <Box width={40}>
          <Text dimColor bold>
            PATH
          </Text>
        </Box>
        <Box width={7}>
          <Text dimColor bold>
            {' HITS'}
          </Text>
        </Box>
        <Box>
          <Text dimColor bold>
            STATUS
          </Text>
        </Box>
      </Box>

      {/* Rows (windowed viewport — scroll with ↑/↓ or k/j) */}
      {shown.length === 0 ? (
        <Box>
          <Text dimColor>Waiting for traffic… point your client at {s.proxyUrl}</Text>
        </Box>
      ) : (
        <>
          {hiddenAbove > 0 && (
            <Box>
              <Text dimColor>▲ {hiddenAbove} more above</Text>
            </Box>
          )}
          {shown.map((row) => (
            <Row key={row.key} row={row} />
          ))}
          {hiddenBelow > 0 && (
            <Box>
              <Text dimColor>▼ {hiddenBelow} more below</Text>
            </Box>
          )}
        </>
      )}

      {/* Footer */}
      <Box marginTop={1}>
        {s.lastMessage ? (
          <Text color="yellow">{s.lastMessage}</Text>
        ) : (
          <Text dimColor>
            {rows.length > MAX_ROWS ? '↑/↓ or j/k scroll   ' : ''}q or Ctrl+C — stop & aggregate
          </Text>
        )}
      </Box>
    </Box>
  );
}
