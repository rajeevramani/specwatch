/**
 * LLM client behind a narrow interface (specwatch-ajn).
 *
 * The runner drives a raw tool-calling loop and never imports the Anthropic SDK
 * directly. It talks to an {@link LlmClient}, which has two implementations:
 *
 *   - {@link MockLlmClient}     — deterministic, scripted, ZERO network. Used by
 *                                 the vitest dry-run and by `calib:run` without
 *                                 `--live`. This is what proves the pipeline
 *                                 end-to-end without spending a cent.
 *   - {@link AnthropicLlmClient}— the real client, pinned to one model id, fixed
 *                                 sampling. It is WIRED but only constructed when
 *                                 `--live` is passed AND `ANTHROPIC_API_KEY` is
 *                                 set. The Anthropic SDK is imported lazily so it
 *                                 is never a hard dependency of the mock path.
 *
 * Keeping the SDK behind a dynamic import means tests/dry-runs work with nothing
 * installed, and a human can opt into paid live runs by installing the SDK and
 * passing `--live` (see `npm run calib:run:live`).
 */

/** A single tool definition as sent to the model (no routing metadata). */
export interface WireTool {
  name: string;
  description: string;
  input_schema: unknown;
}

/** A tool call the model asked us to make. */
export interface LlmToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** A tool result we feed back to the model. */
export interface LlmToolResult {
  toolUseId: string;
  content: string;
  isError?: boolean;
}

/** A turn in the running transcript handed to the client each step. */
export type LlmTurn =
  | { role: 'user'; text: string }
  | { role: 'assistant'; toolUses: LlmToolUse[]; text?: string }
  | { role: 'tool'; results: LlmToolResult[] };

export interface LlmRequest {
  system: string;
  tools: WireTool[];
  /** Full conversation so far (the client is stateless per call). */
  turns: LlmTurn[];
}

/** The model's response for one step of the loop. */
export interface LlmResponse {
  /** `tool_use` when the model wants to call tools, `end_turn` when finished. */
  stopReason: 'tool_use' | 'end_turn';
  /** Any assistant text emitted this step (may be empty). */
  text: string;
  /** Tool calls requested this step (empty when `stopReason === 'end_turn'`). */
  toolUses: LlmToolUse[];
}

/** The pluggable model interface the runner depends on. */
export interface LlmClient {
  /** A stable identifier for the model/scaffold (recorded in run output). */
  readonly id: string;
  /** Run one step of the tool-calling loop. */
  step(req: LlmRequest): Promise<LlmResponse>;
}

// ---------------------------------------------------------------------------
// Mock client — deterministic, scripted, no network.
// ---------------------------------------------------------------------------

/**
 * A scripted plan for one task: an ordered list of steps. Each step is either a
 * batch of tool calls to emit, or a final end-turn. The mock walks the plan as
 * the loop progresses, ignoring the model-facing prompt entirely — its outputs
 * depend ONLY on how many assistant steps have happened, so a rerun is
 * byte-identical (the determinism the acceptance criteria require of the mock).
 *
 * Tool-call inputs may be a literal object, or a function of the prior tool
 * results so a mock can thread a server-assigned id (e.g. a created customer's
 * id) into the next call — exactly what a real agent does, but deterministically.
 */
export interface MockToolCall {
  name: string;
  input: Record<string, unknown> | ((ctx: MockContext) => Record<string, unknown>);
}

export type MockStep = { type: 'tools'; calls: MockToolCall[] } | { type: 'end'; text?: string };

/** Context the mock can read when computing a tool input from prior results. */
export interface MockContext {
  /** All tool results seen so far, in call order, parsed from JSON when possible. */
  results: Array<{ name: string; input: Record<string, unknown>; output: unknown }>;
}

export type MockPlan = MockStep[];

/**
 * Deterministic mock LLM. Replays a per-task {@link MockPlan}. The plan is keyed
 * by the FIRST user turn's text (the task prompt), so one mock can serve the
 * whole task set. If no plan matches a prompt, the mock immediately ends the
 * turn (a "did nothing" agent) — useful for negative tests.
 */
export class MockLlmClient implements LlmClient {
  readonly id: string;
  private readonly plans: Map<string, MockPlan>;

  constructor(plans: Record<string, MockPlan>, id = 'mock-agent') {
    this.id = id;
    this.plans = new Map(Object.entries(plans));
  }

  async step(req: LlmRequest): Promise<LlmResponse> {
    const prompt = firstUserText(req.turns);
    const plan = this.plans.get(prompt) ?? [];

    // How many assistant tool-use steps have already happened == our position.
    const stepIndex = req.turns.filter((t) => t.role === 'assistant').length;
    const step = plan[stepIndex];

    if (!step || step.type === 'end') {
      return { stopReason: 'end_turn', text: step?.text ?? '', toolUses: [] };
    }

    const ctx = buildMockContext(req.tools, req.turns);
    const toolUses: LlmToolUse[] = step.calls.map((call, i) => ({
      id: `mock_${stepIndex}_${i}`,
      name: call.name,
      input: typeof call.input === 'function' ? call.input(ctx) : call.input,
    }));
    return { stopReason: 'tool_use', text: '', toolUses };
  }
}

