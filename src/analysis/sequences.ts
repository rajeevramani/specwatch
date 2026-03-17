/**
 * Operation sequence detection and verification loop analysis.
 * Detects patterns in agent traffic: verification loops, create chains,
 * and list-after-create sequences from captured samples.
 */
import type Database from 'better-sqlite3';
import { SessionRepository } from '../storage/sessions.js';
import { SampleRepository } from '../storage/samples.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The kind of pattern detected between two consecutive operations. */
export type SequencePattern =
  | 'verification_loop'
  | 'create_chain'
  | 'list_after_create'
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
// Sequence detection
// ---------------------------------------------------------------------------

/**
 * Build a string key for grouping identical sequences.
 */
function sequenceKeyString(key: SequenceKey): string {
  return `${key.fromMethod} ${key.fromPath} -> ${key.toMethod} ${key.toPath}`;
}

/**
 * Detect operation sequences from samples in a session.
 * Queries samples ordered by captured_at, builds pairs of consecutive requests,
 * groups by (from→to), counts occurrences, and calculates average delay.
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

  // Group consecutive pairs
  const accumulators = new Map<string, SequenceAccumulator>();

  for (let i = 0; i < samples.length - 1; i++) {
    const from = samples[i];
    const to = samples[i + 1];

    const key: SequenceKey = {
      fromMethod: from.httpMethod,
      fromPath: from.normalizedPath,
      toMethod: to.httpMethod,
      toPath: to.normalizedPath,
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
    const pattern = classifyPattern(
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

  const verificationLoops = sequences.filter((s) => s.pattern === 'verification_loop');
  const wastedRequests = verificationLoops.reduce((sum, s) => sum + s.count, 0);

  return {
    sequences,
    verificationLoops,
    totalRequests: samples.length,
    wastedRequests,
  };
}
