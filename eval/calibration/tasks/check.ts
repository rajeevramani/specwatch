import { TASKS, getTask } from './tasks.js';
import type { CalibrationTask, TaskResult, TruthSnapshot } from './types.js';

/**
 * Task checker (specwatch-a7n).
 *
 * Given the backend's ground-truth state, return per-task pass/fail. The verdict
 * is a pure function of `/__truth` — the agent's own report is never consulted.
 *
 * Two entry points:
 *   - `checkTasks(truth)`        — evaluate a snapshot you already have.
 *   - `fetchTruth(baseUrl)`      — read `/__truth` from a running backend.
 *   - `checkTasksAgainst(url)`   — convenience: fetch then check.
 *
 * A CLI wrapper is exposed when this module is run directly (see bottom).
 */

export interface CheckReport {
  results: TaskResult[];
  passCount: number;
  failCount: number;
  /** true iff every task passed. */
  allPassed: boolean;
}

/** Evaluate a fixed list of tasks against a ground-truth snapshot. */
export function checkTasks(
  truth: TruthSnapshot,
  tasks: CalibrationTask[] = TASKS,
): CheckReport {
  const results = tasks.map((t) => t.assert(truth));
  const passCount = results.filter((r) => r.pass).length;
  return {
    results,
    passCount,
    failCount: results.length - passCount,
    allPassed: passCount === results.length,
  };
}

/** Evaluate a single task by id against a snapshot. */
export function checkTask(taskId: string, truth: TruthSnapshot): TaskResult {
  return getTask(taskId).assert(truth);
}

/** Read the full ground-truth snapshot from a running backend. */
export async function fetchTruth(baseUrl: string): Promise<TruthSnapshot> {
  const url = `${baseUrl.replace(/\/$/, '')}/__truth`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as TruthSnapshot;
}

/** Convenience: fetch ground truth from a running backend and check all tasks. */
export async function checkTasksAgainst(
  baseUrl: string,
  tasks: CalibrationTask[] = TASKS,
): Promise<CheckReport> {
  return checkTasks(await fetchTruth(baseUrl), tasks);
}

/** Render a report as a compact human-readable string. */
export function formatReport(report: CheckReport): string {
  const lines = report.results.map(
    (r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.taskId.padEnd(28)}  ${r.detail}`,
  );
  lines.push(
    `\n${report.passCount}/${report.results.length} tasks passed` +
      (report.allPassed ? '' : ` (${report.failCount} failed)`),
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI: `tsx check.ts [baseUrl]` (defaults to http://localhost:8787).
// Exits 0 if all tasks pass, 1 otherwise. Reads only ground truth.
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const baseUrl = process.argv[2] ?? process.env.BACKEND_URL ?? 'http://localhost:8787';
  const report = await checkTasksAgainst(baseUrl);
  // eslint-disable-next-line no-console
  console.log(formatReport(report));
  process.exit(report.allPassed ? 0 : 1);
}

// Run main only when executed directly (not when imported by tests).
const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(2);
  });
}
