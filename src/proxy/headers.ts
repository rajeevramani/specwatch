// Header filtering and redaction logic — owned by Proxy Engineer

import { classifyAuthorization, projectHeaders } from '../headers/metadata.js';
import type { HeaderEntry } from '../types/index.js';

/**
 * Hop-by-hop headers that must not be forwarded or captured.
 * These are connection-specific and have no meaning beyond the immediate transport hop.
 */
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * Infrastructure headers added by proxies and load balancers.
 * These are injected by middleware and not meaningful for API schema capture.
 */
const INFRASTRUCTURE_HEADERS = new Set([
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-forwarded-host',
  'x-forwarded-port',
  'via',
  'forwarded',
  'host',
]);

/**
 * Returns true if the header name is a hop-by-hop or infrastructure header
 * that should be excluded from capture entirely.
 */
export function isInfrastructureHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return HOP_BY_HOP_HEADERS.has(lower) || INFRASTRUCTURE_HEADERS.has(lower);
}

/** Capture structural presence and a closed authorization classification only. */
export function captureHeaders(headers: Record<string, unknown>): HeaderEntry[] | undefined {
  const entries: HeaderEntry[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || isInfrastructureHeader(name)) continue;
    const authSchemes =
      name.toLowerCase() === 'authorization' ? classifyAuthorization(value) : undefined;
    entries.push(authSchemes ? { name, authSchemes } : { name });
  }
  return projectHeaders(entries);
}
