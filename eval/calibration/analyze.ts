/**
 * Calibration analysis — signal -> success weights (specwatch-51h).
 *
 * THE epic deliverable. Joins three sources, all produced by earlier calibration
 * tasks, and answers the calibration question: *which JAIRF signals causally move
 * agent task-success, and by how much?*
 *
 *   1. variant manifest (specwatch-sl1)  — variant -> { degrades, JAIRF overall +
 *      grade + per-signal scores }. The static read.
 *   2. agent-runner artifacts (specwatch-ajn) — `<variant>.json` with a per-task
 *      `success` (decided by the backend's ground-truth readback, NOT specwatch).
 *   3. specwatch capture (specwatch-13a) — `<variant>.specwatch.json` with
 *      per-task runtime telemetry (verification loops, wasted requests, response
 *      completeness, calls-per-task). The runtime read.
 *
 * It produces:
 *   - a SIGNAL -> SUCCESS table: per ablated JAIRF signal, gold success rate vs the
 *     degraded variant's success rate, and the delta (the empirical, *causal*
 *     weight — only that one signal changed between gold and the variant);
 *   - a SIGNIFICANCE flag per signal (does degrading it move success beyond noise),
 *     via a two-proportion z-test on gold-vs-degraded task outcomes;
 *   - a PREDICTION comparison: how well static-only JAIRF predicts per-variant
 *     success, vs static JAIRF + specwatch runtime telemetry — i.e. where runtime
 *     evidence adds signal beyond the static read.
 *
 * Pure-data in, pure-data out: {@link analyze} is a deterministic function of the
 * run artifacts, so the committed report is reproducible. The CLI ({@link main})
 * just wires the filesystem + writes `report.md` and `analysis.json`.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Input shapes (a subset of the artifacts the earlier tasks emit — we only read
// the fields the join needs, so the analysis is robust to extra fields).
// ---------------------------------------------------------------------------

/** One entry of the variant manifest (specwatch-sl1). */
export interface ManifestVariant {
  name: string;
  label?: string;
  /** Which JAIRF signal(s) this variant degrades. `[]` for gold. */
  degrades: string[];
  runtimeDriven?: boolean;
  jairf: { overall: number; grade?: string; level?: number };
  categories?: Record<string, number>;
  /** Per-signal 0..100 scores AgentReady assigns this variant's spec. */
  signals: Record<string, number>;
}

export interface Manifest {
  gold?: string;
  variants: ManifestVariant[];
}

/** Per-task record inside a `<variant>.json` run artifact (specwatch-ajn). */
export interface RunTaskRecord {
  taskId: string;
  success: boolean;
  callCount?: number;
}

/** A `<variant>.json` agent-runner artifact (subset). */
export interface RunArtifact {
  variant: string;
  agent?: string;
  model?: string;
  live?: boolean;
  passCount?: number;
  failCount?: number;
  records: RunTaskRecord[];
}

/** Per-task telemetry inside a `<variant>.specwatch.json` capture (specwatch-13a). */
export interface CaptureTask {
  taskId: string;
  success: boolean;
  callsPerTask: number;
  verificationLoops: number;
  wastedRequests: number;
  responseCompleteness: number | null;
  thinEndpoints: string[];
}

/** A `<variant>.specwatch.json` capture artifact (subset). */
export interface CaptureArtifactInput {
  source?: string;
  consumer?: string;
  variant: {
    variant: string;
    totalCalls?: number;
    totalVerificationLoops?: number;
    totalWastedRequests?: number;
    avgResponseCompleteness?: number | null;
    tasks: CaptureTask[];
  };
}

// ---------------------------------------------------------------------------
// Output shapes.
// ---------------------------------------------------------------------------

/**
 * The map from a human-facing ablated-signal name (the manifest `degrades`
 * token) to the JAIRF per-signal score key(s) it primarily drives, used to label
 * the table with the static score that moved. Telemetry-only signals (no static
 * doc change — e.g. `completeness`) map to an empty list and are flagged as
 * runtime-driven.
 */
