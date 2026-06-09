import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseSpec, scoreSpec } from '../../packages/agentready-scoring/src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const GOLD_PATH = resolve(here, '../../specs/gold.yaml');

/**
 * Calibration acceptance (bead specwatch-ag5.5).
 *
 * Demonstrates the corrected Specwatch -> Agent Ready Score loop end-to-end:
 * THIN write-response runtime evidence must produce WEAKER runtime readiness
 * than RICH write-response evidence, scored through the real embedded
 * `x-specwatch-agent` consumption path (the same one the contract test in
 * specwatch-ag5.4 pins).
 *
 * This is a deterministic comparison: rather than a live agent sweep, it
 * overlays representative per-operation runtime evidence (camelCase
 * x-specwatch-agent) on the gold spec's write operations — thin (low
 * completeness + verification loops) vs rich (full completeness, no loops) —
 * and scores both. See eval/calibration/FINDINGS.md for the recorded numbers.
 */

const WRITE_METHODS = new Set(['post', 'put', 'patch']);

interface AgentExt {
  responseCompleteness?: number;
  missingFields?: string[];
  verificationLoopDetected?: boolean;
  verificationLoopCount?: number;
  commonNextSteps?: string[];
}

function loadGold(): any {
  return parseSpec(readFileSync(GOLD_PATH, 'utf8'));
}

/** Deep-clone the gold spec and attach the given runtime evidence to every write op. */
function withWriteEvidence(ext: AgentExt): any {
  const spec = JSON.parse(JSON.stringify(loadGold()));
  for (const pathItem of Object.values<any>(spec.paths ?? {})) {
    for (const [method, op] of Object.entries<any>(pathItem)) {
      if (WRITE_METHODS.has(method) && op && typeof op === 'object') {
        op['x-specwatch-agent'] = ext;
      }
    }
  }
  return spec;
}

const THIN: AgentExt = {
  responseCompleteness: 0.2,
  missingFields: ['id', 'createdAt'],
  verificationLoopDetected: true,
  verificationLoopCount: 3,
};
const RICH: AgentExt = {
  responseCompleteness: 1.0,
  verificationLoopDetected: false,
  verificationLoopCount: 0,
};

describe('calibration: thin vs rich write-response readiness evidence', () => {
  it('thin write-response evidence scores lower than rich', () => {
    const baseline = scoreSpec(loadGold());
    const thin = scoreSpec(withWriteEvidence(THIN));
    const rich = scoreSpec(withWriteEvidence(RICH));

    // Direction: rich runtime evidence beats thin.
    expect(rich.overall).toBeGreaterThan(thin.overall);
    // Thin runtime evidence drags the score below the evidence-free baseline.
    expect(thin.overall).toBeLessThan(baseline.overall);
    // Both runtime runs are actually consuming the embedded extension.
    expect(thin.runtimeVerified).toBe(true);
    expect(rich.runtimeVerified).toBe(true);

    // Recorded for FINDINGS.md (visible with `--reporter=verbose` or on failure).
    console.log(
      `[calibration ag5.5] baseline=${baseline.overall} rich=${rich.overall} thin=${thin.overall} ` +
        `(rich-thin=${rich.overall - thin.overall})`,
    );
  });
});
