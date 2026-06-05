/**
 * Fixture generator for the calibration analysis acceptance (specwatch-51h).
 *
 * The MOCK agent dry-run is deterministic and signal-INSENSITIVE: it replays the
 * same gold plan for every variant, so every variant passes 5/5 and there is no
 * signal->success gradient to analyse. That is correct for the mock (the mock has
 * no spec-reading behaviour) but useless for *demonstrating* a populated signal->
 * success table.
 *
 * This generator emits a small, fully SYNTHETIC set of run artifacts that DO carry
 * a plausible gradient — one degraded task per single-signal variant, two for the
 * all-bad extreme, plus the matching specwatch telemetry deltas (loops / wasted /
 * thinness rise as the spec degrades). The shapes are exactly those the real
 * `npm run calib:run` writes (`<variant>.json`, `<variant>.specwatch.json`), so
 * `analyze.ts` consumes them with no special-casing.
 *
 * These numbers are ILLUSTRATIVE, not measured. They exist solely to exercise the
 * analysis end-to-end and prove the table populates. Real, measured numbers come
 * from the LIVE agent run (human-gated; see `calib:run:live` + the report’s notes).
 *
 *   npm run calib:fixtures   # regenerates fixtures/runs/*.json deterministically
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const RUNS_DIR = resolve(here, 'runs');

const TASK_IDS = [
  't1_onboard_and_cancel',
  't2_place_order_and_pay',
  't3_fulfil_pending_order',
  't4_correct_line_item_quantity',
  't5_onboard_rename_offboard',
];

/** Fixed deterministic generatedAt so fixtures are byte-stable across regen. */
const FIXED_TS = '2026-06-06T00:00:00.000Z';

/**
 * Per-variant synthetic profile. `fails` = task indices the agent fails under
 * this degradation; telemetry rises with degradation severity.
 */
interface Profile {
  variant: string;
  fails: number[];
  thinResponses: boolean;
  verificationLoops: number;
  wastedRequests: number;
  /** avg response completeness 0..1 or null when no write/read pair observed. */
  avgCompleteness: number | null;
  /** thin endpoints flagged across tasks. */
  thinEndpoints: number;
}

// Illustrative gradient: error-schema and operationId degradations bite hardest
// (the agent can't recover from ambiguous tools / opaque errors); descriptions a
// little; examples barely; thin-responses shows up only in telemetry (success
// holds because ground-truth state is still reachable). all-bad is the floor.
const PROFILES: Profile[] = [
  {
    variant: 'gold',
    fails: [],
    thinResponses: false,
    verificationLoops: 0,
    wastedRequests: 0,
    avgCompleteness: 1.0,
    thinEndpoints: 0,
  },
  {
    variant: 'no-descriptions',
    fails: [1],
    thinResponses: false,
    verificationLoops: 2,
    wastedRequests: 1,
    avgCompleteness: 1.0,
    thinEndpoints: 0,
  },
  {
    variant: 'bad-operationids',
    fails: [1, 4],
    thinResponses: false,
    verificationLoops: 5,
    wastedRequests: 4,
    avgCompleteness: 1.0,
    thinEndpoints: 0,
  },
  {
    variant: 'no-examples',
    fails: [],
    thinResponses: false,
    verificationLoops: 1,
    wastedRequests: 0,
    avgCompleteness: 1.0,
    thinEndpoints: 0,
  },
  {
    variant: 'no-error-schemas',
    fails: [1, 2],
    thinResponses: false,
    verificationLoops: 6,
    wastedRequests: 5,
    avgCompleteness: 1.0,
    thinEndpoints: 0,
  },
  {
    variant: 'thin-responses',
    fails: [],
    thinResponses: true,
    verificationLoops: 4,
    wastedRequests: 3,
    avgCompleteness: 0.45,
    thinEndpoints: 3,
  },
  {
    variant: 'all-bad',
    fails: [0, 1, 2, 4],
    thinResponses: true,
    verificationLoops: 9,
    wastedRequests: 8,
    avgCompleteness: 0.4,
    thinEndpoints: 4,
  },
];

function makeRunArtifact(p: Profile): unknown {
  const records = TASK_IDS.map((taskId, i) => {
    const success = !p.fails.includes(i);
    return {
      variant: p.variant,
      taskId,
      success,
      detail: success
        ? 'synthetic: ground-truth end-state satisfied'
        : 'synthetic: end-state assertion failed',
      callCount: 3 + (i % 3),
      steps: 4 + (i % 2),
      truncated: false,
      // Transcripts intentionally omitted in fixtures — the analysis only reads
      // `success` / `callCount` from run artifacts. (The capture fixture carries
      // the telemetry the analysis needs.)
      transcript: [],
    };
  });
  const passCount = records.filter((r) => r.success).length;
  return {
    generatedAt: FIXED_TS,
    synthetic: true,
    note: 'SYNTHETIC fixture (specwatch-51h). Illustrative success gradient, not a measured live run.',
    variant: p.variant,
    agent: 'fixture:synthetic',
    model: 'fixture',
    live: false,
    thinResponses: p.thinResponses,
    passCount,
    failCount: records.length - passCount,
    records,
  };
}

function makeCaptureArtifact(p: Profile): unknown {
  // Spread variant-level totals across tasks deterministically.
  const tasks = TASK_IDS.map((taskId, i) => {
    const success = !p.fails.includes(i);
    const loops = i === 0 ? p.verificationLoops : 0; // park totals on task 0 for simplicity
    const wasted = i === 0 ? p.wastedRequests : 0;
    return {
      variant: p.variant,
      taskId,
      success,
      callsPerTask: 3 + (i % 3),
      verificationLoops: loops,
      wastedRequests: wasted,
      responseCompleteness: p.avgCompleteness,
      thinEndpoints: i === 0 ? Array.from({ length: p.thinEndpoints }, (_, k) => `PUT /e${k}`) : [],
      commonNextSteps: {},
    };
  });
  return {
    generatedAt: FIXED_TS,
    synthetic: true,
    source: 'replay',
    consumer: 'agent',
    variant: {
      variant: p.variant,
      agent: 'fixture:synthetic',
      thinResponses: p.thinResponses,
      taskCount: tasks.length,
      totalCalls: tasks.reduce((s, t) => s + t.callsPerTask, 0),
      totalVerificationLoops: p.verificationLoops,
      totalWastedRequests: p.wastedRequests,
      avgResponseCompleteness: p.avgCompleteness,
      tasks,
    },
  };
}

function main(): void {
  mkdirSync(RUNS_DIR, { recursive: true });
  for (const p of PROFILES) {
    writeFileSync(
      resolve(RUNS_DIR, `${p.variant}.json`),
      JSON.stringify(makeRunArtifact(p), null, 2) + '\n',
      'utf8',
    );
    writeFileSync(
      resolve(RUNS_DIR, `${p.variant}.specwatch.json`),
      JSON.stringify(makeCaptureArtifact(p), null, 2) + '\n',
      'utf8',
    );
  }
  console.log(`[calib:fixtures] wrote ${PROFILES.length * 2} fixture artifacts -> ${RUNS_DIR}`);
}

main();
