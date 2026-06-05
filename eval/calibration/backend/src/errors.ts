import type { Response } from 'express';

/**
 * RFC 9457 (problem+json) error responses.
 *
 * The gold OpenAPI spec documents every error as an `application/problem+json`
 * body with `type`, `title`, `status`, `detail`, and a machine-readable `code`.
 * Emitting that exact shape here keeps the spec truthful to backend behavior —
 * the calibration baseline must not misrepresent what an agent actually sees.
 */
export interface Problem {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: string;
}

const PROBLEM_BASE = 'https://api.calibration.local/problems';

const TITLES: Record<string, string> = {
  invalid_body: 'Invalid request body',
  not_found: 'Resource not found',
  conflict: 'Resource conflict',
  unprocessable: 'Unprocessable entity',
  rate_limited: 'Too many requests',
  internal_error: 'Internal server error',
};

/** Send an RFC 9457 problem+json error response. */
export function sendProblem(res: Response, status: number, code: string, detail: string): Response {
  const problem: Problem = {
    type: `${PROBLEM_BASE}/${code.replace(/_/g, '-')}`,
    title: TITLES[code] ?? 'Error',
    status,
    detail,
    code,
  };
  return res.status(status).type('application/problem+json').json(problem);
}
