/**
 * Tests for MCP response unwrapping (isMcpToolResponse, unwrapMcpResponse).
 */

import { describe, it, expect } from 'vitest';
import { isMcpToolResponse, unwrapMcpResponse } from '../../src/analysis/jsonrpc.js';
import { inferSchema } from '../../src/inference/engine.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMcpResponse(text: string) {
  return {
    jsonrpc: '2.0' as const,
    id: 1,
    result: {
      content: [{ type: 'text', text }],
    },
  };
}

// ---------------------------------------------------------------------------
// unwrapMcpResponse
// ---------------------------------------------------------------------------

describe('unwrapMcpResponse', () => {
  it('unwraps valid MCP response with parseable JSON text', () => {
    const body = makeMcpResponse('{"users":[{"id":1,"name":"Alice"}]}');
    const result = unwrapMcpResponse(body);
    expect(result).toEqual({ users: [{ id: 1, name: 'Alice' }] });
  });

  it('returns original body when text is not valid JSON', () => {
    const body = makeMcpResponse('plain text, not JSON');
    const result = unwrapMcpResponse(body);
    expect(result).toBe(body);
  });

  it('returns original body when content array is empty', () => {
    const body = { jsonrpc: '2.0', id: 1, result: { content: [] } };
    const result = unwrapMcpResponse(body);
    expect(result).toBe(body);
  });

  it('picks the first text entry when multiple content entries exist', () => {
    const body = {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [
          { type: 'image', data: 'base64...' },
          { type: 'text', text: '{"picked":true}' },
          { type: 'text', text: '{"picked":false}' },
        ],
      },
    };
    const result = unwrapMcpResponse(body);
    expect(result).toEqual({ picked: true });
  });

  it('returns original body for non-MCP body (plain object)', () => {
    const body = { status: 'ok', data: [1, 2, 3] };
    const result = unwrapMcpResponse(body);
    expect(result).toBe(body);
  });

  it('returns null as-is', () => {
    expect(unwrapMcpResponse(null)).toBeNull();
  });

  it('returns undefined as-is', () => {
    expect(unwrapMcpResponse(undefined)).toBeUndefined();
  });

  it('returns string as-is', () => {
    expect(unwrapMcpResponse('hello')).toBe('hello');
  });

  it('returns array as-is', () => {
    const arr = [1, 2, 3];
    expect(unwrapMcpResponse(arr)).toBe(arr);
  });

  it('returns original body for JSON-RPC error response', () => {
    const body = {
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32600, message: 'Invalid Request' },
    };
    const result = unwrapMcpResponse(body);
    expect(result).toBe(body);
  });

  it('returns original body when result is not an object', () => {
    const body = { jsonrpc: '2.0', id: 1, result: 'ok' };
    const result = unwrapMcpResponse(body);
    expect(result).toBe(body);
  });

  it('returns original body when result.content is not an array', () => {
    const body = { jsonrpc: '2.0', id: 1, result: { content: 'not-array' } };
    const result = unwrapMcpResponse(body);
    expect(result).toBe(body);
  });
});

// ---------------------------------------------------------------------------
// isMcpToolResponse
// ---------------------------------------------------------------------------

describe('isMcpToolResponse', () => {
  it('returns true for valid MCP tool response', () => {
    const body = makeMcpResponse('{"data":"value"}');
    expect(isMcpToolResponse(body)).toBe(true);
  });

  it('returns false for non-JSON-RPC body', () => {
    expect(isMcpToolResponse({ status: 'ok' })).toBe(false);
  });

  it('returns false without content array', () => {
    expect(isMcpToolResponse({ jsonrpc: '2.0', result: {} })).toBe(false);
  });

  it('returns false for null', () => {
    expect(isMcpToolResponse(null)).toBe(false);
  });

  it('returns false for array', () => {
    expect(isMcpToolResponse([1, 2])).toBe(false);
  });

  it('returns false when content has no text entries', () => {
    const body = {
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'image', data: 'abc' }] },
    };
    expect(isMcpToolResponse(body)).toBe(false);
  });

  it('returns false for JSON-RPC error response', () => {
    const body = {
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32600, message: 'Invalid' },
    };
    expect(isMcpToolResponse(body)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration: inferSchema on unwrapped MCP response
// ---------------------------------------------------------------------------

describe('inferSchema on unwrapped MCP response', () => {
  it('produces schema with actual fields, not MCP wrapper fields', () => {
    const mcpBody = makeMcpResponse(JSON.stringify({
      users: [{ id: 1, name: 'Alice', email: 'alice@example.com' }],
      total: 1,
    }));

    const unwrapped = unwrapMcpResponse(mcpBody);
    const schema = inferSchema(unwrapped);

    // Should have the actual payload fields
    expect(schema.type).toBe('object');
    expect(schema.properties).toBeDefined();
    expect(schema.properties!.users).toBeDefined();
    expect(schema.properties!.total).toBeDefined();

    // Should NOT have MCP wrapper fields
    expect(schema.properties!.jsonrpc).toBeUndefined();
    expect(schema.properties!.result).toBeUndefined();
    expect(schema.properties!.id).toBeUndefined();
  });

  it('falls back to wrapper schema for non-JSON text', () => {
    const mcpBody = makeMcpResponse('not json');
    const unwrapped = unwrapMcpResponse(mcpBody);
    const schema = inferSchema(unwrapped);

    // Should still have MCP wrapper fields since unwrap returned original
    expect(schema.properties!.jsonrpc).toBeDefined();
    expect(schema.properties!.result).toBeDefined();
  });
});