export const SIGNAL_TO_JAIRF_KEYS: Record<string, string[]> = {
  descriptions: ['description_coverage', 'doc_clarity', 'descriptive_richness'],
  operationId: ['operationid_quality', 'tool_calling', 'distinctiveness'],
  examples: ['request_examples', 'response_examples'],
  errorSchemas: ['error_standardization'],
  completeness: [], // runtime-only: spec == gold, degradation applied at run time
};

export interface VariantSummary {
  variant: string;
  degrades: string[];
  runtimeDriven: boolean;
  jairfOverall: number;
  jairfGrade?: string;
  taskCount: number;
  passCount: number;
  successRate: number;
  /** Variant-level runtime telemetry rollup (from the capture). */
  telemetry: {
    totalCalls: number;
    verificationLoops: number;
    wastedRequests: number;
    avgResponseCompleteness: number | null;
    thinEndpointCount: number;
  };
}

/** One row of the signal -> success table. */
export interface SignalSuccessRow {
  /** The ablated signal (manifest `degrades` token). */
  signal: string;
  /** The variant that degrades exactly this signal. */
  variant: string;
  /** JAIRF per-signal scores for the keys this signal drives (gold -> degraded). */
  jairfKeys: { key: string; gold: number; degraded: number; drop: number }[];
  runtimeDriven: boolean;
  goldSuccessRate: number;
  degradedSuccessRate: number;
  /** degradedSuccessRate - goldSuccessRate. Negative = degrading hurt success. */
  successDelta: number;
  taskCount: number;
  goldPass: number;
  degradedPass: number;
  /** Two-proportion z statistic for gold vs degraded success. */
  zStat: number;
  /** Approximate two-sided p-value for `zStat`. */
  pValue: number;
  /** True when the success move is significant at alpha (and non-zero). */
  significant: boolean;
  /** True when degrading this signal moved success at all (|delta| > 0), regardless of power. */
  directional: boolean;
  /** Runtime telemetry delta vs gold (how the agent struggled, beyond success). */
  telemetryDelta: {
    verificationLoops: number;
    wastedRequests: number;
    avgResponseCompletenessGold: number | null;
    avgResponseCompletenessDegraded: number | null;
  };
}

export interface PredictionComparison {
  /**
   * Static-only model: correlate per-variant JAIRF overall with per-variant
   * success rate (Pearson r across variants).
   */
  staticOnly: { rSquared: number; pearson: number; n: number };
  /**
   * Static + runtime: does telemetry explain residual success the static score
   * misses? We correlate per-variant success with a combined predictor that adds
   * a runtime "struggle" penalty (loops + wasted + thinness) to the static score.
   */
  staticPlusRuntime: { rSquared: number; pearson: number; n: number };
  /** rSquared(static+runtime) - rSquared(static-only). >0 = runtime adds signal. */
  rSquaredGain: number;
  /** Plain-English verdict for the report. */
  verdict: string;
}

export interface AnalysisResult {
  generatedAt: string;
  alpha: number;
  goldVariant: string;
  variants: VariantSummary[];
  signalTable: SignalSuccessRow[];
  /** Signals whose degradation significantly moved success (p < alpha). */
  significantSignals: string[];
  /**
   * Signals whose degradation moved success at all (|delta| > 0), ranked by
   * magnitude. At small per-variant task counts a clean drop can be real yet not
   * reach the z-test threshold — the directional list is the practical ranking.
   */
  directionalMovers: { signal: string; successDelta: number }[];
  prediction: PredictionComparison;
  /** Provenance: which artifact files fed the join. */
  sources: { manifest: string; runs: string[]; captures: string[] };
  /** Non-fatal notes (e.g. mock all-pass data => no gradient). */
  notes: string[];
}

// ---------------------------------------------------------------------------
// Statistics (small, dependency-free, deterministic).
// ---------------------------------------------------------------------------

