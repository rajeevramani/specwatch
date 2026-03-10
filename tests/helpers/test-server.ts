/**
 * TestServer — a local HTTP server for integration tests.
 *
 * Serves known JSON responses at configurable routes so tests can verify
 * the full capture → inference → storage → export pipeline without making
 * real network requests.
 *
 * Usage:
 *   const server = new TestServer();
 *   await server.start();
 *   // server.url → "http://127.0.0.1:<port>"
 *   await server.stop();
 */

import * as http from 'node:http';
import * as net from 'node:net';
import { AddressInfo } from 'node:net';

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export interface RouteDefinition {
  method: string;
  path: string;
  statusCode: number;
  contentType: string;
  body: string | Buffer;
}

// ---------------------------------------------------------------------------
// Pre-canned response payloads
// ---------------------------------------------------------------------------

/** A list of user objects */
export const USER_LIST_BODY = JSON.stringify([
  {
    id: 1,
    name: 'Alice',
    email: 'alice@example.com',
    createdAt: '2024-01-15T10:30:00Z',
  },
  {
    id: 2,
    name: 'Bob',
    email: 'bob@example.com',
    createdAt: '2024-02-20T09:00:00Z',
  },
]);

/** A single user object */
export const SINGLE_USER_BODY = JSON.stringify({
  id: 1,
  name: 'Alice',
  email: 'alice@example.com',
  profileId: '550e8400-e29b-41d4-a716-446655440000',
  avatarUrl: 'https://example.com/avatar/alice.png',
  birthDate: '1990-01-15',
  lastLogin: '2024-01-15T10:30:00Z',
  ipAddress: '192.168.1.1',
  ipv6Address: '2001:0db8:85a3:0000:0000:8a2e:0370:7334',
  createdAt: '2024-01-15T10:30:00Z',
});

/** Created user (201 response) */
export const CREATED_USER_BODY = JSON.stringify({
  id: 3,
  name: 'Charlie',
  email: 'charlie@example.com',
  createdAt: '2024-03-10T12:00:00Z',
});

/** A 404 not found error body */
export const NOT_FOUND_BODY = JSON.stringify({
  error: 'not_found',
  message: 'User not found',
});

/** A 500 internal server error body */
export const SERVER_ERROR_BODY = JSON.stringify({
  error: 'internal_server_error',
  message: 'Something went wrong',
});

/** A nested object with deep nesting */
export const NESTED_OBJECT_BODY = JSON.stringify({
  user: {
    profile: {
      avatar: {
        url: 'https://example.com/avatar.png',
        dimensions: {
          width: 200,
          height: 200,
        },
      },
    },
  },
});

/** An array of orders */
export const ORDER_LIST_BODY = JSON.stringify([
  { id: 101, userId: 1, total: 99.99, status: 'completed', createdAt: '2024-01-10T08:00:00Z' },
  { id: 102, userId: 1, total: 150.0, status: 'pending', createdAt: '2024-01-12T09:00:00Z' },
]);

/** Mixed-type field response (nullable avatar) */
export const USER_WITH_NULLABLE_AVATAR = JSON.stringify({
  id: 4,
  name: 'Dana',
  avatar: null,
  email: 'dana@example.com',
});

/** Plain text response (non-JSON) */
export const PLAIN_TEXT_BODY = 'OK';

/** HTML response (non-JSON) */
export const HTML_BODY = '<html><body><h1>Hello</h1></body></html>';

/** Generate a body larger than 1MB for skip-testing */
export function generateLargeBody(): string {
  const item = { id: 1, value: 'x'.repeat(100), padding: 'a'.repeat(900) };
  const items = [];
  // 1050 items × ~1000 bytes each ≈ 1.05MB
  for (let i = 0; i < 1050; i++) {
    items.push({ ...item, id: i });
  }
  return JSON.stringify(items);
}

// ---------------------------------------------------------------------------
// Default routes
// ---------------------------------------------------------------------------

