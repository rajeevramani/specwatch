import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { getDatabase } from '../../src/storage/database.js';
import { SessionRepository } from '../../src/storage/sessions.js';
import { SampleRepository } from '../../src/storage/samples.js';
import {
  detectSequences,
  classifyPattern,
  classifyJsonRpcPattern,
} from '../../src/analysis/sequences.js';
import type { OperationSequence, SequenceAnalysis } from '../../src/analysis/sequences.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function insertSample(
  sampleRepo: SampleRepository,
  sessionId: string,
  method: string,
  path: string,
  normalizedPath: string,
  capturedAt: string,
) {
  sampleRepo.insertSample({
    sessionId,
    httpMethod: method,
    path,
    normalizedPath,
    capturedAt,
  });
}

function isoTime(baseMs: number, offsetMs: number): string {
  return new Date(baseMs + offsetMs).toISOString();
}

// ---------------------------------------------------------------------------
// classifyPattern
// ---------------------------------------------------------------------------

describe('classifyPattern', () => {
  it('classifies POST→GET to same resource as verification_loop', () => {
    expect(classifyPattern('POST', '/users', 'GET', '/users/{userId}', 500)).toBe(
      'verification_loop',
    );
  });

  it('classifies PUT→GET to same resource as verification_loop', () => {
    expect(classifyPattern('PUT', '/users/{userId}', 'GET', '/users/{userId}', 300)).toBe(
      'verification_loop',
    );
  });

  it('classifies PATCH→GET to same resource as verification_loop', () => {
    expect(classifyPattern('PATCH', '/users/{userId}', 'GET', '/users/{userId}', 100)).toBe(
      'verification_loop',
    );
  });

  it('does not classify as verification_loop if delay > 2s', () => {
    expect(classifyPattern('POST', '/users', 'GET', '/users/{userId}', 3000)).not.toBe(
      'verification_loop',
    );
  });

  it('classifies POST→POST to parent/child as create_chain', () => {
    expect(
      classifyPattern('POST', '/parents/{parentId}', 'POST', '/parents/{parentId}/children', 500),
    ).toBe('create_chain');
  });

  it('classifies POST→GET to same collection as list_after_create', () => {
    expect(classifyPattern('POST', '/users', 'GET', '/users', 500)).toBe('list_after_create');
  });

  it('classifies unrelated requests as unknown', () => {
    expect(classifyPattern('GET', '/users', 'GET', '/orders', 500)).toBe('unknown');
  });

  it('classifies GET→GET as unknown (not a write method)', () => {
    expect(classifyPattern('GET', '/users', 'GET', '/users/{userId}', 100)).toBe('unknown');
  });

  it('classifies DELETE→GET as unknown', () => {
    expect(classifyPattern('DELETE', '/users/{userId}', 'GET', '/users/{userId}', 100)).toBe(
      'unknown',
    );
  });
});

// ---------------------------------------------------------------------------
// detectSequences
// ---------------------------------------------------------------------------

