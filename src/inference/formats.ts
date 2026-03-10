/**
 * String format detection for the Specwatch schema inference engine.
 * Detects common string formats in priority order: UUID > Email > URI > DateTime > Date > IPv4 > IPv6
 */

import type { StringFormat } from '../types/index.js';

// UUID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx (case-insensitive hex)
const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// Email: local@domain — simplified but practical
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// URI: starts with http:// or https://
const URI_REGEX = /^https?:\/\/.+/;

// ISO 8601 DateTime: date + T + time component (with optional timezone)
const DATETIME_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2}|[+-]\d{4})?$/;

// ISO 8601 Date only: YYYY-MM-DD
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

// IPv4: four octets of 0-255
const IPV4_REGEX = /^(\d{1,3}\.){3}\d{1,3}$/;

// IPv6: colon-separated hex groups (simplified — covers common representations)
// Matches: full form, compressed (::), loopback (::1), mixed IPv4-mapped, etc.
const IPV6_REGEX =
  /^(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$|^::(?:[0-9a-fA-F]{1,4}:){0,6}[0-9a-fA-F]{1,4}$|^[0-9a-fA-F]{1,4}::(?:[0-9a-fA-F]{1,4}:){0,5}[0-9a-fA-F]{1,4}$|^(?:[0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}$|^(?:[0-9a-fA-F]{1,4}:){1,7}:$|^:(?::[0-9a-fA-F]{1,4}){1,7}$|^::$/;

/**
 * Detect the string format of a string value.
 * Returns the format name or undefined if no format is detected.
 *
 * Priority order: UUID > Email > URI > DateTime > Date > IPv4 > IPv6
 */
export function detectStringFormat(value: string): StringFormat | undefined {
  if (UUID_REGEX.test(value)) return 'uuid';
  if (EMAIL_REGEX.test(value)) return 'email';
  if (URI_REGEX.test(value)) return 'uri';
  if (DATETIME_REGEX.test(value)) return 'date-time';
  if (DATE_REGEX.test(value)) return 'date';
  if (IPV4_REGEX.test(value)) return 'ipv4';
  if (IPV6_REGEX.test(value)) return 'ipv6';
  return undefined;
}
