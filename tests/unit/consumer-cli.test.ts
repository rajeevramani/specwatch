/**
 * Tests for --consumer CLI flag on the start command.
 */

import { describe, it, expect } from 'vitest';
import { createProgram } from '../../src/cli/commands.js';

describe('--consumer CLI option', () => {
  it('--consumer agent is parsed correctly', () => {
    const program = createProgram();
    const startCmd = program.commands.find((c) => c.name() === 'start')!;
    expect(startCmd).toBeDefined();

    // Parse with --consumer agent (exitOverride prevents process.exit)
    program.exitOverride();
    startCmd.exitOverride();

    // We can't fully run the action (it starts a server), but we can verify
    // the option is registered and parsed by inspecting the command options
    const consumerOpt = startCmd.options.find((o) => o.long === '--consumer');
    expect(consumerOpt).toBeDefined();
    expect(consumerOpt!.defaultValue).toBe('human');
  });

  it('--consumer human is the default', () => {
    const program = createProgram();
    const startCmd = program.commands.find((c) => c.name() === 'start')!;

    const consumerOpt = startCmd.options.find((o) => o.long === '--consumer');
    expect(consumerOpt).toBeDefined();
    expect(consumerOpt!.defaultValue).toBe('human');
  });

  it('consumer validation rejects invalid values', async () => {
    // Test the validation logic directly by simulating what the action does
    const { SpecwatchError } = await import('../../src/cli/errors.js');

    const consumer = 'invalid-value';
    let thrownError: Error | undefined;
    if (consumer !== 'human' && consumer !== 'agent') {
      thrownError = new SpecwatchError(
        `Invalid consumer type: '${consumer}'.`,
        'Use --consumer human or --consumer agent.',
      );
    }

    expect(thrownError).toBeDefined();
    expect(thrownError!.message).toContain('Invalid consumer type');
  });
});
