// Body buffering and header capture — owned by Proxy Engineer

import * as http from 'node:http';
import { captureHeaders } from './headers.js';
import type { HeaderEntry } from '../types/index.js';

/** Maximum body size to buffer for inference (1 MiB) */
export const MAX_BODY_BYTES = 1_048_576; // 1MB

/**
 * A captured request/response pair ready for schema inference.
 *
 * Bodies are only populated when:
 * - The Content-Type is application/json
 * - The body size is <= MAX_BODY_BYTES
 *
 * `requestBodySkipped` / `responseBodySkipped` are set true when the body
 * exceeded 1MB (so the caller can increment `session.skipped_count`).
 */
export interface CapturedPair {
  /** HTTP method (GET, POST, etc.) */
  method: string;
  /** Raw request URL including query string */
  url: string;
  /** HTTP response status code */
  statusCode: number;
  /** Structural request headers */
  requestHeaders: HeaderEntry[] | undefined;
  /** Structural response headers */
  responseHeaders: HeaderEntry[] | undefined;
  /**
   * Parsed request body JSON value, or undefined if:
   * - Not application/json
   * - Body exceeded 1MB
   * - Body was empty
   * - JSON parse failed
   */
  requestBody: unknown | undefined;
  /**
   * Parsed response body JSON value, or undefined if:
   * - Not application/json
   * - Body exceeded 1MB
   * - Body was empty
   * - JSON parse failed
   */
  responseBody: unknown | undefined;
  /** True if the request body was skipped because it exceeded MAX_BODY_BYTES */
  requestBodySkipped: boolean;
  /** True if the response body was skipped because it exceeded MAX_BODY_BYTES */
  responseBodySkipped: boolean;
  /** ISO 8601 timestamp of capture */
  capturedAt: string;
}

interface CapturedResponse {
  body: unknown | undefined;
  skipped: boolean;
  headers: HeaderEntry[] | undefined;
}

/**
 * Returns true if the Content-Type header value indicates JSON.
 * Handles parameters like `application/json; charset=utf-8`.
 */
function isJsonContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const base = contentType.split(';')[0].trim().toLowerCase();
  return base === 'application/json';
}

/**
 * Buffer a readable stream up to `maxBytes`. Resolves with:
 * - `{ data: Buffer }` — if total size <= maxBytes
 * - `{ skipped: true }` — if a chunk pushed the buffer past maxBytes
 *
 * The stream must still be consumed regardless; callers that use this for
 * request bodies should ensure the original stream is not re-read.
 */
async function bufferStream(
  stream: NodeJS.ReadableStream,
  maxBytes: number,
): Promise<{ data: Buffer } | { skipped: true }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let oversize = false;

    stream.on('data', (chunk: Buffer) => {
      if (oversize) return; // drain but stop accumulating
      total += chunk.length;
      if (total > maxBytes) {
        oversize = true;
        chunks.length = 0; // free memory
        return;
      }
      chunks.push(chunk);
    });

    stream.on('end', () => {
      if (oversize) {
        resolve({ skipped: true });
      } else {
        resolve({ data: Buffer.concat(chunks) });
      }
    });

    stream.on('error', reject);
  });
}

/**
 * Safely parse a Buffer as JSON. Returns the parsed value, or undefined on failure.
 */
