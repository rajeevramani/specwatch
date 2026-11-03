/**
 * Locks the approved 0.4.0 local candidate version across package.json and the CLI `--version`.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createProgram } from '../../src/cli/commands.js';

const EXPECTED = '0.4.0';

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

  it('plugin version matches the approved candidate', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const plugin = JSON.parse(
      readFileSync(join(here, '../../specwatch-plugin/.claude-plugin/plugin.json'), 'utf8'),
    ) as { version: string };
    expect(plugin.version).toBe(EXPECTED);
  });

  it('minimum runtime and CI agree with the approved Node22 policy', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '../../package.json'), 'utf8')) as {
      engines: { node: string };
    };
    const lock = JSON.parse(readFileSync(join(here, '../../package-lock.json'), 'utf8')) as {
      packages: Record<string, { engines?: { node?: string } }>;
    };
    expect(pkg.engines.node).toBe('>=22');
    expect(lock.packages['']?.engines?.node).toBe('>=22');
    const workflow = readFileSync(join(here, '../../.github/workflows/ci.yml'), 'utf8');
    expect(workflow).toMatch(/node-version: \[22\]/);
    expect(workflow).not.toMatch(/node-version: \[20/);
  });

  it('CLI --version reports the same version', () => {
    expect(createProgram().version()).toBe(EXPECTED);
  });
});
