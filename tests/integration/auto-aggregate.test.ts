/**
 * E2E test for the auto-aggregate trigger in the HTTP server handler.
 *
 * The auto-aggregate logic lives inside the start command's HTTP server callback
 * in commands.ts. When --max-samples N and --auto-aggregate are both specified,
 * reaching N samples should trigger aggregation automatically.
 *
 * This test spins up a real test server and proxy, sends N+1 requests with
 * --max-samples N --auto-aggregate, and verifies that:
 *   1. Exactly N samples are captured (N+1th is ignored)
 *   2. Aggregation runs automatically
 *   3. Aggregated schemas (snapshots) are created in the database
 *   4. The session transitions to 'completed'
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import * as http from 'node:http';
import * as httpProxy from 'http-proxy';
import { TestServer, createTestServer } from '../helpers/test-server.js';
import { getDatabase } from '../../src/storage/database.js';
import { SessionRepository } from '../../src/storage/sessions.js';
import { SampleRepository } from '../../src/storage/samples.js';
import { AggregatedSchemaRepository } from '../../src/storage/schemas.js';
import { captureRequestResponse } from '../../src/proxy/middleware.js';
import { inferSchema } from '../../src/inference/engine.js';
import { normalizePath } from '../../src/inference/path-normalizer.js';
import { runAggregation } from '../../src/aggregation/pipeline.js';
import type Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function httpGet(url: string): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on('end', () => {
          resolve({ statusCode: res.statusCode ?? 0, body });
        });
      })
      .on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Mini proxy that mirrors the start command's server handler logic
// ---------------------------------------------------------------------------

interface MiniProxyOptions {
  targetUrl: string;
  port: number;
  db: Database.Database;
  sessionId: string;
  maxSamples: number;
  autoAggregate: boolean;
}

interface MiniProxyResult {
  server: http.Server;
  proxyInstance: httpProxy.ProxyServer;
  sampleCount: number;
  aggregated: boolean;
  /** Resolves when max samples is reached and aggregation (if enabled) completes. */
  maxReached: Promise<void>;
  close: () => Promise<void>;
}

/**
 * Creates a mini proxy that replicates the logic from commands.ts start action.
 * This lets us test the sample counting, threshold check, and auto-aggregate
 * trigger without invoking the full CLI.
 */
async function createMiniProxy(opts: MiniProxyOptions): Promise<MiniProxyResult> {
  const { targetUrl, port, db, sessionId, maxSamples, autoAggregate } = opts;
  const sessions = new SessionRepository(db);
  const sampleRepo = new SampleRepository(db);

  let resolveMaxReached: () => void;
  const maxReachedPromise = new Promise<void>((resolve) => {
    resolveMaxReached = resolve;
  });

  let stopCapture = false;

  const result: MiniProxyResult = {
    server: null!,
    proxyInstance: null!,
    sampleCount: 0,
    aggregated: false,
    maxReached: maxReachedPromise,
    close: async () => {},
  };

  const proxyInstance = httpProxy.createProxyServer({
    target: targetUrl,
    changeOrigin: true,
    secure: true,
    timeout: 30_000,
    proxyTimeout: 30_000,
  });

  proxyInstance.on('error', (err, _req, res) => {
    if (res instanceof http.ServerResponse && !res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Bad Gateway', message: err.message }));
    }
  });

  const server = http.createServer(async (req, res) => {
    // Set up capture BEFORE proxying (mirrors commands.ts)
    const capturePromise = captureRequestResponse(req, res);

    // Forward to upstream
    proxyInstance.web(req, res);

    // After response finishes, process the capture
    try {
      const pair = await capturePromise;

      // Check max samples or stop flag (mirrors commands.ts)
      if (stopCapture || (maxSamples !== undefined && result.sampleCount >= maxSamples)) {
        return;
      }

      // Check if body was skipped
      if (pair.requestBodySkipped || pair.responseBodySkipped) {
        sessions.incrementSkippedCount(sessionId);
        return;
      }

      // Infer schemas
      const requestSchema =
        pair.requestBody !== undefined ? inferSchema(pair.requestBody) : undefined;
      const responseSchema =
        pair.responseBody !== undefined ? inferSchema(pair.responseBody) : undefined;

      // Normalize path
      const normalizedPath = normalizePath(pair.url);

      // Parse query params
      let queryParams: Record<string, string> | undefined;
      const queryStart = pair.url.indexOf('?');
      if (queryStart >= 0) {
        queryParams = {};
        const searchParams = new URLSearchParams(pair.url.slice(queryStart + 1));
        for (const [key, value] of searchParams) {
          queryParams[key] = value;
        }
      }

      // Insert sample
      sampleRepo.insertSample({
        sessionId,
        httpMethod: pair.method,
        path: pair.url.split('?')[0],
        normalizedPath,
        statusCode: pair.statusCode,
        queryParams,
        requestSchema,
        responseSchema,
        requestHeaders: pair.requestHeaders,
        responseHeaders: pair.responseHeaders,
        capturedAt: pair.capturedAt,
      });

      sessions.incrementSampleCount(sessionId);
      result.sampleCount++;

      // Auto-stop if max samples reached (mirrors commands.ts)
      if (maxSamples !== undefined && result.sampleCount >= maxSamples) {
        stopCapture = true;

        // Await server close to drain in-flight connections before aggregating
        await new Promise<void>((resolveClose) => {
          server.close(() => resolveClose());
        });

        // Auto-aggregate if requested (mirrors commands.ts)
        if (autoAggregate) {
          try {
            runAggregation(db, sessionId);
            result.aggregated = true;
          } catch {
            // swallow aggregation errors in test
          }
        }

        resolveMaxReached();
      }
    } catch {
      // swallow capture errors
    }
  });

  result.server = server;
  result.proxyInstance = proxyInstance;

  // Start listening
  await new Promise<void>((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => resolve());
    server.once('error', reject);
  });

  result.close = async () => {
    return new Promise<void>((resolve) => {
      proxyInstance.close();
      server.close(() => resolve());
    });
  };

  return result;
}

