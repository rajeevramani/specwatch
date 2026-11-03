import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import {
  REQUIRED_CHECKS,
  parseArguments,
  summarizeChecks,
} from '../../scripts/qualify-candidate.mjs';

const complete = (): Array<{ name: string; status: string | undefined }> =>
  REQUIRED_CHECKS.map((name) => ({ name, status: 'passed' }));

describe('candidate qualification argument and result contracts', () => {
  it('accepts only an explicit absolute output path', () => {
    const output = resolve('owned-qualification-output');
    expect(parseArguments(['--output', output])).toEqual({ output });
  });

  it('supports side-effect-free help', () => {
    expect(parseArguments(['--help'])).toEqual({ help: true });
  });

  it.each([
    [],
    ['--output'],
    ['--output', 'relative-directory'],
    ['--output', ''],
    ['--unknown', '/owned'],
    ['--output', '/owned', '--output', '/other'],
    ['--help', '--output', '/owned'],
  ])('rejects malformed argv %j', (...args) => {
    expect(() => parseArguments(args)).toThrow('fresh absolute directory');
  });

  it('accepts exactly the complete successful check set', () => {
    expect(summarizeChecks(complete())).toEqual({
      status: 'passed',
      total: REQUIRED_CHECKS.length,
    });
  });

  it('rejects empty or missing results', () => {
    expect(() => summarizeChecks([])).toThrow('incomplete');
    expect(() => summarizeChecks(undefined)).toThrow('incomplete');
  });

  it('rejects an omitted case instead of claiming partial success', () => {
    expect(() => summarizeChecks(complete().slice(1))).toThrow('incomplete');
  });

  it('rejects duplicate case names even at the expected total', () => {
    const checks = complete();
    checks[1] = checks[0];
    expect(() => summarizeChecks(checks)).toThrow('duplicated');
  });

  it.each(['failed', 'skipped', 'pending', undefined])('rejects %s results', (status) => {
    const checks = complete();
    checks[0] = { ...checks[0], status };
    expect(() => summarizeChecks(checks)).toThrow('failed or skipped');
  });

  it('rejects unknown check names', () => {
    const checks = complete();
    checks[0] = { name: 'unverified-claim', status: 'passed' };
    expect(() => summarizeChecks(checks)).toThrow('invalid');
  });
});
