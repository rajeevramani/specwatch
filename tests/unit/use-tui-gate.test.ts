/**
 * Approved 0.4.0 contract: the legacy dashboard is dormant. All capture
 * contexts, including interactive human terminals, use the line printer.
 */

import { describe, it, expect } from 'vitest';
import { shouldUseTui } from '../../src/cli/output.js';

describe('shouldUseTui gate', () => {
  it('keeps the dashboard dormant even for interactive human capture', () => {
    expect(shouldUseTui(true, 'human', false)).toBe(false);
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
      [true, 'human', false, false],
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
