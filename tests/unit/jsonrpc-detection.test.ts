/**
 * Tests for JSON-RPC detection, extraction, and v3 migration.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { getDatabase } from '../../src/storage/database.js';
import { SampleRepository } from '../../src/storage/samples.js';
import { SessionRepository } from '../../src/storage/sessions.js';
import { applyMigrations, getSchemaVersion, setSchemaVersion, MIGRATIONS } from '../../src/storage/migrations.js';
import {
  isJsonRpcSession,
  extractJsonRpcOperation,
  extractJsonRpcFromBody,
} from '../../src/analysis/jsonrpc.js';
import type { Sample, InferredSchema } from '../../src/types/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const dummyStats = { sampleCount: 1, firstObserved: '2024-01-01', lastObserved: '2024-01-01' };

function makeSample(overrides: Partial<Sample> = {}): Sample {
  return {
    id: 1,
    sessionId: 'sess-1',
    httpMethod: 'POST',
    path: '/api/v1/mcp',
    normalizedPath: '/api/v1/mcp',
    statusCode: 200,
    capturedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeJsonRpcSchema(method: string, toolName?: string): InferredSchema {
  const props: Record<string, InferredSchema> = {
    jsonrpc: { type: 'string', enum: ['2.0'], stats: dummyStats },
    method: { type: 'string', enum: [method], stats: dummyStats },
    id: { type: 'integer', stats: dummyStats },
  };

  if (toolName) {
    props.params = {
      type: 'object',
      properties: {
        name: { type: 'string', enum: [toolName], stats: dummyStats },
        arguments: { type: 'object', stats: dummyStats },
      },
      stats: dummyStats,
    };
  } else {
    props.params = { type: 'object', stats: dummyStats };
  }

  return { type: 'object', properties: props, stats: dummyStats };
}

// ---------------------------------------------------------------------------
// isJsonRpcSession
// ---------------------------------------------------------------------------

describe('isJsonRpcSession', () => {
  it('returns true for MCP-like samples with jsonrpcMethod set', () => {
    const samples = Array.from({ length: 10 }, (_, i) =>
      makeSample({
        id: i + 1,
        jsonrpcMethod: 'tools/call',
        jsonrpcTool: 'my_tool',
      }),
    );
    expect(isJsonRpcSession(samples)).toBe(true);
  });

  it('returns true when >80% of samples match via schema shape', () => {
    const jsonrpcSamples = Array.from({ length: 9 }, (_, i) =>
      makeSample({
        id: i + 1,
        requestSchema: makeJsonRpcSchema('tools/call', 'my_tool'),
      }),
    );
    const restSample = makeSample({
      id: 10,
      httpMethod: 'GET',
      path: '/users/123',
      normalizedPath: '/users/{userId}',
    });
    expect(isJsonRpcSession([...jsonrpcSamples, restSample])).toBe(true);
  });

  it('returns false for REST samples', () => {
    const samples = [
      makeSample({ id: 1, httpMethod: 'GET', path: '/users', normalizedPath: '/users' }),
      makeSample({ id: 2, httpMethod: 'POST', path: '/users', normalizedPath: '/users' }),
      makeSample({ id: 3, httpMethod: 'GET', path: '/users/1', normalizedPath: '/users/{userId}' }),
    ];
    expect(isJsonRpcSession(samples)).toBe(false);
  });

  it('returns false for empty sample set', () => {
    expect(isJsonRpcSession([])).toBe(false);
  });

  it('returns false when <80% of samples match', () => {
    const jsonrpcSamples = Array.from({ length: 3 }, (_, i) =>
      makeSample({
        id: i + 1,
        jsonrpcMethod: 'tools/call',
      }),
    );
    const restSamples = Array.from({ length: 7 }, (_, i) =>
      makeSample({
        id: i + 4,
        httpMethod: 'GET',
        path: `/endpoint/${i}`,
        normalizedPath: `/endpoint/{id}`,
      }),
    );
    expect(isJsonRpcSession([...jsonrpcSamples, ...restSamples])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractJsonRpcOperation
// ---------------------------------------------------------------------------

describe('extractJsonRpcOperation', () => {
  it('extracts tools/call with tool name from stored fields', () => {
    const sample = makeSample({
      jsonrpcMethod: 'tools/call',
      jsonrpcTool: 'cp_create_cluster',
    });
    const op = extractJsonRpcOperation(sample);
    expect(op).toEqual({
      rpcMethod: 'tools/call',
      toolName: 'cp_create_cluster',
      operationKey: 'tools/call:cp_create_cluster',
    });
  });

  it('extracts tools/list (no tool name) from stored fields', () => {
    const sample = makeSample({ jsonrpcMethod: 'tools/list' });
    const op = extractJsonRpcOperation(sample);
    expect(op).toEqual({
      rpcMethod: 'tools/list',
      toolName: undefined,
      operationKey: 'tools/list',
    });
  });

  it('extracts initialize from stored fields', () => {
    const sample = makeSample({ jsonrpcMethod: 'initialize' });
    const op = extractJsonRpcOperation(sample);
    expect(op).toEqual({
      rpcMethod: 'initialize',
      toolName: undefined,
      operationKey: 'initialize',
    });
  });

  it('falls back to schema extraction when stored fields are missing', () => {
    const sample = makeSample({
      requestSchema: makeJsonRpcSchema('tools/call', 'my_tool'),
    });
    const op = extractJsonRpcOperation(sample);
    expect(op).toEqual({
      rpcMethod: 'tools/call',
      toolName: 'my_tool',
      operationKey: 'tools/call:my_tool',
    });
  });

  it('extracts method from schema without tool name for non-tools/call', () => {
    const sample = makeSample({
      requestSchema: makeJsonRpcSchema('resources/list'),
    });
    const op = extractJsonRpcOperation(sample);
    expect(op).toEqual({
      rpcMethod: 'resources/list',
      toolName: undefined,
      operationKey: 'resources/list',
    });
  });

  it('returns undefined for non-JSON-RPC sample', () => {
    const sample = makeSample({
      httpMethod: 'GET',
      path: '/users',
      normalizedPath: '/users',
    });
    expect(extractJsonRpcOperation(sample)).toBeUndefined();
  });

  it('returns undefined when schema has no jsonrpc property', () => {
    const sample = makeSample({
      requestSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', stats: dummyStats },
          email: { type: 'string', stats: dummyStats },
        },
        stats: dummyStats,
      },
    });
    expect(extractJsonRpcOperation(sample)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// extractJsonRpcFromBody
// ---------------------------------------------------------------------------

describe('extractJsonRpcFromBody', () => {
  it('extracts method and tool from tools/call body', () => {
    const body = {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'cp_create_cluster', arguments: { region: 'us-west' } },
      id: 1,
    };
    expect(extractJsonRpcFromBody(body)).toEqual({
      method: 'tools/call',
      tool: 'cp_create_cluster',
    });
  });

  it('extracts method without tool for tools/list', () => {
    const body = { jsonrpc: '2.0', method: 'tools/list', id: 2 };
    expect(extractJsonRpcFromBody(body)).toEqual({
      method: 'tools/list',
      tool: undefined,
    });
  });

  it('extracts initialize method', () => {
    const body = {
      jsonrpc: '2.0',
      method: 'initialize',
      params: { protocolVersion: '2024-11-05' },
      id: 0,
    };
    expect(extractJsonRpcFromBody(body)).toEqual({
      method: 'initialize',
      tool: undefined,
    });
  });

  it('returns undefined for non-JSON-RPC body', () => {
    expect(extractJsonRpcFromBody({ name: 'test', email: 'a@b.com' })).toBeUndefined();
  });

  it('returns undefined for null/undefined', () => {
    expect(extractJsonRpcFromBody(null)).toBeUndefined();
    expect(extractJsonRpcFromBody(undefined)).toBeUndefined();
  });

  it('returns undefined for arrays', () => {
    expect(extractJsonRpcFromBody([1, 2, 3])).toBeUndefined();
  });

  it('returns undefined when jsonrpc version is missing', () => {
    expect(extractJsonRpcFromBody({ method: 'tools/call' })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// v3 migration
// ---------------------------------------------------------------------------

describe('v3 migration — jsonrpc columns', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = getDatabase(':memory:');
  });

  it('adds jsonrpc_method and jsonrpc_tool columns to samples table', () => {
    // Columns should exist after full migration
    const info = db.prepare('PRAGMA table_info(samples)').all() as Array<{ name: string }>;
    const columnNames = info.map((c) => c.name);
    expect(columnNames).toContain('jsonrpc_method');
    expect(columnNames).toContain('jsonrpc_tool');
  });

  it('schema version is 3 after full migration', () => {
    expect(getSchemaVersion(db)).toBe(MIGRATIONS.length);
    expect(getSchemaVersion(db)).toBe(3);
  });

  it('v2 database upgrades to v3 correctly', () => {
    // Create a fresh in-memory db, apply only v1+v2
    const testDb = new Database(':memory:');
    MIGRATIONS[0].up(testDb);
    MIGRATIONS[1].up(testDb);
    setSchemaVersion(testDb, 2);

    // Apply remaining migrations
    applyMigrations(testDb);
    expect(getSchemaVersion(testDb)).toBe(3);

    const info = testDb.prepare('PRAGMA table_info(samples)').all() as Array<{ name: string }>;
    const columnNames = info.map((c) => c.name);
    expect(columnNames).toContain('jsonrpc_method');
    expect(columnNames).toContain('jsonrpc_tool');
    testDb.close();
  });
});

// ---------------------------------------------------------------------------
// SampleRepository with JSON-RPC fields
// ---------------------------------------------------------------------------

describe('SampleRepository with JSON-RPC fields', () => {
  let db: Database.Database;
  let sampleRepo: SampleRepository;
  let sessionId: string;

  beforeEach(() => {
    db = getDatabase(':memory:');
    const sessions = new SessionRepository(db);
    const session = sessions.createSession('https://api.example.com', 8080);
    sessionId = session.id;
    sampleRepo = new SampleRepository(db);
  });

  it('stores and retrieves jsonrpcMethod and jsonrpcTool', () => {
    sampleRepo.insertSample({
      sessionId,
      httpMethod: 'POST',
      path: '/api/v1/mcp',
      normalizedPath: '/api/v1/mcp',
      statusCode: 200,
      capturedAt: '2024-01-01T00:00:00Z',
      jsonrpcMethod: 'tools/call',
      jsonrpcTool: 'cp_create_cluster',
    });

    const samples = sampleRepo.listBySession(sessionId);
    expect(samples).toHaveLength(1);
    expect(samples[0].jsonrpcMethod).toBe('tools/call');
    expect(samples[0].jsonrpcTool).toBe('cp_create_cluster');
  });

  it('stores undefined jsonrpc fields as null', () => {
    sampleRepo.insertSample({
      sessionId,
      httpMethod: 'GET',
      path: '/users',
      normalizedPath: '/users',
      statusCode: 200,
      capturedAt: '2024-01-01T00:00:00Z',
    });

    const samples = sampleRepo.listBySession(sessionId);
    expect(samples).toHaveLength(1);
    expect(samples[0].jsonrpcMethod).toBeUndefined();
    expect(samples[0].jsonrpcTool).toBeUndefined();
  });

  it('stores jsonrpcMethod without jsonrpcTool', () => {
    sampleRepo.insertSample({
      sessionId,
      httpMethod: 'POST',
      path: '/api/v1/mcp',
      normalizedPath: '/api/v1/mcp',
      statusCode: 200,
      capturedAt: '2024-01-01T00:00:00Z',
      jsonrpcMethod: 'tools/list',
    });

    const samples = sampleRepo.listBySession(sessionId);
    expect(samples[0].jsonrpcMethod).toBe('tools/list');
    expect(samples[0].jsonrpcTool).toBeUndefined();
  });
});
