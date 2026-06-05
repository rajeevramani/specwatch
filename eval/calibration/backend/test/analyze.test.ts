import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  analyze,
  loadInputs,
  renderReport,
  twoProportionZ,
  pearson,
  SIGNAL_TO_JAIRF_KEYS,
  type AnalysisResult,
} from '../../analyze.js';

/**
 * Calibration analysis acceptance test (specwatch-51h).
 *
 * Proves — against the COMMITTED fixture run-artifacts (fixtures/runs/*.json),
 * with zero paid calls — that analyze.ts:
 *   - joins {variant -> JAIRF signals + score} x {per-(variant,task) success} x
 *     {specwatch telemetry};
 *   - emits a POPULATED signal->success table (gold vs degraded + delta per
 *     ablated signal);
 *   - flags which signals move success (directionally + significance);
 *   - compares static-only vs static+telemetry prediction;
 *   - renders a markdown report carrying all of the above.
 */

const here = dirname(fileURLToPath(import.meta.url));
const CALIB_ROOT = resolve(here, '../..');
const MANIFEST = resolve(CALIB_ROOT, 'variants/manifest.json');
const FIXTURES = resolve(CALIB_ROOT, 'fixtures/runs');

function runFixtureAnalysis(): AnalysisResult {
  const inputs = loadInputs({ manifestPath: MANIFEST, runsDir: FIXTURES });
  return analyze(inputs);
}

