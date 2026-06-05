/**
 * Specwatch capture per variant (specwatch-13a).
 *
 * The agent runner ({@link runner.ts}) drives the fixed agent through the task
 * set; every tool call it makes is an HTTP request to the calibration backend,
 * recorded verbatim on the transcript (method, path, status, response body,
 * timestamp). That transcript *is* the captured agent traffic — exactly what a
 * specwatch proxy sitting in front of the backend in `--consumer agent` mode
 * would see. This module replays that captured traffic THROUGH SPECWATCH'S OWN
 * LIBRARY (no re-implementation of the analysis):
 *
 *   1. open a real specwatch SQLite db + run its migrations
 *   2. create a real session with `consumer: 'agent'`
 *   3. insert each captured call as a real {@link Sample} (request/response
 *      bodies inferred via specwatch's `inferSchema`)
 *   4. run specwatch's real `runAggregation` -> `AggregatedSchema[]`
 *   5. run specwatch's real `detectSequences` (verification loops, common
 *      next-steps, calls-per-task) and `analyzeCompleteness` (response
 *      completeness)
 *
 * The result is runtime telemetry keyed by `variant + task` (and a variant-level
 * rollup), written machine-readable for the analysis join (specwatch-51h).
 *
 * Rationale for replay-vs-live-proxy: in MOCK dry-run there is no network proxy
 * to stand up, and the backend is started per-task in-process on an ephemeral
 * port. Feeding the captured calls straight into specwatch's library exercises
 * the exact same analysis code a live proxy would, deterministically and with no
 * spend. A live full-run with the real proxy in the request path is human-gated
 * (see `capture:live` note / openIssues).
 */
import { getDatabase } from '../../../src/storage/database.js';
import { SessionRepository } from '../../../src/storage/sessions.js';
import { SampleRepository } from '../../../src/storage/samples.js';
import { runAggregation } from '../../../src/aggregation/pipeline.js';
import { detectSequences } from '../../../src/analysis/sequences.js';
import { analyzeCompleteness } from '../../../src/analysis/completeness.js';
import { inferSchema } from '../../../src/inference/engine.js';
import type { InsertSampleInput } from '../../../src/storage/samples.js';
import type { TaskRunRecord, TranscriptToolCall, VariantRunResult } from './runner.js';

/** Runtime telemetry derived from specwatch for ONE (variant, task) pair. */
export interface TaskTelemetry {
  variant: string;
  taskId: string;
  /** Whether the backend (NOT specwatch) judged the task a success. Joined in. */
  success: boolean;
  /** Total HTTP calls the agent made for this task (== specwatch totalRequests). */
  callsPerTask: number;
  /** Distinct (verification_loop|retry|redundant_list) sequences specwatch found. */
  verificationLoops: number;
  /** Requests specwatch attributes to wasted verification/retry work. */
  wastedRequests: number;
  /**
   * Response completeness averaged across write endpoints specwatch could pair
   * with a read endpoint (1.0 = write returns every field the read does). `null`
   * when no write/read pair was observed for this task.
   */
  responseCompleteness: number | null;
  /** Write endpoints specwatch flagged as thin (completeness < 0.5). */
  thinEndpoints: string[];
  /**
   * Common next-steps keyed by "from" endpoint ("METHOD /path" -> ["METHOD
   * /path", ...]) — the observed successor calls, specwatch's agent-extension
   * signal.
   */
  commonNextSteps: Record<string, string[]>;
}

/** Variant-level rollup across all its tasks. */
export interface VariantTelemetry {
  variant: string;
  agent: string;
  thinResponses: boolean;
  taskCount: number;
  totalCalls: number;
  totalVerificationLoops: number;
  totalWastedRequests: number;
  /** Mean of the per-task responseCompleteness values that were non-null. */
  avgResponseCompleteness: number | null;
  tasks: TaskTelemetry[];
}

/** Top-level capture artifact written to disk. */
export interface CaptureArtifact {
  generatedAt: string;
  /** How the traffic reached specwatch — `replay` (mock dry-run) or `proxy` (live). */
  source: 'replay' | 'proxy';
  /** specwatch session consumer mode the analysis ran under. */
  consumer: 'agent';
  variant: VariantTelemetry;
}

/** Pull every executed tool call (in order) out of a task transcript. */
function transcriptCalls(record: TaskRunRecord): TranscriptToolCall[] {
  const calls: TranscriptToolCall[] = [];
  for (const entry of record.transcript) {
    if (entry.kind === 'assistant') calls.push(...entry.toolCalls);
  }
  return calls;
}

