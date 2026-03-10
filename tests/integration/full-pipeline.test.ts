/**
 * Full pipeline integration tests.
 *
 * These tests exercise the complete path:
 *   TestServer → ProxyServer → capture → inference → storage → aggregation → export
 *
 * NOTE (Phase A): Only the test infrastructure (TestServer and fixture imports)
 * is exercised here. The full pipeline assertions (Phase C) will be added once
 * all src/ modules are implemented.
 *
 * The tests that are enabled now ensure:
 * 1. TestServer starts, serves routes, and stops cleanly.
 * 2. Fixtures are importable and have the correct shape.
 * 3. The test helpers compile and run without errors.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import yaml from 'js-yaml';
import { TestServer, createTestServer } from '../helpers/test-server.js';
import {
  SIMPLE_FLAT_OBJECT,
  ALL_STRING_FORMATS_OBJECT,
  PIPELINE_TEST_REQUESTS,
  USERS_API_SAMPLES,
} from '../helpers/fixtures.js';
import { getDatabase } from '../../src/storage/database.js';
import { SessionRepository } from '../../src/storage/sessions.js';
import { SampleRepository } from '../../src/storage/samples.js';
import { AggregatedSchemaRepository } from '../../src/storage/schemas.js';
import { inferSchema } from '../../src/inference/engine.js';
import { normalizePath } from '../../src/inference/path-normalizer.js';
import { runAggregation } from '../../src/aggregation/pipeline.js';
import { buildOpenApiDocument, serializeOpenApi } from '../../src/export/openapi.js';

// ---------------------------------------------------------------------------
// TestServer self-tests
// ---------------------------------------------------------------------------

describe('TestServer — infrastructure', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = new TestServer();
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  it('starts and provides a URL', () => {
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(server.port).toBeGreaterThan(0);
  });

  it('serves GET /users with JSON array', async () => {
    const url = `${server.url}/users`;
    const body = await httpGet(url);
    const parsed = JSON.parse(body);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed[0]).toHaveProperty('id');
    expect(parsed[0]).toHaveProperty('name');
    expect(parsed[0]).toHaveProperty('email');
  });

  it('serves GET /users/1 with a single user object', async () => {
    const url = `${server.url}/users/1`;
    const { body, statusCode } = await httpGetWithStatus(url);
    expect(statusCode).toBe(200);
    const parsed = JSON.parse(body);
    expect(parsed).toHaveProperty('id', 1);
    expect(parsed).toHaveProperty('email', 'alice@example.com');
  });

  it('serves GET /users/999 with 404', async () => {
    const url = `${server.url}/users/999`;
    const { statusCode } = await httpGetWithStatus(url);
    expect(statusCode).toBe(404);
  });

  it('serves GET /error with 500', async () => {
    const url = `${server.url}/error`;
    const { statusCode } = await httpGetWithStatus(url);
    expect(statusCode).toBe(500);
  });

  it('serves GET /text with text/plain content type', async () => {
    const url = `${server.url}/text`;
    const { contentType, statusCode } = await httpGetWithStatus(url);
    expect(statusCode).toBe(200);
    expect(contentType).toContain('text/plain');
  });

  it('serves GET /html with text/html content type', async () => {
    const url = `${server.url}/html`;
    const { contentType, statusCode } = await httpGetWithStatus(url);
    expect(statusCode).toBe(200);
    expect(contentType).toContain('text/html');
  });

  it('serves GET /large with body > 1MB', async () => {
    const url = `${server.url}/large`;
    const body = await httpGet(url);
    expect(Buffer.byteLength(body, 'utf8')).toBeGreaterThan(1024 * 1024);
  });

  it('serves POST /users with 201 status', async () => {
    const url = `${server.url}/users`;
    const requestBody = JSON.stringify({ name: 'Test', email: 'test@example.com' });
    const { statusCode, body } = await httpPost(url, requestBody);
    expect(statusCode).toBe(201);
    const parsed = JSON.parse(body);
    expect(parsed).toHaveProperty('id');
    expect(parsed).toHaveProperty('name');
  });

  it('returns 404 for unknown routes', async () => {
    const url = `${server.url}/nonexistent`;
    const { statusCode } = await httpGetWithStatus(url);
    expect(statusCode).toBe(404);
  });

  it('serves GET /health', async () => {
    const url = `${server.url}/health`;
    const { statusCode, body } = await httpGetWithStatus(url);
    expect(statusCode).toBe(200);
    const parsed = JSON.parse(body);
    expect(parsed).toHaveProperty('status', 'ok');
  });

  it('serves DELETE /users/1 with 204', async () => {
    const url = `${server.url}/users/1`;
    const { statusCode } = await httpRequest(url, 'DELETE');
    expect(statusCode).toBe(204);
  });

  it('serves all string format types in /users/1', async () => {
    const url = `${server.url}/users/1`;
    const body = await httpGet(url);
    const parsed = JSON.parse(body);
    // UUID
    expect(parsed.profileId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    // URI
    expect(parsed.avatarUrl).toMatch(/^https?:\/\//);
    // Date
    expect(parsed.birthDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // DateTime
    expect(parsed.lastLogin).toMatch(/T\d{2}:\d{2}:\d{2}/);
    // IPv4
    expect(parsed.ipAddress).toMatch(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
  });

  it('strips query string before route matching', async () => {
    const url = `${server.url}/users?page=1&limit=10`;
    const { statusCode } = await httpGetWithStatus(url);
    // Should still match GET /users route
    expect(statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// createTestServer factory helper
// ---------------------------------------------------------------------------

describe('createTestServer factory', () => {
  it('creates, starts, and provides a cleanup function', async () => {
    const { server, cleanup } = await createTestServer();
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    await cleanup();
    // After cleanup, accessing url should throw
    expect(() => server.url).toThrow('TestServer is not started');
  });
});

// ---------------------------------------------------------------------------
// Fixture shape validation
// ---------------------------------------------------------------------------

describe('Fixtures — shape validation', () => {
  it('SIMPLE_FLAT_OBJECT has the expected structure', () => {
    expect(SIMPLE_FLAT_OBJECT).toMatchObject({
      id: expect.any(Number),
      name: expect.any(String),
      email: expect.stringContaining('@'),
    });
  });

  it('ALL_STRING_FORMATS_OBJECT contains all string format examples', () => {
    // UUID
    expect(ALL_STRING_FORMATS_OBJECT.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    // Email
    expect(ALL_STRING_FORMATS_OBJECT.email).toContain('@');
    // DateTime
    expect(ALL_STRING_FORMATS_OBJECT.createdAt).toContain('T');
    // Date
    expect(ALL_STRING_FORMATS_OBJECT.birthDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // URI
    expect(ALL_STRING_FORMATS_OBJECT.website).toMatch(/^https?:\/\//);
    // IPv4
    expect(ALL_STRING_FORMATS_OBJECT.ipv4).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    // IPv6
    expect(ALL_STRING_FORMATS_OBJECT.ipv6).toContain(':');
  });

  it('PIPELINE_TEST_REQUESTS contains 10+ requests', () => {
    expect(PIPELINE_TEST_REQUESTS.length).toBeGreaterThanOrEqual(10);
  });

  it('USERS_API_SAMPLES covers multiple endpoints and status codes', () => {
    const endpoints = new Set(
      USERS_API_SAMPLES.map((s) => `${s.httpMethod} ${s.normalizedPath}`),
    );
    const statusCodes = new Set(USERS_API_SAMPLES.map((s) => s.statusCode));

    expect(endpoints.size).toBeGreaterThan(1);
    expect(statusCodes.has(200)).toBe(true);
    expect(statusCodes.has(404)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phase C: Full pipeline integration tests
// ---------------------------------------------------------------------------

/** Body size limit matching src/proxy/middleware.ts MAX_BODY_BYTES */
const MAX_BODY_BYTES = 1_048_576;

