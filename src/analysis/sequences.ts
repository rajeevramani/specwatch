/**
 * Operation sequence detection and verification loop analysis.
 * Detects patterns in agent traffic: verification loops, create chains,
 * and list-after-create sequences from captured samples.
 */
import type Database from 'better-sqlite3';
import { SessionRepository } from '../storage/sessions.js';
import { SampleRepository } from '../storage/samples.js';
import { isJsonRpcSession, extractJsonRpcOperation } from './jsonrpc.js';
import type { Sample } from '../types/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The kind of pattern detected between two consecutive operations. */
export type SequencePattern =
  | 'verification_loop'
  | 'create_chain'
  | 'list_after_create'
  | 'redundant_list'
  | 'retry'
  | 'unknown';

/** A pair of consecutive operations within a session. */
export interface OperationSequence {
  /** HTTP method of the first request */
  fromMethod: string;
  /** Normalized path of the first request */
  fromPath: string;
  /** HTTP method of the second request */
  toMethod: string;
  /** Normalized path of the second request */
  toPath: string;
  /** Average delay between the two requests in milliseconds */
  avgDelayMs: number;
  /** How many times this exact sequence was observed */
  count: number;
  /** Classified pattern */
  pattern: SequencePattern;
}

/** Summary analysis for a session's request sequences. */
export interface SequenceAnalysis {
  /** All detected sequences */
  sequences: OperationSequence[];
  /** Sequences classified as verification loops */
  verificationLoops: OperationSequence[];
  /** Total number of requests in the session */
  totalRequests: number;
  /** Estimated wasted requests (requests that are part of verification loops) */
  wastedRequests: number;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface SequenceKey {
  fromMethod: string;
  fromPath: string;
  toMethod: string;
  toPath: string;
}

interface SequenceAccumulator {
  key: SequenceKey;
  delays: number[];
}

// ---------------------------------------------------------------------------
// Pattern classification
// ---------------------------------------------------------------------------

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/**
 * Extracts the resource base path from a normalized path.
 * e.g. "/users/{userId}" → "/users", "/users/{userId}/posts/{postId}" → "/users/{userId}/posts"
 */
function getResourceBase(normalizedPath: string): string {
  const segments = normalizedPath.split('/').filter(Boolean);
  if (segments.length === 0) return '/';
  // If last segment is a param, return parent
  const last = segments[segments.length - 1];
  if (last.startsWith('{') && last.endsWith('}')) {
    return '/' + segments.slice(0, -1).join('/');
  }
  return normalizedPath;
}

/**
 * Checks if toPath is a child resource of fromPath.
 * e.g. fromPath="/parents/{parentId}", toPath="/parents/{parentId}/children" → true
 */
function isChildResource(fromPath: string, toPath: string): boolean {
  const fromBase = getResourceBase(fromPath);
  // toPath should start with the fromPath (including param) and have additional segments
  // e.g. /parents/{parentId}/children starts with /parents/{parentId}
  return (
    toPath.startsWith(fromPath + '/') ||
    toPath.startsWith(fromBase + '/{') // parent/{id}/child pattern
  );
}

/**
 * Classify a sequence of two consecutive operations into a known pattern.
 */
export function classifyPattern(
  fromMethod: string,
  fromPath: string,
  toMethod: string,
  toPath: string,
  avgDelayMs: number,
): SequencePattern {
  const fromBase = getResourceBase(fromPath);
  const toBase = getResourceBase(toPath);

  if (WRITE_METHODS.has(fromMethod) && toMethod === 'GET') {
    const toSegments = toPath.split('/').filter(Boolean);
    const toLastSegment = toSegments[toSegments.length - 1] ?? '';
    const toIsCollection = !toLastSegment.startsWith('{');

    // list_after_create: POST /resource → GET /resource (same collection endpoint)
    // Must check before verification_loop since both match write→GET patterns
    if (toIsCollection && (fromPath === toPath || fromBase === toPath)) {
      return 'list_after_create';
    }

    // verification_loop: POST/PUT/PATCH /resource → GET /resource/{id} (item endpoint)
    const sameResource = fromBase === toBase || fromPath === toBase;
    if (sameResource && avgDelayMs <= 2000) {
      return 'verification_loop';
    }
  }

  // create_chain: POST /parent → POST /parent/{id}/child
  if (fromMethod === 'POST' && toMethod === 'POST') {
    if (isChildResource(fromPath, toPath)) {
      return 'create_chain';
    }
  }

  return 'unknown';
}

// ---------------------------------------------------------------------------
// JSON-RPC pattern classification
// ---------------------------------------------------------------------------

/**
 * Classify a pair of consecutive JSON-RPC operations into a known pattern.
 */
export function classifyJsonRpcPattern(
  fromKey: string,
  toKey: string,
): SequencePattern {
  // retry: same tool called consecutively (e.g., tools/call:my_tool → tools/call:my_tool)
  if (fromKey === toKey && fromKey.startsWith('tools/call:')) {
    return 'retry';
  }

  // redundant_list: tools/list called multiple times
  if (fromKey === 'tools/list' && toKey === 'tools/list') {
    return 'redundant_list';
  }

  // verification_loop: tools/call:create_X → tools/call:query_X or get_X
  // Detect create→query pattern by looking at tool name prefixes
  const fromParts = fromKey.split(':');
  const toParts = toKey.split(':');
  if (
    fromParts[0] === 'tools/call' &&
    toParts[0] === 'tools/call' &&
    fromParts[1] &&
    toParts[1]
  ) {
    const fromTool = fromParts[1];
    const toTool = toParts[1];
    // create/set/update → get/query/read/describe/list on same resource type
    const writePrefix = /^(create|set|update|put|patch|add|insert|upsert)[-_]/i;
    const readPrefix = /^(get|query|read|describe|list|fetch|show|find|lookup)[-_]/i;
    if (writePrefix.test(fromTool) && readPrefix.test(toTool)) {
      // Check if they share a resource suffix
      const fromSuffix = fromTool.replace(writePrefix, '');
      const toSuffix = toTool.replace(readPrefix, '');
      if (fromSuffix === toSuffix) {
        return 'verification_loop';
      }
    }
  }

  return 'unknown';
}

// ---------------------------------------------------------------------------
// Sequence detection
// ---------------------------------------------------------------------------

/**
 * Build a string key for grouping identical sequences.
 */
function sequenceKeyString(key: SequenceKey): string {
  return `${key.fromMethod} ${key.fromPath} -> ${key.toMethod} ${key.toPath}`;
}

/**
 * Get the operation key for a sample — uses JSON-RPC operation key for
 * JSON-RPC sessions, or "METHOD /path" for REST sessions.
 */
function getOperationKey(sample: Sample, jsonrpc: boolean): { method: string; path: string } {
  if (jsonrpc) {
    const op = extractJsonRpcOperation(sample);
    if (op) {
      return { method: op.rpcMethod, path: op.operationKey };
    }
  }
  return { method: sample.httpMethod, path: sample.normalizedPath };
}

/**
 * Detect operation sequences from samples in a session.
 * Queries samples ordered by captured_at, builds pairs of consecutive requests,
 * groups by (from→to), counts occurrences, and calculates average delay.
 *
 * For JSON-RPC sessions, groups by operation key (e.g., "tools/call:my_tool")
 * instead of HTTP method + path.
 *
 * Only analyzes sessions where consumer = 'agent'.
 */
export function detectSequences(db: Database.Database, sessionId: string): SequenceAnalysis {
  const sessionRepo = new SessionRepository(db);
  const sampleRepo = new SampleRepository(db);

  const session = sessionRepo.getSession(sessionId);
  if (!session) {
    return { sequences: [], verificationLoops: [], totalRequests: 0, wastedRequests: 0 };
  }

  // Only analyze agent sessions
  if (session.consumer !== 'agent') {
    return { sequences: [], verificationLoops: [], totalRequests: 0, wastedRequests: 0 };
  }

  const samples = sampleRepo.listBySession(sessionId);
  if (samples.length < 2) {
    return {
      sequences: [],
      verificationLoops: [],
      totalRequests: samples.length,
      wastedRequests: 0,
    };
  }

  const jsonrpc = isJsonRpcSession(samples);

  // Group consecutive pairs
  const accumulators = new Map<string, SequenceAccumulator>();

  for (let i = 0; i < samples.length - 1; i++) {
    const from = samples[i];
    const to = samples[i + 1];

    const fromOp = getOperationKey(from, jsonrpc);
    const toOp = getOperationKey(to, jsonrpc);

    const key: SequenceKey = {
      fromMethod: fromOp.method,
      fromPath: fromOp.path,
      toMethod: toOp.method,
      toPath: toOp.path,
    };

    const keyStr = sequenceKeyString(key);
    const delayMs =
      new Date(to.capturedAt).getTime() - new Date(from.capturedAt).getTime();

    const existing = accumulators.get(keyStr);
    if (existing) {
      existing.delays.push(delayMs);
    } else {
      accumulators.set(keyStr, { key, delays: [delayMs] });
    }
  }

  // Build operation sequences with classification
  const sequences: OperationSequence[] = [];

  for (const acc of accumulators.values()) {
    const avgDelayMs = acc.delays.reduce((sum, d) => sum + d, 0) / acc.delays.length;

    const pattern = jsonrpc
      ? classifyJsonRpcPattern(acc.key.fromPath, acc.key.toPath)
      : classifyPattern(
          acc.key.fromMethod,
          acc.key.fromPath,
          acc.key.toMethod,
          acc.key.toPath,
          avgDelayMs,
        );

    sequences.push({
      fromMethod: acc.key.fromMethod,
      fromPath: acc.key.fromPath,
      toMethod: acc.key.toMethod,
      toPath: acc.key.toPath,
      avgDelayMs: Math.round(avgDelayMs),
      count: acc.delays.length,
      pattern,
    });
  }

  // Sort by count descending for readability
  sequences.sort((a, b) => b.count - a.count);

  const verificationLoops = sequences.filter(
    (s) => s.pattern === 'verification_loop' || s.pattern === 'redundant_list' || s.pattern === 'retry',
  );
  const wastedRequests = verificationLoops.reduce((sum, s) => sum + s.count, 0);

  return {
    sequences,
    verificationLoops,
    totalRequests: samples.length,
    wastedRequests,
  };
}
