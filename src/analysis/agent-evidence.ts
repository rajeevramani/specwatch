/**
 * Machine-readable agent evidence built from Specwatch runtime analysis.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { CompletenessReport } from './completeness.js';
import type { OperationSequence, SequenceAnalysis } from './sequences.js';
import {
  type OpenApiOperationRef,
  matchOpenApiOperation,
  parseOperationKey,
} from './spec-mapper.js';

export const AGENT_EVIDENCE_SCHEMA_VERSION = 'specwatch.agent_evidence.v1';

/** Standard HTTP methods — used to scope REST-only signals (excludes JSON-RPC keys). */
const HTTP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']);

export type RecommendationKind =
  | 'enrich_write_response'
  | 'document_common_next_step'
  | 'standardize_error_response'
  | 'reduce_redundant_call'
  | 'add_operation_metadata';

export type RecommendationSeverity = 'low' | 'medium' | 'high';

export interface AgentEvidenceRecommendation {
  kind: RecommendationKind;
  severity: RecommendationSeverity;
  message: string;
}

/** A follow-up operation with its observed frequency, so consumers can judge signal strength. */
export interface FollowUpOperation {
  operation: string;
  count: number;
}

export interface AgentEvidenceOperation {
  operation_key: string;
  method: string;
  path: string;
  operation_id?: string;
  spec_location?: string;
  observed_count: number;
  response_completeness?: number;
  verification_loop_count: number;
  wasted_request_count: number;
  missing_response_fields: string[];
  common_follow_up_operations: FollowUpOperation[];
  recommendations: AgentEvidenceRecommendation[];
  warnings?: string[];
}

export interface AgentEvidence {
  schema_version: typeof AGENT_EVIDENCE_SCHEMA_VERSION;
  run: {
    name: string;
    consumer: 'agent';
    sample_count: number;
  };
  spec?: {
    source: string;
    hash: string;
  };
  operations: AgentEvidenceOperation[];
  unmatched_observations?: Array<{
    operation_key: string;
    reason: string;
  }>;
  warnings?: string[];
}

export interface BuildAgentEvidenceOptions {
  runName: string;
  sampleCount: number;
  sequenceAnalysis: SequenceAnalysis;
  completenessReport: CompletenessReport;
  specSource?: string;
  /** Raw spec text already read by the caller — hashed here to avoid a second read. */
  specContent?: string;
  specOperations?: OpenApiOperationRef[];
}

interface OperationAccumulator {
  operationKey: string;
  method: string;
  path: string;
  observedCount: number;
  responseCompleteness?: number;
  verificationLoopCount: number;
  wastedRequestCount: number;
  missingResponseFields: string[];
  commonFollowUpOperations: FollowUpOperation[];
  warnings: string[];
}

