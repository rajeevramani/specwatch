// Unit tests for body buffering middleware — owned by Proxy Engineer

import { describe, it, expect } from 'vitest';
import * as http from 'node:http';
import { EventEmitter } from 'node:events';
import { captureRequestResponse, MAX_BODY_BYTES, type CapturedPair } from './middleware.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/**
 * Create a minimal mock IncomingMessage (request).
 * Emits data + end synchronously via setImmediate, simulating a stream.
 */
function makeMockReq(options: {
  method?: string;
  url?: string;
  headers?: http.IncomingHttpHeaders;
  body?: Buffer | string | null;
}): http.IncomingMessage {
  const emitter = new EventEmitter() as http.IncomingMessage;
  Object.assign(emitter, {
    method: options.method ?? 'GET',
    url: options.url ?? '/',
    headers: options.headers ?? {},
    socket: { setTimeout: () => {} },
  });

  const body = options.body;
  // Emit body asynchronously to simulate a real stream
  setImmediate(() => {
    if (body !== null && body !== undefined && body !== '') {
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(body as string);
      emitter.emit('data', buf);
    }
    emitter.emit('end');
  });

  return emitter;
}

/**
 * Create a minimal mock ServerResponse.
 * Collects written data and emits 'finish' when end() is called.
 */
function makeMockRes(options?: {
  responseHeaders?: Record<string, string>;
}): http.ServerResponse & { writtenChunks: Buffer[] } {
  const emitter = new EventEmitter() as http.ServerResponse & { writtenChunks: Buffer[] };
  const writtenChunks: Buffer[] = [];
  emitter.writtenChunks = writtenChunks;

  let statusCode = 200;
  const headers: Record<string, string | string[] | number> = {
    ...(options?.responseHeaders ?? {}),
  };

  Object.assign(emitter, {
    statusCode,
    headersSent: false,
    getHeader: (name: string) => headers[name.toLowerCase()],
    getHeaders: () => headers,
    setHeader: (name: string, value: string) => {
      headers[name.toLowerCase()] = value;
    },
    writeHead: function (
      code: number,
      reasonOrHdrs?: string | Record<string, string | string[] | number>,
      maybeHdrs?: Record<string, string | string[] | number>,
    ) {
      statusCode = code;
      emitter.statusCode = code;
      const hdrs =
        typeof reasonOrHdrs === 'object' && reasonOrHdrs !== null ? reasonOrHdrs : maybeHdrs;
      if (hdrs) {
        for (const [k, v] of Object.entries(hdrs)) {
          headers[k.toLowerCase()] = v;
        }
      }
      (emitter as { headersSent: boolean }).headersSent = true;
      return emitter;
    },
    write: function (
      chunk: Buffer | string,
      _encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
      _cb?: (err?: Error | null) => void,
    ): boolean {
      writtenChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
      return true;
    },
    end: function (
      chunkOrCb?: Buffer | string | (() => void),
      _encodingOrCb?: BufferEncoding | (() => void),
      _cb?: () => void,
    ): http.ServerResponse {
      if (chunkOrCb && typeof chunkOrCb !== 'function') {
        writtenChunks.push(
          Buffer.isBuffer(chunkOrCb) ? chunkOrCb : Buffer.from(chunkOrCb as string),
        );
      }
      setImmediate(() => emitter.emit('finish'));
      return emitter;
    },
  });

  return emitter;
}

/**
 * Run captureRequestResponse with mocks and fire the response.
 */
async function runCapture(reqOptions: Parameters<typeof makeMockReq>[0], responseOptions: {
  status?: number;
  contentType?: string;
  body?: string;
}): Promise<CapturedPair> {
  const req = makeMockReq(reqOptions);
  const res = makeMockRes();

  const pairPromise = captureRequestResponse(req, res);

  // Simulate the proxy calling writeHead + end after forwarding to upstream
  const respBody = responseOptions.body ?? '';
  const ct = responseOptions.contentType ?? 'text/plain';
  // Use setImmediate so that we don't block the request body drain
  setImmediate(() => {
    (res.writeHead as Function)(responseOptions.status ?? 200, {
      'content-type': ct,
      'content-length': String(Buffer.byteLength(respBody)),
    });
    (res.end as Function)(respBody);
  });

  return pairPromise;
}

// ---------------------------------------------------------------------------
// MAX_BODY_BYTES constant
// ---------------------------------------------------------------------------

describe('MAX_BODY_BYTES', () => {
  it('is exactly 1MB (1048576 bytes)', () => {
    expect(MAX_BODY_BYTES).toBe(1_048_576);
  });
});

