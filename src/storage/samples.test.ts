import { describe, it, expect, beforeEach } from 'vitest';
import { getDatabase } from './database.js';
import { SessionRepository } from './sessions.js';
import { SampleRepository } from './samples.js';
import type { InferredSchema, HeaderEntry } from '../types/index.js';
import type Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------


const OBJECT_SCHEMA: InferredSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer', stats: { sampleCount: 1, presenceCount: 1, confidence: 1.0 } },
    name: { type: 'string', stats: { sampleCount: 1, presenceCount: 1, confidence: 1.0 } },
  },
  required: ['id', 'name'],
  stats: { sampleCount: 1, presenceCount: 1, confidence: 1.0 },
};

const REQ_HEADERS: HeaderEntry[] = [
  { name: 'Content-Type', example: 'application/json' },
  { name: 'Authorization', example: 'Bearer ***' },
];

const RESP_HEADERS: HeaderEntry[] = [{ name: 'X-Request-Id', example: 'abc-123' }];

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let db: Database.Database;
let sessions: SessionRepository;
let samples: SampleRepository;
let sessionId: string;

beforeEach(() => {
  db = getDatabase(':memory:');
  sessions = new SessionRepository(db);
  samples = new SampleRepository(db);
  sessionId = sessions.createSession('https://api.example.com', 8080).id;
});

// ---------------------------------------------------------------------------
// insertSample
// ---------------------------------------------------------------------------

describe('insertSample', () => {
  it('returns a positive integer id', () => {
    const id = samples.insertSample({
      sessionId,
      httpMethod: 'GET',
      path: '/users/1',
      normalizedPath: '/users/{userId}',
      capturedAt: new Date().toISOString(),
    });
    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);
  });

  it('assigns distinct ids to successive inserts', () => {
    const now = new Date().toISOString();
    const id1 = samples.insertSample({
      sessionId,
      httpMethod: 'GET',
      path: '/users/1',
      normalizedPath: '/users/{userId}',
      capturedAt: now,
    });
    const id2 = samples.insertSample({
      sessionId,
      httpMethod: 'GET',
      path: '/users/2',
      normalizedPath: '/users/{userId}',
      capturedAt: now,
    });
    expect(id1).not.toBe(id2);
  });

  it('stores and deserializes requestSchema as JSON', () => {
    const id = samples.insertSample({
      sessionId,
      httpMethod: 'POST',
      path: '/users',
      normalizedPath: '/users',
      requestSchema: OBJECT_SCHEMA,
      capturedAt: new Date().toISOString(),
    });
    const list = samples.listBySession(sessionId);
    const sample = list.find((s) => s.id === id);
    expect(sample!.requestSchema).toEqual(OBJECT_SCHEMA);
  });

  it('stores and deserializes responseSchema as JSON', () => {
    const id = samples.insertSample({
      sessionId,
      httpMethod: 'GET',
      path: '/users/1',
      normalizedPath: '/users/{userId}',
      responseSchema: OBJECT_SCHEMA,
      capturedAt: new Date().toISOString(),
    });
    const list = samples.listBySession(sessionId);
    const sample = list.find((s) => s.id === id);
    expect(sample!.responseSchema).toEqual(OBJECT_SCHEMA);
  });

  it('stores and deserializes headers as JSON', () => {
    const id = samples.insertSample({
      sessionId,
      httpMethod: 'POST',
      path: '/users',
      normalizedPath: '/users',
      requestHeaders: REQ_HEADERS,
      responseHeaders: RESP_HEADERS,
      capturedAt: new Date().toISOString(),
    });
    const list = samples.listBySession(sessionId);
    const sample = list.find((s) => s.id === id);
    expect(sample!.requestHeaders).toEqual(REQ_HEADERS);
    expect(sample!.responseHeaders).toEqual(RESP_HEADERS);
  });

  it('stores and deserializes queryParams as JSON', () => {
    const queryParams = { page: '1', limit: '10' };
    const id = samples.insertSample({
      sessionId,
      httpMethod: 'GET',
      path: '/users?page=1&limit=10',
      normalizedPath: '/users',
      queryParams,
      capturedAt: new Date().toISOString(),
    });
    const list = samples.listBySession(sessionId);
    const sample = list.find((s) => s.id === id);
    expect(sample!.queryParams).toEqual(queryParams);
  });

  it('handles null/undefined optional fields gracefully', () => {
    const id = samples.insertSample({
      sessionId,
      httpMethod: 'GET',
      path: '/health',
      normalizedPath: '/health',
      capturedAt: new Date().toISOString(),
    });
    const list = samples.listBySession(sessionId);
    const sample = list.find((s) => s.id === id)!;
    expect(sample.requestSchema).toBeUndefined();
    expect(sample.responseSchema).toBeUndefined();
    expect(sample.requestHeaders).toBeUndefined();
    expect(sample.responseHeaders).toBeUndefined();
    expect(sample.queryParams).toBeUndefined();
    expect(sample.statusCode).toBeUndefined();
  });

  it('stores statusCode', () => {
    const id = samples.insertSample({
      sessionId,
      httpMethod: 'GET',
      path: '/users/1',
      normalizedPath: '/users/{userId}',
      statusCode: 200,
      capturedAt: new Date().toISOString(),
    });
    const list = samples.listBySession(sessionId);
    const sample = list.find((s) => s.id === id)!;
    expect(sample.statusCode).toBe(200);
  });

  it('stores a complex nested schema (oneOf)', () => {
    const oneOfSchema: InferredSchema = {
      type: 'string', // ignored when oneOf present
      oneOf: [
        { type: 'null', stats: { sampleCount: 5, presenceCount: 2, confidence: 0.4 } },
        {
          type: 'string',
          format: 'uuid',
          stats: { sampleCount: 5, presenceCount: 3, confidence: 0.6 },
        },
      ],
      stats: { sampleCount: 5, presenceCount: 5, confidence: 1.0 },
    };
    const id = samples.insertSample({
      sessionId,
      httpMethod: 'GET',
      path: '/items/1',
      normalizedPath: '/items/{itemId}',
      responseSchema: oneOfSchema,
      capturedAt: new Date().toISOString(),
    });
    const list = samples.listBySession(sessionId);
    const sample = list.find((s) => s.id === id)!;
    expect(sample.responseSchema).toEqual(oneOfSchema);
  });
});