export function buildAgentEvidence(opts: BuildAgentEvidenceOptions): AgentEvidence {
  const accumulators = new Map<string, OperationAccumulator>();

  for (const tool of opts.sequenceAnalysis.toolUsage) {
    const parsed = parseOperationKey(tool.operationKey);
    if (!parsed) continue;
    getAccumulator(accumulators, parsed.method, parsed.path).observedCount = tool.count;
  }

  for (const endpoint of opts.completenessReport.endpoints) {
    const acc = getAccumulator(accumulators, endpoint.method, endpoint.path);
    acc.responseCompleteness = round(endpoint.completenessScore);
    acc.missingResponseFields = endpoint.missingFields;
  }

  // verification_loop_count and wasted_request_count derive from DISTINCT
  // sequence patterns. Read-after-write loops feed verification_loop_count;
  // repeated equivalent REST calls (retry) feed wasted_request_count.
  // Sourcing both from the same signal is the bug this fixes.
  //
  // wasted is sourced only from REST retry sequences. REST detection pairs
  // CONSECUTIVE samples, so the count is the true duplicate count. JSON-RPC
  // detection is windowed (each request paired with up to N followers), so its
  // sequence counts overcount duplicates; JSON-RPC protocol/tool redundancy is
  // therefore surfaced at the report level (redundantCalls) rather than folded
  // into per-operation evidence here (deferred to a later phase).
  for (const seq of opts.sequenceAnalysis.sequences) {
    if (seq.pattern === 'verification_loop') {
      const acc = getAccumulator(accumulators, seq.fromMethod, seq.fromPath);
      acc.verificationLoopCount += seq.count;
    } else if (seq.pattern === 'retry' && HTTP_METHODS.has(seq.fromMethod.toUpperCase())) {
      const acc = getAccumulator(accumulators, seq.fromMethod, seq.fromPath);
      acc.wastedRequestCount += seq.count;
    }
  }

  const nextSteps = collectNextSteps(opts.sequenceAnalysis.sequences);
  for (const [operationKey, steps] of nextSteps) {
    const parsed = parseOperationKey(operationKey);
    if (!parsed) continue;
    getAccumulator(accumulators, parsed.method, parsed.path).commonFollowUpOperations = steps;
  }

  const unmatched: AgentEvidence['unmatched_observations'] = [];
  const operations = Array.from(accumulators.values())
    .map((acc) => {
      const evidenceOperation: AgentEvidenceOperation = {
        operation_key: acc.operationKey,
        method: acc.method,
        path: acc.path,
        observed_count: acc.observedCount,
        response_completeness: acc.responseCompleteness,
        verification_loop_count: acc.verificationLoopCount,
        wasted_request_count: acc.wastedRequestCount,
        missing_response_fields: acc.missingResponseFields,
        common_follow_up_operations: acc.commonFollowUpOperations,
        recommendations: buildRecommendations(acc, opts.sampleCount),
      };

      if (opts.specOperations) {
        const match = matchOpenApiOperation(opts.specOperations, acc.method, acc.path);
        if (match.operation) {
          evidenceOperation.operation_id = match.operation.operationId;
          evidenceOperation.spec_location = match.operation.specLocation;
        } else if (match.warning) {
          // The operation always lives once in operations[] carrying the warning.
          // unmatched_observations is a summary index of NO-MATCH keys only;
          // ambiguous matches (multiple candidates) are excluded from it — they
          // stay in operations[] with the warning and an omitted operation_id.
          evidenceOperation.warnings = [match.warning];
          if (!match.ambiguous) {
            unmatched.push({ operation_key: acc.operationKey, reason: match.warning });
          }
        }
      }

      if (acc.warnings.length > 0) {
        evidenceOperation.warnings = [...(evidenceOperation.warnings ?? []), ...acc.warnings];
      }

      return evidenceOperation;
    })
    .sort((a, b) => a.operation_key.localeCompare(b.operation_key));

  const evidence: AgentEvidence = {
    schema_version: AGENT_EVIDENCE_SCHEMA_VERSION,
    run: {
      name: opts.runName,
      consumer: 'agent',
      sample_count: opts.sampleCount,
    },
    operations,
  };

  if (opts.specSource) {
    // Hash the bytes the caller already read when available; only fall back to a
    // second read if raw content was not provided.
    const hash =
      opts.specContent !== undefined ? hashContent(opts.specContent) : hashFile(opts.specSource);
    evidence.spec = { source: opts.specSource, hash };
  }
  if (unmatched.length > 0) {
    evidence.unmatched_observations = unmatched;
  }

  return evidence;
}

function getAccumulator(
  accumulators: Map<string, OperationAccumulator>,
  method: string,
  path: string,
): OperationAccumulator {
  const normalizedMethod = method.toUpperCase();
  const operationKey = `${normalizedMethod} ${path}`;
  const existing = accumulators.get(operationKey);
  if (existing) return existing;

  const created: OperationAccumulator = {
    operationKey,
    method: normalizedMethod,
    path,
    observedCount: 0,
    verificationLoopCount: 0,
    wastedRequestCount: 0,
    missingResponseFields: [],
    commonFollowUpOperations: [],
    warnings: [],
  };
  accumulators.set(operationKey, created);
  return created;
}

