/**
 * Pinned, snake_case JSON contract for `investigate --json`.
 *
 * This is a STABLE machine contract — it deliberately does NOT serialize the raw
 * internal `CallInvestigation` type (whose camelCase field names are an
 * implementation detail that can churn). It mirrors the naming style of
 * `AgentEvidence` (schema_version + snake_case fields) so agent consumers get a
 * consistent surface across `agent-report` and `investigate`.
 */

import type { SchemaDiff } from '../types/index.js';
import type {
  CallInvestigation,
  CallOccurrence,
  InvestigationReport,
  PairAnalysis,
  RedundantCause,
} from './investigation.js';

export const INVESTIGATION_JSON_SCHEMA_VERSION = 'specwatch.investigation.v1';

export interface InvestigationBreakingChangeJson {
  type: string;
  path: string;
  description: string;
  old_value: string | null;
  new_value: string | null;
}

export interface InvestigationDiffJson {
  breaking_changes: InvestigationBreakingChangeJson[];
  non_breaking_changes: string[];
}

export interface InvestigationOccurrenceJson {
  sample_index: number;
  sample_id: number;
  captured_at: string;
  status_code: number | null;
  phase: string | null;
}

export interface InvestigationPairJson {
  from_index: number;
  to_index: number;
  delta_ms: number;
  cause: RedundantCause;
  intervening_ops: string[];
  cross_phase: boolean;
  response_diff: InvestigationDiffJson | null;
  request_diff: InvestigationDiffJson | null;
}

export interface InvestigationEntryJson {
  operation_key: string;
  primary_cause: RedundantCause;
  explanation: string;
  recommendation: string;
  occurrences: InvestigationOccurrenceJson[];
  pair_analyses: InvestigationPairJson[];
}

export interface InvestigationJson {
  schema_version: typeof INVESTIGATION_JSON_SCHEMA_VERSION;
  session_id: string;
  investigations: InvestigationEntryJson[];
}

function serializeDiff(diff: SchemaDiff | undefined): InvestigationDiffJson | null {
  if (!diff) return null;
  return {
    breaking_changes: diff.breakingChanges.map((c) => ({
      type: c.type,
      path: c.path,
      description: c.description,
      old_value: c.oldValue ?? null,
      new_value: c.newValue ?? null,
    })),
    non_breaking_changes: diff.nonBreakingChanges,
  };
}

function serializeOccurrence(o: CallOccurrence): InvestigationOccurrenceJson {
  return {
    sample_index: o.sampleIndex,
    sample_id: o.sampleId,
    captured_at: o.capturedAt,
    status_code: o.statusCode ?? null,
    phase: o.phase ?? null,
  };
}

function serializePair(p: PairAnalysis): InvestigationPairJson {
  return {
    from_index: p.fromIndex,
    to_index: p.toIndex,
    delta_ms: p.deltaMs,
    cause: p.cause,
    intervening_ops: p.interveningOps,
    cross_phase: p.crossPhase,
    response_diff: serializeDiff(p.responseDiff),
    request_diff: serializeDiff(p.requestDiff),
  };
}

/** Serialize one investigation into the pinned entry shape. */
export function serializeInvestigationEntry(inv: CallInvestigation): InvestigationEntryJson {
  return {
    operation_key: inv.operationKey,
    primary_cause: inv.primaryCause,
    explanation: inv.explanation,
    recommendation: inv.recommendation,
    occurrences: inv.occurrences.map(serializeOccurrence),
    pair_analyses: inv.pairAnalyses.map(serializePair),
  };
}

/** Serialize a full report (all redundant operations) into the pinned contract. */
export function serializeInvestigationReport(report: InvestigationReport): InvestigationJson {
  return {
    schema_version: INVESTIGATION_JSON_SCHEMA_VERSION,
    session_id: report.sessionId,
    investigations: report.investigations.map(serializeInvestigationEntry),
  };
}

/** Serialize a single-operation investigation (the `--tool` path) into the pinned contract. */
export function serializeSingleInvestigation(
  sessionId: string,
  inv: CallInvestigation,
): InvestigationJson {
  return {
    schema_version: INVESTIGATION_JSON_SCHEMA_VERSION,
    session_id: sessionId,
    investigations: [serializeInvestigationEntry(inv)],
  };
}