describe('detectSequences', () => {
  let db: Database.Database;
  let sessionRepo: SessionRepository;
  let sampleRepo: SampleRepository;

  beforeEach(() => {
    db = getDatabase(':memory:');
    sessionRepo = new SessionRepository(db);
    sampleRepo = new SampleRepository(db);
  });

  it('returns empty analysis for non-existent session', () => {
    const result = detectSequences(db, 'non-existent');
    expect(result.sequences).toEqual([]);
    expect(result.totalRequests).toBe(0);
  });

  it('returns empty analysis for human consumer session', () => {
    const session = sessionRepo.createSession('https://api.example.com', 8080);
    // Default consumer is 'human'
    const base = Date.now();
    insertSample(sampleRepo, session.id, 'POST', '/users', '/users', isoTime(base, 0));
    insertSample(sampleRepo, session.id, 'GET', '/users/1', '/users/{userId}', isoTime(base, 500));

    const result = detectSequences(db, session.id);
    expect(result.sequences).toEqual([]);
    expect(result.totalRequests).toBe(0);
  });

  it('returns empty analysis for agent session with 0 samples', () => {
    const session = sessionRepo.createSession(
      'https://api.example.com',
      8080,
      undefined,
      undefined,
      'agent',
    );

    const result = detectSequences(db, session.id);
    expect(result.sequences).toEqual([]);
    expect(result.totalRequests).toBe(0);
  });

  it('returns empty sequences for agent session with 1 sample', () => {
    const session = sessionRepo.createSession(
      'https://api.example.com',
      8080,
      undefined,
      undefined,
      'agent',
    );
    insertSample(
      sampleRepo,
      session.id,
      'GET',
      '/users',
      '/users',
      new Date().toISOString(),
    );

    const result = detectSequences(db, session.id);
    expect(result.sequences).toEqual([]);
    expect(result.totalRequests).toBe(1);
    expect(result.wastedRequests).toBe(0);
  });

  it('detects POST→GET as verification_loop', () => {
    const session = sessionRepo.createSession(
      'https://api.example.com',
      8080,
      undefined,
      undefined,
      'agent',
    );
    const base = Date.now();

    insertSample(sampleRepo, session.id, 'POST', '/users', '/users', isoTime(base, 0));
    insertSample(
      sampleRepo,
      session.id,
      'GET',
      '/users/42',
      '/users/{userId}',
      isoTime(base, 500),
    );

    const result = detectSequences(db, session.id);
    expect(result.sequences).toHaveLength(1);
    expect(result.sequences[0].pattern).toBe('verification_loop');
    expect(result.sequences[0].fromMethod).toBe('POST');
    expect(result.sequences[0].fromPath).toBe('/users');
    expect(result.sequences[0].toMethod).toBe('GET');
    expect(result.sequences[0].toPath).toBe('/users/{userId}');
    expect(result.sequences[0].count).toBe(1);
    expect(result.verificationLoops).toHaveLength(1);
    expect(result.wastedRequests).toBe(1);
    expect(result.totalRequests).toBe(2);
  });

  it('detects POST→POST parent/child as create_chain', () => {
    const session = sessionRepo.createSession(
      'https://api.example.com',
      8080,
      undefined,
      undefined,
      'agent',
    );
    const base = Date.now();

    insertSample(
      sampleRepo,
      session.id,
      'POST',
      '/parents/1',
      '/parents/{parentId}',
      isoTime(base, 0),
    );
    insertSample(
      sampleRepo,
      session.id,
      'POST',
      '/parents/1/children',
      '/parents/{parentId}/children',
      isoTime(base, 1000),
    );

    const result = detectSequences(db, session.id);
    expect(result.sequences).toHaveLength(1);
    expect(result.sequences[0].pattern).toBe('create_chain');
  });

  it('classifies unrelated requests as unknown', () => {
    const session = sessionRepo.createSession(
      'https://api.example.com',
      8080,
      undefined,
      undefined,
      'agent',
    );
    const base = Date.now();

    insertSample(sampleRepo, session.id, 'GET', '/users', '/users', isoTime(base, 0));
    insertSample(sampleRepo, session.id, 'GET', '/orders', '/orders', isoTime(base, 500));

    const result = detectSequences(db, session.id);
    expect(result.sequences).toHaveLength(1);
    expect(result.sequences[0].pattern).toBe('unknown');
    expect(result.verificationLoops).toHaveLength(0);
    expect(result.wastedRequests).toBe(0);
  });

  it('increments count for repeated identical sequences', () => {
    const session = sessionRepo.createSession(
      'https://api.example.com',
      8080,
      undefined,
      undefined,
      'agent',
    );
    const base = Date.now();

    // Three POST→GET verification loops
    insertSample(sampleRepo, session.id, 'POST', '/users', '/users', isoTime(base, 0));
    insertSample(
      sampleRepo,
      session.id,
      'GET',
      '/users/1',
      '/users/{userId}',
      isoTime(base, 500),
    );
    insertSample(sampleRepo, session.id, 'POST', '/users', '/users', isoTime(base, 2000));
    insertSample(
      sampleRepo,
      session.id,
      'GET',
      '/users/2',
      '/users/{userId}',
      isoTime(base, 2500),
    );
    insertSample(sampleRepo, session.id, 'POST', '/users', '/users', isoTime(base, 4000));
    insertSample(
      sampleRepo,
      session.id,
      'GET',
      '/users/3',
      '/users/{userId}',
      isoTime(base, 4500),
    );

    const result = detectSequences(db, session.id);

    // POST→GET appears 3 times, GET→POST appears 2 times (interleaved)
    const postGet = result.sequences.find(
      (s) => s.fromMethod === 'POST' && s.toMethod === 'GET',
    );
    expect(postGet).toBeDefined();
    expect(postGet!.count).toBe(3);
    expect(postGet!.pattern).toBe('verification_loop');

    expect(result.wastedRequests).toBe(3);
  });

  it('calculates average delay correctly', () => {
    const session = sessionRepo.createSession(
      'https://api.example.com',
      8080,
      undefined,
      undefined,
      'agent',
    );
    const base = Date.now();

    // Two POST→GET with delays of 200ms and 400ms → avg 300ms
    insertSample(sampleRepo, session.id, 'POST', '/users', '/users', isoTime(base, 0));
    insertSample(
      sampleRepo,
      session.id,
      'GET',
      '/users/1',
      '/users/{userId}',
      isoTime(base, 200),
    );
    insertSample(sampleRepo, session.id, 'POST', '/users', '/users', isoTime(base, 1000));
    insertSample(
      sampleRepo,
      session.id,
      'GET',
      '/users/2',
      '/users/{userId}',
      isoTime(base, 1400),
    );

    const result = detectSequences(db, session.id);
    const postGet = result.sequences.find(
      (s) => s.fromMethod === 'POST' && s.toMethod === 'GET',
    );
    expect(postGet).toBeDefined();
    expect(postGet!.avgDelayMs).toBe(300);
  });

  it('detects mixed patterns in a single session', () => {
    const session = sessionRepo.createSession(
      'https://api.example.com',
      8080,
      undefined,
      undefined,
      'agent',
    );
    const base = Date.now();

    // Verification loop: POST → GET
    insertSample(sampleRepo, session.id, 'POST', '/users', '/users', isoTime(base, 0));
    insertSample(
      sampleRepo,
      session.id,
      'GET',
      '/users/1',
      '/users/{userId}',
      isoTime(base, 500),
    );

    // Create chain: POST parent → POST child
    insertSample(
      sampleRepo,
      session.id,
      'POST',
      '/teams/1',
      '/teams/{teamId}',
      isoTime(base, 2000),
    );
    insertSample(
      sampleRepo,
      session.id,
      'POST',
      '/teams/1/members',
      '/teams/{teamId}/members',
      isoTime(base, 3000),
    );

    // Unknown: GET → DELETE
    insertSample(
      sampleRepo,
      session.id,
      'GET',
      '/orders',
      '/orders',
      isoTime(base, 5000),
    );
    insertSample(
      sampleRepo,
      session.id,
      'DELETE',
      '/orders/99',
      '/orders/{orderId}',
      isoTime(base, 6000),
    );

    const result = detectSequences(db, session.id);
    expect(result.totalRequests).toBe(6);

    const patterns = result.sequences.map((s) => s.pattern);
    expect(patterns).toContain('verification_loop');
    expect(patterns).toContain('create_chain');
    expect(patterns).toContain('unknown');

    expect(result.verificationLoops).toHaveLength(1);
    expect(result.wastedRequests).toBe(1);
  });

  it('sorts sequences by count descending', () => {
    const session = sessionRepo.createSession(
      'https://api.example.com',
      8080,
      undefined,
      undefined,
      'agent',
    );
    const base = Date.now();

    // 1x GET→DELETE
    insertSample(sampleRepo, session.id, 'GET', '/orders', '/orders', isoTime(base, 0));
    insertSample(
      sampleRepo,
      session.id,
      'DELETE',
      '/orders/1',
      '/orders/{orderId}',
      isoTime(base, 500),
    );

    // 2x POST→GET
    insertSample(sampleRepo, session.id, 'POST', '/users', '/users', isoTime(base, 1000));
    insertSample(
      sampleRepo,
      session.id,
      'GET',
      '/users/1',
      '/users/{userId}',
      isoTime(base, 1500),
    );
    insertSample(sampleRepo, session.id, 'POST', '/users', '/users', isoTime(base, 3000));
    insertSample(
      sampleRepo,
      session.id,
      'GET',
      '/users/2',
      '/users/{userId}',
      isoTime(base, 3500),
    );

    const result = detectSequences(db, session.id);
    expect(result.sequences[0].count).toBeGreaterThanOrEqual(result.sequences[1].count);
  });
});