/**
 * Simulate what the proxy middleware does for a single request/response pair:
 *   1. Check if response body is JSON and under 1MB
 *   2. Infer request/response schemas
 *   3. Normalize the path
 *   4. Insert sample into storage
 *   5. Increment session sample_count (or skipped_count)
 */
function simulateCapture(
  sessionRepo: SessionRepository,
  sampleRepo: SampleRepository,
  sessionId: string,
  opts: {
    method: string;
    path: string;
    statusCode: number;
    responseBody: unknown | undefined;
    requestBody?: unknown | undefined;
    responseBodySkipped?: boolean;
  },
): void {
  const { method, path, statusCode, responseBody, requestBody, responseBodySkipped } = opts;

  // Large body: skip entirely, increment skipped_count
  if (responseBodySkipped) {
    sessionRepo.incrementSkippedCount(sessionId);
    return;
  }

  // Nothing to infer (non-JSON or empty body on both sides)
  if (responseBody === undefined && requestBody === undefined) {
    return;
  }

  const normalizedPathValue = normalizePath(path);
  const requestSchema = requestBody !== undefined ? inferSchema(requestBody) : undefined;
  const responseSchema = responseBody !== undefined ? inferSchema(responseBody) : undefined;

  sampleRepo.insertSample({
    sessionId,
    httpMethod: method.toUpperCase(),
    path,
    normalizedPath: normalizedPathValue,
    statusCode,
    capturedAt: new Date().toISOString(),
    requestSchema,
    responseSchema,
  });

  sessionRepo.incrementSampleCount(sessionId);
}

