/**
 * User-friendly error messages for common Specwatch failure modes.
 */

export class SpecwatchError extends Error {
  constructor(
    message: string,
    public readonly suggestion?: string,
  ) {
    super(message);
    this.name = 'SpecwatchError';
  }
}

export function portInUseError(port: number): SpecwatchError {
  return new SpecwatchError(
    `Port ${port} is already in use.`,
    `Try: specwatch start <url> --port ${port + 1}`,
  );
}

export function targetUnreachableError(url: string): SpecwatchError {
  return new SpecwatchError(
    `Cannot connect to ${url}.`,
    'Check the URL and your network connection.',
  );
}

export function noActiveSessionError(): SpecwatchError {
  return new SpecwatchError(
    'No active session.',
    'Start one with: specwatch start <url>',
  );
}

export function noCompletedSessionsError(): SpecwatchError {
  return new SpecwatchError(
    'No completed sessions to export.',
    'Start learning first: specwatch start <url>',
  );
}

export function sessionNotFoundError(id: string): SpecwatchError {
  return new SpecwatchError(
    `Session '${id}' not found.`,
    "Run 'specwatch sessions list' to see available sessions.",
  );
}

export function sessionNameNotFoundError(name: string): SpecwatchError {
  return new SpecwatchError(
    `No session found with name '${name}'.`,
    "Run 'specwatch sessions list' to see available sessions.",
  );
}
