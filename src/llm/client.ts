/**
 * LLM client — sends investigation data to an OpenAI-compatible chat endpoint
 * and parses structured explanations from the response.
 */
import type { CallInvestigation } from '../analysis/investigation.js';
import type { InvestigationReport } from '../analysis/investigation.js';
import type { LlmConfig } from './config.js';
import { buildSystemPrompt, buildInvestigationPrompt } from './prompts.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LlmExplanation {
  explanation: string;
  recommendation: string;
}

// ---------------------------------------------------------------------------
// Single investigation
// ---------------------------------------------------------------------------

/**
 * Send a single investigation to the LLM and return a parsed explanation.
 * Returns undefined on any failure — never throws.
 */
export async function explainInvestigation(
  investigation: CallInvestigation,
  config: LlmConfig,
): Promise<LlmExplanation | undefined> {
  try {
    const url = config.baseUrl.replace(/\/+$/, '') + '/chat/completions';

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: 'system', content: buildSystemPrompt() },
          { role: 'user', content: buildInvestigationPrompt(investigation) },
        ],
        temperature: 0.3,
      }),
    });

    if (!response.ok) return undefined;

    const data = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };

    const raw = data.choices?.[0]?.message?.content;
    if (!raw) return undefined;

    // Strip markdown fences — some models wrap JSON in ```json ... ```
    const content = raw.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '');

    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (typeof parsed.explanation !== 'string' || typeof parsed.recommendation !== 'string') {
      return undefined;
    }

    return {
      explanation: parsed.explanation,
      recommendation: parsed.recommendation,
    };
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Batch — all investigations in a report
// ---------------------------------------------------------------------------

/**
 * Sequentially explain each investigation in the report.
 * On success, replaces explanation/recommendation; on failure, keeps originals.
 * Returns a new report (does not mutate the input).
 */
export async function explainAllInvestigations(
  report: InvestigationReport,
  config: LlmConfig,
): Promise<InvestigationReport> {
  const updated: CallInvestigation[] = [];

  for (const inv of report.investigations) {
    const result = await explainInvestigation(inv, config);
    if (result) {
      updated.push({
        ...inv,
        explanation: result.explanation,
        recommendation: result.recommendation,
      });
    } else {
      updated.push(inv);
    }
  }

  return {
    ...report,
    investigations: updated,
  };
}
