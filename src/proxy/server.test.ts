// Unit tests for the reverse proxy server — owned by Proxy Engineer

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import { ProxyServer } from './server.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal HTTP test server that responds with a fixed payload */
function createTestServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ server: http.Server; url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({
        server,
        url: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise((res) => {
            server.close(() => res());
          }),
      });
    });
  });
}

/** Make an HTTP GET request and return status + body */
function httpGet(
  url: string,
  headers?: Record<string, string>,
): Promise<{ statusCode: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options: http.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers,
    };
    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () =>
        resolve({
          statusCode: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString(),
          headers: res.headers,
        }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

/** Make an HTTP request with a body */
function httpRequest(
  method: string,
  url: string,
  body?: string,
  contentType = 'application/json',
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options: http.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method,
      headers: body
        ? {
            'Content-Type': contentType,
            'Content-Length': Buffer.byteLength(body).toString(),
          }
        : {},
    };
    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () =>
        resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
      );
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** Find a free TCP port */
function getFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

// ---------------------------------------------------------------------------
// Port binding
// ---------------------------------------------------------------------------

describe('ProxyServer — port binding', () => {
  let proxy: ProxyServer;
  let upstream: { url: string; close: () => Promise<void> };

  beforeEach(async () => {
    upstream = await createTestServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });

  afterEach(async () => {
    await proxy?.stop();
    await upstream?.close();
  });

  it('starts and listens on the configured port', async () => {
    const port = await getFreePort();
    proxy = new ProxyServer({ targetUrl: upstream.url, port });
    await proxy.start();
    expect(proxy.listenPort).toBe(port);

    const result = await httpGet(`http://127.0.0.1:${port}/`);
    expect(result.statusCode).toBe(200);
  });

  it('rejects when port is already in use', async () => {
    const port = await getFreePort();
    proxy = new ProxyServer({ targetUrl: upstream.url, port });
    await proxy.start();

    const second = new ProxyServer({ targetUrl: upstream.url, port });
    await expect(second.start()).rejects.toThrow();
    // second never started successfully, just clean up proxy
  });
});

// ---------------------------------------------------------------------------
// HTTP method forwarding
// ---------------------------------------------------------------------------

describe('ProxyServer — HTTP method forwarding', () => {
  let proxy: ProxyServer;
  let upstream: { url: string; close: () => Promise<void> };
  let proxyPort: number;
  let capturedMethod: string;

  beforeEach(async () => {
    capturedMethod = '';
    upstream = await createTestServer((req, res) => {
      capturedMethod = req.method ?? '';
      res.writeHead(200);
      res.end('ok');
    });
    proxyPort = await getFreePort();
    proxy = new ProxyServer({ targetUrl: upstream.url, port: proxyPort });
    await proxy.start();
  });

  afterEach(async () => {
    await proxy.stop();
    await upstream.close();
  });

  for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']) {
    it(`forwards ${method} requests`, async () => {
      await httpRequest(method, `http://127.0.0.1:${proxyPort}/test`);
      expect(capturedMethod).toBe(method);
    });
  }
});

// ---------------------------------------------------------------------------
// Query string preservation
// ---------------------------------------------------------------------------

describe('ProxyServer — query string preservation', () => {
  let proxy: ProxyServer;
  let upstream: { url: string; close: () => Promise<void> };
  let proxyPort: number;
  let capturedUrl: string;

  beforeEach(async () => {
    capturedUrl = '';
    upstream = await createTestServer((req, res) => {
      capturedUrl = req.url ?? '';
      res.writeHead(200);
      res.end('ok');
    });
    proxyPort = await getFreePort();
    proxy = new ProxyServer({ targetUrl: upstream.url, port: proxyPort });
    await proxy.start();
  });

  afterEach(async () => {
    await proxy.stop();
    await upstream.close();
  });

  it('preserves query string parameters', async () => {
    await httpGet(`http://127.0.0.1:${proxyPort}/users?page=2&limit=10`);
    expect(capturedUrl).toBe('/users?page=2&limit=10');
  });

  it('preserves encoded query parameters', async () => {
    await httpGet(`http://127.0.0.1:${proxyPort}/search?q=hello%20world&sort=asc`);
    expect(capturedUrl).toBe('/search?q=hello%20world&sort=asc');
  });
});

// ---------------------------------------------------------------------------
// HTTPS upstream support
// ---------------------------------------------------------------------------

