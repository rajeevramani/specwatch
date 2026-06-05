/**
 * Score the hand-authored gold spec with the shared @agentready/scoring package
 * and print the JAIRF breakdown. Human-runnable entrypoint:
 *
 *   cd eval/calibration/backend && npm run score:gold
 *
 * Exits non-zero if the overall score drops below 80 (grade B+) so the gold
 * baseline can be guarded in CI alongside the vitest assertions.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseSpec, scoreSpec } from '../packages/agentready-scoring/src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const gold = parseSpec(readFileSync(resolve(here, 'gold.yaml'), 'utf8'));
const r = scoreSpec(gold);

console.log(`\nJAIRF overall: ${r.overall}  grade ${r.grade}  ${r.level.label}`);
console.log(`operations: ${r.operationCount}  gates: ${r.gates.length}\n`);
for (const c of r.categories) {
  console.log(`[${c.id}] ${c.score}  (weight ${c.weight})`);
  for (const s of c.signals ?? []) console.log(`    ${String(s.score).padStart(3)}  ${s.id}`);
}

if (r.overall < 80) {
  console.error(`\nFAIL: overall ${r.overall} < 80`);
  process.exit(1);
}
console.log(`\nPASS: overall ${r.overall} >= 80`);
