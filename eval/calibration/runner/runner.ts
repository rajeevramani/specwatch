/**
 * Agent runner (specwatch-ajn).
 *
 * Drives ONE fixed agent (model + system prompt + scaffold) through the fixed
 * a7n task set against ONE (backend, spec-variant) pair, via a raw tool-calling
 * loop — no agent framework. For each task it records:
 *   - success      : decided ONLY by the backend's `/__truth` readback through
 *                    the a7n checker — never the agent's self-report.
 *   - call count   : number of tool calls the agent made.
 *   - transcript   : the full ordered turn log (prompt, tool calls, results).
 *
 * The agent is a CONSTANT across variants (calibration design §5): only the spec
 * the agent sees — hence the derived tools — changes between variants. The LLM
 * sits behind {@link LlmClient}; the default is a deterministic MOCK so the whole
 * pipeline runs end-to-end with no paid calls. The real Anthropic client is wired
 * but only used on `--live` with a key present (see {@link makeLiveClient}).
 *
 * State isolation: a FRESH in-process backend (own SQLite, deterministic seed) is
 * started per task on an ephemeral port, so tasks never see each other's writes
 * and a rerun on the same variant is reproducible modulo model nondeterminism.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../backend/src/app.js';
import { TASKS, checkTask, fetchTruth } from '../tasks/index.js';
import type { CalibrationTask, TaskResult } from '../tasks/index.js';
import { specToTools, toWireTools, type AgentTool } from './tools.js';
import type {
  LlmClient,
  LlmRequest,
  LlmToolResult,
  LlmToolUse,
  LlmTurn,
} from './llm.js';

/** Default fixed agent identity. Pinned model id; agent is a constant. */
export const DEFAULT_MODEL = 'claude-opus-4-8';

/** Fixed system prompt — identical for every variant and task. */
export const SYSTEM_PROMPT = [
  'You are an automated API client. You are given a set of tools, each wrapping one',
  'operation of a REST API, and a task to accomplish by calling those tools.',
  'Work out the necessary sequence of calls yourself from the tool descriptions and',
  'their results. Many tasks require several dependent calls: create or look up a',
  'resource, then use the id it returns in a later call. Inspect each tool result',
  'before deciding the next call. When the task is fully accomplished, stop and give',
  'a one-line summary. Do not ask the user questions; act autonomously.',
].join(' ');

/** A single recorded tool call + its result, for the transcript. */
export interface TranscriptToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** HTTP status the backend returned (or null if the tool was unknown). */
  status: number | null;
  /** Response body as text (truncated for storage sanity). */
  response: string;
  isError: boolean;
}

/** One transcript entry. */
export type TranscriptEntry =
  | { kind: 'prompt'; text: string }
  | { kind: 'assistant'; text: string; toolCalls: TranscriptToolCall[] }
  | { kind: 'final'; text: string }
  | { kind: 'note'; text: string };

/** The per-(variant, task) record the runner emits. */
export interface TaskRunRecord {
  variant: string;
  taskId: string;
  /** Decided by the a7n checker over `/__truth` — the sole arbiter of success. */
  success: boolean;
  /** Diagnostic detail from the checker (why it passed/failed). */
  detail: string;
  /** Total tool calls the agent made across all loop steps. */
  callCount: number;
  /** Number of loop steps (model turns) taken. */
  steps: number;
  /** True if the loop hit `maxSteps` before the model ended its turn. */
  truncated: boolean;
  transcript: TranscriptEntry[];
}

/** The result of running the whole task set against one (backend, variant). */
export interface VariantRunResult {
  variant: string;
  /** The fixed agent identity used (model/scaffold id). */
  agent: string;
  /** True if the THIN_RESPONSES backend toggle was active for this run. */
  thinResponses: boolean;
  records: TaskRunRecord[];
  passCount: number;
  failCount: number;
}

export interface RunOptions {
  /** Variant name, recorded on every record (e.g. `gold`, `no-descriptions`). */
  variant: string;
  /** Parsed OpenAPI spec the agent sees (already loaded + parsed). */
  spec: any;
  /** The LLM client (mock by default; real only on --live). */
  client: LlmClient;
  /** Tasks to run (defaults to the full a7n set). */
  tasks?: CalibrationTask[];
  /** Backend response-completeness toggle (the thin-responses variant). */
  thinResponses?: boolean;
  /** Safety cap on loop steps per task. */
  maxSteps?: number;
  /** Optional progress callback. */
  onRecord?: (record: TaskRunRecord) => void;
}

/** Start the calibration backend in-process on an ephemeral port. */
async function startBackend(thinResponses: boolean): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const { app } = createApp({ file: ':memory:', thinResponses });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

/** Fill a path template's `{name}` placeholders from the tool input. */
function fillPath(template: string, input: Record<string, unknown>, tool: AgentTool): string {
  return template.replace(/\{([^}]+)\}/g, (_m, name: string) => {
    const value = input[name];
    return value === undefined || value === null ? `{${name}}` : encodeURIComponent(String(value));
  }).concat(buildQuery(input, tool));
}

/** Build a `?a=b&c=d` query string from the tool's query params present in input. */
function buildQuery(input: Record<string, unknown>, tool: AgentTool): string {
  const pairs: string[] = [];
  for (const [name, loc] of Object.entries(tool._http.paramLocations)) {
    if (loc !== 'query') continue;
    const value = input[name];
    if (value === undefined || value === null) continue;
    pairs.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
  }
  return pairs.length ? `?${pairs.join('&')}` : '';
}