describe('analyze (signal -> success, on committed fixtures)', () => {
  it('loads the manifest + fixture run/capture artifacts and joins them', () => {
    const inputs = loadInputs({ manifestPath: MANIFEST, runsDir: FIXTURES });
    // One run + one capture per manifest variant.
    expect(inputs.runs.length).toBe(inputs.manifest.variants.length);
    expect(inputs.captures.length).toBe(inputs.manifest.variants.length);
    // Provenance recorded.
    expect(inputs.sources?.runs.length).toBeGreaterThan(0);
    expect(inputs.sources?.captures.length).toBeGreaterThan(0);
  });

  it('produces a populated signal->success table with one row per single-signal ablation', () => {
    const r = runFixtureAnalysis();

    // Five phase-1 single-signal ablations (descriptions, operationId, examples,
    // errorSchemas, completeness). all-bad (multi-signal) is excluded from the table.
    const signals = r.signalTable.map((row) => row.signal).sort();
    expect(signals).toEqual(
      ['completeness', 'descriptions', 'errorSchemas', 'examples', 'operationId'].sort(),
    );
    expect(r.signalTable.length).toBe(5);

    // Every row carries the join contract.
    for (const row of r.signalTable) {
      expect(typeof row.goldSuccessRate).toBe('number');
      expect(typeof row.degradedSuccessRate).toBe('number');
      expect(typeof row.successDelta).toBe('number');
      expect(typeof row.pValue).toBe('number');
      expect(typeof row.significant).toBe('boolean');
      expect(typeof row.directional).toBe('boolean');
      // JAIRF key drops are labelled from the manifest signal scores.
      for (const k of row.jairfKeys) {
        expect(k.drop).toBe(k.gold - k.degraded);
      }
    }
  });

  it('attributes the right JAIRF key drops to each signal', () => {
    const r = runFixtureAnalysis();
    const byName = new Map(r.signalTable.map((row) => [row.signal, row]));

    // descriptions row drops description_coverage from gold(100) to degraded(26).
    const desc = byName.get('descriptions')!;
    const descCov = desc.jairfKeys.find((k) => k.key === 'description_coverage')!;
    expect(descCov.gold).toBe(100);
    expect(descCov.degraded).toBe(26);
    expect(descCov.drop).toBe(74);

    // operationId row reflects operationid_quality 100 -> 22.
    const op = byName.get('operationId')!;
    const opQual = op.jairfKeys.find((k) => k.key === 'operationid_quality')!;
    expect(opQual.drop).toBe(78);

    // completeness is runtime-only: no static JAIRF keys map to it.
    expect(SIGNAL_TO_JAIRF_KEYS.completeness).toEqual([]);
    expect(byName.get('completeness')!.runtimeDriven).toBe(true);
    expect(byName.get('completeness')!.jairfKeys.length).toBe(0);
  });

  it('captures the success gradient: degrading operationId / errorSchemas / descriptions hurts', () => {
    const r = runFixtureAnalysis();
    const byName = new Map(r.signalTable.map((row) => [row.signal, row]));

    // Gold baseline is 100% for every row.
    for (const row of r.signalTable) expect(row.goldSuccessRate).toBe(1);

    // The illustrative fixture gradient: these three drop success.
    expect(byName.get('operationId')!.successDelta).toBeLessThan(0);
    expect(byName.get('errorSchemas')!.successDelta).toBeLessThan(0);
    expect(byName.get('descriptions')!.successDelta).toBeLessThan(0);

    // examples + completeness hold success here (examples barely matters;
    // completeness shows up only in telemetry, not ground-truth success).
    expect(byName.get('examples')!.successDelta).toBe(0);
    expect(byName.get('completeness')!.successDelta).toBe(0);

    // Directional movers are ranked most-harmful-first and exclude the no-movers.
    const movers = r.directionalMovers.map((m) => m.signal);
    expect(movers).toContain('operationId');
    expect(movers).toContain('errorSchemas');
    expect(movers).toContain('descriptions');
    expect(movers).not.toContain('examples');
    expect(movers).not.toContain('completeness');
    // Sorted ascending by delta (most negative first).
    const deltas = r.directionalMovers.map((m) => m.successDelta);
    expect([...deltas].sort((a, b) => a - b)).toEqual(deltas);
  });

  it('joins specwatch telemetry: struggle telemetry rises as the spec degrades', () => {
    const r = runFixtureAnalysis();
    const byName = new Map(r.variants.map((v) => [v.variant, v]));

    // Gold has zero struggle; all-bad has the most.
    expect(byName.get('gold')!.telemetry.verificationLoops).toBe(0);
    expect(byName.get('all-bad')!.telemetry.verificationLoops).toBeGreaterThan(0);
    expect(byName.get('all-bad')!.telemetry.wastedRequests).toBeGreaterThan(
      byName.get('gold')!.telemetry.wastedRequests,
    );

    // thin-responses is the runtime-completeness variant: avg completeness < 1.
    const thin = byName.get('thin-responses')!;
    expect(thin.telemetry.avgResponseCompleteness).not.toBeNull();
    expect(thin.telemetry.avgResponseCompleteness!).toBeLessThan(1);
    expect(thin.telemetry.thinEndpointCount).toBeGreaterThan(0);
  });

  it('compares static-only vs static+telemetry prediction', () => {
    const r = runFixtureAnalysis();
    expect(r.prediction.staticOnly.n).toBe(r.variants.length);
    expect(r.prediction.staticPlusRuntime.n).toBe(r.variants.length);
    // R^2 in [0, 1].
    expect(r.prediction.staticOnly.rSquared).toBeGreaterThanOrEqual(0);
    expect(r.prediction.staticOnly.rSquared).toBeLessThanOrEqual(1);
    // The thesis check: static JAIRF correlates positively with success.
    expect(r.prediction.staticOnly.pearson).toBeGreaterThan(0);
    expect(r.prediction.rSquaredGain).toBe(
      r.prediction.staticPlusRuntime.rSquared - r.prediction.staticOnly.rSquared,
    );
    expect(typeof r.prediction.verdict).toBe('string');
    expect(r.prediction.verdict.length).toBeGreaterThan(0);
  });

  it('renders a markdown report with the signal->success table and all sections', () => {
    const r = runFixtureAnalysis();
    const md = renderReport(r);

    expect(md).toContain('# Calibration report');
    expect(md).toContain('Signal → success table');
    // The table header.
    expect(md).toContain('| JAIRF signal | Variant | JAIRF key drop |');
    // Each ablated signal appears as a row.
    for (const signal of [
      'descriptions',
      'operationId',
      'examples',
      'errorSchemas',
      'completeness',
    ]) {
      expect(md).toContain(`\`${signal}\``);
    }
    // Prediction + provenance sections present.
    expect(md).toContain('Prediction quality');
    expect(md).toContain('Static-only JAIRF');
    expect(md).toContain('Static + specwatch telemetry');
    expect(md).toContain('## Provenance');
    // At least one non-zero delta is shown (table is genuinely populated).
    expect(md).toMatch(/-\d+pp/);
  });

  it('committed report.md on disk matches a fresh render of the fixtures', () => {
    // Guards against the committed report drifting from the fixtures it claims to
    // summarise. We compare the table body (deltas/significance), not the
    // timestamp line which is intentionally non-deterministic.
    const committed = readFileSync(resolve(CALIB_ROOT, 'reports/report.md'), 'utf8');
    const r = runFixtureAnalysis();
    const fresh = renderReport(r);

    const tableOf = (s: string) => {
      const start = s.indexOf('| JAIRF signal');
      const end = s.indexOf('## 2.');
      return s.slice(start, end).trim();
    };
    expect(tableOf(committed)).toBe(tableOf(fresh));
  });
});

describe('analyze statistics helpers', () => {
  it('twoProportionZ: identical proportions => z 0, p 1', () => {
    const { z, p } = twoProportionZ(5, 5, 5, 5);
    expect(z).toBe(0);
    expect(p).toBe(1);
  });

  it('twoProportionZ: a clear drop yields a negative z and p < 1', () => {
    const { z, p } = twoProportionZ(100, 100, 50, 100);
    expect(z).toBeGreaterThan(0); // gold(1.0) - degraded(0.5) > 0
    expect(p).toBeLessThan(0.05);
  });

  it('twoProportionZ: empty samples are safe', () => {
    expect(twoProportionZ(0, 0, 0, 0)).toEqual({ z: 0, p: 1 });
  });

  it('pearson: perfect positive correlation is 1', () => {
    expect(pearson([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 6);
  });

  it('pearson: zero-variance input is safe (returns 0)', () => {
    expect(pearson([1, 1, 1], [1, 2, 3])).toBe(0);
  });
});
