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
  common_follow_up_operations: string[];
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
  commonFollowUpOperations: string[];
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
        recommendations: buildRecommendations(acc),
      };

      if (opts.specOperations) {
        const match = matchOpenApiOperation(opts.specOperations, acc.method, acc.path);
        if (match.operation) {
          evidenceOperation.operation_id = match.operation.operationId;
          evidenceOperation.spec_location = match.operation.specLocation;
        } else if (match.warning) {
          evidenceOperation.warnings = [match.warning];
          unmatched.push({ operation_key: acc.operationKey, reason: match.warning });
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
    evidence.spec = {
      source: opts.specSource,
      hash: hashFile(opts.specSource),
    };
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

function collectNextSteps(sequences: OperationSequence[]): Map<string, string[]> {
  const byOperation = new Map<string, Map<string, number>>();
  for (const seq of sequences) {
    const fromKey = `${seq.fromMethod.toUpperCase()} ${seq.fromPath}`;
    const toKey = `${seq.toMethod.toUpperCase()} ${seq.toPath}`;
    const counts = byOperation.get(fromKey) ?? new Map<string, number>();
    counts.set(toKey, (counts.get(toKey) ?? 0) + seq.count);
    byOperation.set(fromKey, counts);
  }

  const result = new Map<string, string[]>();
  for (const [operationKey, counts] of byOperation) {
    const sorted = Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([key]) => key);
    result.set(operationKey, sorted);
  }
  return result;
}

function buildRecommendations(acc: OperationAccumulator): AgentEvidenceRecommendation[] {
  const recommendations: AgentEvidenceRecommendation[] = [];

  if (acc.responseCompleteness !== undefined && acc.responseCompleteness < 0.5) {
    recommendations.push({
      kind: 'enrich_write_response',
      severity: 'high',
      message: `Return more complete data from ${acc.operationKey} to reduce agent read-after-write verification.`,
    });
  }

  if (acc.verificationLoopCount > 0) {
    recommendations.push({
      kind: 'document_common_next_step',
      severity: 'medium',
      message: `${acc.operationKey} was followed by verification reads ${acc.verificationLoopCount} time(s); document or enrich the response so agents know whether the write succeeded.`,
    });
  }

  if (acc.wastedRequestCount > 0) {
    recommendations.push({
      kind: 'reduce_redundant_call',
      severity: 'medium',
      message: `${acc.operationKey} contributed to redundant agent calls; clarify response semantics or next-step affordances.`,
    });
  }

  return recommendations;
}

function hashFile(filePath: string): string {
  const body = readFileSync(filePath);
  return `sha256:${createHash('sha256').update(body).digest('hex')}`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