/** Standard normal CDF via the Abramowitz-Stegun erf approximation. */
function normalCdf(x: number): number {
  // erf(x/sqrt2)
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p =
    d *
    t *
    (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

/**
 * Two-proportion z-test for gold success (a/n1) vs degraded success (b/n2).
 * Returns {z, p} with a two-sided p-value. Degenerate inputs (n=0, or both
 * proportions 0 or 1 with identical rates) return z=0, p=1.
 */
export function twoProportionZ(
  a: number,
  n1: number,
  b: number,
  n2: number,
): { z: number; p: number } {
  if (n1 === 0 || n2 === 0) return { z: 0, p: 1 };
  const p1 = a / n1;
  const p2 = b / n2;
  const pooled = (a + b) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  if (se === 0) return { z: 0, p: 1 };
  const z = (p1 - p2) / se;
  const p = 2 * (1 - normalCdf(Math.abs(z)));
  return { z, p };
}

/** Pearson correlation; returns 0 for degenerate (zero-variance) inputs. */
export function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return 0;
  return sxy / Math.sqrt(sxx * syy);
}

// ---------------------------------------------------------------------------
// Core analysis.
// ---------------------------------------------------------------------------

export interface AnalyzeInputs {
  manifest: Manifest;
  runs: RunArtifact[];
  captures: CaptureArtifactInput[];
  alpha?: number;
  goldVariant?: string;
  sources?: { manifest: string; runs: string[]; captures: string[] };
}

function successRate(run: RunArtifact): { pass: number; total: number; rate: number } {
  const total = run.records.length;
  const pass = run.records.filter((r) => r.success).length;
  return { pass, total, rate: total > 0 ? pass / total : 0 };
}

/**
 * Run the full join + regression. Deterministic function of the artifacts — the
 * committed report is `JSON.stringify(analyze(...))` rendered to markdown.
 */
export function analyze(inputs: AnalyzeInputs): AnalysisResult {
  const alpha = inputs.alpha ?? 0.05;
  const goldVariant = inputs.goldVariant ?? 'gold';
  const notes: string[] = [];

  const manifestByName = new Map(inputs.manifest.variants.map((v) => [v.name, v]));
  const runByName = new Map(inputs.runs.map((r) => [r.variant, r]));
  const captureByName = new Map(inputs.captures.map((c) => [c.variant.variant, c]));

  // --- Per-variant summary (join of all three sources). --------------------
  const variants: VariantSummary[] = [];
  for (const mv of inputs.manifest.variants) {
    const run = runByName.get(mv.name);
    if (!run) {
      notes.push(`No run artifact for variant "${mv.name}"; excluded from analysis.`);
      continue;
    }
    const { pass, total, rate } = successRate(run);
    const cap = captureByName.get(mv.name)?.variant;
    variants.push({
      variant: mv.name,
      degrades: mv.degrades,
      runtimeDriven: Boolean(mv.runtimeDriven),
      jairfOverall: mv.jairf.overall,
      jairfGrade: mv.jairf.grade,
      taskCount: total,
      passCount: pass,
      successRate: rate,
      telemetry: {
        totalCalls: cap?.totalCalls ?? 0,
        verificationLoops: cap?.totalVerificationLoops ?? 0,
        wastedRequests: cap?.totalWastedRequests ?? 0,
        avgResponseCompleteness: cap?.avgResponseCompleteness ?? null,
        thinEndpointCount: cap ? cap.tasks.reduce((s, t) => s + t.thinEndpoints.length, 0) : 0,
      },
    });
  }

  const goldRun = runByName.get(goldVariant);
  const goldManifest = manifestByName.get(goldVariant);
  if (!goldRun || !goldManifest) {
    throw new Error(
      `Gold variant "${goldVariant}" missing from run artifacts or manifest — cannot compute deltas.`,
    );
  }
  const gold = successRate(goldRun);
  const goldCap = captureByName.get(goldVariant)?.variant;

  // --- Signal -> success table. One row per single-signal-ablation variant. -
  const signalTable: SignalSuccessRow[] = [];
  for (const mv of inputs.manifest.variants) {
    if (mv.name === goldVariant) continue;
    // Single-signal ablations only (the all-bad multi-signal variant is summarised
    // separately, not a clean per-signal row — degrading 5 things at once is not
    // attributable to any one signal).
    if (mv.degrades.length !== 1) continue;
    const signal = mv.degrades[0];
    const run = runByName.get(mv.name);
    if (!run) continue;
    const deg = successRate(run);

    const jairfKeys = (SIGNAL_TO_JAIRF_KEYS[signal] ?? []).map((key) => {
      const g = goldManifest.signals[key] ?? 0;
      const d = mv.signals[key] ?? 0;
      return { key, gold: g, degraded: d, drop: g - d };
    });

    const { z, p } = twoProportionZ(gold.pass, gold.total, deg.pass, deg.total);
    const delta = deg.rate - gold.rate;
    const directional = Math.abs(delta) > 1e-9;
    const significant = p < alpha && directional;

    const cap = captureByName.get(mv.name)?.variant;
    signalTable.push({
      signal,
      variant: mv.name,
      jairfKeys,
      runtimeDriven: Boolean(mv.runtimeDriven),
      goldSuccessRate: gold.rate,
      degradedSuccessRate: deg.rate,
      successDelta: delta,
      taskCount: deg.total,
      goldPass: gold.pass,
      degradedPass: deg.pass,
      zStat: z,
      pValue: p,
      significant,
      directional,
      telemetryDelta: {
        verificationLoops:
          (cap?.totalVerificationLoops ?? 0) - (goldCap?.totalVerificationLoops ?? 0),
        wastedRequests: (cap?.totalWastedRequests ?? 0) - (goldCap?.totalWastedRequests ?? 0),
        avgResponseCompletenessGold: goldCap?.avgResponseCompleteness ?? null,
        avgResponseCompletenessDegraded: cap?.avgResponseCompleteness ?? null,
      },
    });
  }

  const significantSignals = signalTable.filter((r) => r.significant).map((r) => r.signal);
  const directionalMovers = signalTable
    .filter((r) => r.directional)
    .map((r) => ({ signal: r.signal, successDelta: r.successDelta }))
    .sort((a, b) => a.successDelta - b.successDelta); // most-negative (most-harmful) first

  // --- Prediction: static-only vs static + runtime. ------------------------
  // Across all variants (excluding the multi-signal all-bad, which is not a clean
  // single point on the curve but IS a useful extreme — we keep it; it strengthens
  // the correlation if the thesis holds). One (x, y) point per variant.
  const xsStatic: number[] = [];
  const xsCombined: number[] = [];
  const ys: number[] = [];
  for (const v of variants) {
    xsStatic.push(v.jairfOverall);
    // Runtime "struggle" penalty: loops + wasted requests + (1 - completeness)
    // thinness, normalised to roughly the JAIRF 0..100 scale and SUBTRACTED, so a
    // struggling variant looks worse than its static score alone suggests.
    const completeness = v.telemetry.avgResponseCompleteness;
    const thinPenalty =
      completeness === null ? v.telemetry.thinEndpointCount * 5 : (1 - completeness) * 100;
    const strugglePenalty =
      v.telemetry.verificationLoops * 3 + v.telemetry.wastedRequests * 2 + thinPenalty;
    xsCombined.push(v.jairfOverall - strugglePenalty);
    ys.push(v.successRate * 100);
  }
  const rStatic = pearson(xsStatic, ys);
  const rCombined = pearson(xsCombined, ys);
  const rsStatic = rStatic * rStatic;
  const rsCombined = rCombined * rCombined;
  const gain = rsCombined - rsStatic;

  let verdict: string;
  const successValues = new Set(ys);
  if (successValues.size <= 1) {
    verdict =
      'No success variance across variants (all variants share the same success rate) — ' +
      'correlation is undefined on this dataset, so neither static nor runtime prediction ' +
      'can be evaluated. Re-run with the LIVE agent (npm run calib:analyze:live note) to get a ' +
      'success gradient. On a gradient, rSquaredGain > 0 means specwatch telemetry explains ' +
      'success the static JAIRF read alone misses.';
  } else if (gain > 0.01) {
    verdict =
      `Static + specwatch telemetry predicts agent success better than static JAIRF alone ` +
      `(R^2 ${rsStatic.toFixed(3)} -> ${rsCombined.toFixed(3)}, +${gain.toFixed(3)}). Runtime ` +
      `evidence adds signal beyond the static read.`;
  } else {
    verdict =
      `Static JAIRF already captures most of the predictable success variance ` +
      `(R^2 ${rsStatic.toFixed(3)}); specwatch telemetry adds ${gain >= 0 ? '+' : ''}${gain.toFixed(3)} ` +
      `R^2 — marginal on this dataset.`;
  }

  if (successValues.size <= 1) {
    notes.push(
      'All variants have identical success rates in these artifacts. With the deterministic ' +
        'MOCK agent every task passes regardless of spec quality, so there is no signal->success ' +
        'gradient to regress. The table is populated (gold-vs-degraded rows present) but every ' +
        'delta is 0 and nothing is flagged significant. A real gradient requires the LIVE agent ' +
        '(human-gated, needs ANTHROPIC_API_KEY).',
    );
  }

  return {
    generatedAt: new Date().toISOString(),
    alpha,
    goldVariant,
    variants,
    signalTable,
    significantSignals,
    directionalMovers,
    prediction: {
      staticOnly: { rSquared: rsStatic, pearson: rStatic, n: ys.length },
      staticPlusRuntime: { rSquared: rsCombined, pearson: rCombined, n: ys.length },
      rSquaredGain: gain,
      verdict,
    },
    sources: inputs.sources ?? { manifest: '', runs: [], captures: [] },
    notes,
  };
}

// ---------------------------------------------------------------------------
// Markdown report template.
// ---------------------------------------------------------------------------

function pct(x: number): string {
  return `${(x * 100).toFixed(0)}%`;
}

function signed(x: number, digits = 0): string {
  const v = digits > 0 ? x.toFixed(digits) : Math.round(x).toString();
  return x > 0 ? `+${v}` : v;
}

/** Render the analysis result to the committed markdown report. */
export function renderReport(r: AnalysisResult): string {
  const lines: string[] = [];
  lines.push('# Calibration report — JAIRF signal -> agent task-success');
  lines.push('');
  lines.push(
    '> **Objective.** Which JAIRF signals *causally* move agent task-success, and by how much? ' +
      'One real backend, one fixed agent, one task set — only the spec changes. Each variant ' +
      'degrades exactly one JAIRF signal, so a success drop is *attributable* to that signal. ' +
      'The deltas below are empirical, causal weights to replace AgentReady’s guessed ones.',
  );
  lines.push('');
  lines.push(`Generated: ${r.generatedAt}`);
  lines.push(`Gold (baseline) variant: \`${r.goldVariant}\`  ·  significance alpha = ${r.alpha}`);
  lines.push('');
  lines.push(
    '_Reproducible from run artifacts via_ `npm run calib:analyze` _(reads the variant manifest, ' +
      'the agent-runner `<variant>.json` success records, and the specwatch `<variant>.specwatch.json` ' +
      'telemetry; writes this report + `analysis.json`)._',
  );
  lines.push('');

  // --- Headline signal -> success table. -----------------------------------
  lines.push('## 1. Signal → success table (the deliverable)');
  lines.push('');
  lines.push(
    'Per ablated signal: gold success vs the degraded variant’s success, the delta (the ' +
      'empirical weight), and whether the move is statistically significant. `Δ success` is the ' +
      'causal effect of degrading **only** that signal.',
  );
  lines.push('');
  lines.push(
    '| JAIRF signal | Variant | JAIRF key drop | Gold success | Degraded success | Δ success | p | Significant? |',
  );
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const row of r.signalTable) {
    const keyDrop =
      row.jairfKeys.length > 0
        ? row.jairfKeys.map((k) => `${k.key} ${k.gold}→${k.degraded}`).join('<br>')
        : row.runtimeDriven
          ? '_(runtime-only; spec = gold)_'
          : '—';
    lines.push(
      `| \`${row.signal}\` | \`${row.variant}\` | ${keyDrop} | ${pct(row.goldSuccessRate)} ` +
        `(${row.goldPass}/${row.taskCount}) | ${pct(row.degradedSuccessRate)} (${row.degradedPass}/${row.taskCount}) | ` +
        `**${signed(row.successDelta * 100)}pp** | ${row.pValue.toFixed(3)} | ${row.significant ? '**yes**' : 'no'} |`,
    );
  }
  lines.push('');
  if (r.significantSignals.length > 0) {
    lines.push(
      `**Signals that significantly move success (p < ${r.alpha}):** ${r.significantSignals
        .map((s) => `\`${s}\``)
        .join(', ')}.`,
    );
  } else if (r.directionalMovers.length > 0) {
    lines.push(
      `**No signal reached the p < ${r.alpha} significance threshold** at this per-variant task ` +
        `count (${r.signalTable[0]?.taskCount ?? '?'} tasks/variant is underpowered for the ` +
        `two-proportion z-test). The signals that *directionally* move success, ranked by effect ` +
        `size (most harmful first):`,
    );
    lines.push('');
    for (const m of r.directionalMovers) {
      lines.push(`  - \`${m.signal}\`: **${signed(m.successDelta * 100)}pp**`);
    }
  } else {
    lines.push(
      '**No signal moved success on this dataset** (every degraded variant matched gold success). ' +
        'See notes — this is expected with the deterministic mock agent, which replays the gold ' +
        'plan regardless of spec quality; a real gradient needs the LIVE agent.',
    );
  }
  lines.push('');

  // --- Per-variant summary. ------------------------------------------------
  lines.push('## 2. Per-variant summary (static score + runtime telemetry)');
  lines.push('');
  lines.push(
    '| Variant | Degrades | JAIRF | Success | Calls | Verif. loops | Wasted | Avg completeness | Thin endpoints |',
  );
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const v of r.variants) {
    const comp =
      v.telemetry.avgResponseCompleteness === null
        ? '—'
        : v.telemetry.avgResponseCompleteness.toFixed(2);
    lines.push(
      `| \`${v.variant}\` | ${v.degrades.length ? v.degrades.join(', ') : '—'}${
        v.runtimeDriven ? ' _(runtime)_' : ''
      } | ${v.jairfOverall}${v.jairfGrade ? ` (${v.jairfGrade})` : ''} | ${pct(v.successRate)} ` +
        `(${v.passCount}/${v.taskCount}) | ${v.telemetry.totalCalls} | ${v.telemetry.verificationLoops} | ` +
        `${v.telemetry.wastedRequests} | ${comp} | ${v.telemetry.thinEndpointCount} |`,
    );
  }
  lines.push('');

  // --- Prediction comparison. ----------------------------------------------
  lines.push('## 3. Prediction quality — static-only JAIRF vs static + specwatch telemetry');
  lines.push('');
  lines.push(
    'Does specwatch runtime telemetry add predictive signal *beyond* the static read? ' +
      'We correlate per-variant success against (a) the static JAIRF overall score, and ' +
      '(b) JAIRF overall adjusted by a runtime struggle penalty (verification loops + wasted ' +
      'requests + response thinness).',
  );
  lines.push('');
  lines.push('| Predictor | Pearson r | R² | n (variants) |');
  lines.push('|---|---|---|---|');
  lines.push(
    `| Static-only JAIRF | ${r.prediction.staticOnly.pearson.toFixed(3)} | ${r.prediction.staticOnly.rSquared.toFixed(
      3,
    )} | ${r.prediction.staticOnly.n} |`,
  );
  lines.push(
    `| Static + specwatch telemetry | ${r.prediction.staticPlusRuntime.pearson.toFixed(
      3,
    )} | ${r.prediction.staticPlusRuntime.rSquared.toFixed(3)} | ${r.prediction.staticPlusRuntime.n} |`,
  );
  lines.push('');
  lines.push(`**R² gain from telemetry:** ${signed(r.prediction.rSquaredGain, 3)}`);
  lines.push('');
  lines.push(`**Verdict.** ${r.prediction.verdict}`);
  lines.push('');

  // --- Notes + provenance. -------------------------------------------------
  if (r.notes.length > 0) {
    lines.push('## 4. Notes');
    lines.push('');
    for (const n of r.notes) lines.push(`- ${n}`);
    lines.push('');
  }
  lines.push('## Provenance');
  lines.push('');
  lines.push(`- Manifest: \`${r.sources.manifest}\``);
  lines.push(`- Run artifacts: ${r.sources.runs.map((s) => `\`${s}\``).join(', ') || '—'}`);
  lines.push(
    `- Specwatch captures: ${r.sources.captures.map((s) => `\`${s}\``).join(', ') || '—'}`,
  );
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Filesystem loading + CLI.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const CALIB_ROOT = here;
const DEFAULT_MANIFEST = resolve(CALIB_ROOT, 'variants/manifest.json');
const DEFAULT_RUNS_DIR = resolve(CALIB_ROOT, '.runs');
const DEFAULT_OUT_DIR = resolve(CALIB_ROOT, 'reports');

export interface LoadOptions {
  manifestPath: string;
  runsDir: string;
}

/** Load the manifest + every `<variant>.json` / `<variant>.specwatch.json` in a runs dir. */
export function loadInputs(opts: LoadOptions): AnalyzeInputs {
  const manifest: Manifest = JSON.parse(readFileSync(opts.manifestPath, 'utf8'));
  if (!existsSync(opts.runsDir)) {
    throw new Error(
      `Runs directory not found: ${opts.runsDir}. Run \`npm run calib:run -- --variant <name>\` ` +
        `for each variant first, or point --runs at a fixtures directory.`,
    );
  }
  const files = readdirSync(opts.runsDir).filter((f) => f.endsWith('.json'));
  const runFiles = files.filter((f) => !f.endsWith('.specwatch.json'));
  const captureFiles = files.filter((f) => f.endsWith('.specwatch.json'));

  const runs: RunArtifact[] = runFiles.map((f) =>
    JSON.parse(readFileSync(resolve(opts.runsDir, f), 'utf8')),
  );
  const captures: CaptureArtifactInput[] = captureFiles.map((f) =>
    JSON.parse(readFileSync(resolve(opts.runsDir, f), 'utf8')),
  );

  return {
    manifest,
    runs,
    captures,
    sources: {
      manifest: opts.manifestPath,
      runs: runFiles.map((f) => resolve(opts.runsDir, f)),
      captures: captureFiles.map((f) => resolve(opts.runsDir, f)),
    },
  };
}