/** Execute one tool call as an HTTP request against the backend. */
async function executeTool(
  baseUrl: string,
  toolsByName: Map<string, AgentTool>,
  use: LlmToolUse,
): Promise<TranscriptToolCall> {
  const tool = toolsByName.get(use.name);
  if (!tool) {
    return {
      id: use.id,
      name: use.name,
      input: use.input,
      status: null,
      response: `No tool named "${use.name}" exists. Available tools: ${[...toolsByName.keys()].join(', ')}`,
      isError: true,
    };
  }

  const url = baseUrl + fillPath(tool._http.pathTemplate, use.input, tool);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  for (const [name, loc] of Object.entries(tool._http.paramLocations)) {
    if (loc === 'header' && use.input[name] !== undefined && use.input[name] !== null) {
      headers[name] = String(use.input[name]);
    }
  }

  let body: string | undefined;
  if (tool._http.bodyProps.length > 0 && tool._http.method !== 'GET' && tool._http.method !== 'DELETE') {
    const payload: Record<string, unknown> = {};
    for (const prop of tool._http.bodyProps) {
      if (use.input[prop] !== undefined) payload[prop] = use.input[prop];
    }
    body = JSON.stringify(payload);
  }

  try {
    const res = await fetch(url, { method: tool._http.method, headers, body });
    const text = await res.text();
    return {
      id: use.id,
      name: use.name,
      input: use.input,
      status: res.status,
      response: text.length > 4000 ? text.slice(0, 4000) + '…' : text,
      isError: res.status >= 400,
    };
  } catch (e) {
    return {
      id: use.id,
      name: use.name,
      input: use.input,
      status: null,
      response: `Request failed: ${(e as Error).message}`,
      isError: true,
    };
  }
}

/** Run a single task against a running backend with a freshly-derived tool set. */
async function runTask(
  baseUrl: string,
  variant: string,
  task: CalibrationTask,
  tools: AgentTool[],
  client: LlmClient,
  maxSteps: number,
): Promise<TaskRunRecord> {
  const toolsByName = new Map(tools.map((t) => [t.name, t]));
  const wireTools = toWireTools(tools);
  const turns: LlmTurn[] = [{ role: 'user', text: task.prompt }];
  const transcript: TranscriptEntry[] = [{ kind: 'prompt', text: task.prompt }];

  let callCount = 0;
  let steps = 0;
  let truncated = false;

  while (steps < maxSteps) {
    const req: LlmRequest = { system: SYSTEM_PROMPT, tools: wireTools, turns };
    const resp = await client.step(req);
    steps += 1;

    if (resp.stopReason === 'end_turn' || resp.toolUses.length === 0) {
      transcript.push({ kind: 'final', text: resp.text });
      turns.push({ role: 'assistant', text: resp.text, toolUses: [] });
      break;
    }

    // Record the assistant turn, execute every requested tool call.
    turns.push({ role: 'assistant', text: resp.text, toolUses: resp.toolUses });
    const toolCalls: TranscriptToolCall[] = [];
    const results: LlmToolResult[] = [];
    for (const use of resp.toolUses) {
      callCount += 1;
      const call = await executeTool(baseUrl, toolsByName, use);
      toolCalls.push(call);
      results.push({ toolUseId: use.id, content: call.response, isError: call.isError });
    }
    transcript.push({ kind: 'assistant', text: resp.text, toolCalls });
    turns.push({ role: 'tool', results });

    if (steps >= maxSteps) {
      truncated = true;
      transcript.push({ kind: 'note', text: `Hit maxSteps=${maxSteps}; loop truncated.` });
      break;
    }
  }

  // Decide success ONLY from ground truth via the a7n checker.
  let result: TaskResult;
  try {
    const truth = await fetchTruth(baseUrl);
    result = checkTask(task.id, truth);
  } catch (e) {
    result = { taskId: task.id, pass: false, detail: `failed to read /__truth: ${(e as Error).message}` };
  }

  return {
    variant,
    taskId: task.id,
    success: result.pass,
    detail: result.detail,
    callCount,
    steps,
    truncated,
    transcript,
  };
}

/**
 * Run the full task set against one (backend, variant) pair. A fresh backend is
 * started per task so task end-states never interfere. Returns the per-task
 * records plus a pass/fail tally.
 */
export async function runVariant(opts: RunOptions): Promise<VariantRunResult> {
  const tasks = opts.tasks ?? TASKS;
  const thinResponses = opts.thinResponses ?? false;
  const maxSteps = opts.maxSteps ?? 25;
  const tools = specToTools(opts.spec);

  const records: TaskRunRecord[] = [];
  for (const task of tasks) {
    const backend = await startBackend(thinResponses);
    try {
      const record = await runTask(backend.baseUrl, opts.variant, task, tools, opts.client, maxSteps);
      records.push(record);
      opts.onRecord?.(record);
    } finally {
      await backend.close();
    }
  }

  const passCount = records.filter((r) => r.success).length;
  return {
    variant: opts.variant,
    agent: opts.client.id,
    thinResponses,
    records,
    passCount,
    failCount: records.length - passCount,
  };
}
