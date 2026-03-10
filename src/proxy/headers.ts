// Header filtering and redaction logic — owned by Proxy Engineer

import type { IncomingHttpHeaders } from 'node:http';
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

/**
 * Redacts the value of sensitive headers while preserving their presence.
 *
 * Rules:
 * - Authorization: keep scheme prefix (e.g., "Bearer ***", "Basic ***"), or "***" if no scheme
 * - Cookie: replace with "***"
 * - X-API-Key: replace with "***"
 *
 * Returns the original value unchanged for non-sensitive headers.
 */
export function redactHeader(name: string, value: string): string {
  const lower = name.toLowerCase();

  if (lower === 'authorization') {
    // Keep scheme prefix (e.g., "Bearer", "Basic", "Token") but redact the credential
    const spaceIdx = value.indexOf(' ');
    if (spaceIdx !== -1) {
      const scheme = value.slice(0, spaceIdx);
      return `${scheme} ***`;
    }
    return '***';
  }

  if (lower === 'cookie') {
    return '***';
  }

  if (lower === 'x-api-key') {
    return '***';
  }

  return value;
}

/**
 * Captures headers from an incoming HTTP request or response, applying:
 * 1. Filtering: hop-by-hop and infrastructure headers are excluded
 * 2. Redaction: sensitive header values are masked
 *
 * Returns an array of HeaderEntry objects sorted by name for stable output.
 * Returns undefined if no capturable headers are present.
 */
export function captureHeaders(
  headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>,
): HeaderEntry[] | undefined {
  const entries: HeaderEntry[] = [];

  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (isInfrastructureHeader(name)) continue;

    // Normalise to a single string value — take only the first if array
    const rawValue = Array.isArray(value) ? value[0] : value;
    if (rawValue === undefined || rawValue === '') continue;

    const example = redactHeader(name, rawValue);
    entries.push({ name, example });
  }

  if (entries.length === 0) return undefined;

  // Sort alphabetically by name for stable, deterministic output
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}