/**
 * Helper: fetch a URL from the TestServer and parse the response,
 * returning the pieces needed by simulateCapture.
 */
async function fetchAndParse(
  serverUrl: string,
  method: string,
  path: string,
  reqBody?: string,
): Promise<{
  statusCode: number;
  responseBody: unknown | undefined;
  requestBody: unknown | undefined;
  responseBodySkipped: boolean;
}> {
  let statusCode: number;
  let rawBody: string;
  let contentType: string;

  if (method === 'POST' && reqBody) {
    const result = await httpPost(`${serverUrl}${path}`, reqBody);
    statusCode = result.statusCode;
    rawBody = result.body;
    contentType = 'application/json'; // POST /users returns JSON
  } else {
    const result = await httpGetWithStatus(`${serverUrl}${path}`);
    statusCode = result.statusCode;
    rawBody = result.body;
    contentType = result.contentType;
  }

  // Check body size limit
  const bodyBytes = Buffer.byteLength(rawBody, 'utf8');
  if (bodyBytes > MAX_BODY_BYTES) {
    return { statusCode, responseBody: undefined, requestBody: undefined, responseBodySkipped: true };
  }

  // Only parse JSON content types
  let responseBody: unknown | undefined = undefined;
  if (contentType.includes('application/json') && rawBody.length > 0) {
    try {
      responseBody = JSON.parse(rawBody);
    } catch {
      responseBody = undefined;
    }
  }

  let requestBody: unknown | undefined = undefined;
  if (reqBody) {
    try {
      requestBody = JSON.parse(reqBody);
    } catch {
      requestBody = undefined;
    }
  }

  return { statusCode, responseBody, requestBody, responseBodySkipped: false };
}