/** Best-effort JSON parse; returns undefined for empty/non-JSON bodies. */
function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/** Strip the query string for the normalized path's sibling raw path field. */
function rawPathOf(call: TranscriptToolCall): string {
  return call.rawPath ?? call.normalizedPath ?? '/';
}

/**
 * Insert one task's captured calls as specwatch samples, then run specwatch's
 * real aggregation + agent-traffic analysis over them. A fresh in-memory db is
 * used per task so calls-per-task and loop counts are scoped to the task.
 */
export function analyzeTask(record: TaskRunRecord): TaskTelemetry {
  // getDatabase runs specwatch's migrations on open.
  const db = getDatabase(':memory:');
  try {
    const sessions = new SessionRepository(db);
    const sampleRepo = new SampleRepository(db);

    const session = sessions.createSession(
      `https://calib.local/${record.variant}`,
      0,
      `${record.variant}:${record.taskId}`,
      undefined,
      'agent',
    );

    const calls = transcriptCalls(record);
    for (const call of calls) {
      // Unknown-tool calls never hit the backend (no method/path) — skip them
      // for traffic analysis; they still count toward the agent's effort but
      // there is no HTTP sample to infer.
      if (!call.httpMethod || !call.normalizedPath) continue;

      const reqBody = tryParseJson(JSON.stringify(call.input ?? {}));
      const resBody = tryParseJson(call.response);

      const sample: InsertSampleInput = {
        sessionId: session.id,
        httpMethod: call.httpMethod,
        path: rawPathOf(call),
        normalizedPath: call.normalizedPath,
        statusCode: call.status ?? undefined,
        requestSchema:
          reqBody !== undefined && Object.keys(call.input ?? {}).length > 0
            ? inferSchema(reqBody)
            : undefined,
        responseSchema: resBody !== undefined ? inferSchema(resBody) : undefined,
        capturedAt: call.capturedAt,
      };
      sampleRepo.insertSample(sample);
    }

    // specwatch's real aggregation -> AggregatedSchema[] (for completeness).
    const aggregation = runAggregation(db, session.id, { snapshot: 1 });
    const completeness = analyzeCompleteness(aggregation.schemas);

    // specwatch's real sequence analysis (verification loops + next steps).
    const sequences = detectSequences(db, session.id);

    const commonNextSteps: Record<string, string[]> = {};
    for (const seq of sequences.sequences) {
      const from = `${seq.fromMethod} ${seq.fromPath}`;
      const to = `${seq.toMethod} ${seq.toPath}`;
      (commonNextSteps[from] ??= []).push(to);
    }

    return {
      variant: record.variant,
      taskId: record.taskId,
      success: record.success,
      callsPerTask: record.callCount,
      verificationLoops: sequences.verificationLoops.length,
      wastedRequests: sequences.wastedRequests,
      responseCompleteness:
        completeness.endpoints.length > 0 ? completeness.avgCompleteness : null,
      thinEndpoints: completeness.thinResponses.map((e) => `${e.method} ${e.path}`),
      commonNextSteps,
    };
  } finally {
    db.close();
  }
}

/**
 * Run specwatch capture over a whole variant run: per-task telemetry plus a
 * variant-level rollup. Pure function of the runner's {@link VariantRunResult}.
 */
export function captureVariant(run: VariantRunResult): CaptureArtifact {
  const tasks = run.records.map(analyzeTask);

  const completenessValues = tasks
    .map((t) => t.responseCompleteness)
    .filter((v): v is number => v !== null);

  const variant: VariantTelemetry = {
    variant: run.variant,
    agent: run.agent,
    thinResponses: run.thinResponses,
    taskCount: tasks.length,
    totalCalls: tasks.reduce((s, t) => s + t.callsPerTask, 0),
    totalVerificationLoops: tasks.reduce((s, t) => s + t.verificationLoops, 0),
    totalWastedRequests: tasks.reduce((s, t) => s + t.wastedRequests, 0),
    avgResponseCompleteness:
      completenessValues.length > 0
        ? completenessValues.reduce((s, v) => s + v, 0) / completenessValues.length
        : null,
    tasks,
  };

  return {
    generatedAt: new Date().toISOString(),
    source: 'replay',
    consumer: 'agent',
    variant,
  };
}
