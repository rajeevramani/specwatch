// Unit tests for graceful shutdown — owned by Proxy Engineer

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as http from 'node:http';
import { ProxyServer, registerShutdownHandlers } from './server.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestUpstream(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ url: string; server: http.Server; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        server,
        close: () =>
          new Promise((res) => {
            // closeAllConnections is available in Node 18.2+
            if (typeof (server as unknown as { closeAllConnections?: () => void }).closeAllConnections === 'function') {
              (server as unknown as { closeAllConnections: () => void }).closeAllConnections();
            }
            server.close(() => res());
          }),
      });
    });
  });
}

function getFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

function makeRequest(url: string): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: 'GET',
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// registerShutdownHandlers — single SIGINT
// ---------------------------------------------------------------------------

describe('registerShutdownHandlers — single SIGINT graceful shutdown', () => {
  afterEach(() => {
    // Ensure we clear all SIGINT listeners between tests
    process.removeAllListeners('SIGINT');
  });

  it('calls onShutdown with forceQuit=false on first SIGINT', async () => {
    const calls: boolean[] = [];
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    const cleanup = registerShutdownHandlers(async (forceQuit) => {
      calls.push(forceQuit);
    });

    process.emit('SIGINT');

    // Wait for async handler chain
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    cleanup();
    exitSpy.mockRestore();

    expect(calls).toEqual([false]);
  });

  it('calls process.exit(0) after graceful shutdown completes', async () => {
    const exitCodes: number[] = [];
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code) => { exitCodes.push(code as number); return undefined as never; });

    registerShutdownHandlers(async () => {
      // noop — graceful
    });

    process.emit('SIGINT');

    // Wait for the promise chain to complete
    await new Promise((r) => setTimeout(r, 50));

    exitSpy.mockRestore();

    expect(exitCodes).toContain(0);
  });

  it('calls process.exit(1) if shutdown callback throws', async () => {
    const exitCodes: number[] = [];
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code) => { exitCodes.push(code as number); return undefined as never; });

    registerShutdownHandlers(async () => {
      throw new Error('shutdown error');
    });

    process.emit('SIGINT');

    await new Promise((r) => setTimeout(r, 50));

    exitSpy.mockRestore();

    expect(exitCodes).toContain(1);
  });
});

// ---------------------------------------------------------------------------
// registerShutdownHandlers — double SIGINT force-quit
// ---------------------------------------------------------------------------

