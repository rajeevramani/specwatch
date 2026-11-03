/** Pure, closed projection at every header metadata boundary. No raw values survive. */
import type { HeaderEntry } from '../types/index.js';

type AuthScheme = NonNullable<HeaderEntry['authSchemes']>[number];
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** Interpret transient protocol input (or explicit legacy migration input) only. */
export function classifyAuthorization(value: unknown): AuthScheme[] | undefined {
  const schemes = new Set<AuthScheme>();
  for (const item of Array.isArray(value) ? value : [value]) {
    if (typeof item !== 'string') continue;
    const match = /^(bearer|basic)[ \t]+\S/i.exec(item);
    if (match) schemes.add(match[1].toLowerCase() as AuthScheme);
  }
  return schemes.size ? [...schemes].sort() : undefined;
}

/** Drop unknown fields unread, including legacy example getters. Never mutate input. */
export function projectHeaders(input: unknown): HeaderEntry[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const entries = new Map<string, Set<AuthScheme>>();
  for (const item of input) {
    if (item === null || typeof item !== 'object') continue;
    const candidate = item as { name?: unknown; authSchemes?: unknown };
    if (typeof candidate.name !== 'string' || !TOKEN.test(candidate.name)) continue;
    const name = candidate.name.toLowerCase();
    const schemes = entries.get(name) ?? new Set<AuthScheme>();
    entries.set(name, schemes);
    if (name === 'authorization' && Array.isArray(candidate.authSchemes)) {
      for (const scheme of candidate.authSchemes) {
        if (scheme === 'bearer' || scheme === 'basic') schemes.add(scheme);
      }
    }
  }
  if (!entries.size) return undefined;
  return [...entries]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, schemes]) =>
      schemes.size ? { name, authSchemes: [...schemes].sort() } : { name },
    );
}

/** Fixed error: native JSON parser diagnostics can include the stored header bytes. */
export function parseHeaderArray(raw: string): unknown[] {
  try {
    const decoded: unknown = JSON.parse(raw);
    if (Array.isArray(decoded)) return decoded;
  } catch {
    // Intentionally omit parser error, input and cause.
  }
  throw new Error('Invalid stored header metadata.');
}

export function decodeHeaders(raw: string | null): HeaderEntry[] | undefined {
  return raw === null ? undefined : projectHeaders(parseHeaderArray(raw));
}

export function encodeHeaders(input: unknown): string | null {
  const projected = projectHeaders(input);
  return projected ? JSON.stringify(projected) : null;
}