// ---------------------------------------------------------------------------
// listBySession
// ---------------------------------------------------------------------------

describe('listBySession', () => {
  it('returns empty array when no samples', () => {
    expect(samples.listBySession(sessionId)).toEqual([]);
  });

  it('returns all samples for the session', () => {
    const now = new Date().toISOString();
    samples.insertSample({
      sessionId,
      httpMethod: 'GET',
      path: '/a',
      normalizedPath: '/a',
      capturedAt: now,
    });
    samples.insertSample({
      sessionId,
      httpMethod: 'POST',
      path: '/b',
      normalizedPath: '/b',
      capturedAt: now,
    });
    expect(samples.listBySession(sessionId)).toHaveLength(2);
  });

  it('does not return samples from other sessions', () => {
    const otherId = sessions.createSession('https://other.example.com', 9090).id;
    const now = new Date().toISOString();
    samples.insertSample({
      sessionId: otherId,
      httpMethod: 'GET',
      path: '/other',
      normalizedPath: '/other',
      capturedAt: now,
    });
    samples.insertSample({
      sessionId,
      httpMethod: 'GET',
      path: '/mine',
      normalizedPath: '/mine',
      capturedAt: now,
    });
    expect(samples.listBySession(sessionId)).toHaveLength(1);
    expect(samples.listBySession(sessionId)[0].path).toBe('/mine');
  });

  it('returns samples ordered by captured_at ascending', () => {
    samples.insertSample({
      sessionId,
      httpMethod: 'GET',
      path: '/first',
      normalizedPath: '/first',
      capturedAt: '2026-01-01T10:00:00.000Z',
    });
    samples.insertSample({
      sessionId,
      httpMethod: 'GET',
      path: '/second',
      normalizedPath: '/second',
      capturedAt: '2026-01-01T11:00:00.000Z',
    });
    const list = samples.listBySession(sessionId);
    expect(list[0].path).toBe('/first');
    expect(list[1].path).toBe('/second');
  });
});

// ---------------------------------------------------------------------------
// listByEndpoint
// ---------------------------------------------------------------------------