/** Build the set of default routes served by the TestServer */
function buildDefaultRoutes(): RouteDefinition[] {
  return [
    // GET /users → list of users
    {
      method: 'GET',
      path: '/users',
      statusCode: 200,
      contentType: 'application/json',
      body: USER_LIST_BODY,
    },
    // POST /users → created user
    {
      method: 'POST',
      path: '/users',
      statusCode: 201,
      contentType: 'application/json',
      body: CREATED_USER_BODY,
    },
    // GET /users/1 → single user
    {
      method: 'GET',
      path: '/users/1',
      statusCode: 200,
      contentType: 'application/json',
      body: SINGLE_USER_BODY,
    },
    // GET /users/999 → 404
    {
      method: 'GET',
      path: '/users/999',
      statusCode: 404,
      contentType: 'application/json',
      body: NOT_FOUND_BODY,
    },
    // GET /users/2 → user with nullable avatar (for union-type testing)
    {
      method: 'GET',
      path: '/users/2',
      statusCode: 200,
      contentType: 'application/json',
      body: USER_WITH_NULLABLE_AVATAR,
    },
    // GET /orders → list of orders
    {
      method: 'GET',
      path: '/orders',
      statusCode: 200,
      contentType: 'application/json',
      body: ORDER_LIST_BODY,
    },
    // GET /nested → deeply nested object
    {
      method: 'GET',
      path: '/nested',
      statusCode: 200,
      contentType: 'application/json',
      body: NESTED_OBJECT_BODY,
    },
    // GET /error → 500 internal server error
    {
      method: 'GET',
      path: '/error',
      statusCode: 500,
      contentType: 'application/json',
      body: SERVER_ERROR_BODY,
    },
    // GET /text → plain text (non-JSON, should be skipped)
    {
      method: 'GET',
      path: '/text',
      statusCode: 200,
      contentType: 'text/plain',
      body: PLAIN_TEXT_BODY,
    },
    // GET /html → HTML (non-JSON, should be skipped)
    {
      method: 'GET',
      path: '/html',
      statusCode: 200,
      contentType: 'text/html',
      body: HTML_BODY,
    },
    // GET /large → body > 1MB (should be skipped for inference)
    {
      method: 'GET',
      path: '/large',
      statusCode: 200,
      contentType: 'application/json',
      body: generateLargeBody(),
    },
    // DELETE /users/1 → 204 No Content
    {
      method: 'DELETE',
      path: '/users/1',
      statusCode: 204,
      contentType: 'application/json',
      body: '',
    },
    // PUT /users/1 → updated user
    {
      method: 'PUT',
      path: '/users/1',
      statusCode: 200,
      contentType: 'application/json',
      body: SINGLE_USER_BODY,
    },
    // PATCH /users/1 → updated user
    {
      method: 'PATCH',
      path: '/users/1',
      statusCode: 200,
      contentType: 'application/json',
      body: SINGLE_USER_BODY,
    },
    // GET /health → simple health check
    {
      method: 'GET',
      path: '/health',
      statusCode: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'ok', uptime: 42 }),
    },
    // GET /auth-required → simulates an endpoint that requires auth headers
    {
      method: 'GET',
      path: '/auth-required',
      statusCode: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: 'secret content', userId: 'abc123' }),
    },
  ];
}

// ---------------------------------------------------------------------------
// TestServer class
// ---------------------------------------------------------------------------

export interface TestServerOptions {
  /** Override the default routes with custom ones */
  routes?: RouteDefinition[];
  /** Additional routes appended to the defaults */
  extraRoutes?: RouteDefinition[];
}

/**
 * A local HTTP server that serves pre-canned JSON (and non-JSON) responses
 * for use in integration tests.
 *
 * The server binds to a random available port on 127.0.0.1.
 * Unrecognized routes return 404 with a JSON error body.
 */
export class TestServer {
  private server: http.Server | null = null;
  private connections = new Set<net.Socket>();
  private readonly routes: RouteDefinition[];
  private _port: number = 0;

  constructor(options: TestServerOptions = {}) {
    if (options.routes !== undefined) {
      this.routes = options.routes;
    } else {
      this.routes = buildDefaultRoutes();
      if (options.extraRoutes) {
        this.routes.push(...options.extraRoutes);
      }
    }
  }

  /** The URL the server is listening on, e.g., "http://127.0.0.1:12345" */
  get url(): string {
    if (!this.server) throw new Error('TestServer is not started');
    return `http://127.0.0.1:${this._port}`;
  }

  /** The port the server is listening on */
  get port(): number {
    if (!this.server) throw new Error('TestServer is not started');
    return this._port;
  }

  /** Start the server and resolve once it is listening */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      this.server.on('connection', (socket) => {
        this.connections.add(socket);
        socket.once('close', () => this.connections.delete(socket));
      });

      // Bind to port 0 to let the OS assign a free port
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address() as AddressInfo;
        this._port = addr.port;
        resolve();
      });

      this.server.once('error', reject);
    });
  }

  /** Stop the server, destroying all open connections */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }

      // Destroy all open connections
      for (const socket of this.connections) {
        socket.destroy();
      }
      this.connections.clear();

      this.server.close(() => {
        this.server = null;
        resolve();
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Request dispatch
  // ---------------------------------------------------------------------------

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const method = (req.method ?? 'GET').toUpperCase();
    // Strip query string before route matching
    const rawPath = req.url ?? '/';
    const path = rawPath.split('?')[0];

    const route = this.routes.find((r) => r.method === method && r.path === path);

    if (!route) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: 'not_found',
          message: `No route matched ${method} ${path}`,
        }),
      );
      return;
    }

    // Consume request body (if any) to avoid connection issues
    req.resume();

    req.on('end', () => {
      const headers: Record<string, string> = {
        'Content-Type': route.contentType,
      };

      if (typeof route.body === 'string' && route.body.length > 0) {
        headers['Content-Length'] = String(Buffer.byteLength(route.body, 'utf8'));
      } else if (Buffer.isBuffer(route.body) && route.body.length > 0) {
        headers['Content-Length'] = String(route.body.length);
      }

      res.writeHead(route.statusCode, headers);

      if (method === 'HEAD') {
        // HEAD responses must not have a body
        res.end();
      } else {
        res.end(route.body);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Convenience factory helpers
// ---------------------------------------------------------------------------

/**
 * Creates, starts, and returns a TestServer along with a cleanup function.
 * Useful in beforeAll/afterAll blocks:
 *
 *   const { server, cleanup } = await createTestServer();
 *   afterAll(cleanup);
 */
export async function createTestServer(
  options: TestServerOptions = {},
): Promise<{ server: TestServer; cleanup: () => Promise<void> }> {
  const server = new TestServer(options);
  await server.start();
  return {
    server,
    cleanup: () => server.stop(),
  };
}