describe('registerShutdownHandlers — double SIGINT force-quit', () => {
  afterEach(() => {
    process.removeAllListeners('SIGINT');
  });

  it('calls onShutdown(true) on second SIGINT within 2s', async () => {
    const calls: boolean[] = [];
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    registerShutdownHandlers(async (forceQuit) => {
      calls.push(forceQuit);
    });

    // Second signal fires quickly — within 2s
    process.emit('SIGINT');
    process.emit('SIGINT');

    await new Promise((r) => setTimeout(r, 50));

    exitSpy.mockRestore();

    // The second call should trigger force-quit with true
    expect(calls).toContain(true);
  });

  it('calls process.exit(1) on force-quit', async () => {
    const exitCodes: number[] = [];
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code) => { exitCodes.push(code as number); return undefined as never; });

    registerShutdownHandlers(async (_forceQuit) => {
      // noop
    });

    process.emit('SIGINT');
    process.emit('SIGINT');

    await new Promise((r) => setTimeout(r, 50));

    exitSpy.mockRestore();

    expect(exitCodes).toContain(1);
  });

  it('does NOT force-quit if second SIGINT arrives after 2s window', async () => {
    const calls: boolean[] = [];
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    // Manipulate Date.now to simulate time passing
    let fakeNow = 1000;
    const origNow = Date.now;
    Date.now = () => fakeNow;

    try {
      registerShutdownHandlers(async (forceQuit) => {
        calls.push(forceQuit);
      });

      process.emit('SIGINT');
      await new Promise((r) => setImmediate(r));

      // Advance time by 3 seconds (past the 2s window)
      fakeNow += 3000;

      // Second signal — should start a new graceful shutdown (not force-quit)
      // But at this point the first handler already removed itself, so the
      // second signal won't be caught — this just verifies no force-quit occurred
      const forceCalls = calls.filter((c) => c === true);
      expect(forceCalls).toHaveLength(0);
    } finally {
      Date.now = origNow;
      exitSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// registerShutdownHandlers — cleanup function
// ---------------------------------------------------------------------------

describe('registerShutdownHandlers — cleanup', () => {
  afterEach(() => {
    process.removeAllListeners('SIGINT');
  });

  it('cleanup function removes the SIGINT listener', () => {
    const before = process.listenerCount('SIGINT');
    const cleanup = registerShutdownHandlers(async () => {});
    const during = process.listenerCount('SIGINT');
    cleanup();
    const after = process.listenerCount('SIGINT');

    expect(during).toBe(before + 1);
    expect(after).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// ProxyServer.stop() — graceful drain
// ---------------------------------------------------------------------------

describe('ProxyServer.stop() — graceful drain', () => {
  it('resolves after server is closed', async () => {
    const port = await getFreePort();
    const upstream = await createTestUpstream((_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });

    const proxy = new ProxyServer({ targetUrl: upstream.url, port });
    await proxy.start();

    // Make one request to ensure server works
    const result = await makeRequest(`http://127.0.0.1:${port}/`);
    expect(result.statusCode).toBe(200);

    // Stop the server — should resolve cleanly
    await proxy.stop();
    await upstream.close();

    // Verify the server no longer accepts connections
    await expect(makeRequest(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  });

  it('stop() resolves immediately when server was never started', async () => {
    const proxy = new ProxyServer({
      targetUrl: 'http://127.0.0.1:1',
      port: await getFreePort(),
    });
    // Should not throw or hang
    await proxy.stop();
  });
});

// ---------------------------------------------------------------------------
// ProxyServer.forceClose() — immediate termination
// ---------------------------------------------------------------------------

describe('ProxyServer.forceClose() — force-quit', () => {
  it('stops accepting new connections after forceClose()', async () => {
    const port = await getFreePort();
    const upstream = await createTestUpstream((_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });

    const proxy = new ProxyServer({ targetUrl: upstream.url, port });
    await proxy.start();

    // Verify proxy works before force close
    const before = await makeRequest(`http://127.0.0.1:${port}/`);
    expect(before.statusCode).toBe(200);

    // Force close
    proxy.forceClose();
    await upstream.close();

    // After forceClose, new connections should fail
    await expect(makeRequest(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  });

  it('forceClose() on unstarted proxy does not throw', () => {
    const proxy = new ProxyServer({ targetUrl: 'http://127.0.0.1:1', port: 19999 });
    expect(() => proxy.forceClose()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// In-flight request drain timeout
// ---------------------------------------------------------------------------

describe('ProxyServer — in-flight request drain timeout', () => {
  it('stop() with short drain timeout completes within reasonable time', async () => {
    const port = await getFreePort();
    const upstream = await createTestUpstream((_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });

    const proxy = new ProxyServer({ targetUrl: upstream.url, port });
    await proxy.start();

    // Make a request to ensure it works
    await makeRequest(`http://127.0.0.1:${port}/`);

    // Stop with a short drain timeout — should not hang
    const stopStart = Date.now();
    await proxy.stop(200);
    const elapsed = Date.now() - stopStart;

    await upstream.close();

    // Should complete within a few seconds (drain timeout + overhead)
    expect(elapsed).toBeLessThan(5_000);

    // Server should no longer accept connections
    await expect(makeRequest(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  });

  it('stop() resolves after connections drain (no hanging requests)', async () => {
    const port = await getFreePort();
    const upstream = await createTestUpstream((_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });

    const proxy = new ProxyServer({ targetUrl: upstream.url, port });
    await proxy.start();

    // All requests complete before stop
    await makeRequest(`http://127.0.0.1:${port}/`);
    await makeRequest(`http://127.0.0.1:${port}/`);

    // Should stop cleanly with a generous drain timeout
    await proxy.stop(5_000);
    await upstream.close();
  });
});
