/**
 * Tests for the LLM explain feature: config, prompts, and client.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import type { CallInvestigation, InvestigationReport } from '../../src/analysis/investigation.js';
import type { LlmConfig } from '../../src/llm/config.js';

// Mock node:fs so loadDotEnv in config.ts becomes a no-op (no .env interference).
// Individual tests that need real fs can restore via vi.mocked().
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: vi.fn((...args: unknown[]) => {
      // Block .env reads, allow everything else
      if (typeof args[0] === 'string' && args[0].endsWith('.env')) {
        const err = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return actual.readFileSync.apply(actual, args as Parameters<typeof actual.readFileSync>);
    }),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInvestigation(overrides?: Partial<CallInvestigation>): CallInvestigation {
  return {
    operationKey: 'tools/list',
    occurrences: [
      {
        sampleIndex: 0,
        sampleId: 1,
        capturedAt: '2025-01-15T10:00:00.000Z',
        statusCode: 200,
        phase: 'discovery',
      },
      {
        sampleIndex: 2,
        sampleId: 3,
        capturedAt: '2025-01-15T10:00:01.000Z',
        statusCode: 200,
        phase: 'creation',
      },
    ],
    pairAnalyses: [
      {
        fromIndex: 0,
        toIndex: 1,
        deltaMs: 1000,
        cause: 'identical_response',
        responseDiff: undefined,
        requestDiff: undefined,
        interveningOps: ['tools/call:create_thing'],
        crossPhase: true,
      },
    ],
    primaryCause: 'identical_response',
    explanation: 'Original explanation',
    recommendation: 'Original recommendation',
    ...overrides,
  };
}

function makeConfig(): LlmConfig {
  return { baseUrl: 'http://localhost:11434/v1', apiKey: 'test-key', model: 'qwen2.5:latest' };
}

function makeChatResponse(content: string): object {
  return {
    choices: [{ message: { content } }],
  };
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

describe('loadLlmConfig', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns undefined when no env vars set', async () => {
    // Ensure vars are absent
    vi.stubEnv('LLM_BASE_URL', '');
    vi.stubEnv('LLM_API_KEY', '');
    vi.stubEnv('LLM_MODEL', '');

    // Re-import to pick up env
    const { loadLlmConfig } = await import('../../src/llm/config.js');
    // loadLlmConfig reads process.env — empty strings are falsy for the check
    const result = loadLlmConfig();
    expect(result).toBeUndefined();
  });

  it('returns config when LLM_BASE_URL and LLM_API_KEY are set', async () => {
    vi.stubEnv('LLM_BASE_URL', 'http://localhost:11434/v1');
    vi.stubEnv('LLM_API_KEY', 'my-key');

    const { loadLlmConfig } = await import('../../src/llm/config.js');
    const result = loadLlmConfig();
    expect(result).toBeDefined();
    expect(result!.baseUrl).toBe('http://localhost:11434/v1');
    expect(result!.apiKey).toBe('my-key');
  });

  it('defaults model to qwen2.5:latest when LLM_MODEL is not set', async () => {
    vi.stubEnv('LLM_BASE_URL', 'http://localhost:11434/v1');
    vi.stubEnv('LLM_API_KEY', 'my-key');
    // Ensure LLM_MODEL is absent (vi.mock blocks .env from setting it)
    const saved = process.env.LLM_MODEL;
    delete process.env.LLM_MODEL;

    try {
      const { loadLlmConfig } = await import('../../src/llm/config.js');
      const result = loadLlmConfig();
      expect(result).toBeDefined();
      expect(result!.model).toBe('qwen2.5:latest');
    } finally {
      if (saved !== undefined) process.env.LLM_MODEL = saved;
    }
  });

  it('uses LLM_MODEL when set', async () => {
    vi.stubEnv('LLM_BASE_URL', 'http://localhost:11434/v1');
    vi.stubEnv('LLM_API_KEY', 'my-key');
    vi.stubEnv('LLM_MODEL', 'llama3:8b');

    const { loadLlmConfig } = await import('../../src/llm/config.js');
    const result = loadLlmConfig();
    expect(result).toBeDefined();
    expect(result!.model).toBe('llama3:8b');
  });
});

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

describe('buildSystemPrompt', () => {
  it('mentions MCP', async () => {
    const { buildSystemPrompt } = await import('../../src/llm/prompts.js');
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('MCP');
  });

  it('contains JSON instruction', async () => {
    const { buildSystemPrompt } = await import('../../src/llm/prompts.js');
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('JSON');
  });
});

describe('buildInvestigationPrompt', () => {
  it('includes operation key', async () => {
    const { buildInvestigationPrompt } = await import('../../src/llm/prompts.js');
    const inv = makeInvestigation();
    const prompt = buildInvestigationPrompt(inv);
    expect(prompt).toContain('tools/list');
  });

  it('includes timeline entries', async () => {
    const { buildInvestigationPrompt } = await import('../../src/llm/prompts.js');
    const inv = makeInvestigation();
    const prompt = buildInvestigationPrompt(inv);
    expect(prompt).toContain('2025-01-15T10:00:00.000Z');
    expect(prompt).toContain('2025-01-15T10:00:01.000Z');
  });

  it('includes pair analysis details', async () => {
    const { buildInvestigationPrompt } = await import('../../src/llm/prompts.js');
    const inv = makeInvestigation();
    const prompt = buildInvestigationPrompt(inv);
    expect(prompt).toContain('delta=1000ms');
    expect(prompt).toContain('tools/call:create_thing');
    expect(prompt).toContain('cross_phase');
  });

  it('contains JSON instruction', async () => {
    const { buildInvestigationPrompt } = await import('../../src/llm/prompts.js');
    const inv = makeInvestigation();
    const prompt = buildInvestigationPrompt(inv);
    expect(prompt).toContain('JSON');
  });
});

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

describe('explainInvestigation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns LlmExplanation on valid JSON response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () =>
        makeChatResponse(
          JSON.stringify({
            explanation: 'LLM explanation',
            recommendation: 'LLM recommendation',
          }),
        ),
    });
    vi.stubGlobal('fetch', mockFetch);

    const { explainInvestigation } = await import('../../src/llm/client.js');
    const result = await explainInvestigation(makeInvestigation(), makeConfig());

    expect(result).toBeDefined();
    expect(result!.explanation).toBe('LLM explanation');
    expect(result!.recommendation).toBe('LLM recommendation');

    // Verify fetch was called with correct URL and auth
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:11434/v1/chat/completions');
    expect(opts.headers.Authorization).toBe('Bearer test-key');
  });

  it('returns undefined on invalid JSON in content', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => makeChatResponse('not valid json at all'),
    });
    vi.stubGlobal('fetch', mockFetch);

    const { explainInvestigation } = await import('../../src/llm/client.js');
    const result = await explainInvestigation(makeInvestigation(), makeConfig());
    expect(result).toBeUndefined();
  });

  it('returns undefined on network error', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', mockFetch);

    const { explainInvestigation } = await import('../../src/llm/client.js');
    const result = await explainInvestigation(makeInvestigation(), makeConfig());
    expect(result).toBeUndefined();
  });

  it('returns undefined on non-ok response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    });
    vi.stubGlobal('fetch', mockFetch);

    const { explainInvestigation } = await import('../../src/llm/client.js');
    const result = await explainInvestigation(makeInvestigation(), makeConfig());
    expect(result).toBeUndefined();
  });
});

describe('explainAllInvestigations', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('replaces explanation on success', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () =>
        makeChatResponse(
          JSON.stringify({
            explanation: 'LLM says this',
            recommendation: 'LLM suggests that',
          }),
        ),
    });
    vi.stubGlobal('fetch', mockFetch);

    const { explainAllInvestigations } = await import('../../src/llm/client.js');
    const report: InvestigationReport = {
      sessionId: 's1',
      investigations: [makeInvestigation()],
    };

    const result = await explainAllInvestigations(report, makeConfig());
    expect(result.investigations[0].explanation).toBe('LLM says this');
    expect(result.investigations[0].recommendation).toBe('LLM suggests that');
  });

  it('keeps originals on failure', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('fail'));
    vi.stubGlobal('fetch', mockFetch);

    const { explainAllInvestigations } = await import('../../src/llm/client.js');
    const inv = makeInvestigation({
      explanation: 'Original explanation',
      recommendation: 'Original recommendation',
    });
    const report: InvestigationReport = {
      sessionId: 's1',
      investigations: [inv],
    };

    const result = await explainAllInvestigations(report, makeConfig());
    expect(result.investigations[0].explanation).toBe('Original explanation');
    expect(result.investigations[0].recommendation).toBe('Original recommendation');
  });

  it('does not mutate the input report', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () =>
        makeChatResponse(
          JSON.stringify({
            explanation: 'New',
            recommendation: 'New',
          }),
        ),
    });
    vi.stubGlobal('fetch', mockFetch);

    const { explainAllInvestigations } = await import('../../src/llm/client.js');
    const original = makeInvestigation();
    const report: InvestigationReport = {
      sessionId: 's1',
      investigations: [original],
    };

    const result = await explainAllInvestigations(report, makeConfig());
    expect(result).not.toBe(report);
    expect(original.explanation).toBe('Original explanation');
  });
});
