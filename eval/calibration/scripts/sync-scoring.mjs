#!/usr/bin/env node
/**
 * sync-scoring.mjs — re-vendor AgentReady's scorer into @agentready/scoring.
 *
 * Source of truth (override with AGENTREADY_SCORING_SRC):
 *   ../agent-ready-score/src/lib/scoring.ts   (relative to the specwatch repo root)
 *
 * Usage (from specwatch repo root):
 *   node eval/calibration/scripts/sync-scoring.mjs
 *
 * Copies the source verbatim into the package's src/vendor/scoring.ts, prepends
 * a DO-NOT-EDIT banner, and prints a content hash for both files so drift is
 * visible. See PROVENANCE.md.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// eval/calibration/scripts -> repo root is three levels up.
const repoRoot = resolve(here, '..', '..', '..');

const DEFAULT_SRC = resolve(repoRoot, '..', 'agent-ready-score', 'src', 'lib', 'scoring.ts');
const src = process.env.AGENTREADY_SCORING_SRC
  ? resolve(process.env.AGENTREADY_SCORING_SRC)
  : DEFAULT_SRC;

const dest = resolve(
  repoRoot,
  'eval',
  'calibration',
  'packages',
  'agentready-scoring',
  'src',
  'vendor',
  'scoring.ts',
);

const BANNER = `/* eslint-disable */
/**
 * ============================================================================
 * VENDORED FILE — DO NOT EDIT BY HAND
 * ============================================================================
 *
 * Source of truth:
 *   ../agent-ready-score/src/lib/scoring.ts
 *
 * This is a byte-for-byte vendored copy of AgentReady's JAIRF scorer, kept
 * here so the calibration harness (and specwatch) can import scoreSpec /
 * extractRuntimeSignals / public types from a single package.
 *
 * To re-sync after changing the source of truth, run from the specwatch repo
 * root:
 *
 *   node eval/calibration/scripts/sync-scoring.mjs
 *
 * The sync script copies the source verbatim (re-adding this banner) and the
 * package test asserts the result still scores a sample spec — a divergence
 * tripwire. See PROVENANCE.md for the full divergence-risk discussion.
 * ============================================================================
 */
`;

if (!existsSync(src)) {
  console.error(`[sync-scoring] source of truth not found: ${src}`);
  console.error('[sync-scoring] set AGENTREADY_SCORING_SRC to the scoring.ts path.');
  process.exit(1);
}

const raw = readFileSync(src, 'utf8');
const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

const out = BANNER + raw;
writeFileSync(dest, out, 'utf8');

console.log('[sync-scoring] synced AgentReady scorer:');
console.log(`  source : ${src}`);
console.log(`  dest   : ${dest}`);
console.log(`  source sha256: ${hash(raw)}`);
console.log(`  vendored body sha256 (banner stripped): ${hash(out.slice(BANNER.length))}`);
console.log('[sync-scoring] done. Run the package vitest to confirm the contract holds.');
