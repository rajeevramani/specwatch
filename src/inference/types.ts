/**
 * Core type definitions for the Specwatch schema inference engine.
 * These types are shared across all modules — do not modify without Lead approval.
 */

// === Schema Inference Types ===

/** JSON Schema types supported by the inference engine */
export type SchemaType = 'string' | 'number' | 'integer' | 'boolean' | 'null' | 'object' | 'array';

/** Format annotations detected from values (string and numeric formats) */
export type StringFormat = 'uuid' | 'date-time' | 'date' | 'email' | 'uri' | 'ipv4' | 'ipv6' | 'double' | 'int32' | 'int64';

/** Statistics tracking field presence and sampling across observations */
export interface FieldStats {
  /** Total number of samples observed for the parent object */
  sampleCount: number;
  /** Number of times this specific field was present */
  presenceCount: number;
  /** Ratio of presenceCount / sampleCount */
  confidence: number;
}

/**
 * Recursive schema representation inferred from JSON values.
 *
 * When `oneOf` is present, `type` is ignored — each variant in `oneOf`
 * is a complete InferredSchema with its own type, format, properties, items, etc.
 * This fixes Flowplane's data loss bug where oneOf held only type names.
 */
export interface InferredSchema {
  /** The JSON type of this schema node */
  type: SchemaType;
  /** String format annotation (only for type: 'string') */
  format?: StringFormat;
  /** Object properties (only for type: 'object') */
  properties?: Record<string, InferredSchema>;
  /** Required field names (only for type: 'object') */
  required?: string[];
  /** Array item schema (only for type: 'array') */
  items?: InferredSchema;
  /** Union type variants — full schemas, not just type names */
  oneOf?: InferredSchema[];
  /** Inferred enum values for low-cardinality string fields */
  enum?: string[];
  /** Tracked observed string values for enum inference (internal, stripped in export) */
  _observedValues?: string[];
  /** Field presence and sampling statistics */
  stats: FieldStats;
}

// === Session Types ===

/** Session lifecycle states */
export type SessionStatus = 'active' | 'aggregating' | 'completed' | 'failed';

/** Valid consumer types for a session */
export type SessionConsumer = 'human' | 'agent';

/** A proxy capture session */
export interface Session {
  /** UUID identifier */
  id: string;
  /** Optional user-provided name for identification */
  name?: string;
  /** Target API URL (e.g., "https://api.example.com") */
  targetUrl: string;
  /** Local proxy port */
  port: number;
  /** Current session lifecycle state */
  status: SessionStatus;
  /** ISO 8601 timestamp of session creation */
  createdAt: string;
  /** ISO 8601 timestamp of when proxy started */
  startedAt?: string;
  /** ISO 8601 timestamp of when proxy stopped */
  stoppedAt?: string;
  /** ISO 8601 timestamp of when aggregation finished */
  completedAt?: string;
  /** Number of successfully captured samples */
  sampleCount: number;
  /** Number of skipped requests (too large or non-JSON) */
  skippedCount: number;
  /** Optional cap on number of samples */
  maxSamples?: number;
  /** Error message if session failed */
  errorMessage?: string;
  /** Who is consuming this session: 'human' (default) or 'agent' */
  consumer?: SessionConsumer;
}

// === Sample Types ===

/** A single request/response observation with inferred schemas */
export interface Sample {
  /** Auto-incremented ID */
  id: number;
  /** ID of the parent session */
  sessionId: string;
  /** HTTP method (GET, POST, etc.) */
  httpMethod: string;
  /** Raw path with query string (e.g., /users/123?page=1) */
  path: string;
  /** Normalized template path without query string (e.g., /users/{userId}) */
  normalizedPath: string;
  /** HTTP response status code */
  statusCode?: number;
  /** Parsed query parameters */
  queryParams?: Record<string, string>;
  /** Inferred schema of the request body (null if no body) */
  requestSchema?: InferredSchema;
  /** Inferred schema of the response body (null if no body) */
  responseSchema?: InferredSchema;
  /** Captured and redacted request headers */
  requestHeaders?: HeaderEntry[];
  /** Captured and redacted response headers */
  responseHeaders?: HeaderEntry[];
  /** ISO 8601 timestamp of when this sample was captured */
  capturedAt: string;
}

/** A captured HTTP header with name and example value */
export interface HeaderEntry {
  /** Header name (e.g., "Content-Type") */
  name: string;
  /** Example value (redacted for sensitive headers) */
  example: string;
}

// === Aggregation Types ===

/** Aggregated consensus schema for an endpoint across multiple samples */
export interface AggregatedSchema {
  /** Auto-incremented ID */
  id: number;
  /** ID of the parent session */
  sessionId: string;
  /** HTTP method */
  httpMethod: string;
  /** Normalized template path */
  path: string;
  /** Schema version (auto-incremented across sessions) */
  version: number;
  /** Snapshot number within a session (for auto-aggregate) */
  snapshot: number;
  /** Merged request body schema */
  requestSchema?: InferredSchema;
  /** Response schemas keyed by status code (e.g., {"200": {...}, "404": {...}}) */
  responseSchemas?: Record<string, InferredSchema>;
  /** Merged request headers */
  requestHeaders?: HeaderEntry[];
  /** Merged response headers */
  responseHeaders?: HeaderEntry[];
  /** Total number of samples contributing to this schema */
  sampleCount: number;
  /** Confidence score [0.0, 1.0] */
  confidenceScore: number;
  /** Aggregated query parameter names with observed values */
  queryParams?: Record<string, string[]>;
  /** Observed raw values for each path parameter (for type inference) */
  pathParamValues?: Record<string, string[]>;
  /** Number of unique response schema shapes observed for this endpoint */
  uniqueResponseShapes?: number;
  /** Breaking changes detected against previous session */
  breakingChanges?: BreakingChange[];
  /** Previous session ID for diff tracking */
  previousSessionId?: string;
  /** ISO 8601 timestamp of first observation */
  firstObserved: string;
  /** ISO 8601 timestamp of last observation */
  lastObserved: string;
}

// === Breaking Change Types ===

/** Types of breaking changes detected between schema versions */
export type BreakingChangeType =
  | 'required_field_removed'
  | 'incompatible_type_change'
  | 'required_field_added'
  | 'field_became_required'
  | 'schema_type_changed';

/** A detected breaking change between two schema versions */
export interface BreakingChange {
  /** Category of breaking change */
  type: BreakingChangeType;
  /** JSON path to the affected field (e.g., "$.user.email") */
  path: string;
  /** Human-readable description of the change */
  description: string;
  /** Previous value or type */
  oldValue?: string;
  /** New value or type */
  newValue?: string;
}

/** Result of comparing two schemas for breaking and non-breaking changes */
export interface SchemaDiff {
  /** Breaking changes that may affect consumers */
  breakingChanges: BreakingChange[];
  /** Non-breaking changes (informational) */
  nonBreakingChanges: string[];
}

// === Export Types ===

/** Options for exporting schemas to OpenAPI or JSON format */
export interface ExportOptions {
  /** Output format */
  format: 'openapi' | 'json';
  /** OpenAPI spec version (3.0 not yet supported in v1) */
  openapiVersion: '3.1' | '3.0';
  /** Minimum confidence threshold for including endpoints */
  minConfidence: number;
  /** OpenAPI info.title */
  title?: string;
  /** OpenAPI info.version */
  version?: string;
  /** OpenAPI info.description */
  description?: string;
  /** Include x-specwatch-* metadata extensions */
  includeMetadata?: boolean;
}
