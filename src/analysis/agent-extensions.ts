/**
 * Bridge between analysis modules (sequences, completeness) and the OpenAPI export.
 * Builds per-endpoint x-specwatch-agent extension objects from analysis results.
 */
import type { SequenceAnalysis } from './sequences.js';
import type { CompletenessReport } from './completeness.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Extension data attached to a single operation as x-specwatch-agent. */
export interface AgentExtension {
  responseCompleteness?: number;
  missingFields?: string[];
  verificationLoopDetected?: boolean;
  verificationLoopCount?: number;
  commonNextSteps?: string[];
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Build a map of agent extensions keyed by "METHOD /path".
 *
 * Only includes fields that have meaningful data. Returns an empty record
 * if neither analysis produces actionable results.
 */
export function buildAgentExtensions(
  sequenceAnalysis: SequenceAnalysis,
  completenessReport: CompletenessReport,
): Record<string, AgentExtension> {
  const extensions: Record<string, AgentExtension> = {};

  // --- Completeness data (keyed by write endpoint) ---
  for (const endpoint of completenessReport.endpoints) {
    const key = `${endpoint.method} ${endpoint.path}`;
    const ext: AgentExtension = {};

    ext.responseCompleteness = Math.round(endpoint.completenessScore * 100) / 100;

    if (endpoint.missingFields.length > 0) {
      ext.missingFields = endpoint.missingFields;
    }

    extensions[key] = ext;
  }

  // --- Verification loop data (keyed by the "from" write endpoint) ---
  for (const loop of sequenceAnalysis.verificationLoops) {
    const key = `${loop.fromMethod} ${loop.fromPath}`;
    const ext = extensions[key] ?? {};

    ext.verificationLoopDetected = true;
    ext.verificationLoopCount = loop.count;

    extensions[key] = ext;
  }

  // --- Common next steps from all sequences (keyed by "from" endpoint) ---
  // Group sequences by their "from" endpoint to collect next steps
  const nextStepsMap = new Map<string, string[]>();
  for (const seq of sequenceAnalysis.sequences) {
    const key = `${seq.fromMethod} ${seq.fromPath}`;
    const step = `${seq.toMethod} ${seq.toPath}`;
    const steps = nextStepsMap.get(key) ?? [];
    steps.push(step);
    nextStepsMap.set(key, steps);
  }

  for (const [key, steps] of nextStepsMap) {
    const ext = extensions[key] ?? {};
    ext.commonNextSteps = steps;
    extensions[key] = ext;
  }

  // --- Filter out empty extensions ---
  const result: Record<string, AgentExtension> = {};
  for (const [key, ext] of Object.entries(extensions)) {
    if (Object.keys(ext).length > 0) {
      result[key] = ext;
    }
  }

  return result;
}