// ---------------------------------------------------------------------------
// Request body buffering
// ---------------------------------------------------------------------------

describe('captureRequestResponse — request body', () => {
  it('captures JSON request body for POST', async () => {
    const body = JSON.stringify({ name: 'Alice', age: 30 });
    const pair = await runCapture(
      { method: 'POST', headers: { 'content-type': 'application/json' }, body },
      { body: '{}', contentType: 'application/json' },
    );
    expect(pair.requestBody).toEqual({ name: 'Alice', age: 30 });
    expect(pair.requestBodySkipped).toBe(false);
  });

  it('captures JSON request body for PUT', async () => {
    const body = JSON.stringify({ id: 1, value: 'updated' });
    const pair = await runCapture(
      { method: 'PUT', headers: { 'content-type': 'application/json' }, body },
      { body: '{}', contentType: 'application/json' },
    );
    expect(pair.requestBody).toEqual({ id: 1, value: 'updated' });
  });

  it('captures JSON request body for PATCH', async () => {
    const body = JSON.stringify({ status: 'active' });
    const pair = await runCapture(
      { method: 'PATCH', headers: { 'content-type': 'application/json' }, body },
      { body: '{}', contentType: 'application/json' },
    );
    expect(pair.requestBody).toEqual({ status: 'active' });
  });

  it('does not capture body for GET requests', async () => {
    const pair = await runCapture(
      { method: 'GET' },
      { body: '{}', contentType: 'application/json' },
    );
    expect(pair.requestBody).toBeUndefined();
    expect(pair.requestBodySkipped).toBe(false);
  });

  it('does not capture body for DELETE requests', async () => {
    const pair = await runCapture(
      { method: 'DELETE' },
      { body: '{}', contentType: 'application/json' },
    );
    expect(pair.requestBody).toBeUndefined();
    expect(pair.requestBodySkipped).toBe(false);
  });

  it('returns undefined body for non-JSON content type (XML)', async () => {
    const pair = await runCapture(
      {
        method: 'POST',
        headers: { 'content-type': 'application/xml' },
        body: '<root><name>Alice</name></root>',
      },
      { body: '{}', contentType: 'application/json' },
    );
    expect(pair.requestBody).toBeUndefined();
    expect(pair.requestBodySkipped).toBe(false);
  });

  it('returns undefined body for text/plain content type', async () => {
    const pair = await runCapture(
      { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'plain text' },
      { body: '{}', contentType: 'application/json' },
    );
    expect(pair.requestBody).toBeUndefined();
  });

  it('returns undefined body for empty request body', async () => {
    const pair = await runCapture(
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: null },
      { body: '{}', contentType: 'application/json' },
    );
    expect(pair.requestBody).toBeUndefined();
  });

  it('skips request body exceeding 1MB', async () => {
    // Build a body just over 1MB
    const oversized = Buffer.alloc(MAX_BODY_BYTES + 1, 0x61); // 'a' * (1MB + 1)

    const req = makeMockReq({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    // Override: emit a single large chunk + end
    const origSetImmediate = (req as unknown as { _body: Buffer })._body;
    void origSetImmediate;

    // Rebuild the req to emit our oversized buffer
    const emitter2 = new EventEmitter() as http.IncomingMessage;
    Object.assign(emitter2, {
      method: 'POST',
      url: '/',
      headers: { 'content-type': 'application/json' },
      socket: { setTimeout: () => {} },
    });
    setImmediate(() => {
      emitter2.emit('data', oversized);
      emitter2.emit('end');
    });

    const res = makeMockRes();
    const pairPromise = captureRequestResponse(emitter2, res);
    setImmediate(() => {
      (res.writeHead as Function)(200, { 'content-type': 'application/json' });
      (res.end as Function)('{}');
    });

    const pair = await pairPromise;
    expect(pair.requestBodySkipped).toBe(true);
    expect(pair.requestBody).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Response body buffering
// ---------------------------------------------------------------------------

describe('captureRequestResponse — response body', () => {
  it('captures JSON response body', async () => {
    const responseBody = JSON.stringify({ users: [{ id: 1 }, { id: 2 }] });
    const pair = await runCapture(
      { method: 'GET' },
      { body: responseBody, contentType: 'application/json' },
    );
    expect(pair.responseBody).toEqual({ users: [{ id: 1 }, { id: 2 }] });
    expect(pair.responseBodySkipped).toBe(false);
  });

  it('does not capture non-JSON response body', async () => {
    const pair = await runCapture(
      { method: 'GET' },
      { body: '<html><body>Hello</body></html>', contentType: 'text/html' },
    );
    expect(pair.responseBody).toBeUndefined();
    expect(pair.responseBodySkipped).toBe(false);
  });

  it('does not capture plain text response body', async () => {
    const pair = await runCapture(
      { method: 'GET' },
      { body: 'plain text', contentType: 'text/plain' },
    );
    expect(pair.responseBody).toBeUndefined();
  });

  it('returns undefined for empty JSON response', async () => {
    const pair = await runCapture(
      { method: 'GET' },
      { body: '', contentType: 'application/json' },
    );
    expect(pair.responseBody).toBeUndefined();
  });

  it('skips response body exceeding 1MB', async () => {
    const req = makeMockReq({ method: 'GET' });
    const res = makeMockRes();
    const pairPromise = captureRequestResponse(req, res);

    // Build an oversized buffer
    const oversized = Buffer.alloc(MAX_BODY_BYTES + 1, 0x78); // 'x' * (1MB+1)

    setImmediate(() => {
      (res.writeHead as Function)(200, { 'content-type': 'application/json' });
      // Write in chunks to test accumulation logic
      const half = oversized.slice(0, MAX_BODY_BYTES);
      const rest = oversized.slice(MAX_BODY_BYTES);
      (res.write as Function)(half);
      (res.end as Function)(rest);
    });

    const pair = await pairPromise;
    expect(pair.responseBodySkipped).toBe(true);
    expect(pair.responseBody).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Content-type with charset parameter
// ---------------------------------------------------------------------------

describe('captureRequestResponse — content-type with parameters', () => {
  it('recognises application/json; charset=utf-8 as JSON for request body', async () => {
    const body = JSON.stringify({ ok: true });
    const pair = await runCapture(
      { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, body },
      { body, contentType: 'application/json; charset=utf-8' },
    );
    expect(pair.requestBody).toEqual({ ok: true });
    expect(pair.responseBody).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// Status code and metadata
// ---------------------------------------------------------------------------

describe('captureRequestResponse — metadata', () => {
  it('captures HTTP method', async () => {
    const pair = await runCapture(
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      { body: '{}', contentType: 'application/json' },
    );
    expect(pair.method).toBe('POST');
  });

  it('captures status code', async () => {
    const pair = await runCapture(
      { method: 'GET' },
      { status: 201, body: '{}', contentType: 'application/json' },
    );
    expect(pair.statusCode).toBe(201);
  });

  it('captures URL', async () => {
    const pair = await runCapture(
      { method: 'GET', url: '/users?page=1' },
      { body: '{}', contentType: 'application/json' },
    );
    expect(pair.url).toBe('/users?page=1');
  });

  it('captures ISO 8601 capturedAt timestamp', async () => {
    const pair = await runCapture({ method: 'GET' }, { body: '{}' });
    expect(pair.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

// ---------------------------------------------------------------------------
// Request header capture
// ---------------------------------------------------------------------------

describe('captureRequestResponse — request headers', () => {
  it('captures request headers with redaction', async () => {
    const pair = await runCapture(
      {
        method: 'GET',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer mytoken',
          'x-request-id': 'req-123',
          connection: 'keep-alive', // should be filtered
        },
      },
      { body: '{}', contentType: 'application/json' },
    );
    const map = Object.fromEntries(pair.requestHeaders!.map((h) => [h.name, h.example]));
    expect(map['authorization']).toBe('Bearer ***');
    expect(map['x-request-id']).toBe('req-123');
    expect(map['connection']).toBeUndefined();
  });

  it('returns undefined requestHeaders when no capturable headers', async () => {
    const pair = await runCapture(
      { method: 'GET', headers: { connection: 'keep-alive' } },
      { body: '{}', contentType: 'application/json' },
    );
    expect(pair.requestHeaders).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Non-blocking: response must not be delayed
// ---------------------------------------------------------------------------

describe('captureRequestResponse — non-blocking', () => {
  it('pair resolves after the finish event (response already sent to client)', async () => {
    const req = makeMockReq({ method: 'GET' });
    const res = makeMockRes();

    // Track order of events
    const events: string[] = [];

    const pairPromise = captureRequestResponse(req, res).then((pair) => {
      events.push('pair_resolved');
      return pair;
    });

    setImmediate(() => {
      (res.writeHead as Function)(200, { 'content-type': 'application/json' });
      (res.end as Function)('{"ok":true}');
      events.push('res_end_called');
    });

    const pair = await pairPromise;

    // The pair should resolve after res.end was called
    expect(events).toContain('res_end_called');
    expect(events).toContain('pair_resolved');
    expect(pair.responseBody).toEqual({ ok: true });
  });
});
