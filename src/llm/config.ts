/**
 * LLM configuration — loads connection details from environment variables
 * or a .env file in the current working directory.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

// ---------------------------------------------------------------------------
// .env parsing
// ---------------------------------------------------------------------------

/**
 * Parse a .env file (simple KEY=VALUE format).
 * Skips comments (#) and blank lines. Does not overwrite existing env vars.
 */
function loadDotEnv(dir: string): void {
  let content: string;
  try {
    content = readFileSync(join(dir, '.env'), 'utf-8');
  } catch {
    return; // file doesn't exist — that's fine
  }

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();

    if (!key) continue;
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Load LLM config from environment (with optional .env fallback). */
export function loadLlmConfig(): LlmConfig | undefined {
  loadDotEnv(process.cwd());

  const baseUrl = process.env.LLM_BASE_URL;
  const apiKey = process.env.LLM_API_KEY;
  const model = process.env.LLM_MODEL ?? 'qwen2.5:latest';

  if (!baseUrl || !apiKey) return undefined;

  return { baseUrl, apiKey, model };
}

/** Check whether LLM integration is available. */
export function isLlmConfigured(): boolean {
  return loadLlmConfig() !== undefined;
}