describe('ProxyServer — HTTPS upstream configuration', () => {
  it('creates proxy with secure: true for HTTPS targets', async () => {
    // We verify the proxy accepts HTTPS target URLs without throwing at construction/start.
    // We cannot actually make TLS connections to a local server in unit tests without
    // full certificate setup, so we test the error handling path instead.
    const port = await getFreePort();
    const proxy = new ProxyServer({
      targetUrl: 'https://127.0.0.1:1', // port 1 — will fail to connect
      port,
      timeout: 1000,
    });
    await proxy.start();

    try {
      const result = await httpGet(`http://127.0.0.1:${port}/`);
      // Should get a 502 Bad Gateway or 504 from the proxy
      expect([502, 504]).toContain(result.statusCode);
    } finally {
      await proxy.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Target error handling (502/504)
// ---------------------------------------------------------------------------

describe('ProxyServer — target error handling', () => {
  let proxyPort: number;
  let proxy: ProxyServer;

  afterEach(async () => {
    await proxy?.stop();
  });

  it('returns 502 when target is unreachable', async () => {
    proxyPort = await getFreePort();
    proxy = new ProxyServer({
      targetUrl: 'http://127.0.0.1:1', // nothing listening on port 1
      port: proxyPort,
      timeout: 2000,
    });
    await proxy.start();

    const result = await httpGet(`http://127.0.0.1:${proxyPort}/`);
    expect([502, 504]).toContain(result.statusCode);
  });
});

// ---------------------------------------------------------------------------
// Target timeout handling
// ---------------------------------------------------------------------------

describe('ProxyServer — target timeout', () => {
  let proxy: ProxyServer;
  let upstream: { url: string; server: http.Server; close: () => Promise<void> };
  let proxyPort: number;

  afterEach(async () => {
    await proxy?.stop();
    await upstream?.close();
  });

  it('returns 504 or connection reset when upstream hangs past the timeout', async () => {
    // Upstream that never responds
    upstream = await createTestServer((_req, _res) => {
      // intentionally hang — never call res.end()
    });

    proxyPort = await getFreePort();
    proxy = new ProxyServer({
      targetUrl: upstream.url,
      port: proxyPort,
      timeout: 500, // 500ms — short for test speed
    });
    await proxy.start();

    // http-proxy may either send a 504 response OR reset the socket depending on
    // whether response headers have been flushed. Both are valid timeout behaviours.
    try {
      const result = await httpGet(`http://127.0.0.1:${proxyPort}/slow`);
      expect([502, 504]).toContain(result.statusCode);
    } catch (err: unknown) {
      // ECONNRESET means the proxy destroyed the socket on timeout — also acceptable
      const code = (err as NodeJS.ErrnoException).code;
      expect(code).toBe('ECONNRESET');
    }
  });
});

// ---------------------------------------------------------------------------
// Custom header forwarding
// ---------------------------------------------------------------------------

describe('ProxyServer — header forwarding', () => {
  let proxy: ProxyServer;
  let upstream: { url: string; close: () => Promise<void> };
  let proxyPort: number;
  let capturedHeaders: http.IncomingHttpHeaders;

  beforeEach(async () => {
    capturedHeaders = {};
    upstream = await createTestServer((req, res) => {
      capturedHeaders = req.headers;
      res.writeHead(200);
      res.end('ok');
    });
    proxyPort = await getFreePort();
    proxy = new ProxyServer({ targetUrl: upstream.url, port: proxyPort });
    await proxy.start();
  });

  afterEach(async () => {
    await proxy.stop();
    await upstream.close();
  });

  it('forwards custom request headers to the upstream', async () => {
    await httpGet(`http://127.0.0.1:${proxyPort}/`, {
      'X-Custom-Header': 'test-value',
      'X-Request-ID': 'req-123',
    });
    expect(capturedHeaders['x-custom-header']).toBe('test-value');
    expect(capturedHeaders['x-request-id']).toBe('req-123');
  });
});

// ---------------------------------------------------------------------------
// onCapture callback
// ---------------------------------------------------------------------------

describe('ProxyServer — onCapture callback', () => {
  let proxy: ProxyServer;
  let upstream: { url: string; close: () => Promise<void> };
  let proxyPort: number;

  beforeEach(async () => {
    upstream = await createTestServer((_req, res) => {
      res.writeHead(200);
      res.end('{}');
    });
    proxyPort = await getFreePort();
  });

  afterEach(async () => {
    await proxy?.stop();
    await upstream?.close();
  });

  it('fires onCapture after response is sent', async () => {
    let captured = false;
    proxy = new ProxyServer({
      targetUrl: upstream.url,
      port: proxyPort,
      onCapture: () => {
        captured = true;
      },
    });
    await proxy.start();

    await httpGet(`http://127.0.0.1:${proxyPort}/`);
    // Give the event loop a tick for the finish handler
    await new Promise((r) => setTimeout(r, 50));
    expect(captured).toBe(true);
  });

  it('does not crash when onCapture throws', async () => {
    proxy = new ProxyServer({
      targetUrl: upstream.url,
      port: proxyPort,
      onCapture: () => {
        throw new Error('capture error');
      },
    });
    await proxy.start();

    // Should not throw — error in onCapture is swallowed
    const result = await httpGet(`http://127.0.0.1:${proxyPort}/`);
    expect(result.statusCode).toBe(200);
  });
});
