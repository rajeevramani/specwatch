/**
 * `calib:run` entrypoint (specwatch-ajn).
 *
 * Runs the fixed agent through the a7n task set against ONE spec variant and
 * writes the per-(variant, task) records to disk.
 *
 *   npm run calib:run -- --variant gold            # MOCK agent (default, free)
 *   npm run calib:run -- --variant gold --live     # REAL Claude (needs key+SDK)
 *
 * Default is the deterministic MOCK client — no network, no spend. `--live` is
 * honoured ONLY when `ANTHROPIC_API_KEY` is set; without it the CLI refuses to
 * proceed rather than silently fall back, so a human opting into paid calls does
 * so explicitly. The variant's spec is loaded from `variants/<name>.yaml` (or
 * the gold spec for `gold`), and the thin-responses runtime toggle is inferred
 * from the variant manifest (`runtimeDriven`) or `--thin-responses`.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseSpec } from '../packages/agentready-scoring/src/index.js';
import {
  runVariant,
  DEFAULT_MODEL,
  SYSTEM_PROMPT,
  PERSONA_SYSTEM_PROMPT,
  type VariantRunResult,
} from './runner.js';
import { MockLlmClient, AnthropicLlmClient, OpenRouterLlmClient, type LlmClient } from './llm.js';
import { GOLD_MOCK_PLANS, MOCK_OP_ROUTES } from './mock-plans.js';
import { TASKS, GOAL_TASKS } from '../tasks/index.js';
import { captureVariant } from './capture.js';

const here = dirname(fileURLToPath(import.meta.url));
const CALIB_ROOT = resolve(here, '..');
const VARIANTS_DIR = resolve(CALIB_ROOT, 'variants');
const GOLD_SPEC = resolve(CALIB_ROOT, 'specs/gold.yaml');
const OUT_DIR = resolve(CALIB_ROOT, '.runs');

type Provider = 'anthropic' | 'openrouter';

/** Default OpenRouter model when --provider openrouter is set without --model. */
const DEFAULT_OPENROUTER_MODEL = 'anthropic/claude-sonnet-4.5';

type SystemKind = 'mechanic' | 'assistant';
type TaskSet = 'mechanic' | 'goal';

interface CliArgs {
  variant: string;
  live: boolean;
  provider: Provider;
  system: SystemKind;
  taskSet: TaskSet;
  thinResponses?: boolean;
  model?: string;
  maxSteps: number;
  out?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    variant: 'gold',
    live: false,
    provider: 'anthropic',
    system: 'mechanic',
    taskSet: 'mechanic',
    maxSteps: 25,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--variant') args.variant = argv[++i];
    else if (a === '--live') args.live = true;
    else if (a === '--provider') args.provider = argv[++i] as Provider;
    else if (a === '--system') args.system = argv[++i] as SystemKind;
    else if (a === '--tasks') args.taskSet = argv[++i] as TaskSet;
    else if (a === '--thin-responses') args.thinResponses = true;
    else if (a === '--no-thin-responses') args.thinResponses = false;
    else if (a === '--model') args.model = argv[++i];
    else if (a === '--max-steps') args.maxSteps = Number(argv[++i]);
    else if (a === '--out') args.out = argv[++i];
  }
  return args;
}

/** Resolve the pinned model for the chosen provider. */
function resolveModel(args: CliArgs): string {
  if (args.model) return args.model;
  return args.provider === 'openrouter' ? DEFAULT_OPENROUTER_MODEL : DEFAULT_MODEL;
}

/** Load + parse the spec the agent sees for a variant. */
function loadVariantSpec(variant: string): any {
  if (variant === 'gold') return parseSpec(readFileSync(GOLD_SPEC, 'utf8'));
  const path = resolve(VARIANTS_DIR, `${variant}.yaml`);
  if (!existsSync(path)) {
    throw new Error(
      `No spec found for variant "${variant}" at ${path}. Run \`npm run ablate\` first, ` +
        `or pass a known variant (gold, no-descriptions, bad-operationids, no-examples, ` +
        `no-error-schemas, thin-responses, all-bad).`,
    );
  }
  return parseSpec(readFileSync(path, 'utf8'));
}