function firstUserText(turns: LlmTurn[]): string {
  for (const t of turns) if (t.role === 'user') return t.text;
  return '';
}

/** Reconstruct ordered (call -> result) pairs from the transcript for the mock. */
function buildMockContext(_tools: WireTool[], turns: LlmTurn[]): MockContext {
  const calls: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
  const resultsById = new Map<string, string>();
  for (const t of turns) {
    if (t.role === 'assistant') {
      for (const u of t.toolUses) calls.push({ id: u.id, name: u.name, input: u.input });
    } else if (t.role === 'tool') {
      for (const r of t.results) resultsById.set(r.toolUseId, r.content);
    }
  }
  return {
    results: calls.map((c) => {
      const raw = resultsById.get(c.id);
      let output: unknown = raw;
      if (typeof raw === 'string') {
        try {
          output = JSON.parse(raw);
        } catch {
          /* leave as string */
        }
      }
      return { name: c.name, input: c.input, output };
    }),
  };
}

// ---------------------------------------------------------------------------
// Real Anthropic client — wired, gated, lazily imported.
// ---------------------------------------------------------------------------

export interface AnthropicClientOptions {
  /** Pinned model id. Agent is a constant across variants (design §5). */
  model: string;
  /**
   * Sampling temperature. Recorded for provenance and passed to the API only
   * when the pinned model accepts it (some newer models reject `temperature`).
   * Default 0 for determinism per the calibration design.
   */
  temperature?: number;
  maxTokens?: number;
  /** When false (default), `temperature` is omitted from the request. */
  sendTemperature?: boolean;
  apiKey?: string;
}

/**
 * Real client. Constructed only on the `--live` path with a key present. The
 * Anthropic SDK (`@anthropic-ai/sdk`) is imported dynamically so it is NOT a
 * hard dependency of this package — the mock path needs nothing installed.
 */
export class AnthropicLlmClient implements LlmClient {
  readonly id: string;
  private readonly opts: Required<Omit<AnthropicClientOptions, 'apiKey'>> & { apiKey?: string };
  private clientPromise?: Promise<any>;

  constructor(opts: AnthropicClientOptions) {
    this.opts = {
      model: opts.model,
      temperature: opts.temperature ?? 0,
      maxTokens: opts.maxTokens ?? 4096,
      sendTemperature: opts.sendTemperature ?? false,
      apiKey: opts.apiKey,
    };
    this.id = `anthropic:${this.opts.model}`;
  }

  private async client(): Promise<any> {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        // Dynamic import keeps the SDK optional. Use a runtime-built specifier so
        // the bundler/typechecker does not require the module to be present.
        const sdkName = ['@anthropic-ai', 'sdk'].join('/');
        let mod: any;
        try {
          mod = await import(/* @vite-ignore */ sdkName);
        } catch (e) {
          throw new Error(
            `--live requires the Anthropic SDK. Install it with \`npm i @anthropic-ai/sdk\` ` +
              `in eval/calibration/runner. Original error: ${(e as Error).message}`,
            { cause: e },
          );
        }
        const Anthropic = mod.default ?? mod.Anthropic ?? mod;
        return new Anthropic(this.opts.apiKey ? { apiKey: this.opts.apiKey } : {});
      })();
    }
    return this.clientPromise;
  }

  async step(req: LlmRequest): Promise<LlmResponse> {
    const client = await this.client();
    const params: Record<string, unknown> = {
      model: this.opts.model,
      max_tokens: this.opts.maxTokens,
      system: req.system,
      tools: req.tools,
      messages: turnsToAnthropicMessages(req.turns),
    };
    if (this.opts.sendTemperature) params.temperature = this.opts.temperature;

    const message = await client.messages.create(params);
    return anthropicMessageToResponse(message);
  }
}

/** Map our transcript to Anthropic Messages `messages[]`. */
function turnsToAnthropicMessages(turns: LlmTurn[]): Array<{ role: string; content: unknown }> {
  const messages: Array<{ role: string; content: unknown }> = [];
  for (const t of turns) {
    if (t.role === 'user') {
      messages.push({ role: 'user', content: t.text });
    } else if (t.role === 'assistant') {
      const content: unknown[] = [];
      if (t.text) content.push({ type: 'text', text: t.text });
      for (const u of t.toolUses) {
        content.push({ type: 'tool_use', id: u.id, name: u.name, input: u.input });
      }
      messages.push({ role: 'assistant', content });
    } else {
      messages.push({
        role: 'user',
        content: t.results.map((r) => ({
          type: 'tool_result',
          tool_use_id: r.toolUseId,
          content: r.content,
          is_error: r.isError ?? false,
        })),
      });
    }
  }
  return messages;
}

/** Parse an Anthropic `Message` into our {@link LlmResponse}. */
function anthropicMessageToResponse(message: any): LlmResponse {
  const toolUses: LlmToolUse[] = [];
  let text = '';
  for (const block of message.content ?? []) {
    if (block.type === 'text') text += block.text;
    else if (block.type === 'tool_use') {
      toolUses.push({ id: block.id, name: block.name, input: block.input ?? {} });
    }
  }
  const stopReason = message.stop_reason === 'tool_use' || toolUses.length > 0 ? 'tool_use' : 'end_turn';
  return { stopReason, text, toolUses };
}
