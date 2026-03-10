import { describe, it, expect, beforeEach } from 'vitest';
import { getDatabase } from './database.js';
import { SessionRepository } from './sessions.js';
import { AggregatedSchemaRepository } from './schemas.js';
import type { InferredSchema, HeaderEntry, BreakingChange } from '../types/index.js';
import type Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OBJECT_SCHEMA: InferredSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer', stats: { sampleCount: 5, presenceCount: 5, confidence: 1.0 } },
    name: { type: 'string', stats: { sampleCount: 5, presenceCount: 5, confidence: 1.0 } },
    email: {
      type: 'string',
      format: 'email',
      stats: { sampleCount: 5, presenceCount: 4, confidence: 0.8 },
    },
  },
  required: ['id', 'name'],
  stats: { sampleCount: 5, presenceCount: 5, confidence: 1.0 },
};

const RESPONSE_SCHEMAS: Record<string, InferredSchema> = {
  '200': OBJECT_SCHEMA,
  '404': {
    type: 'object',
    properties: {
      error: { type: 'string', stats: { sampleCount: 2, presenceCount: 2, confidence: 1.0 } },
    },
    required: ['error'],
    stats: { sampleCount: 2, presenceCount: 2, confidence: 1.0 },
  },
};

const REQ_HEADERS: HeaderEntry[] = [
  { name: 'Authorization', example: 'Bearer ***' },
  { name: 'Content-Type', example: 'application/json' },
];

const RESP_HEADERS: HeaderEntry[] = [{ name: 'X-Request-Id', example: 'req-abc-123' }];

const BREAKING_CHANGES: BreakingChange[] = [
  {
    type: 'required_field_removed',
    path: '$.email',
    description: 'Required field "email" was removed',
    oldValue: 'string',
  },
];

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let db: Database.Database;
let sessions: SessionRepository;
let schemas: AggregatedSchemaRepository;
let sessionId: string;

beforeEach(() => {
  db = getDatabase(':memory:');
  sessions = new SessionRepository(db);
  schemas = new AggregatedSchemaRepository(db);
  sessionId = sessions.createSession('https://api.example.com', 8080).id;
});

// ---------------------------------------------------------------------------
// insertAggregated
// ---------------------------------------------------------------------------