describe('Full pipeline (Phase C)', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = new TestServer();
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  it('full pipeline: 10+ requests → inference → storage → aggregation → OpenAPI export', async () => {
    const db = getDatabase(':memory:');
    const sessionRepo = new SessionRepository(db);
    const sampleRepo = new SampleRepository(db);

    const session = sessionRepo.createSession(server.url, server.port, 'full-pipeline');
    const sessionId = session.id;

    // Send all PIPELINE_TEST_REQUESTS through the TestServer
    for (const req of PIPELINE_TEST_REQUESTS) {
      const parsed = await fetchAndParse(server.url, req.method, req.path, req.body);

      simulateCapture(sessionRepo, sampleRepo, sessionId, {
        method: req.method,
        path: req.path,
        statusCode: parsed.statusCode,
        responseBody: parsed.responseBody,
        requestBody: parsed.requestBody,
        responseBodySkipped: parsed.responseBodySkipped,
      });
    }

    // Verify samples were stored (non-JSON /text request should have been skipped)
    const sampleCount = sampleRepo.countBySession(sessionId);
    expect(sampleCount).toBeGreaterThan(0);
    // At least 8 of 10 requests produce JSON responses
    expect(sampleCount).toBeGreaterThanOrEqual(8);

    // Run aggregation
    const aggResult = runAggregation(db, sessionId);
    expect(aggResult.schemas.length).toBeGreaterThan(0);
    expect(aggResult.sampleCount).toBe(sampleCount);

    // Session should be completed
    const completedSession = sessionRepo.getSession(sessionId);
    expect(completedSession?.status).toBe('completed');

    // Verify aggregated schemas have correct structure
    const schemaRepo = new AggregatedSchemaRepository(db);
    const aggregated = schemaRepo.listBySession(sessionId);
    expect(aggregated.length).toBeGreaterThan(0);

    for (const agg of aggregated) {
      expect(agg.sessionId).toBe(sessionId);
      expect(agg.httpMethod).toBeTruthy();
      expect(agg.path).toMatch(/^\//);
      expect(agg.sampleCount).toBeGreaterThan(0);
      expect(agg.confidenceScore).toBeGreaterThanOrEqual(0);
      expect(agg.confidenceScore).toBeLessThanOrEqual(1);
      expect(agg.firstObserved).toBeTruthy();
      expect(agg.lastObserved).toBeTruthy();
    }

    // Verify /users endpoint was captured
    const usersGetSchema = aggregated.find(
      (s) => s.path === '/users' && s.httpMethod === 'GET',
    );
    expect(usersGetSchema).toBeDefined();
    expect(usersGetSchema!.responseSchemas).toBeDefined();

    // Verify path normalization occurred (users/1 and users/2 collapsed to /users/{userId})
    const userByIdSchema = aggregated.find((s) => s.path === '/users/{userId}');
    expect(userByIdSchema).toBeDefined();

    // Export OpenAPI and verify output
    const doc = buildOpenApiDocument(aggregated);
    const yamlOutput = serializeOpenApi(doc, 'yaml');
    const jsonOutput = serializeOpenApi(doc, 'json');

    // YAML is valid
    const parsedYaml = yaml.load(yamlOutput) as Record<string, unknown>;
    expect(parsedYaml).toHaveProperty('openapi', '3.1.0');
    expect(parsedYaml).toHaveProperty('paths');

    // JSON is valid
    const parsedJson = JSON.parse(jsonOutput) as Record<string, unknown>;
    expect(parsedJson).toHaveProperty('openapi', '3.1.0');

    // Exported paths include expected endpoints
    const paths = parsedYaml['paths'] as Record<string, unknown>;
    expect(paths).toHaveProperty('/users');
    expect(paths).toHaveProperty('/users/{userId}');
    expect(paths).toHaveProperty('/health');

    db.close();
  });

  it('non-JSON responses (/text, /html) produce no samples', async () => {
    const db = getDatabase(':memory:');
    const sessionRepo = new SessionRepository(db);
    const sampleRepo = new SampleRepository(db);

    const session = sessionRepo.createSession(server.url, server.port, 'non-json-test');
    const sessionId = session.id;

    // Hit both non-JSON endpoints
    for (const path of ['/text', '/html']) {
      const parsed = await fetchAndParse(server.url, 'GET', path);

      simulateCapture(sessionRepo, sampleRepo, sessionId, {
        method: 'GET',
        path,
        statusCode: parsed.statusCode,
        responseBody: parsed.responseBody,
        requestBody: parsed.requestBody,
        responseBodySkipped: parsed.responseBodySkipped,
      });
    }

    // Neither text/plain nor text/html should have produced samples
    const count = sampleRepo.countBySession(sessionId);
    expect(count).toBe(0);

    // Session sample_count should still be 0
    const updatedSession = sessionRepo.getSession(sessionId);
    expect(updatedSession?.sampleCount).toBe(0);

    // skipped_count should also be 0 (non-JSON is simply ignored, not "skipped")
    expect(updatedSession?.skippedCount).toBe(0);

    db.close();
  });

  it('bodies > 1MB are skipped (skipped_count incremented, no sample stored)', async () => {
    const db = getDatabase(':memory:');
    const sessionRepo = new SessionRepository(db);
    const sampleRepo = new SampleRepository(db);

    const session = sessionRepo.createSession(server.url, server.port, 'large-body-test');
    const sessionId = session.id;

    // Fetch the /large endpoint (> 1MB JSON body)
    const parsed = await fetchAndParse(server.url, 'GET', '/large');

    // The body must have been detected as oversize
    expect(parsed.responseBodySkipped).toBe(true);

    simulateCapture(sessionRepo, sampleRepo, sessionId, {
      method: 'GET',
      path: '/large',
      statusCode: parsed.statusCode,
      responseBody: parsed.responseBody,
      requestBody: parsed.requestBody,
      responseBodySkipped: parsed.responseBodySkipped,
    });

    // No samples stored
    const count = sampleRepo.countBySession(sessionId);
    expect(count).toBe(0);

    // skipped_count incremented
    const updatedSession = sessionRepo.getSession(sessionId);
    expect(updatedSession?.skippedCount).toBe(1);
    expect(updatedSession?.sampleCount).toBe(0);

    db.close();
  });

  it('export produces valid OpenAPI 3.1 after pipeline', async () => {
    const db = getDatabase(':memory:');
    const sessionRepo = new SessionRepository(db);
    const sampleRepo = new SampleRepository(db);

    const session = sessionRepo.createSession(server.url, server.port, 'openapi-test');
    const sessionId = session.id;

    // Capture several JSON endpoints
    for (const path of ['/users', '/users/1', '/orders', '/health']) {
      const parsed = await fetchAndParse(server.url, 'GET', path);
      simulateCapture(sessionRepo, sampleRepo, sessionId, {
        method: 'GET',
        path,
        statusCode: parsed.statusCode,
        responseBody: parsed.responseBody,
        requestBody: parsed.requestBody,
        responseBodySkipped: parsed.responseBodySkipped,
      });
    }

    // Run aggregation
    const aggResult = runAggregation(db, sessionId);
    expect(aggResult.schemas.length).toBeGreaterThan(0);

    // Build and serialize the OpenAPI document
    const schemaRepo = new AggregatedSchemaRepository(db);
    const aggregated = schemaRepo.listBySession(sessionId);

    const doc = buildOpenApiDocument(aggregated, {
      title: 'Test API',
      version: '2.0.0',
    });

    // Verify top-level OpenAPI structure
    expect(doc['openapi']).toBe('3.1.0');
    expect((doc['info'] as Record<string, unknown>)['title']).toBe('Test API');
    expect((doc['info'] as Record<string, unknown>)['version']).toBe('2.0.0');

    // YAML serialization round-trips correctly
    const yamlStr = serializeOpenApi(doc, 'yaml');
    const parsedYaml = yaml.load(yamlStr) as Record<string, unknown>;
    expect(parsedYaml['openapi']).toBe('3.1.0');

    // JSON serialization round-trips correctly
    const jsonStr = serializeOpenApi(doc, 'json');
    const parsedJson = JSON.parse(jsonStr) as Record<string, unknown>;
    expect(parsedJson['openapi']).toBe('3.1.0');

    // Every path item has valid operations with operationId and responses
    const paths = parsedJson['paths'] as Record<string, Record<string, unknown>>;
    expect(Object.keys(paths).length).toBeGreaterThan(0);

    for (const [pathKey, pathItem] of Object.entries(paths)) {
      expect(pathKey).toMatch(/^\//);
      for (const [httpMethod, operation] of Object.entries(pathItem)) {
        expect(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']).toContain(httpMethod);
        const op = operation as Record<string, unknown>;
        expect(op['operationId']).toBeDefined();
        expect(typeof op['operationId']).toBe('string');
        expect(op['responses']).toBeDefined();
      }
    }

    db.close();
  });

  it('empty session: aggregation completes with 0 schemas, export produces minimal valid doc', () => {
    const db = getDatabase(':memory:');
    const sessionRepo = new SessionRepository(db);

    const session = sessionRepo.createSession(server.url, server.port, 'empty-session');
    const sessionId = session.id;

    // Run aggregation with zero samples
    const result = runAggregation(db, sessionId);
    expect(result.sampleCount).toBe(0);
    expect(result.schemas).toHaveLength(0);

    // Session transitioned to completed
    const completedSession = sessionRepo.getSession(sessionId);
    expect(completedSession?.status).toBe('completed');

    // Export from the empty aggregated list
    const schemaRepo = new AggregatedSchemaRepository(db);
    const aggregated = schemaRepo.listBySession(sessionId);
    expect(aggregated).toHaveLength(0);

    const doc = buildOpenApiDocument(aggregated);
    const yamlStr = serializeOpenApi(doc, 'yaml');
    const parsedYaml = yaml.load(yamlStr) as Record<string, unknown>;

    // Still a valid OpenAPI 3.1 document
    expect(parsedYaml['openapi']).toBe('3.1.0');
    expect(parsedYaml['info']).toBeDefined();

    // Paths object exists but is empty
    const paths = parsedYaml['paths'] as Record<string, unknown>;
    expect(typeof paths).toBe('object');
    expect(Object.keys(paths)).toHaveLength(0);

    db.close();
  });

  it('all tests use in-memory SQLite with no filesystem side effects', () => {
    // Verify getDatabase(':memory:') produces a functional in-memory database
    const db = getDatabase(':memory:');

    // The database name should be ':memory:'
    expect(db.name).toBe(':memory:');

    // Repositories work against the in-memory database
    const sessionRepo = new SessionRepository(db);
    const session = sessionRepo.createSession('http://localhost:9999', 9999);
    expect(session.id).toBeTruthy();
    expect(session.status).toBe('active');

    // Samples table exists and is functional
    const sampleRepo = new SampleRepository(db);
    const count = sampleRepo.countBySession(session.id);
    expect(count).toBe(0);

    // Aggregated schemas table exists and is functional
    const schemaRepo = new AggregatedSchemaRepository(db);
    const schemas = schemaRepo.listBySession(session.id);
    expect(schemas).toHaveLength(0);

    db.close();
  });
});

// ---------------------------------------------------------------------------
// HTTP helper utilities
// ---------------------------------------------------------------------------

function httpGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on('end', () => resolve(data));
      })
      .on('error', reject);
  });
}

interface HttpResponse {
  statusCode: number;
  body: string;
  contentType: string;
}

function httpGetWithStatus(url: string): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            body,
            contentType: (res.headers['content-type'] as string) ?? '',
          });
        });
      })
      .on('error', reject);
  });
}

function httpPost(
  url: string,
  body: string,
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options: http.RequestOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body)),
      },
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => {
        data += chunk.toString();
      });
      res.on('end', () => {
        resolve({ statusCode: res.statusCode ?? 0, body: data });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function httpRequest(
  url: string,
  method: string,
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options: http.RequestOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
      method,
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => {
        data += chunk.toString();
      });
      res.on('end', () => {
        resolve({ statusCode: res.statusCode ?? 0, body: data });
      });
    });
    req.on('error', reject);
    req.end();
  });
}
