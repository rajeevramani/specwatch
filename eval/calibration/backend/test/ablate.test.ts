import { describe, it, expect } from 'vitest';
import {
  loadGold,
  generate,
  buildVariant,
  signalScores,
  VARIANTS,
  SIGNAL_FAMILIES,
  type SignalFamily,
} from '../../ablate.js';
import { scoreSpec } from '../../packages/agentready-scoring/src/index.js';

/**
 * Ablation generator acceptance test (specwatch-sl1).
 *
 * Guarantees:
 *  1. Exactly 5 single-signal variants + 1 all-bad variant (+ the gold copy).
 *  2. Each emitted variant is a valid OpenAPI 3.1 document.
 *  3. Each spec-level variant differs from gold in EXACTLY ONE signal family
 *     (the diff of changed JAIRF signal ids is a subset of that family, and is
 *     non-empty) — clean attribution. The runtime-driven completeness variant
 *     is byte-identical to gold (degradation happens via the backend toggle).
 *  4. The all-bad variant moves signals from every spec-level family.
 *  5. The manifest tags each variant with the JAIRF score AgentReady computes
 *     for it + a per-signal breakdown, and degrading a signal lowers the score.
 */

const gold = loadGold();
const generated = generate(gold);
const byName = new Map(generated.map((g) => [g.def.name, g]));

/** Signal ids whose score differs between two specs. */
function changedSignals(specA: any, specB: any): string[] {
  const a = signalScores(scoreSpec(specA));
  const b = signalScores(scoreSpec(specB));
  return Object.keys(a).filter((id) => a[id] !== b[id]);
}

describe('ablation generator — variant set', () => {
  it('emits gold + 5 single-signal variants + 1 all-bad variant', () => {
    const names = VARIANTS.map((v) => v.name);
    expect(names).toEqual([
      'gold',
      'no-descriptions',
      'bad-operationids',
      'no-examples',
      'no-error-schemas',
      'thin-responses',
      'all-bad',
    ]);

    const singleSignal = VARIANTS.filter(
      (v) => v.name !== 'gold' && v.name !== 'all-bad' && v.degrades.length === 1,
    );
    expect(singleSignal).toHaveLength(5);

    // Each phase-1 family is covered by exactly one single-signal variant.
    const families = singleSignal.map((v) => v.degrades[0]).sort();
    expect(families).toEqual(
      (['completeness', 'descriptions', 'errorSchemas', 'examples', 'operationId'] as SignalFamily[]).sort(),
    );

    const allBad = VARIANTS.find((v) => v.name === 'all-bad')!;
    expect(allBad.degrades).toEqual([
      'descriptions',
      'operationId',
      'examples',
      'errorSchemas',
      'completeness',
    ]);
  });
});

describe('ablation generator — valid OpenAPI 3.1', () => {
  for (const { def, spec } of generated) {
    it(`${def.name} is a well-formed OpenAPI 3.1 document`, () => {
      expect(spec.openapi).toBe('3.1.0');
      expect(spec.info?.title).toBeTruthy();
      expect(spec.info?.version).toBeTruthy();
      expect(Object.keys(spec.paths ?? {}).length).toBeGreaterThan(0);
      // Same operation count as gold — ablations degrade signals, never remove
      // operations (that would change the agent's tool surface).
      expect(scoreSpec(spec).operationCount).toBe(scoreSpec(gold).operationCount);
      // No leftover gate-tripping issues (the ablations target quality signals,
      // not validity/security gates).
      expect(scoreSpec(spec).gates).toHaveLength(0);
    });
  }
});