function tryParseJson(buf: Buffer): unknown | undefined {
  if (buf.length === 0) return undefined;
  try {
    return JSON.parse(buf.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Buffer a request body (POST, PUT, PATCH) from the incoming request stream.
 *
 * The stream is consumed directly. If the body > 1MB or Content-Type is not
 * application/json, the body is still consumed but not stored.
 *
 * Returns:
 * - `body`: parsed JSON value, or undefined
 * - `skipped`: true if body exceeded 1MB
 */
async function captureRequestBody(
  req: http.IncomingMessage,
): Promise<{ body: unknown | undefined; skipped: boolean }> {
  const method = (req.method ?? '').toUpperCase();
  const hasBody = ['POST', 'PUT', 'PATCH'].includes(method);
  if (!hasBody) return { body: undefined, skipped: false };

  const contentType = req.headers['content-type'];
  const isJson = isJsonContentType(contentType);

  const result = await bufferStream(req, MAX_BODY_BYTES);

  if ('skipped' in result) {
    return { body: undefined, skipped: true };
  }

  if (!isJson) {
    return { body: undefined, skipped: false };
  }

  return { body: tryParseJson(result.data), skipped: false };
}

/**
 * Intercept a response, lazily detecting content-type when writeHead is called.
 * Uses a single interception layer (no double-patching).
 *
 * Returns a promise that resolves with the captured body after res.end().
 */
function interceptResponseBodyLazy(res: http.ServerResponse): Promise<CapturedResponse> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let oversize = false;
    let isJson = false;
    let contentTypeKnown = false;
    let responseHeaders: HeaderEntry[] | undefined;

    const originalWrite = res.write.bind(res) as typeof res.write;
    const originalEnd = res.end.bind(res) as typeof res.end;
    const originalWriteHead = res.writeHead.bind(res) as typeof res.writeHead;

    function setContentType(ctStr: string | undefined): void {
      if (contentTypeKnown) return;
      contentTypeKnown = true;
      isJson = isJsonContentType(ctStr);
    }

    function detectContentType(): void {
      if (contentTypeKnown) return;
      // Try res.getHeader (works for headers set via setHeader, not writeHead args)
      const ct = res.getHeader('content-type');
      const ctStr = Array.isArray(ct) ? ct[0] : (ct as string | undefined);
      setContentType(ctStr);
    }

    // Observe effective protocol headers on transient copies; retain metadata only.
    res.writeHead = function patchedWriteHead(
      ...args: [
        number,
        (string | http.OutgoingHttpHeaders | http.OutgoingHttpHeader[])?,
        (http.OutgoingHttpHeaders | http.OutgoingHttpHeader[])?,
      ]
    ): http.ServerResponse {
      res.writeHead = originalWriteHead;
      // Forward first, outside the projection catch: preserve Node's argument
      // count, return value and protocol errors, even if metadata capture fails.
      const result = Reflect.apply(originalWriteHead, res, args) as http.ServerResponse;
      try {
        const effective: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
        const supplied = typeof args[1] === 'string' ? args[2] : (args[1] ?? args[2]);
        if (Array.isArray(supplied)) {
          const explicit = new Map<string, http.OutgoingHttpHeader[]>();
          for (let i = 0; i + 1 < supplied.length; i += 2) {
            const name = supplied[i];
            if (typeof name !== 'string') continue;
            const key = name.toLowerCase();
            const values = explicit.get(key) ?? [];
            values.push(supplied[i + 1]);
            explicit.set(key, values);
          }
          for (const [name, values] of explicit) effective[name] = values.flat();
        } else if (supplied) {
          for (const [name, value] of Object.entries(supplied))
            effective[name.toLowerCase()] = value;
        }
        // Node's final cache is authoritative when setHeader caused writeHead
        // to cache explicit headers, including duplicate raw-array values.
        for (const [name, value] of Object.entries(res.getHeaders()))
          effective[name.toLowerCase()] = value;
        const ct = effective['content-type'];
        setContentType(typeof ct === 'string' ? ct : Array.isArray(ct) ? ct[0] : undefined);
        responseHeaders = captureHeaders(effective);
      } catch {
        responseHeaders = undefined;
      }
      return result;
    } as typeof res.writeHead;

    function accumulate(chunk: unknown, encoding?: BufferEncoding): void {
      if (!isJson || oversize) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string, encoding ?? 'utf8');
      total += buf.length;
      if (total > MAX_BODY_BYTES) {
        oversize = true;
        chunks.length = 0;
      } else {
        chunks.push(buf);
      }
    }

    res.write = function patchedWrite(
      chunk: unknown,
      encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
      cb?: (err?: Error | null) => void,
    ): boolean {
      detectContentType();
      accumulate(chunk, typeof encodingOrCb === 'string' ? encodingOrCb : undefined);

      if (typeof encodingOrCb === 'function') {
        return originalWrite(chunk as string, encodingOrCb);
      }
      if (typeof encodingOrCb === 'string' && cb) {
        return originalWrite(chunk as string, encodingOrCb, cb);
      }
      if (typeof encodingOrCb === 'string') {
        return originalWrite(chunk as string, encodingOrCb);
      }
      return originalWrite(chunk as Buffer);
    } as typeof res.write;

    res.end = function patchedEnd(
      chunkOrCb?: unknown,
      encodingOrCb?: BufferEncoding | (() => void),
      cb?: () => void,
    ): http.ServerResponse {
      detectContentType();

      if (chunkOrCb && typeof chunkOrCb !== 'function') {
        accumulate(chunkOrCb, typeof encodingOrCb === 'string' ? encodingOrCb : undefined);
      }

      // Compute result before restoring originals
      if (oversize) {
        resolve({
          body: undefined,
          skipped: true,
          get headers() {
            return responseHeaders;
          },
        });
      } else {
        const combined = Buffer.concat(chunks);
        resolve({
          body: isJson ? tryParseJson(combined) : undefined,
          skipped: false,
          get headers() {
            return responseHeaders;
          },
        });
      }

      // Restore originals
      res.write = originalWrite;
      res.end = originalEnd;

      if (typeof chunkOrCb === 'function') {
        return originalEnd(chunkOrCb);
      }
      if (typeof encodingOrCb === 'function') {
        return originalEnd(chunkOrCb as string, encodingOrCb);
      }
      if (typeof encodingOrCb === 'string' && cb) {
        return originalEnd(chunkOrCb as string, encodingOrCb, cb);
      }
      if (typeof encodingOrCb === 'string') {
        return originalEnd(chunkOrCb as string, encodingOrCb);
      }
      if (chunkOrCb !== undefined) {
        return originalEnd(chunkOrCb as Buffer);
      }
      return originalEnd();
    } as typeof res.end;
  });
}