describe('listByEndpoint', () => {
  it('returns empty array when no matching samples', () => {
    expect(samples.listByEndpoint(sessionId, 'GET', '/users/{userId}')).toEqual([]);
  });

  it('returns only samples matching method and normalized path', () => {
    const now = new Date().toISOString();
    samples.insertSample({
      sessionId,
      httpMethod: 'GET',
      path: '/users/1',
      normalizedPath: '/users/{userId}',
      capturedAt: now,
    });
    samples.insertSample({
      sessionId,
      httpMethod: 'GET',
      path: '/users/2',
      normalizedPath: '/users/{userId}',
      capturedAt: now,
    });
    samples.insertSample({
      sessionId,
      httpMethod: 'POST',
      path: '/users',
      normalizedPath: '/users',
      capturedAt: now,
    });
    const result = samples.listByEndpoint(sessionId, 'GET', '/users/{userId}');
    expect(result).toHaveLength(2);
    result.forEach((s) => {
      expect(s.httpMethod).toBe('GET');
      expect(s.normalizedPath).toBe('/users/{userId}');
    });
  });

  it('excludes samples from other sessions', () => {
    const otherId = sessions.createSession('https://other.example.com', 9090).id;
    const now = new Date().toISOString();
    samples.insertSample({
      sessionId: otherId,
      httpMethod: 'GET',
      path: '/users/1',
      normalizedPath: '/users/{userId}',
      capturedAt: now,
    });
    const result = samples.listByEndpoint(sessionId, 'GET', '/users/{userId}');
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// groupByEndpoint
// ---------------------------------------------------------------------------

describe('groupByEndpoint', () => {
  it('returns empty map when no samples', () => {
    expect(samples.groupByEndpoint(sessionId).size).toBe(0);
  });

  it('groups samples by METHOD /path STATUS', () => {
    const now = new Date().toISOString();
    samples.insertSample({
      sessionId,
      httpMethod: 'GET',
      path: '/users/1',
      normalizedPath: '/users/{userId}',
      statusCode: 200,
      capturedAt: now,
    });
    samples.insertSample({
      sessionId,
      httpMethod: 'GET',
      path: '/users/2',
      normalizedPath: '/users/{userId}',
      statusCode: 200,
      capturedAt: now,
    });
    samples.insertSample({
      sessionId,
      httpMethod: 'GET',
      path: '/users/3',
      normalizedPath: '/users/{userId}',
      statusCode: 404,
      capturedAt: now,
    });
    samples.insertSample({
      sessionId,
      httpMethod: 'POST',
      path: '/users',
      normalizedPath: '/users',
      statusCode: 201,
      capturedAt: now,
    });

    const groups = samples.groupByEndpoint(sessionId);
    expect(groups.size).toBe(3);
    expect(groups.get('GET /users/{userId} 200')).toHaveLength(2);
    expect(groups.get('GET /users/{userId} 404')).toHaveLength(1);
    expect(groups.get('POST /users 201')).toHaveLength(1);
  });

  it('uses "unknown" for missing status codes', () => {
    const now = new Date().toISOString();
    samples.insertSample({
      sessionId,
      httpMethod: 'GET',
      path: '/health',
      normalizedPath: '/health',
      capturedAt: now,
    });
    const groups = samples.groupByEndpoint(sessionId);
    expect(groups.has('GET /health unknown')).toBe(true);
  });

  it('only includes samples from the specified session', () => {
    const otherId = sessions.createSession('https://other.example.com', 9090).id;
    const now = new Date().toISOString();
    samples.insertSample({
      sessionId: otherId,
      httpMethod: 'GET',
      path: '/users/1',
      normalizedPath: '/users/{userId}',
      statusCode: 200,
      capturedAt: now,
    });
    expect(samples.groupByEndpoint(sessionId).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// countBySession
// ---------------------------------------------------------------------------

describe('countBySession', () => {
  it('returns 0 when no samples', () => {
    expect(samples.countBySession(sessionId)).toBe(0);
  });

  it('returns correct count', () => {
    const now = new Date().toISOString();
    samples.insertSample({
      sessionId,
      httpMethod: 'GET',
      path: '/a',
      normalizedPath: '/a',
      capturedAt: now,
    });
    samples.insertSample({
      sessionId,
      httpMethod: 'GET',
      path: '/b',
      normalizedPath: '/b',
      capturedAt: now,
    });
    expect(samples.countBySession(sessionId)).toBe(2);
  });

  it('does not count samples from other sessions', () => {
    const otherId = sessions.createSession('https://other.example.com', 9090).id;
    const now = new Date().toISOString();
    samples.insertSample({
      sessionId: otherId,
      httpMethod: 'GET',
      path: '/other',
      normalizedPath: '/other',
      capturedAt: now,
    });
    expect(samples.countBySession(sessionId)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// listByJsonRpcMethod
// ---------------------------------------------------------------------------

describe('listByJsonRpcMethod', () => {
  it('returns empty array when no matching samples', () => {
    expect(samples.listByJsonRpcMethod(sessionId, 'tools/list')).toEqual([]);
  });

  it('returns only samples matching the jsonrpc_method', () => {
    const now = new Date().toISOString();
    samples.insertSample({
      sessionId,
      httpMethod: 'POST',
      path: '/mcp',
      normalizedPath: '/mcp',
      jsonrpcMethod: 'tools/list',
      capturedAt: now,
    });
    samples.insertSample({
      sessionId,
      httpMethod: 'POST',
      path: '/mcp',
      normalizedPath: '/mcp',
      jsonrpcMethod: 'tools/call',
      capturedAt: now,
    });
    samples.insertSample({
      sessionId,
      httpMethod: 'POST',
      path: '/mcp',
      normalizedPath: '/mcp',
      jsonrpcMethod: 'tools/list',
      capturedAt: now,
    });

    const result = samples.listByJsonRpcMethod(sessionId, 'tools/list');
    expect(result).toHaveLength(2);
    result.forEach((s) => {
      expect(s.jsonrpcMethod).toBe('tools/list');
    });
  });

  it('excludes samples from other sessions', () => {
    const otherId = sessions.createSession('https://other.example.com', 9090).id;
    const now = new Date().toISOString();
    samples.insertSample({
      sessionId: otherId,
      httpMethod: 'POST',
      path: '/mcp',
      normalizedPath: '/mcp',
      jsonrpcMethod: 'tools/list',
      capturedAt: now,
    });
    expect(samples.listByJsonRpcMethod(sessionId, 'tools/list')).toHaveLength(0);
  });

  it('returns samples ordered by captured_at ascending', () => {
    samples.insertSample({
      sessionId,
      httpMethod: 'POST',
      path: '/mcp',
      normalizedPath: '/mcp',
      jsonrpcMethod: 'tools/call',
      capturedAt: '2026-01-01T10:00:00.000Z',
    });
    samples.insertSample({
      sessionId,
      httpMethod: 'POST',
      path: '/mcp',
      normalizedPath: '/mcp',
      jsonrpcMethod: 'tools/call',
      capturedAt: '2026-01-01T09:00:00.000Z',
    });

    const result = samples.listByJsonRpcMethod(sessionId, 'tools/call');
    expect(result[0].capturedAt).toBe('2026-01-01T09:00:00.000Z');
    expect(result[1].capturedAt).toBe('2026-01-01T10:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// Cascade delete
// ---------------------------------------------------------------------------

describe('cascade delete', () => {
  it('deletes samples when session is deleted', () => {
    const now = new Date().toISOString();
    samples.insertSample({
      sessionId,
      httpMethod: 'GET',
      path: '/users',
      normalizedPath: '/users',
      capturedAt: now,
    });
    const sessionRepo = new SessionRepository(db);
    sessionRepo.deleteSession(sessionId);
    expect(samples.countBySession(sessionId)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Realistic data round-trip
// ---------------------------------------------------------------------------

describe('realistic sample round-trip', () => {
  it('stores and retrieves a full POST /users request/response pair', () => {
    const requestSchema: InferredSchema = {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          format: 'email',
          stats: { sampleCount: 1, presenceCount: 1, confidence: 1.0 },
        },
        name: {
          type: 'string',
          stats: { sampleCount: 1, presenceCount: 1, confidence: 1.0 },
        },
      },
      required: ['email', 'name'],
      stats: { sampleCount: 1, presenceCount: 1, confidence: 1.0 },
    };

    const responseSchema: InferredSchema = {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          format: 'uuid',
          stats: { sampleCount: 1, presenceCount: 1, confidence: 1.0 },
        },
        email: {
          type: 'string',
          format: 'email',
          stats: { sampleCount: 1, presenceCount: 1, confidence: 1.0 },
        },
        name: {
          type: 'string',
          stats: { sampleCount: 1, presenceCount: 1, confidence: 1.0 },
        },
        createdAt: {
          type: 'string',
          format: 'date-time',
          stats: { sampleCount: 1, presenceCount: 1, confidence: 1.0 },
        },
      },
      required: ['id', 'email', 'name', 'createdAt'],
      stats: { sampleCount: 1, presenceCount: 1, confidence: 1.0 },
    };

    const capturedAt = '2026-03-10T16:00:00.000Z';

    const id = samples.insertSample({
      sessionId,
      httpMethod: 'POST',
      path: '/users',
      normalizedPath: '/users',
      statusCode: 201,
      queryParams: undefined,
      requestSchema,
      responseSchema,
      requestHeaders: [{ name: 'Content-Type', example: 'application/json' }],
      responseHeaders: [{ name: 'Location', example: '/users/abc-123' }],
      capturedAt,
    });

    const list = samples.listBySession(sessionId);
    expect(list).toHaveLength(1);

    const s = list[0];
    expect(s.id).toBe(id);
    expect(s.sessionId).toBe(sessionId);
    expect(s.httpMethod).toBe('POST');
    expect(s.path).toBe('/users');
    expect(s.normalizedPath).toBe('/users');
    expect(s.statusCode).toBe(201);
    expect(s.capturedAt).toBe(capturedAt);
    expect(s.requestSchema).toEqual(requestSchema);
    expect(s.responseSchema).toEqual(responseSchema);
    expect(s.requestHeaders).toEqual([{ name: 'Content-Type', example: 'application/json' }]);
    expect(s.responseHeaders).toEqual([{ name: 'Location', example: '/users/abc-123' }]);
  });
});
