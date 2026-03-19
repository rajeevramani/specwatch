/**
 * Prompt construction for LLM-powered investigation explanations.
 * Builds system and user prompts from CallInvestigation data.
 */
import type { CallInvestigation } from '../analysis/investigation.js';

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

export function buildSystemPrompt(): string {
  return `You are an MCP (Model Context Protocol) analyst. You understand the protocol lifecycle: initialize, notifications/initialized, tools/list, tools/call, and resource operations.

Given an investigation of redundant API calls from an MCP agent session, explain WHY the agent made these calls and whether they could be optimized.

Respond with 1-2 sentences for each field. Respond ONLY with JSON in this format:
{"explanation":"...","recommendation":"..."}`;
}

// ---------------------------------------------------------------------------
// Investigation prompt
// ---------------------------------------------------------------------------

export function buildInvestigationPrompt(investigation: CallInvestigation): string {
  const lines: string[] = [];

  lines.push(`Operation: ${investigation.operationKey}`);
  lines.push(`Called ${investigation.occurrences.length} times`);
  lines.push(`Primary cause: ${investigation.primaryCause}`);
  lines.push('');

  // Timeline
  lines.push('Timeline:');
  for (const occ of investigation.occurrences) {
    const parts = [`  ${occ.capturedAt}`];
    if (occ.statusCode !== undefined) parts.push(`status=${occ.statusCode}`);
    if (occ.phase) parts.push(`phase=${occ.phase}`);
    lines.push(parts.join(' '));
  }
  lines.push('');

  // Pair analyses
  if (investigation.pairAnalyses.length > 0) {
    lines.push('Pair analyses:');
    for (const pair of investigation.pairAnalyses) {
      const details: string[] = [
        `delta=${pair.deltaMs}ms`,
        `cause=${pair.cause}`,
      ];
      if (pair.interveningOps.length > 0) {
        details.push(`intervening=[${pair.interveningOps.join(', ')}]`);
      }
      const reqChanges = (pair.requestDiff?.breakingChanges.length ?? 0) + (pair.requestDiff?.nonBreakingChanges.length ?? 0);
      const resChanges = (pair.responseDiff?.breakingChanges.length ?? 0) + (pair.responseDiff?.nonBreakingChanges.length ?? 0);
      if (reqChanges > 0) details.push(`req_changes=${reqChanges}`);
      if (resChanges > 0) details.push(`res_changes=${resChanges}`);
      if (pair.crossPhase) details.push('cross_phase');
      lines.push(`  ${details.join(' ')}`);
    }
    lines.push('');
  }

  lines.push('Respond ONLY with JSON.');

  return lines.join('\n');
}
