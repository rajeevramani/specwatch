/**
 * Call investigation — root-cause analysis for redundant calls in agent sessions.
 * Given a set of redundant calls detected by sequence analysis, investigates each
 * operation to determine why it was called multiple times and provides recommendations.
 */
import type { Sample, InferredSchema } from '../types/index.js';
import type { SchemaDiff } from '../types/index.js';
import { computeSchemaFingerprint } from '../aggregation/pipeline.js';
import { detectBreakingChanges } from '../aggregation/diff.js';
import { extractJsonRpcOperation } from './jsonrpc.js';
import type { PhaseAnalysis, PhaseName } from './phases.js';
import type { RedundantCall } from './sequences.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Root cause classification for why an operation was called multiple times. */
export type RedundantCause =
  | 'identical_response'
  | 'different_response'
  | 'retry_after_error'
  | 'session_restart'
  | 'different_phase'
  | 'different_params'
  | 'unknown';

/** A single occurrence of an operation in the sample timeline. */
export interface CallOccurrence {
  sampleIndex: number;
  sampleId: number;
  capturedAt: string;
  statusCode?: number;
  phase?: PhaseName;
  responseSchema?: InferredSchema;
  requestSchema?: InferredSchema;
}

/** Analysis of a consecutive pair of calls to the same operation. */
export interface PairAnalysis {
  fromIndex: number;
  toIndex: number;
  deltaMs: number;
  cause: RedundantCause;
  responseDiff: SchemaDiff | undefined;
  requestDiff: SchemaDiff | undefined;
  interveningOps: string[];
  crossPhase: boolean;
}

/** Full investigation result for a single redundant operation. */
export interface CallInvestigation {
  operationKey: string;
  occurrences: CallOccurrence[];
  pairAnalyses: PairAnalysis[];
  primaryCause: RedundantCause;
  explanation: string;
  recommendation: string;
}

/** Investigation report spanning all redundant calls in a session. */
export interface InvestigationReport {
  sessionId: string;
  investigations: CallInvestigation[];
}

// ---------------------------------------------------------------------------
// Schema comparison
// ---------------------------------------------------------------------------

/**
 * Check if two schemas are structurally equal using fingerprinting.
 * Both undefined = equal. One undefined = not equal.
 */
export function schemasStructurallyEqual(
  a?: InferredSchema,
  b?: InferredSchema,
): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  return computeSchemaFingerprint(a) === computeSchemaFingerprint(b);
}

// ---------------------------------------------------------------------------
// Cause classification
// ---------------------------------------------------------------------------

/**
 * Classify why a redundant call occurred between two consecutive occurrences.
 * Priority-ordered — first matching rule wins.
 */
export function classifyCause(
  from: CallOccurrence,
  to: CallOccurrence,
  interveningOps: string[],
  crossPhase: boolean,
): RedundantCause {
  // P1: retry after error — from returned an error status
  if (from.statusCode !== undefined && from.statusCode >= 400) {
    return 'retry_after_error';
  }

  // P2: different request params
  if (!schemasStructurallyEqual(from.requestSchema, to.requestSchema)) {
    return 'different_params';
  }

  // P3: session restart — large time gap
  const deltaMs =
    new Date(to.capturedAt).getTime() - new Date(from.capturedAt).getTime();
  if (deltaMs > 30000) {
    return 'session_restart';
  }

  // P4: different phase
  if (crossPhase) {
    return 'different_phase';
  }

  // P5: different response
  if (!schemasStructurallyEqual(from.responseSchema, to.responseSchema)) {
    return 'different_response';
  }

  // P6: identical response — pure waste
  if (schemasStructurallyEqual(from.responseSchema, to.responseSchema)) {
    return 'identical_response';
  }

  return 'unknown';
}

// ---------------------------------------------------------------------------
// Explanation / recommendation generation
// ---------------------------------------------------------------------------

