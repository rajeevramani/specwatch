/**
 * JSON-RPC detection and operation extraction for MCP traffic analysis.
 * Detects whether a session contains JSON-RPC traffic (e.g., MCP servers)
 * and extracts tool operation details from samples.
 */
import type { Sample } from '../types/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Extracted JSON-RPC operation details from a sample. */
export interface JsonRpcOperation {
  /** JSON-RPC method (e.g., "tools/call", "tools/list", "initialize") */
  rpcMethod: string;
  /** Tool name for tools/call requests (e.g., "cp_create_cluster") */
  toolName: string | undefined;
  /** Composite key for grouping (e.g., "tools/call:cp_create_cluster" or "tools/list") */
  operationKey: string;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Determines whether a set of samples looks like JSON-RPC traffic.
 *
 * Heuristic: if >80% of samples are POST to the same path AND have
 * jsonrpcMethod populated (or request schemas with jsonrpc/method fields),
 * the session is treated as JSON-RPC.
 *
 * Returns false for empty sample sets or sessions with mixed REST traffic.
 */
export function isJsonRpcSession(samples: Sample[]): boolean {
  if (samples.length === 0) return false;

  // Check how many samples have jsonrpcMethod set
  let jsonrpcCount = 0;

  for (const sample of samples) {
    if (sample.httpMethod !== 'POST') continue;

    if (sample.jsonrpcMethod) {
      jsonrpcCount++;
      continue;
    }

    // Fallback: inspect request schema for jsonrpc/method properties
    if (hasJsonRpcSchemaShape(sample)) {
      jsonrpcCount++;
    }
  }

  // >80% threshold
  return jsonrpcCount / samples.length > 0.8;
}

/**
 * Checks if a sample's request schema has the shape of a JSON-RPC request
 * (has "jsonrpc" and "method" properties).
 */
function hasJsonRpcSchemaShape(sample: Sample): boolean {
  const schema = sample.requestSchema;
  if (!schema || schema.type !== 'object' || !schema.properties) return false;

  const propNames = Object.keys(schema.properties);
  return propNames.includes('jsonrpc') && propNames.includes('method');
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * Extracts JSON-RPC operation details from a sample.
 *
 * Prefers the stored jsonrpcMethod/jsonrpcTool fields (populated at capture time).
 * Falls back to inspecting the request schema for method enum values and
 * params.name enum values.
 *
 * Returns undefined if the sample is not a JSON-RPC request.
 */
export function extractJsonRpcOperation(sample: Sample): JsonRpcOperation | undefined {
  // Try stored fields first
  if (sample.jsonrpcMethod) {
    const toolName = sample.jsonrpcTool || undefined;
    return {
      rpcMethod: sample.jsonrpcMethod,
      toolName,
      operationKey: buildOperationKey(sample.jsonrpcMethod, toolName),
    };
  }

  // Fallback: inspect request schema
  return extractFromSchema(sample);
}

/**
 * Extracts JSON-RPC method and tool name from a request body object.
 * Used at capture time to populate jsonrpcMethod and jsonrpcTool fields.
 *
 * Returns undefined if the body is not a JSON-RPC request.
 */
export function extractJsonRpcFromBody(
  body: unknown,
): { method: string; tool: string | undefined } | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;

  const obj = body as Record<string, unknown>;
  if (obj.jsonrpc !== '2.0' && obj.jsonrpc !== '1.0') return undefined;
  if (typeof obj.method !== 'string') return undefined;

  const method = obj.method;
  let tool: string | undefined;

  // Extract tool name from params.name for tools/call
  if (method === 'tools/call' && obj.params && typeof obj.params === 'object') {
    const params = obj.params as Record<string, unknown>;
    if (typeof params.name === 'string') {
      tool = params.name;
    }
  }

  return { method, tool };
}

// ---------------------------------------------------------------------------
// MCP Response Unwrapping
// ---------------------------------------------------------------------------

/**
 * Checks if a response body has the shape of an MCP tool response:
 * `{ jsonrpc: "2.0", result: { content: [{ type: "text", text: string }] } }`
 */
export function isMcpToolResponse(body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;

  const obj = body as Record<string, unknown>;
  if (obj.jsonrpc !== '2.0') return false;

  const result = obj.result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;

  const content = (result as Record<string, unknown>).content;
  if (!Array.isArray(content)) return false;

  return content.some(
    (entry) =>
      entry && typeof entry === 'object' && (entry as Record<string, unknown>).type === 'text' && typeof (entry as Record<string, unknown>).text === 'string',
  );
}

/**
 * Extracts actual tool output from an MCP JSON-RPC response.
 *
 * Navigates to `result.content`, finds the first `{ type: "text", text: string }` entry,
 * and attempts to JSON.parse the text. Returns the parsed result on success,
 * or the original body on any failure.
 */
export function unwrapMcpResponse(responseBody: unknown): unknown {
  if (!responseBody || typeof responseBody !== 'object' || Array.isArray(responseBody)) {
    return responseBody;
  }

  const obj = responseBody as Record<string, unknown>;
  if (obj.jsonrpc !== '2.0') return responseBody;

  const result = obj.result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) return responseBody;

  const content = (result as Record<string, unknown>).content;
  if (!Array.isArray(content)) return responseBody;

  const textEntry = content.find(
    (entry) =>
      entry && typeof entry === 'object' && (entry as Record<string, unknown>).type === 'text' && typeof (entry as Record<string, unknown>).text === 'string',
  );

  if (!textEntry) return responseBody;

  try {
    return JSON.parse((textEntry as Record<string, unknown>).text as string);
  } catch {
    return responseBody;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildOperationKey(rpcMethod: string, toolName: string | undefined): string {
  return toolName ? `${rpcMethod}:${toolName}` : rpcMethod;
}

/**
 * Attempts to extract JSON-RPC operation from the request schema structure.
 * Looks for method enum values and params.name enum values.
 */
function extractFromSchema(sample: Sample): JsonRpcOperation | undefined {
  const schema = sample.requestSchema;
  if (!schema || schema.type !== 'object' || !schema.properties) return undefined;

  const props = schema.properties;
  if (!props.jsonrpc || !props.method) return undefined;

  // Try to get method value from enum
  const methodSchema = props.method;
  let rpcMethod: string | undefined;

  if (methodSchema.enum && methodSchema.enum.length > 0) {
    rpcMethod = String(methodSchema.enum[0]);
  }

  if (!rpcMethod) return undefined;

  // Try to get tool name from params.name enum
  let toolName: string | undefined;
  if (rpcMethod === 'tools/call' && props.params) {
    const paramsSchema = props.params;
    if (paramsSchema.type === 'object' && paramsSchema.properties?.name) {
      const nameSchema = paramsSchema.properties.name;
      if (nameSchema.enum && nameSchema.enum.length > 0) {
        toolName = String(nameSchema.enum[0]);
      }
    }
  }

  return {
    rpcMethod,
    toolName,
    operationKey: buildOperationKey(rpcMethod, toolName),
  };
}
