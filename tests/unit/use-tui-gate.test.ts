/**
 * Unit tests for the useTui gate predicate — the TUI renders only for an
 * interactive, human, non-quiet session; every other combination falls back
 * to the line printer.
 */

import { describe, it, expect } from 'vitest';
import { shouldUseTui } from '../../src/cli/output.js';

describe('shouldUseTui gate', () => {
  it('true only for interactive + human + not quiet', () => {
    expect(shouldUseTui(true, 'human', false)).toBe(true);
  });

  it('false when stdout is not a TTY (piped)', () => {
    expect(shouldUseTui(false, 'human', false)).toBe(false);
  });

  it('false for agent consumer even on a TTY', () => {
    expect(shouldUseTui(true, 'agent', false)).toBe(false);
  });

  it('false when quiet', () => {
    expect(shouldUseTui(true, 'human', true)).toBe(false);
  });

  it('full truth matrix', () => {
    const rows: Array<[boolean, string, boolean, boolean]> = [
      [true, 'human', false, true],
      [true, 'human', true, false],
      [true, 'agent', false, false],
      [true, 'agent', true, false],
      [false, 'human', false, false],
      [false, 'human', true, false],
      [false, 'agent', false, false],
      [false, 'agent', true, false],
    ];
    for (const [tty, consumer, quiet, expected] of rows) {
      expect(shouldUseTui(tty, consumer, quiet)).toBe(expected);
    }
  });
});