function generateExplanation(
  cause: RedundantCause,
  occurrences: CallOccurrence[],
  pairAnalyses: PairAnalysis[],
): string {
  switch (cause) {
    case 'identical_response': {
      // Use intervening ops and timing to explain WHY the agent re-called
      const allIntervening = pairAnalyses.flatMap((p) => p.interveningOps);
      const uniqueIntervening = [...new Set(allIntervening)];

      if (uniqueIntervening.length === 0) {
        // Back-to-back with nothing in between
        const avgDelta =
          pairAnalyses.reduce((sum, p) => sum + p.deltaMs, 0) / pairAnalyses.length;
        if (avgDelta < 1000) {
          return 'Called back-to-back with no intervening operations — likely an SDK or framework auto-call (e.g., initialization handshake).';
        }
        return 'Called multiple times with no intervening operations — agent lacks caching for this endpoint.';
      }

      // Check if intervening ops suggest a reason to re-fetch
      const writeOps = uniqueIntervening.filter(
        (op) => /create|update|set|put|patch|add|insert|delete|remove|register|configure/i.test(op),
      );
      if (writeOps.length > 0) {
        const writeList = writeOps.map((o) => o.replace(/^tools\/call:/, '')).join(', ');
        return `Re-fetched after write operations (${writeList}) but response was unchanged — agent expected state to change but it didn't.`;
      }

      return `Called again after ${uniqueIntervening.length} intervening operations but response was unchanged — agent is re-fetching instead of caching.`;
    }
    case 'retry_after_error': {
      const errorOcc = occurrences.find((o) => o.statusCode !== undefined && o.statusCode >= 400);
      const code = errorOcc?.statusCode ?? 'unknown';
      return `First call returned ${code} — agent retried to recover from the error.`;
    }
    case 'different_params':
      return 'Request parameters differ between calls — these are logically distinct operations, not true redundancy.';
    case 'session_restart': {
      const times = occurrences.map((o) => new Date(o.capturedAt).getTime());
      let maxGap = 0;
      for (let i = 1; i < times.length; i++) {
        maxGap = Math.max(maxGap, times[i] - times[i - 1]);
      }
      return `${Math.round(maxGap / 1000)}s gap between calls — agent likely reconnected or restarted the session and re-ran initialization.`;
    }
    case 'different_phase': {
      const phases = occurrences
        .filter((o) => o.phase !== undefined)
        .map((o) => o.phase!);
      const uniquePhases = [...new Set(phases)];
      return `Called once per phase (${uniquePhases.join(' → ')}) — agent re-fetches at the start of each workflow stage.`;
    }
    case 'different_response':
      return 'Response changed between calls — server state was modified by intervening operations, so re-fetching was warranted.';
    default:
      return 'Unable to determine a specific cause for redundancy.';
  }
}

function generateRecommendation(
  cause: RedundantCause,
  pairAnalyses: PairAnalysis[],
): string {
  switch (cause) {
    case 'identical_response': {
      const hasWrites = pairAnalyses.some((p) =>
        p.interveningOps.some((op) =>
          /create|update|set|put|patch|add|insert|delete|remove|register|configure/i.test(op),
        ),
      );
      if (hasWrites) {
        return 'The write operations between calls did not affect this response. Cache it and only re-fetch when directly relevant state changes.';
      }
      return 'Cache the response after the first successful call. If using MCP, the SDK should store tools/list results for the session lifetime.';
    }
    case 'retry_after_error':
      return 'Retry is appropriate. Consider exponential backoff to avoid hammering the server.';
    case 'different_params':
      return 'No action needed — these are logically distinct calls despite sharing the same endpoint.';
    case 'session_restart':
      return 'Investigate why the session restarted. If reconnects are expected, cache can persist across reconnects.';
    case 'different_phase':
      return 'Cache the response within each phase. Re-fetch only on phase transitions if the data may have changed.';
    case 'different_response':
      return 'Re-fetch was justified. If polling, consider webhooks or subscriptions to reduce traffic.';
    default:
      return 'Review the call pattern manually for optimization opportunities.';
  }
}

// ---------------------------------------------------------------------------
// Operation investigation
// ---------------------------------------------------------------------------

/**
 * Investigate a single operation to determine why it was called multiple times.
 * Filters samples for the given operation key, builds occurrence timeline,
 * analyzes each consecutive pair, and determines the primary cause.
 */
