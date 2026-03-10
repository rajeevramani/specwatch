// HTTP proxy server lifecycle — owned by Proxy Engineer

import * as http from 'node:http';
import * as net from 'node:net';
import httpProxy from 'http-proxy';

/** Configuration options for the ProxyServer */
export interface ProxyServerOptions {
  /** Target URL to proxy to (e.g., "https://api.example.com") */
  targetUrl: string;
  /** Local port to listen on (default: 8080) */
  port?: number;
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Callback invoked after a request/response pair completes (post-forwarding) */
  onCapture?: (req: http.IncomingMessage, res: http.ServerResponse) => void;
}

const DEFAULT_PORT = 8080;
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Reverse proxy server that forwards plain HTTP traffic from localhost to an upstream target.
 *
 * The client always connects via plain HTTP to localhost; the proxy connects to the upstream
 * (which may be HTTPS) via http-proxy with changeOrigin: true and secure: true.
 *
 * Lifecycle:
 *   const proxy = new ProxyServer({ targetUrl: 'https://api.example.com', port: 8080 });
 *   await proxy.start();
 *   // ... traffic flows ...
 *   await proxy.stop();
 */
export class ProxyServer {
  private readonly targetUrl: string;
  private readonly port: number;
  private readonly timeoutMs: number;
  private readonly onCapture?: ProxyServerOptions['onCapture'];

  private proxy: httpProxy | null = null;
  private server: http.Server | null = null;
  /** Track open sockets so we can destroy them on force-quit */
  private connections = new Set<net.Socket>();

  constructor(options: ProxyServerOptions) {
    this.targetUrl = options.targetUrl;
    this.port = options.port ?? DEFAULT_PORT;
    this.timeoutMs = options.timeout ?? DEFAULT_TIMEOUT_MS;
    this.onCapture = options.onCapture;
  }

  /** The port this server is configured to listen on */
  get listenPort(): number {
    return this.port;
  }

  /** Start the proxy server. Resolves once the server is listening. */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.proxy = httpProxy.createProxyServer({
        target: this.targetUrl,
        changeOrigin: true,
        secure: true,
        timeout: this.timeoutMs,
        proxyTimeout: this.timeoutMs,
      });

      // Handle errors from the upstream target
      this.proxy.on('error', (err, req, res) => {
        // res may be a Socket (for ws upgrades) or an http.ServerResponse
        if (res instanceof http.ServerResponse && !res.headersSent) {
          const isTimeout =
            (err as NodeJS.ErrnoException).code === 'ECONNRESET' ||
            err.message.toLowerCase().includes('timeout') ||
            err.message.toLowerCase().includes('socket hang up');

          const statusCode = isTimeout ? 504 : 502;
          const message = isTimeout ? 'Gateway Timeout' : 'Bad Gateway';

          res.writeHead(statusCode, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: message, message: err.message }));
        }
      });

      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      // Track connections for graceful shutdown
      this.server.on('connection', (socket) => {
        this.connections.add(socket);
        socket.once('close', () => this.connections.delete(socket));
      });

      this.server.listen(this.port, '127.0.0.1', () => {
        resolve();
      });

      this.server.once('error', (err) => {
        reject(err);
      });
    });
  }

  /** Handle a single incoming request by proxying it to the upstream target */
  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // Set per-request socket timeout
    req.socket.setTimeout(this.timeoutMs);

    this.proxy!.web(req, res, {
      target: this.targetUrl,
    });

    // Fire onCapture callback after the response finishes, non-blocking
    if (this.onCapture) {
      const capture = this.onCapture;
      res.on('finish', () => {
        try {
          capture(req, res);
        } catch {
          // swallow errors in capture callback — they must not affect the client
        }
      });
    }
  }

  /**
   * Graceful shutdown: stop accepting new connections, wait for in-flight requests
   * to complete (up to drainTimeoutMs), then close the server.
   *
   * Resolves when the server is fully closed.
   */
  stop(drainTimeoutMs = 5_000): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }

      const server = this.server;
      this.server = null;

      // Stop accepting new connections
      server.close(() => {
        resolve();
      });

      // Force-close idle connections after drain timeout
      const drainTimer = setTimeout(() => {
        for (const socket of this.connections) {
          socket.destroy();
        }
        this.connections.clear();
      }, drainTimeoutMs);

      // Don't let the drain timer prevent the process from exiting
      if (drainTimer.unref) drainTimer.unref();
    });
  }

  /** Destroy all open connections immediately (force-quit path) */
  forceClose(): void {
    for (const socket of this.connections) {
      socket.destroy();
    }
    this.connections.clear();

    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Graceful shutdown signal handling (Task 1.7)
// ---------------------------------------------------------------------------

/** Callback type for shutdown notification */
export type ShutdownCallback = (forceQuit: boolean) => Promise<void> | void;

/**
 * Registers SIGINT handlers implementing double-Ctrl+C force-quit semantics.
 *
 * - First SIGINT: calls onShutdown(false), waits for it, exits 0.
 * - Second SIGINT within 2 seconds: calls onShutdown(true), exits 1 immediately.
 *
 * Returns a cleanup function that removes the signal handlers (useful in tests).
 */
export function registerShutdownHandlers(onShutdown: ShutdownCallback): () => void {
  let firstSignalTime: number | null = null;
  let shutdownInProgress = false;

  const handler = () => {
    const now = Date.now();

    // Double Ctrl+C: second signal during an in-progress shutdown,
    // OR a second signal within 2 seconds of the first → force-quit
    const isForceQuit =
      shutdownInProgress ||
      (firstSignalTime !== null && now - firstSignalTime < 2_000);

    if (isForceQuit) {
      process.removeListener('SIGINT', handler);
      Promise.resolve(onShutdown(true)).finally(() => {
        process.exit(1);
      });
      return;
    }

    // First SIGINT — graceful shutdown. Keep the handler registered so a
    // second SIGINT within 2s can trigger the force-quit path.
    firstSignalTime = now;
    shutdownInProgress = true;

    Promise.resolve(onShutdown(false))
      .then(() => {
        process.removeListener('SIGINT', handler);
        process.exit(0);
      })
      .catch(() => {
        process.removeListener('SIGINT', handler);
        process.exit(1);
      });
  };

  process.on('SIGINT', handler);

  // Return cleanup function
  return () => {
    process.removeListener('SIGINT', handler);
  };
}