/** Read the variant manifest entry (for the runtime thin-responses toggle). */
function manifestEntry(variant: string): any | undefined {
  const manifestPath = resolve(VARIANTS_DIR, 'manifest.json');
  if (!existsSync(manifestPath)) return undefined;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  return (manifest.variants ?? []).find((v: any) => v.name === variant);
}

/**
 * Pick the agent client. Default: deterministic MOCK (no spend). `--live`:
 * the real Anthropic client, but ONLY when a key is present — otherwise this
 * throws so we never make (or fail) a paid call by accident.
 */
function makeClient(args: CliArgs): LlmClient {
  const model = resolveModel(args);
  if (!args.live) {
    return new MockLlmClient(GOLD_MOCK_PLANS, `mock:${model}`);
  }
  if (args.provider === 'openrouter') {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new Error(
        '--live --provider openrouter requires OPENROUTER_API_KEY to be set. ' +
          'Refusing to proceed without a key.',
      );
    }
    // temperature: 0 for determinism (OpenAI format accepts it).
    return new OpenRouterLlmClient({ model, apiKey, temperature: 0 });
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      '--live requires ANTHROPIC_API_KEY to be set. Refusing to proceed without a key. ' +
        'Run without --live to use the deterministic mock agent (no API calls).',
    );
  }
  return new AnthropicLlmClient({ model, apiKey, temperature: 0, sendTemperature: false });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const spec = loadVariantSpec(args.variant);
  const entry = manifestEntry(args.variant);
  const thinResponses = args.thinResponses ?? Boolean(entry?.runtimeDriven);
  const model = resolveModel(args);
  const client = makeClient(args);
  const system = args.system === 'assistant' ? PERSONA_SYSTEM_PROMPT : SYSTEM_PROMPT;
  const tasks = args.taskSet === 'goal' ? GOAL_TASKS : TASKS;

  console.log(
    `[calib:run] variant=${args.variant} agent=${client.id} ` +
      `mode=${args.live ? `LIVE/${args.provider}` : 'mock'} system=${args.system} ` +
      `tasks=${args.taskSet}(${tasks.length}) thinResponses=${thinResponses}`,
  );

  const result: VariantRunResult = await runVariant({
    variant: args.variant,
    spec,
    client,
    thinResponses,
    maxSteps: args.maxSteps,
    system,
    tasks,
    // Mock emits gold operationIds; alias them by route so a variant that mangled
    // the ids still runs end-to-end. Live agent gets no aliases (degradation real).
    nameAliases: args.live ? undefined : MOCK_OP_ROUTES,
    onRecord: (r) => {
      console.log(
        `  ${r.success ? 'PASS' : 'FAIL'}  ${r.taskId.padEnd(28)} ` +
          `calls=${String(r.callCount).padStart(2)} steps=${r.steps}` +
          (r.truncated ? ' [truncated]' : '') +
          `  ${r.detail}`,
      );
    },
  });

  mkdirSync(OUT_DIR, { recursive: true });
  const outPath = args.out ?? resolve(OUT_DIR, `${args.variant}.json`);
  const payload = {
    generatedAt: new Date().toISOString(),
    variant: result.variant,
    agent: result.agent,
    model,
    provider: args.provider,
    live: args.live,
    system: args.system,
    taskSet: args.taskSet,
    systemPrompt: system,
    thinResponses: result.thinResponses,
    passCount: result.passCount,
    failCount: result.failCount,
    records: result.records,
  };
  writeFileSync(outPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');

  console.log(
    `\n[calib:run] ${result.passCount}/${result.records.length} tasks passed -> ${outPath}`,
  );

  // Specwatch capture (specwatch-13a): replay the captured agent traffic through
  // specwatch's own analysis (consumer=agent) and emit runtime telemetry keyed by
  // variant+task for the analysis join.
  const capture = captureVariant(result);
  const capturePath = resolve(OUT_DIR, `${args.variant}.specwatch.json`);
  writeFileSync(capturePath, JSON.stringify(capture, null, 2) + '\n', 'utf8');
  console.log(
    `[calib:run] specwatch capture: ${capture.variant.totalCalls} calls, ` +
      `${capture.variant.totalVerificationLoops} verification loops -> ${capturePath}`,
  );
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