export function investigateOperation(
  samples: Sample[],
  operationKey: string,
  phaseAnalysis?: PhaseAnalysis,
): CallInvestigation {
  // Filter samples matching this operation key
  const occurrences: CallOccurrence[] = [];

  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];
    const op = extractJsonRpcOperation(sample);
    const sampleOpKey = op?.operationKey ?? `${sample.httpMethod} ${sample.normalizedPath}`;

    if (sampleOpKey !== operationKey) continue;

    // Look up phase from phaseAnalysis if provided
    let phase: PhaseName | undefined;
    if (phaseAnalysis) {
      for (const p of phaseAnalysis.phases) {
        if (i >= p.startIndex && i <= p.endIndex) {
          phase = p.name;
          break;
        }
      }
    }

    occurrences.push({
      sampleIndex: i,
      sampleId: sample.id,
      capturedAt: sample.capturedAt,
      statusCode: sample.statusCode,
      phase,
      responseSchema: sample.responseSchema,
      requestSchema: sample.requestSchema,
    });
  }

  // Analyze consecutive pairs
  const pairAnalyses: PairAnalysis[] = [];
  const causeCounts = new Map<RedundantCause, number>();

  for (let i = 0; i < occurrences.length - 1; i++) {
    const from = occurrences[i];
    const to = occurrences[i + 1];

    const deltaMs =
      new Date(to.capturedAt).getTime() - new Date(from.capturedAt).getTime();

    // Get intervening operations (samples between the two indices)
    const interveningOps: string[] = [];
    for (let j = from.sampleIndex + 1; j < to.sampleIndex; j++) {
      const s = samples[j];
      const op = extractJsonRpcOperation(s);
      const key = op?.operationKey ?? `${s.httpMethod} ${s.normalizedPath}`;
      interveningOps.push(key);
    }

    const crossPhase = from.phase !== undefined && to.phase !== undefined && from.phase !== to.phase;

    const cause = classifyCause(from, to, interveningOps, crossPhase);
    causeCounts.set(cause, (causeCounts.get(cause) ?? 0) + 1);

    // Compute diffs
    let responseDiff: SchemaDiff | undefined;
    if (from.responseSchema && to.responseSchema) {
      responseDiff = detectBreakingChanges(from.responseSchema, to.responseSchema);
    }

    let requestDiff: SchemaDiff | undefined;
    if (from.requestSchema && to.requestSchema) {
      requestDiff = detectBreakingChanges(from.requestSchema, to.requestSchema);
    }

    pairAnalyses.push({
      fromIndex: from.sampleIndex,
      toIndex: to.sampleIndex,
      deltaMs,
      cause,
      responseDiff,
      requestDiff,
      interveningOps,
      crossPhase,
    });
  }

  // Primary cause = mode (most frequent)
  let primaryCause: RedundantCause = 'unknown';
  let maxCount = 0;
  for (const [cause, count] of causeCounts) {
    if (count > maxCount) {
      maxCount = count;
      primaryCause = cause;
    }
  }

  const explanation = generateExplanation(primaryCause, occurrences, pairAnalyses);
  const recommendation = generateRecommendation(primaryCause, pairAnalyses);

  return {
    operationKey,
    occurrences,
    pairAnalyses,
    primaryCause,
    explanation,
    recommendation,
  };
}

// ---------------------------------------------------------------------------
// Batch investigation
// ---------------------------------------------------------------------------

/**
 * Investigate all redundant calls detected in a session.
 * Maps over redundantCalls and runs investigateOperation for each.
 */
export function investigateRedundantCalls(
  samples: Sample[],
  redundantCalls: RedundantCall[],
  phaseAnalysis?: PhaseAnalysis,
): InvestigationReport {
  const sessionId = samples.length > 0 ? samples[0].sessionId : '';

  const investigations = redundantCalls.map((rc) =>
    investigateOperation(samples, rc.operationKey, phaseAnalysis),
  );

  return {
    sessionId,
    investigations,
  };
}
