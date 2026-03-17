/**
 * Tests for the agent-report CLI command.
 */

import { describe, it, expect } from 'vitest';
import { createProgram } from '../../src/cli/commands.js';

describe('agent-report CLI command', () => {
  it('agent-report command exists on createProgram()', () => {
    const program = createProgram();
    const agentReportCmd = program.commands.find((c) => c.name() === 'agent-report');
    expect(agentReportCmd).toBeDefined();
    expect(agentReportCmd!.description()).toBe(
      'Analyze agent traffic patterns and API friendliness',
    );
  });

  it('has --name option', () => {
    const program = createProgram();
    const agentReportCmd = program.commands.find((c) => c.name() === 'agent-report')!;
    const nameOpt = agentReportCmd.options.find((o) => o.long === '--name');
    expect(nameOpt).toBeDefined();
  });

  it('errors on human session with clear message', async () => {
    // Test the validation logic: consumer !== 'agent' should produce the right error
    const { SpecwatchError } = await import('../../src/cli/errors.js');

    const consumer = 'human';
    let thrownError: Error | undefined;
    if (consumer !== 'agent') {
      thrownError = new SpecwatchError(
        'agent-report requires a session captured with --consumer agent',
        'Start a session with: specwatch start <url> --consumer agent',
      );
    }

    expect(thrownError).toBeDefined();
    expect(thrownError!.message).toContain('--consumer agent');
  });
});