describe('ablation generator — single-signal attribution', () => {
  const goldSpec = byName.get('gold')!.spec;

  const cases: Array<[string, SignalFamily]> = [
    ['no-descriptions', 'descriptions'],
    ['bad-operationids', 'operationId'],
    ['no-examples', 'examples'],
    ['no-error-schemas', 'errorSchemas'],
  ];

  for (const [name, family] of cases) {
    it(`${name} changes only ${family}-family signals (and at least one)`, () => {
      const variant = byName.get(name)!.spec;
      const changed = changedSignals(goldSpec, variant);
      // Non-empty: the variant genuinely degrades something.
      expect(changed.length).toBeGreaterThan(0);
      // Subset of the family: nothing outside this family moved.
      const allowed = new Set(SIGNAL_FAMILIES[family]);
      const leaked = changed.filter((id) => !allowed.has(id));
      expect(leaked, `${name} leaked into non-${family} signals: ${leaked.join(', ')}`).toEqual([]);
      // The family's primary signal actually dropped vs gold.
      const goldSignals = signalScores(scoreSpec(goldSpec));
      const variantSignals = signalScores(scoreSpec(variant));
      const dropped = SIGNAL_FAMILIES[family].filter((id) => variantSignals[id] < goldSignals[id]);
      expect(dropped.length, `no ${family} signal dropped`).toBeGreaterThan(0);
    });
  }

  it('thin-responses is byte-identical to gold (runtime-driven, not a spec edit)', () => {
    const variant = byName.get('thin-responses')!.spec;
    expect(JSON.stringify(variant)).toBe(JSON.stringify(goldSpec));
    expect(changedSignals(goldSpec, variant)).toEqual([]);
    const def = VARIANTS.find((v) => v.name === 'thin-responses')!;
    expect(def.runtimeDriven).toBe(true);
    expect(def.degrades).toEqual(['completeness']);
  });

  it('all-bad moves signals from every spec-level family', () => {
    const allBad = byName.get('all-bad')!.spec;
    const changed = new Set(changedSignals(goldSpec, allBad));
    for (const family of ['descriptions', 'operationId', 'examples', 'errorSchemas'] as SignalFamily[]) {
      const moved = SIGNAL_FAMILIES[family].some((id) => changed.has(id));
      expect(moved, `all-bad did not move any ${family} signal`).toBe(true);
    }
  });
});

describe('ablation generator — manifest scores', () => {
  it('tags every variant with a JAIRF score + per-signal breakdown', () => {
    for (const { def, entry } of generated) {
      expect(entry.name).toBe(def.name);
      expect(entry.jairf.overall).toBeGreaterThan(0);
      expect(entry.jairf.overall).toBeLessThanOrEqual(100);
      expect(['A', 'B', 'C', 'D', 'F']).toContain(entry.jairf.grade);
      expect(Object.keys(entry.signals).length).toBeGreaterThan(0);
      expect(Object.keys(entry.categories).length).toBeGreaterThan(0);
      expect(entry.spec).toBe(`variants/${def.name}.yaml`);
    }
  });

  it('degrading a signal lowers the overall score below gold', () => {
    const goldOverall = byName.get('gold')!.entry.jairf.overall;
    for (const { def, entry } of generated) {
      if (def.name === 'gold' || def.runtimeDriven) continue;
      expect(entry.jairf.overall, `${def.name} should score below gold`).toBeLessThan(goldOverall);
    }
    // all-bad is the worst of all.
    const allBadOverall = byName.get('all-bad')!.entry.jairf.overall;
    for (const { def, entry } of generated) {
      if (def.name === 'all-bad' || def.runtimeDriven) continue;
      expect(allBadOverall).toBeLessThanOrEqual(entry.jairf.overall);
    }
  });

  it('manifest entry score matches a fresh scoreSpec of the emitted variant', () => {
    for (const { spec, entry } of generated) {
      expect(scoreSpec(spec).overall).toBe(entry.jairf.overall);
    }
  });

  it('buildVariant is deterministic for a given gold + def', () => {
    const def = VARIANTS.find((v) => v.name === 'no-descriptions')!;
    const a = buildVariant(gold, def);
    const b = buildVariant(gold, def);
    expect(JSON.stringify(a.spec)).toBe(JSON.stringify(b.spec));
    expect(a.entry.jairf.overall).toBe(b.entry.jairf.overall);
  });
});
