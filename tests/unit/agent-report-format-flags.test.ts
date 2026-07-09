/**
 * Unit tests for S4 — the agent-report channel inversion:
 *   - the `--format` / `--human` / `--pretty` CLI surface (default json)
 *   - the capped human CALL SEQUENCE table (full detail lives in the JSON)
 */

import { describe, it, expect } from 'vitest';
import { createProgram } from '../../src/cli/commands.js';
import { formatAgentReport } from '../../src/cli/output.js';
import type { SequenceAnalysis } from '../../src/analysis/sequences.js';
import type { CompletenessReport } from '../../src/analysis/completeness.js';
import type { PhaseAnalysis, PhaseSample } from '../../src/analysis/phases.js';

function agentReportCmd() {
  return createProgram().commands.find((c) => c.name() === 'agent-report')!;
}

describe('agent-report --format CLI surface', () => {
  it('has a --format option defaulting to json', () => {
    const opt = agentReportCmd().options.find((o) => o.long === '--format');
    expect(opt).toBeDefined();
    expect(opt!.defaultValue).toBe('json');
  });

  it('has --human and --pretty flags', () => {
    const cmd = agentReportCmd();
    expect(cmd.options.find((o) => o.long === '--human')).toBeDefined();
    expect(cmd.options.find((o) => o.long === '--pretty')).toBeDefined();
  });

  it('still has -o/--output and --spec', () => {
    const cmd = agentReportCmd();
    expect(cmd.options.find((o) => o.long === '--output')).toBeDefined();
    expect(cmd.options.find((o) => o.long === '--spec')).toBeDefined();
  });
});

function makeAnalysis(): SequenceAnalysis {
  return {
    sequences: [],
    verificationLoops: [],
    totalRequests: 20,
    wastedRequests: 0,
    redundantCalls: [],
    toolUsage: [],
  };
}

const emptyCompleteness: CompletenessReport = {
  endpoints: [],
  thinResponses: [],
  avgCompleteness: 1,
};

function phaseAnalysisWith(n: number): PhaseAnalysis {
  const samples: PhaseSample[] = Array.from({ length: n }, (_, i) => ({
    index: i,
    operationKey: `GET /r${i}`,
    toolName: undefined,
    capturedAt: new Date(1_000_000 + i * 1000).toISOString(),
  }));
  return {
    phases: [
      {
        name: 'exploration',
        startIndex: 0,
        endIndex: n - 1,
        samples,
        duration: n * 1000,
      },
    ],
    toolPhaseMap: new Map(),
  };
}

// The CALL SEQUENCE table is followed by the VERIFICATION LOOPS section; slice
// between them so assertions target only the sequence table (other tables, e.g.
// the PHASES tool list, legitimately mention every operation key uncapped).
function callSequenceSection(output: string): string {
  const start = output.indexOf('CALL SEQUENCE');
  const end = output.indexOf('VERIFICATION LOOPS', start);
  return output.slice(start, end === -1 ? undefined : end);
}

describe('formatAgentReport CALL SEQUENCE cap', () => {
  it('caps the CALL SEQUENCE table at 15 rows and notes the remainder', () => {
    const output = formatAgentReport(
      'my-api',
      makeAnalysis(),
      emptyCompleteness,
      20,
      phaseAnalysisWith(20),
    );
    const seq = callSequenceSection(output);
    expect(seq).toContain('CALL SEQUENCE');
    expect(seq).toContain('/r0 ');
    expect(seq).toContain('/r14 '); // 15th row (index 14) shown
    expect(seq).not.toContain('/r15 '); // 16th row hidden from the sequence table
    expect(seq).toContain('and 5 more calls');
    expect(seq).toContain('--format json');
  });

  it('does not add the remainder note when the sequence fits within the cap', () => {
    const output = formatAgentReport(
      'my-api',
      makeAnalysis(),
      emptyCompleteness,
      10,
      phaseAnalysisWith(10),
    );
    expect(output).toContain('CALL SEQUENCE');
    expect(output).toContain('/r9');
    expect(output).not.toContain('more calls');
  });
});