function collectNextSteps(sequences: OperationSequence[]): Map<string, FollowUpOperation[]> {
  const byOperation = new Map<string, Map<string, number>>();
  for (const seq of sequences) {
    const fromKey = `${seq.fromMethod.toUpperCase()} ${seq.fromPath}`;
    const toKey = `${seq.toMethod.toUpperCase()} ${seq.toPath}`;
    // A self-follow-up (e.g. a retry) is not a distinct "next step".
    if (toKey === fromKey) continue;
    const counts = byOperation.get(fromKey) ?? new Map<string, number>();
    counts.set(toKey, (counts.get(toKey) ?? 0) + seq.count);
    byOperation.set(fromKey, counts);
  }

  const result = new Map<string, FollowUpOperation[]>();
  for (const [operationKey, counts] of byOperation) {
    const sorted = Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([operation, count]) => ({ operation, count }));
    result.set(operationKey, sorted);
  }
  return result;
}

/** Below this sample count, recommendations carry a weak-signal caveat. */
const LOW_SAMPLE_THRESHOLD = 10;

/**
 * Build the phase-1 recommendation set for an operation.
 *
 * Phase-1 emits exactly three kinds — `enrich_write_response`,
 * `document_common_next_step`, `reduce_redundant_call`. The other two
 * `RecommendationKind` values (`standardize_error_response`,
 * `add_operation_metadata`) are declared in the type but have no producer yet
 * (deferred to phase-2 — they need signals not collected here).
 *
 * Wording is OBSERVATIONAL and evidence-first: lead with what was observed, then
 * suggest the fix. Language strength scales with confidence (a strong/repeated
 * pattern reads "may reduce…"; a weak one reads "Consider…"), and a low sample
 * count adds an explicit weak-signal caveat.
 */
function buildRecommendations(
  acc: OperationAccumulator,
  sampleCount: number,
): AgentEvidenceRecommendation[] {
  const recommendations: AgentEvidenceRecommendation[] = [];
  const caveat =
    sampleCount < LOW_SAMPLE_THRESHOLD ? ' (Low sample count — treat as a weak signal.)' : '';

  // enrich_write_response: the write response is thin and/or agents had to
  // re-read to confirm the write (read-after-write verification loops). Both are
  // the same "the response didn't return enough" concern.
  const thin = acc.responseCompleteness !== undefined && acc.responseCompleteness < 0.5;
  const loops = acc.verificationLoopCount > 0;
  if (thin || loops) {
    const observed: string[] = [];
    if (thin) {
      observed.push(
        `returned ${Math.round((acc.responseCompleteness as number) * 100)}% of the fields a later read returns`,
      );
    }
    if (loops) {
      observed.push(
        `was followed by ${acc.verificationLoopCount} read-after-write verification read(s)`,
      );
    }
    const strong =
      acc.verificationLoopCount >= 3 || (thin && (acc.responseCompleteness as number) < 0.25);
    const action = strong
      ? 'Returning the created or updated resource in full may reduce these reads.'
      : 'Consider returning the created or updated resource in full.';
    recommendations.push({
      kind: 'enrich_write_response',
      severity: strong ? 'high' : 'medium',
      message: `${acc.operationKey} ${observed.join(' and ')}. ${action}${caveat}`,
    });
  }

  // document_common_next_step: agents repeatedly called ANOTHER operation after
  // this one — driven by the observed follow-up data, not by verification loops.
  if (acc.commonFollowUpOperations.length > 0) {
    const next = acc.commonFollowUpOperations[0].operation;
    recommendations.push({
      kind: 'document_common_next_step',
      severity: 'low',
      message: `Agents commonly called ${next} after ${acc.operationKey}. Consider documenting this next step or adding a response affordance (such as a link) so it is discoverable.${caveat}`,
    });
  }

  // reduce_redundant_call: the same call was repeated with no new input.
  if (acc.wastedRequestCount > 0) {
    recommendations.push({
      kind: 'reduce_redundant_call',
      severity: 'medium',
      message: `${acc.operationKey} was repeated ${acc.wastedRequestCount} time(s) with no new input. Consider clarifying the response semantics so a single call suffices.${caveat}`,
    });
  }

  return recommendations;
}

function hashContent(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function hashFile(filePath: string): string {
  return hashContent(readFileSync(filePath, 'utf8'));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
