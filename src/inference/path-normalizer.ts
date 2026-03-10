/**
 * Path normalization for API endpoints.
 * Groups equivalent endpoint paths by replacing dynamic segments (IDs, UUIDs, dates, etc.)
 * with named parameter templates.
 *
 * Ported from Flowplane's path_normalizer.rs with contextual naming.
 */

// UUID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// ISO 8601 Date: YYYY-MM-DD
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

// ISO 8601 DateTime: date + T + time
const DATETIME_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

// Pure numeric ID: one or more digits
const NUMERIC_REGEX = /^\d+$/;

// Alphanumeric code: mix of letters and digits (e.g., ABC123, SKU-001)
const ALPHANUMERIC_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_-]*[a-zA-Z0-9]$|^[a-zA-Z0-9]$/;

// Literal keywords that should never be treated as dynamic segments
const LITERAL_KEYWORDS = new Set([
  'api',
  'v1',
  'v2',
  'v3',
  'v4',
  'v5',
  'admin',
  'public',
  'private',
  'internal',
  'external',
  'health',
  'status',
  'metrics',
  'docs',
  'swagger',
  'openapi',
  'graphql',
  'rest',
  'rpc',
  'ws',
  'wss',
]);

// Common plural-to-singular conversions for REST resource names
const PLURAL_MAP: Record<string, string> = {
  users: 'user',
  orders: 'order',
  products: 'product',
  items: 'item',
  events: 'event',
  sessions: 'session',
  accounts: 'account',
  roles: 'role',
  groups: 'group',
  teams: 'team',
  projects: 'project',
  tasks: 'task',
  messages: 'message',
  notifications: 'notification',
  comments: 'comment',
  posts: 'post',
  pages: 'page',
  categories: 'category',
  tags: 'tag',
  files: 'file',
  images: 'image',
  documents: 'document',
  tokens: 'token',
  keys: 'key',
  logs: 'log',
  reports: 'report',
  invoices: 'invoice',
  payments: 'payment',
  subscriptions: 'subscription',
  customers: 'customer',
  employees: 'employee',
  departments: 'department',
  addresses: 'address',
  contacts: 'contact',
  organizations: 'organization',
  services: 'service',
  resources: 'resource',
  permissions: 'permission',
  settings: 'setting',
  configs: 'config',
  policies: 'policy',
  rules: 'rule',
  scopes: 'scope',
  namespaces: 'namespace',
  clusters: 'cluster',
  nodes: 'node',
  pods: 'pod',
  containers: 'container',
  repositories: 'repository',
  branches: 'branch',
  commits: 'commit',
  releases: 'release',
  versions: 'version',
  environments: 'environment',
  webhooks: 'webhook',
  endpoints: 'endpoint',
  applications: 'application',
  clients: 'client',
  devices: 'device',
  sensors: 'sensor',
  metrics: 'metric',
  alerts: 'alert',
  incidents: 'incident',
  workflows: 'workflow',
  pipelines: 'pipeline',
  jobs: 'job',
  builds: 'build',
  deployments: 'deployment',
  artifacts: 'artifact',
  assets: 'asset',
  collections: 'collection',
  records: 'record',
  entries: 'entry',
  schemas: 'schema',
  models: 'model',
  datasets: 'dataset',
  queries: 'query',
  results: 'result',
  responses: 'response',
  requests: 'request',
  actions: 'action',
  operations: 'operation',
  transactions: 'transaction',
  transfers: 'transfer',
  conversions: 'conversion',
};

/**
 * Convert a plural resource name to its singular form.
 * Uses a lookup table; falls back to simple heuristics for common English plurals.
 */
function singularize(word: string): string {
  const lower = word.toLowerCase();
  if (PLURAL_MAP[lower] !== undefined) {
    return PLURAL_MAP[lower];
  }
  // Simple heuristic: strip trailing 's' for common patterns
  if (lower.endsWith('ies') && lower.length > 3) {
    return lower.slice(0, -3) + 'y';
  }
  if (lower.endsWith('ses') && lower.length > 3) {
    return lower.slice(0, -2);
  }
  if (lower.endsWith('s') && lower.length > 2) {
    return lower.slice(0, -1);
  }
  return lower;
}

/**
 * Generate a parameter name from the preceding path segment.
 * e.g., "users" → "{userId}", "orders" → "{orderId}", "events" → "{eventDate}"
 */
