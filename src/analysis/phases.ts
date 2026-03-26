/**
 * Session phase detection — groups agent tool calls into phases based on
 * timing gaps and classifies each phase by its content (discovery, creation,
 * verification, operation).
 */
import type { Sample } from '../types/index.js';
import { isJsonRpcSession, extractJsonRpcOperation } from './jsonrpc.js';
import { isWriteTool, isReadTool } from './completeness.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PhaseName = 'discovery' | 'creation' | 'verification' | 'operation';

export interface PhaseSample {
  index: number;
  operationKey: string;
  toolName?: string;
  capturedAt: string;
}

export interface SessionPhase {
  name: PhaseName;
  startIndex: number;
  endIndex: number;
  samples: PhaseSample[];
  duration: number;
}

export interface PhaseAnalysis {
  phases: SessionPhase[];
  toolPhaseMap: Map<string, string[]>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** A timing gap larger than this between consecutive samples starts a new phase. */
const PHASE_GAP_MS = 2000;

const REST_WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const REST_READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// ---------------------------------------------------------------------------
// Phase detection
// ---------------------------------------------------------------------------

/**
 * Split samples into phases based on timing gaps, then classify each phase.
 */
export function detectPhases(samples: Sample[]): PhaseAnalysis {
  const empty: PhaseAnalysis = { phases: [], toolPhaseMap: new Map() };
  if (samples.length === 0) return empty;

  const jsonrpc = isJsonRpcSession(samples);

  // Build PhaseSample entries
  const phaseSamples: PhaseSample[] = samples.map((s, i) => {
    if (jsonrpc) {
      const op = extractJsonRpcOperation(s);
      return {
        index: i,
        operationKey: op?.operationKey ?? `${s.httpMethod} ${s.normalizedPath}`,
        toolName: op?.toolName,
        capturedAt: s.capturedAt,
      };
    }
    return {
      index: i,
      operationKey: `${s.httpMethod} ${s.normalizedPath}`,
      toolName: undefined,
      capturedAt: s.capturedAt,
    };
  });

  // Split into groups by timing gaps
  const groups: PhaseSample[][] = [];
  let current: PhaseSample[] = [phaseSamples[0]];

  for (let i = 1; i < phaseSamples.length; i++) {
    const prevTime = new Date(phaseSamples[i - 1].capturedAt).getTime();
    const curTime = new Date(phaseSamples[i].capturedAt).getTime();
    if (curTime - prevTime > PHASE_GAP_MS) {
      groups.push(current);
      current = [];
    }
    current.push(phaseSamples[i]);
  }
  groups.push(current);

  // Classify each group
  const phases: SessionPhase[] = [];
  let prevPhaseName: PhaseName | undefined;
  let hasSeenWrites = false;

  for (const group of groups) {
    const name = classifyPhase(group, jsonrpc, prevPhaseName, hasSeenWrites);
    if (name === 'creation') hasSeenWrites = true;
    const startTime = new Date(group[0].capturedAt).getTime();
    const endTime = new Date(group[group.length - 1].capturedAt).getTime();
    phases.push({
      name,
      startIndex: group[0].index,
      endIndex: group[group.length - 1].index,
      samples: group,
      duration: endTime - startTime,
    });
    prevPhaseName = name;
  }

  // Build tool → phase map
  const toolPhaseMap = new Map<string, string[]>();
  for (const phase of phases) {
    for (const s of phase.samples) {
      const key = s.toolName ?? s.operationKey;
      const existing = toolPhaseMap.get(key);
      if (!existing) {
        toolPhaseMap.set(key, [phase.name]);
      } else if (!existing.includes(phase.name)) {
        existing.push(phase.name);
      }
    }
  }

  return { phases, toolPhaseMap };
}

// ---------------------------------------------------------------------------
// Phase classification
// ---------------------------------------------------------------------------

function classifyPhase(
  group: PhaseSample[],
  jsonrpc: boolean,
  prevPhase: PhaseName | undefined,
  hasSeenWrites: boolean,
): PhaseName {
  let writeCount = 0;
  let readCount = 0;
  const distinctOps = new Set<string>();

  for (const s of group) {
    distinctOps.add(s.operationKey);

    if (jsonrpc) {
      if (s.toolName) {
        if (isWriteTool(s.toolName)) writeCount++;
        else if (isReadTool(s.toolName)) readCount++;
      }
      // Protocol messages like initialize, tools/list are read-like
      if (!s.toolName && (s.operationKey === 'tools/list' || s.operationKey === 'initialize')) {
        readCount++;
      }
    } else {
      // REST: classify by HTTP method
      const method = s.operationKey.split(' ')[0];
      if (REST_WRITE_METHODS.has(method)) writeCount++;
      else if (REST_READ_METHODS.has(method)) readCount++;
    }
  }

  // If any write tool is present, it's a creation phase
  if (writeCount > 0) return 'creation';

  // If writes have occurred earlier in the session and this phase is read-heavy, it's verification
  if (hasSeenWrites && readCount > 0) {
    return 'verification';
  }

  // Read-heavy before any writes = discovery
  if (readCount > 0) return 'discovery';

  // Fallback
  return 'operation';
}