/**
 * Capture a request/response pair for schema inference.
 *
 * Usage in the proxy server's request handler:
 *
 *   const pair = await captureRequestResponse(req, res);
 *   // pair is available immediately after the response finishes
 *   // Inference and storage can then run post-response
 *
 * IMPORTANT: This must be called BEFORE the proxy forwards the request,
 * because it wraps res.write/res.end to intercept the response body.
 * The response is NEVER delayed — bytes flow to the client in real time.
 */
export async function captureRequestResponse(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<CapturedPair> {
  const capturedAt = new Date().toISOString();
  const requestHeaders = captureHeaders(req.headers);

  // Intercept response body with lazy content-type detection (single patch layer)
  const responseBodyPromise = interceptResponseBodyLazy(res);

  // Set up finish listener BEFORE any await — the await yields to microtask queue
  // and res.end() may fire before we re-enter this function.
  const finishPromise = new Promise<void>((resolve) => {
    res.on('finish', () => resolve());
  });

  // Capture request body (drains the request stream) — may yield via await
  const { body: requestBody, skipped: requestBodySkipped } = await captureRequestBody(req);

  // Wait for the response to finish, then collect everything
  await finishPromise;

  const {
    body: responseBody,
    skipped: responseBodySkipped,
    headers: responseHeaders,
  } = await responseBodyPromise;

  return {
    method: req.method ?? 'GET',
    url: req.url ?? '/',
    statusCode: res.statusCode,
    requestHeaders,
    responseHeaders,
    requestBody,
    responseBody,
    requestBodySkipped,
    responseBodySkipped,
    capturedAt,
  };
}