describe('insertAggregated', () => {
  it('returns a positive integer id', () => {
    const now = new Date().toISOString();
    const id = schemas.insertAggregated({
      sessionId,
      httpMethod: 'GET',
      path: '/users/{userId}',
      version: 1,
      sampleCount: 5,
      confidenceScore: 0.85,
      firstObserved: now,
      lastObserved: now,
    });
    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);
  });

  it('serializes and deserializes requestSchema', () => {
    const now = new Date().toISOString();
    schemas.insertAggregated({
      sessionId,
      httpMethod: 'POST',
      path: '/users',
      version: 1,
      requestSchema: OBJECT_SCHEMA,
      sampleCount: 5,
      confidenceScore: 0.9,
      firstObserved: now,
      lastObserved: now,
    });
    const list = schemas.listBySession(sessionId);
    expect(list[0].requestSchema).toEqual(OBJECT_SCHEMA);
  });

  it('serializes and deserializes responseSchemas', () => {
    const now = new Date().toISOString();
    schemas.insertAggregated({
      sessionId,
      httpMethod: 'GET',
      path: '/users/{userId}',
      version: 1,
      responseSchemas: RESPONSE_SCHEMAS,
      sampleCount: 7,
      confidenceScore: 0.8,
      firstObserved: now,
      lastObserved: now,
    });
    const list = schemas.listBySession(sessionId);
    expect(list[0].responseSchemas).toEqual(RESPONSE_SCHEMAS);
  });

  it('serializes and deserializes requestHeaders and responseHeaders', () => {
    const now = new Date().toISOString();
    schemas.insertAggregated({
      sessionId,
      httpMethod: 'GET',
      path: '/users',
      version: 1,
      requestHeaders: REQ_HEADERS,
      responseHeaders: RESP_HEADERS,
      sampleCount: 3,
      confidenceScore: 0.7,
      firstObserved: now,
      lastObserved: now,
    });
    const list = schemas.listBySession(sessionId);
    expect(list[0].requestHeaders).toEqual(REQ_HEADERS);
    expect(list[0].responseHeaders).toEqual(RESP_HEADERS);
  });

  it('serializes and deserializes breakingChanges', () => {
    const now = new Date().toISOString();
    schemas.insertAggregated({
      sessionId,
      httpMethod: 'GET',
      path: '/users/{userId}',
      version: 2,
      breakingChanges: BREAKING_CHANGES,
      sampleCount: 10,
      confidenceScore: 0.95,
      firstObserved: now,
      lastObserved: now,
    });
    const list = schemas.listBySession(sessionId);
    expect(list[0].breakingChanges).toEqual(BREAKING_CHANGES);
  });

  it('stores previousSessionId', () => {
    const prevSession = sessions.createSession('https://api.example.com', 8080);
    const now = new Date().toISOString();
    schemas.insertAggregated({
      sessionId,
      httpMethod: 'GET',
      path: '/users',
      version: 2,
      previousSessionId: prevSession.id,
      sampleCount: 5,
      confidenceScore: 0.8,
      firstObserved: now,
      lastObserved: now,
    });
    const list = schemas.listBySession(sessionId);
    expect(list[0].previousSessionId).toBe(prevSession.id);
  });

  it('handles null optional fields gracefully', () => {
    const now = new Date().toISOString();
    schemas.insertAggregated({
      sessionId,
      httpMethod: 'DELETE',
      path: '/users/{userId}',
      version: 1,
      sampleCount: 2,
      confidenceScore: 0.5,
      firstObserved: now,
      lastObserved: now,
    });
    const list = schemas.listBySession(sessionId);
    const s = list[0];
    expect(s.requestSchema).toBeUndefined();
    expect(s.responseSchemas).toBeUndefined();
    expect(s.requestHeaders).toBeUndefined();
    expect(s.responseHeaders).toBeUndefined();
    expect(s.breakingChanges).toBeUndefined();
    expect(s.previousSessionId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// listBySession
// ---------------------------------------------------------------------------

describe('listBySession', () => {
  it('returns empty array when no schemas', () => {
    expect(schemas.listBySession(sessionId)).toEqual([]);
  });

  it('returns all schemas for the session', () => {
    const now = new Date().toISOString();
    schemas.insertAggregated({
      sessionId,
      httpMethod: 'GET',
      path: '/users',
      version: 1,
      sampleCount: 5,
      confidenceScore: 0.8,
      firstObserved: now,
      lastObserved: now,
    });
    schemas.insertAggregated({
      sessionId,
      httpMethod: 'POST',
      path: '/users',
      version: 1,
      sampleCount: 3,
      confidenceScore: 0.7,
      firstObserved: now,
      lastObserved: now,
    });
    expect(schemas.listBySession(sessionId)).toHaveLength(2);
  });

  it('does not return schemas from other sessions', () => {
    const otherId = sessions.createSession('https://other.example.com', 9090).id;
    const now = new Date().toISOString();
    schemas.insertAggregated({
      sessionId: otherId,
      httpMethod: 'GET',
      path: '/items',
      version: 1,
      sampleCount: 1,
      confidenceScore: 0.5,
      firstObserved: now,
      lastObserved: now,
    });
    expect(schemas.listBySession(sessionId)).toHaveLength(0);
  });

  it('returns schemas ordered by path ASC then http_method ASC', () => {
    const now = new Date().toISOString();
    schemas.insertAggregated({
      sessionId,
      httpMethod: 'POST',
      path: '/users',
      version: 1,
      sampleCount: 2,
      confidenceScore: 0.7,
      firstObserved: now,
      lastObserved: now,
    });
    schemas.insertAggregated({
      sessionId,
      httpMethod: 'GET',
      path: '/users',
      version: 1,
      sampleCount: 5,
      confidenceScore: 0.8,
      firstObserved: now,
      lastObserved: now,
    });
    schemas.insertAggregated({
      sessionId,
      httpMethod: 'GET',
      path: '/articles',
      version: 1,
      sampleCount: 3,
      confidenceScore: 0.6,
      firstObserved: now,
      lastObserved: now,
    });
    const list = schemas.listBySession(sessionId);
    expect(list[0].path).toBe('/articles');
    expect(list[1].path).toBe('/users');
    expect(list[1].httpMethod).toBe('GET');
    expect(list[2].path).toBe('/users');
    expect(list[2].httpMethod).toBe('POST');
  });
});

// ---------------------------------------------------------------------------
// getLatestForEndpoint
// ---------------------------------------------------------------------------

describe('getLatestForEndpoint', () => {
  it('returns null when no matching schema exists', () => {
    expect(schemas.getLatestForEndpoint('GET', '/users')).toBeNull();
  });

  it('returns the schema for a matching endpoint', () => {
    const now = new Date().toISOString();
    schemas.insertAggregated({
      sessionId,
      httpMethod: 'GET',
      path: '/users',
      version: 1,
      sampleCount: 5,
      confidenceScore: 0.8,
      firstObserved: now,
      lastObserved: now,
    });
    const result = schemas.getLatestForEndpoint('GET', '/users');
    expect(result).not.toBeNull();
    expect(result!.httpMethod).toBe('GET');
    expect(result!.path).toBe('/users');
  });

  it('returns the most recent schema across sessions (by created_at)', () => {
    const session2Id = sessions.createSession('https://api.example.com', 8081).id;
    const t1 = '2026-01-01T10:00:00.000Z';
    const t2 = '2026-01-02T10:00:00.000Z';

    schemas.insertAggregated({
      sessionId,
      httpMethod: 'GET',
      path: '/users',
      version: 1,
      sampleCount: 3,
      confidenceScore: 0.6,
      firstObserved: t1,
      lastObserved: t1,
      createdAt: t1,
    });
    schemas.insertAggregated({
      sessionId: session2Id,
      httpMethod: 'GET',
      path: '/users',
      version: 2,
      sampleCount: 10,
      confidenceScore: 0.9,
      firstObserved: t2,
      lastObserved: t2,
      createdAt: t2,
    });

    const result = schemas.getLatestForEndpoint('GET', '/users');
    expect(result!.version).toBe(2);
    expect(result!.sessionId).toBe(session2Id);
  });

  it('does not match on different method', () => {
    const now = new Date().toISOString();
    schemas.insertAggregated({
      sessionId,
      httpMethod: 'POST',
      path: '/users',
      version: 1,
      sampleCount: 2,
      confidenceScore: 0.5,
      firstObserved: now,
      lastObserved: now,
    });
    expect(schemas.getLatestForEndpoint('GET', '/users')).toBeNull();
  });

  it('does not match on different path', () => {
    const now = new Date().toISOString();
    schemas.insertAggregated({
      sessionId,
      httpMethod: 'GET',
      path: '/orders',
      version: 1,
      sampleCount: 2,
      confidenceScore: 0.5,
      firstObserved: now,
      lastObserved: now,
    });
    expect(schemas.getLatestForEndpoint('GET', '/users')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getBySessionEndpoint
// ---------------------------------------------------------------------------

describe('getBySessionEndpoint', () => {
  it('returns null when no matching schema', () => {
    expect(schemas.getBySessionEndpoint(sessionId, 'GET', '/users')).toBeNull();
  });

  it('returns the schema matching session, method and path', () => {
    const now = new Date().toISOString();
    schemas.insertAggregated({
      sessionId,
      httpMethod: 'GET',
      path: '/users',
      version: 1,
      sampleCount: 5,
      confidenceScore: 0.8,
      firstObserved: now,
      lastObserved: now,
    });
    const result = schemas.getBySessionEndpoint(sessionId, 'GET', '/users');
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe(sessionId);
    expect(result!.httpMethod).toBe('GET');
    expect(result!.path).toBe('/users');
  });

  it('does not return schema from a different session', () => {
    const otherId = sessions.createSession('https://other.example.com', 9090).id;
    const now = new Date().toISOString();
    schemas.insertAggregated({
      sessionId: otherId,
      httpMethod: 'GET',
      path: '/users',
      version: 1,
      sampleCount: 3,
      confidenceScore: 0.7,
      firstObserved: now,
      lastObserved: now,
    });
    expect(schemas.getBySessionEndpoint(sessionId, 'GET', '/users')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Cascade delete
// ---------------------------------------------------------------------------

describe('cascade delete', () => {
  it('deletes aggregated schemas when session is deleted', () => {
    const now = new Date().toISOString();
    schemas.insertAggregated({
      sessionId,
      httpMethod: 'GET',
      path: '/users',
      version: 1,
      sampleCount: 5,
      confidenceScore: 0.8,
      firstObserved: now,
      lastObserved: now,
    });
    sessions.deleteSession(sessionId);
    expect(schemas.listBySession(sessionId)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Full round-trip with all fields
// ---------------------------------------------------------------------------

describe('full round-trip', () => {
  it('persists and retrieves all fields correctly', () => {
    const prevSession = sessions.createSession('https://api.example.com', 8080);
    const firstObserved = '2026-03-10T09:00:00.000Z';
    const lastObserved = '2026-03-10T16:00:00.000Z';

    const insertedId = schemas.insertAggregated({
      sessionId,
      httpMethod: 'GET',
      path: '/users/{userId}',
      version: 3,
      requestSchema: OBJECT_SCHEMA,
      responseSchemas: RESPONSE_SCHEMAS,
      requestHeaders: REQ_HEADERS,
      responseHeaders: RESP_HEADERS,
      sampleCount: 47,
      confidenceScore: 0.95,
      breakingChanges: BREAKING_CHANGES,
      previousSessionId: prevSession.id,
      firstObserved,
      lastObserved,
    });

    const result = schemas.getBySessionEndpoint(sessionId, 'GET', '/users/{userId}');
    expect(result).not.toBeNull();
    const s = result!;

    expect(s.id).toBe(insertedId);
    expect(s.sessionId).toBe(sessionId);
    expect(s.httpMethod).toBe('GET');
    expect(s.path).toBe('/users/{userId}');
    expect(s.version).toBe(3);
    expect(s.requestSchema).toEqual(OBJECT_SCHEMA);
    expect(s.responseSchemas).toEqual(RESPONSE_SCHEMAS);
    expect(s.requestHeaders).toEqual(REQ_HEADERS);
    expect(s.responseHeaders).toEqual(RESP_HEADERS);
    expect(s.sampleCount).toBe(47);
    expect(s.confidenceScore).toBe(0.95);
    expect(s.breakingChanges).toEqual(BREAKING_CHANGES);
    expect(s.previousSessionId).toBe(prevSession.id);
    expect(s.firstObserved).toBe(firstObserved);
    expect(s.lastObserved).toBe(lastObserved);
  });
});
