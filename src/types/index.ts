/**
 * Re-export all shared types from the inference types module.
 * Import from this file: `import { InferredSchema, Session } from '../types/index.js';`
 */
export type {
  SchemaType,
  StringFormat,
  FieldStats,
  InferredSchema,
  SessionStatus,
  SessionConsumer,
  Session,
  Sample,
  HeaderEntry,
  AggregatedSchema,
  BreakingChangeType,
  BreakingChange,
  SchemaDiff,
  ExportOptions,
} from '../inference/types.js';