// ---------------------------------------------------------------------------
// classifyJsonRpcPattern
// ---------------------------------------------------------------------------

describe('classifyJsonRpcPattern', () => {
  it('classifies same tool called consecutively as retry', () => {
    expect(
      classifyJsonRpcPattern('tools/call:cp_create_cluster', 'tools/call:cp_create_cluster'),
    ).toBe('retry');
  });

  it('classifies tools/list→tools/list as redundant_list', () => {
    expect(classifyJsonRpcPattern('tools/list', 'tools/list')).toBe('redundant_list');
  });

  it('classifies create→query as verification_loop', () => {
    expect(
      classifyJsonRpcPattern('tools/call:create_cluster', 'tools/call:get_cluster'),
    ).toBe('verification_loop');
  });

  it('classifies update→read as verification_loop', () => {
    expect(
      classifyJsonRpcPattern('tools/call:update_user', 'tools/call:get_user'),
    ).toBe('verification_loop');
  });

  it('classifies unrelated tools as unknown', () => {
    expect(
      classifyJsonRpcPattern('tools/call:create_cluster', 'tools/call:list_users'),
    ).toBe('unknown');
  });

  it('classifies initialize→tools/list as unknown', () => {
    expect(classifyJsonRpcPattern('initialize', 'tools/list')).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// detectSequences with JSON-RPC sessions
// ---------------------------------------------------------------------------

describe('detectSequences with JSON-RPC', () => {
  let db: Database.Database;
  let sessionRepo: SessionRepository;
  let sampleRepo: SampleRepository;

  beforeEach(() => {
    db = getDatabase(':memory:');
    sessionRepo = new SessionRepository(db);
    sampleRepo = new SampleRepository(db);
  });

  it('uses tool-based pairing for JSON-RPC sessions', () => {
    const session = sessionRepo.createSession(
      'https://mcp.example.com',
      8080,
      undefined,
      undefined,
      'agent',
    );
    const base = Date.now();

    // All POST to same path, but different JSON-RPC methods
    sampleRepo.insertSample({
      sessionId: session.id,
      httpMethod: 'POST',
      path: '/api/v1/mcp',
      normalizedPath: '/api/v1/mcp',
      capturedAt: isoTime(base, 0),
      jsonrpcMethod: 'initialize',
    });
    sampleRepo.insertSample({
      sessionId: session.id,
      httpMethod: 'POST',
      path: '/api/v1/mcp',
      normalizedPath: '/api/v1/mcp',
      capturedAt: isoTime(base, 500),
      jsonrpcMethod: 'tools/list',
    });
    sampleRepo.insertSample({
      sessionId: session.id,
      httpMethod: 'POST',
      path: '/api/v1/mcp',
      normalizedPath: '/api/v1/mcp',
      capturedAt: isoTime(base, 1000),
      jsonrpcMethod: 'tools/call',
      jsonrpcTool: 'create_cluster',
    });

    const result = detectSequences(db, session.id);
    expect(result.totalRequests).toBe(3);
    expect(result.sequences).toHaveLength(2);

    // Should use operation keys, not HTTP method/path
    const seq0 = result.sequences.find((s) => s.fromPath === 'initialize');
    expect(seq0).toBeDefined();
    expect(seq0!.toPath).toBe('tools/list');
  });

  it('detects repeated tools/list as redundant_list', () => {
    const session = sessionRepo.createSession(
      'https://mcp.example.com',
      8080,
      undefined,
      undefined,
      'agent',
    );
    const base = Date.now();

    for (let i = 0; i < 5; i++) {
      sampleRepo.insertSample({
        sessionId: session.id,
        httpMethod: 'POST',
        path: '/api/v1/mcp',
        normalizedPath: '/api/v1/mcp',
        capturedAt: isoTime(base, i * 500),
        jsonrpcMethod: 'tools/list',
      });
    }

    const result = detectSequences(db, session.id);
    const redundant = result.sequences.find((s) => s.pattern === 'redundant_list');
    expect(redundant).toBeDefined();
    expect(redundant!.count).toBe(4); // 4 consecutive pairs from 5 samples
  });

  it('detects same tool called consecutively as retry', () => {
    const session = sessionRepo.createSession(
      'https://mcp.example.com',
      8080,
      undefined,
      undefined,
      'agent',
    );
    const base = Date.now();

    for (let i = 0; i < 3; i++) {
      sampleRepo.insertSample({
        sessionId: session.id,
        httpMethod: 'POST',
        path: '/api/v1/mcp',
        normalizedPath: '/api/v1/mcp',
        capturedAt: isoTime(base, i * 500),
        jsonrpcMethod: 'tools/call',
        jsonrpcTool: 'create_cluster',
      });
    }

    const result = detectSequences(db, session.id);
    const retry = result.sequences.find((s) => s.pattern === 'retry');
    expect(retry).toBeDefined();
    expect(retry!.count).toBe(2);
  });

  it('detects create→get as verification_loop for JSON-RPC', () => {
    const session = sessionRepo.createSession(
      'https://mcp.example.com',
      8080,
      undefined,
      undefined,
      'agent',
    );
    const base = Date.now();

    sampleRepo.insertSample({
      sessionId: session.id,
      httpMethod: 'POST',
      path: '/api/v1/mcp',
      normalizedPath: '/api/v1/mcp',
      capturedAt: isoTime(base, 0),
      jsonrpcMethod: 'tools/call',
      jsonrpcTool: 'create_cluster',
    });
    sampleRepo.insertSample({
      sessionId: session.id,
      httpMethod: 'POST',
      path: '/api/v1/mcp',
      normalizedPath: '/api/v1/mcp',
      capturedAt: isoTime(base, 500),
      jsonrpcMethod: 'tools/call',
      jsonrpcTool: 'get_cluster',
    });

    const result = detectSequences(db, session.id);
    const vloop = result.sequences.find((s) => s.pattern === 'verification_loop');
    expect(vloop).toBeDefined();
    expect(vloop!.fromPath).toBe('tools/call:create_cluster');
    expect(vloop!.toPath).toBe('tools/call:get_cluster');
  });

  it('REST session still uses HTTP-based pairing (no regression)', () => {
    const session = sessionRepo.createSession(
      'https://api.example.com',
      8080,
      undefined,
      undefined,
      'agent',
    );
    const base = Date.now();

    insertSample(sampleRepo, session.id, 'POST', '/users', '/users', isoTime(base, 0));
    insertSample(
      sampleRepo,
      session.id,
      'GET',
      '/users/1',
      '/users/{userId}',
      isoTime(base, 500),
    );

    const result = detectSequences(db, session.id);
    expect(result.sequences).toHaveLength(1);
    expect(result.sequences[0].fromMethod).toBe('POST');
    expect(result.sequences[0].fromPath).toBe('/users');
    expect(result.sequences[0].toMethod).toBe('GET');
    expect(result.sequences[0].toPath).toBe('/users/{userId}');
    expect(result.sequences[0].pattern).toBe('verification_loop');
  });
});