interface AnalyzeCliArgs {
  manifest: string;
  runs: string;
  outDir: string;
  alpha?: number;
}

function parseArgs(argv: string[]): AnalyzeCliArgs {
  const args: AnalyzeCliArgs = {
    manifest: DEFAULT_MANIFEST,
    runs: DEFAULT_RUNS_DIR,
    outDir: DEFAULT_OUT_DIR,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--manifest') args.manifest = resolve(argv[++i]);
    else if (a === '--runs') args.runs = resolve(argv[++i]);
    else if (a === '--out-dir') args.outDir = resolve(argv[++i]);
    else if (a === '--alpha') args.alpha = Number(argv[++i]);
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`[calib:analyze] manifest=${args.manifest}`);
  console.log(`[calib:analyze] runs=${args.runs}`);

  const inputs = loadInputs({ manifestPath: args.manifest, runsDir: args.runs });
  if (args.alpha !== undefined) inputs.alpha = args.alpha;
  const result = analyze(inputs);

  mkdirSync(args.outDir, { recursive: true });
  const jsonPath = resolve(args.outDir, 'analysis.json');
  const mdPath = resolve(args.outDir, 'report.md');
  writeFileSync(jsonPath, JSON.stringify(result, null, 2) + '\n', 'utf8');
  writeFileSync(mdPath, renderReport(result) + '\n', 'utf8');

  console.log(
    `[calib:analyze] ${result.signalTable.length} signal rows, ` +
      `${result.significantSignals.length} significant -> ${mdPath}`,
  );
  console.log(`[calib:analyze] underlying data -> ${jsonPath}`);
  for (const n of result.notes) console.log(`[calib:analyze] note: ${n}`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