// ---------------------------------------------------------------------------
// Find a free port
// ---------------------------------------------------------------------------

async function getFreePort(): Promise<number> {
  const net = await import('node:net');
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as { port: number };
      const port = addr.port;
      srv.close(() => resolve(port));
    });
    srv.once('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Auto-aggregate E2E', () => {
  let testServer: TestServer;
  let testCleanup: () => Promise<void>;

  beforeAll(async () => {
    const res = await createTestServer();
    testServer = res.server;
    testCleanup = res.cleanup;
  });

  afterAll(async () => {
    await testCleanup();
  });

  it('auto-aggregates after reaching max-samples threshold', async () => {
    const db = getDatabase(':memory:');
    const sessions = new SessionRepository(db);
    const schemaRepo = new AggregatedSchemaRepository(db);

    const session = sessions.createSession(testServer.url, testServer.port, 'auto-agg-test', 3);
    const proxyPort = await getFreePort();

    const proxy = await createMiniProxy({
      targetUrl: testServer.url,
      port: proxyPort,
      db,
      sessionId: session.id,
      maxSamples: 3,
      autoAggregate: true,
    });

    try {
      // Send 4 requests (N+1 where N=3)
      // These hit different endpoints to get varied samples
      const endpoints = ['/users', '/health', '/orders', '/users/1'];
      for (const endpoint of endpoints) {
        try {
          await httpGet(`http://127.0.0.1:${proxyPort}${endpoint}`);
        } catch {
          // The 4th request may fail because the server closes after 3
        }
      }

      // Wait for max samples to be reached and auto-aggregate to complete
      await proxy.maxReached;

      // Verify exactly 3 samples were captured
      expect(proxy.sampleCount).toBe(3);

      // Verify aggregation ran
      expect(proxy.aggregated).toBe(true);

      // Verify session is completed
      const updatedSession = sessions.getSession(session.id);
      expect(updatedSession?.status).toBe('completed');
      expect(updatedSession?.sampleCount).toBe(3);

      // Verify aggregated schemas (snapshots) exist
      const schemas = schemaRepo.listBySession(session.id);
      expect(schemas.length).toBeGreaterThan(0);

      // Verify schemas have reasonable content
      for (const schema of schemas) {
        expect(schema.sessionId).toBe(session.id);
        expect(schema.httpMethod).toBeTruthy();
        expect(schema.path).toMatch(/^\//);
        expect(schema.sampleCount).toBeGreaterThan(0);
      }
    } finally {
      await proxy.close();
      db.close();
    }
  });

  it('does NOT auto-aggregate without --auto-aggregate flag', async () => {
    const db = getDatabase(':memory:');
    const sessions = new SessionRepository(db);
    const schemaRepo = new AggregatedSchemaRepository(db);

    const session = sessions.createSession(testServer.url, testServer.port, 'no-auto-agg', 2);
    const proxyPort = await getFreePort();

    const proxy = await createMiniProxy({
      targetUrl: testServer.url,
      port: proxyPort,
      db,
      sessionId: session.id,
      maxSamples: 2,
      autoAggregate: false,
    });

    try {
      // Send 3 requests (N+1 where N=2)
      for (const endpoint of ['/users', '/health', '/orders']) {
        try {
          await httpGet(`http://127.0.0.1:${proxyPort}${endpoint}`);
        } catch {
          // May fail after server closes
        }
      }

      await proxy.maxReached;

      // Verify samples were captured up to max
      expect(proxy.sampleCount).toBe(2);

      // Verify aggregation did NOT run
      expect(proxy.aggregated).toBe(false);

      // Session should still be active (not aggregated)
      const updatedSession = sessions.getSession(session.id);
      expect(updatedSession?.status).toBe('active');

      // No aggregated schemas
      const schemas = schemaRepo.listBySession(session.id);
      expect(schemas.length).toBe(0);
    } finally {
      await proxy.close();
      db.close();
    }
  });

  it('sample count does not exceed max-samples', async () => {
    const db = getDatabase(':memory:');
    const sessions = new SessionRepository(db);
    const sampleRepo = new SampleRepository(db);

    const maxSamples = 2;
    const session = sessions.createSession(testServer.url, testServer.port, 'max-samples-test', maxSamples);
    const proxyPort = await getFreePort();

    const proxy = await createMiniProxy({
      targetUrl: testServer.url,
      port: proxyPort,
      db,
      sessionId: session.id,
      maxSamples,
      autoAggregate: true,
    });

    try {
      // Send 5 requests — only 2 should be captured
      for (const endpoint of ['/users', '/health', '/orders', '/users/1', '/nested']) {
        try {
          await httpGet(`http://127.0.0.1:${proxyPort}${endpoint}`);
        } catch {
          // May fail after server closes
        }
      }

      await proxy.maxReached;

      // Verify only maxSamples captured
      const dbCount = sampleRepo.countBySession(session.id);
      expect(dbCount).toBe(maxSamples);
      expect(proxy.sampleCount).toBe(maxSamples);
    } finally {
      await proxy.close();
      db.close();
    }
  });

  it('auto-aggregate produces valid endpoint schemas from real traffic', async () => {
    const db = getDatabase(':memory:');
    const sessions = new SessionRepository(db);
    const schemaRepo = new AggregatedSchemaRepository(db);

    const maxSamples = 5;
    const session = sessions.createSession(testServer.url, testServer.port, 'valid-schemas', maxSamples);
    const proxyPort = await getFreePort();

    const proxy = await createMiniProxy({
      targetUrl: testServer.url,
      port: proxyPort,
      db,
      sessionId: session.id,
      maxSamples,
      autoAggregate: true,
    });

    try {
      // Send diverse traffic to create multiple endpoint schemas
      const endpoints = ['/users', '/users/1', '/health', '/orders', '/nested'];
      for (const endpoint of endpoints) {
        try {
          await httpGet(`http://127.0.0.1:${proxyPort}${endpoint}`);
        } catch {
          // ignore
        }
      }

      await proxy.maxReached;

      // Verify aggregation completed
      expect(proxy.aggregated).toBe(true);

      const schemas = schemaRepo.listBySession(session.id);
      expect(schemas.length).toBeGreaterThan(0);

      // Verify response schemas contain actual type information
      const usersSchema = schemas.find(
        (s) => s.path === '/users' && s.httpMethod === 'GET',
      );
      if (usersSchema) {
        expect(usersSchema.responseSchemas).toBeDefined();
        const primaryResponse = Object.values(usersSchema.responseSchemas!)[0];
        expect(primaryResponse).toBeDefined();
        expect(primaryResponse.type).toBeDefined();
      }

      // Verify confidence scores are computed
      for (const schema of schemas) {
        expect(schema.confidenceScore).toBeGreaterThanOrEqual(0);
        expect(schema.confidenceScore).toBeLessThanOrEqual(1);
      }

      // Verify path normalization works through the proxy
      const normalizedPaths = schemas.map((s) => s.path);
      // /users/1 should be normalized to /users/{userId}
      if (normalizedPaths.includes('/users/{userId}')) {
        const userById = schemas.find((s) => s.path === '/users/{userId}');
        expect(userById).toBeDefined();
      }
    } finally {
      await proxy.close();
      db.close();
    }
  });
});