function paramFromPreceding(preceding: string, suffix: string): string {
  const singular = singularize(preceding);
  return `{${singular}${suffix}}`;
}

/**
 * Determine if a segment looks like a dynamic value (ID, UUID, date, etc.)
 * Returns the parameter template string, or null if it's a literal segment.
 */
function classifySegment(
  segment: string,
  precedingSegment: string | null,
  isSecondConsecutiveDynamic: boolean,
): string | null {
  // Already parameterized (e.g., {userId})
  if (segment.startsWith('{') && segment.endsWith('}')) {
    return segment;
  }

  // Literal keywords are never dynamic
  if (LITERAL_KEYWORDS.has(segment.toLowerCase())) {
    return null;
  }

  // Pure literal: only letters (no digits, no special chars) — likely a resource name
  if (/^[a-zA-Z]+$/.test(segment)) {
    return null;
  }

  // UUID → contextual naming with "Id" suffix
  if (UUID_REGEX.test(segment)) {
    if (precedingSegment !== null) {
      return paramFromPreceding(precedingSegment, 'Id');
    }
    return '{id}';
  }

  // DateTime → contextual naming with "Timestamp" suffix
  if (DATETIME_REGEX.test(segment)) {
    if (precedingSegment !== null) {
      return paramFromPreceding(precedingSegment, 'Timestamp');
    }
    return '{timestamp}';
  }

  // Date → contextual naming with "Date" suffix
  if (DATE_REGEX.test(segment)) {
    if (precedingSegment !== null) {
      return paramFromPreceding(precedingSegment, 'Date');
    }
    return '{date}';
  }

  // Pure numeric → contextual naming with "Id" suffix
  if (NUMERIC_REGEX.test(segment)) {
    if (isSecondConsecutiveDynamic) {
      return '{id}';
    }
    if (precedingSegment !== null) {
      return paramFromPreceding(precedingSegment, 'Id');
    }
    return '{id}';
  }

  // Alphanumeric code (contains both letters and digits, or hyphens) → "Code" suffix
  if (ALPHANUMERIC_REGEX.test(segment) && /\d/.test(segment)) {
    if (precedingSegment !== null) {
      return paramFromPreceding(precedingSegment, 'Code');
    }
    return '{code}';
  }

  // Hyphenated or mixed segments that might be slugs or IDs
  if (/[-_]/.test(segment) && /\d/.test(segment)) {
    if (precedingSegment !== null) {
      return paramFromPreceding(precedingSegment, 'Id');
    }
    return '{id}';
  }

  return null;
}

/**
 * Normalize a URL path by replacing dynamic segments with named parameter templates.
 *
 * - Strips query strings before normalizing
 * - Already-parameterized paths pass through unchanged
 * - Contextual naming: /users/123 → /users/{userId}
 * - UUID detection: /orders/550e8400-... → /orders/{orderId}
 * - Date detection: /events/2024-01-15 → /events/{eventDate}
 * - Alphanumeric codes: /products/ABC123 → /products/{productCode}
 * - Consecutive dynamic segments: second uses default {id}
 * - Literal keywords preserved: api, v1, v2, admin, etc.
 */
export function normalizePath(path: string): string {
  // Strip query string
  const queryStart = path.indexOf('?');
  const cleanPath = queryStart >= 0 ? path.slice(0, queryStart) : path;

  // Split into segments (filter empty strings from leading slash)
  const segments = cleanPath.split('/').filter((s) => s.length > 0);

  if (segments.length === 0) {
    return '/';
  }

  const normalized: string[] = [];
  let previousWasDynamic = false;

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];

    // Find the most recent literal segment as context for naming
    let precedingLiteralSegment: string | null = null;
    for (let j = normalized.length - 1; j >= 0; j--) {
      const prev = normalized[j];
      // Skip if it's a parameter template
      if (!prev.startsWith('{')) {
        precedingLiteralSegment = prev;
        break;
      }
    }

    const param = classifySegment(segment, precedingLiteralSegment, previousWasDynamic);

    if (param !== null) {
      normalized.push(param);
      previousWasDynamic = true;
    } else {
      normalized.push(segment);
      previousWasDynamic = false;
    }
  }

  return '/' + normalized.join('/');
}
