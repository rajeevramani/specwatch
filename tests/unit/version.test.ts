/**
 * Locks the 0.3.4 release version across package.json and the CLI `--version`.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createProgram } from '../../src/cli/commands.js';

const EXPECTED = '0.3.4';

describe('release version', () => {
  it('package.json version is pinned', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '../../package.json'), 'utf8')) as {
      version: string;
    };
    expect(pkg.version).toBe(EXPECTED);
  });

  it('package-lock.json version matches (no release drift)', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const lock = JSON.parse(readFileSync(join(here, '../../package-lock.json'), 'utf8')) as {
      version: string;
      packages: Record<string, { version?: string }>;
    };
    expect(lock.version).toBe(EXPECTED);
    expect(lock.packages['']?.version).toBe(EXPECTED);
  });

  it('CLI --version reports the same version', () => {
    expect(createProgram().version()).toBe(EXPECTED);
  });
});
