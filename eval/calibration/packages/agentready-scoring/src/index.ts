/**
 * @agentready/scoring — shared JAIRF scoring package.
 *
 * Single import surface for the calibration harness and specwatch. Re-exports
 * the vendored AgentReady scorer (scoreSpec, extractRuntimeSignals, parseSpec,
 * the per-dimension scorers, and all public types).
 *
 * The implementation lives in ./vendor/scoring.ts, a verbatim copy of
 * agent-ready-score/src/lib/scoring.ts. See PROVENANCE.md.
 */
export {
  parseSpec,
  extractRuntimeSignals,
  scoreFC,
  scoreDXJ,
  scoreARAX,
  scoreAU,
  scoreSEC,
  scoreAID,
  scoreSpec,
} from './vendor/scoring.js';

export type {
  Severity,
  Finding,
  SignalResult,
  SpecwatchAgentExt,
  RuntimeSignals,
  CategoryResult,
  GateResult,
  ReadinessLevel,
  ScoreResult,
  DimensionInput,
  DimensionResult,
} from './vendor/scoring.js';
