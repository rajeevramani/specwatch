import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import * as headersModule from '../../src/proxy/headers.js';
import { captureRequestResponse, type CapturedPair } from '../../src/proxy/middleware.js';
import { mergeHeaders } from '../../src/aggregation/pipeline.js';
import { buildOpenApiDocument } from '../../src/export/openapi.js';
import { buildJsonExport } from '../../src/export/json.js';
import type { AggregatedSchema, HeaderEntry } from '../../src/types/index.js';
import { getDatabase } from '../../src/storage/database.js';
import { MIGRATIONS } from '../../src/storage/migrations.js';
import type Database from 'better-sqlite3';
import { buildInvestigationPrompt, buildSystemPrompt } from '../../src/llm/prompts.js';
import type { CallInvestigation } from '../../src/analysis/investigation.js';

const SENTINEL = 'HEADER_ONLY_SYNTHETIC_SENTINEL';
const asHeaders = (input: unknown) => input as HeaderEntry[];
function schema(path: string, requestHeaders: HeaderEntry[]): AggregatedSchema {
  return {
    id: 1,
    sessionId: 'privacy-unit',
    httpMethod: 'GET',
    path,
    version: 1,
    snapshot: 1,
    sampleCount: 2,
    confidenceScore: 0.8,
    firstObserved: '2026-01-01T00:00:00Z',
    lastObserved: '2026-01-01T00:00:01Z',
    requestHeaders,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('strict header privacy contract', () => {
  it('closes the newly opened database when its v4 migration fails', () => {
    let opened: Database.Database | undefined;
    vi.spyOn(MIGRATIONS[3], 'up').mockImplementation((db) => {
      opened = db;
      throw new Error('Invalid stored header metadata.');
    });
    expect(() => getDatabase(':memory:')).toThrow('Invalid stored header metadata.');
    expect(opened).toBeDefined();
    expect(opened!.open).toBe(false);
  });

  it('classifies array-valued auth without retaining credentials', () => {
    expect(
      headersModule.captureHeaders({ authorization: [`Bearer ${SENTINEL}`, `Basic ${SENTINEL}`] }),
    ).toEqual([{ name: 'authorization', authSchemes: ['basic', 'bearer'] }]);
  });

  it('explanation prompts ignore injected header fields without accessing them', () => {
    const investigation = {
      operationKey: 'GET /fixture',
      primaryCause: 'unknown',
      occurrences: [],
      pairAnalyses: [],
      get requestHeaders() {
        throw new Error('must not access raw header metadata');
      },
      responseHeaders: [{ name: 'x-custom', example: SENTINEL }],
    } as unknown as CallInvestigation;
    const prompt = buildSystemPrompt() + buildInvestigationPrompt(investigation);
    expect(prompt).toContain('GET /fixture');
    expect(prompt).not.toContain(SENTINEL);
  });

  it('OpenAPI direct callers cannot inject legacy examples through getters', () => {
    const headers = asHeaders([
      {
        name: 'Authorization',
        authSchemes: ['basic', 'bearer'],
        get example() {
          throw new Error('legacy getter');
        },
      },
    ]);
    const doc = buildOpenApiDocument([schema('/one', headers)], { includeMetadata: true });
    expect(() => JSON.stringify(doc)).not.toThrow();
    expect((doc.components as { securitySchemes: unknown }).securitySchemes).toEqual({
      bearerAuth: { type: 'http', scheme: 'bearer' },
      basicAuth: { type: 'http', scheme: 'basic' },
    });
  });
  it('captures names and known auth classifications, never header values', () => {
    const input = {
      Authorization: `Bearer ${SENTINEL}`,
      'X-Custom': SENTINEL,
      Cookie: SENTINEL,
      'Set-Cookie': [SENTINEL],
      Location: `/${SENTINEL}`,
      'X-Count': 42,
      'X-Empty': '',
      Connection: 'close',
      Host: 'localhost',
    };
    const result = headersModule.captureHeaders(input);
    expect(result).toEqual([
      { name: 'authorization', authSchemes: ['bearer'] },
      { name: 'cookie' },
      { name: 'location' },
      { name: 'set-cookie' },
      { name: 'x-count' },
      { name: 'x-custom' },
      { name: 'x-empty' },
    ]);
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
    expect(input.Authorization).toBe(`Bearer ${SENTINEL}`);
  });

  it.each(['BearerSentinel token', 'Custom token', 'Bearer ', 'Basic'])(
    'never stores unknown/incomplete scheme %s',
    (value) => {
      expect(headersModule.captureHeaders({ authorization: value })).toEqual([
        { name: 'authorization' },
      ]);
    },
  );

  it('unions known auth schemes while dropping legacy fields without reading them', () => {
    const legacy = {
      name: 'Authorization',
      authSchemes: ['bearer'],
      get example() {
        throw new Error('must not read legacy value');
      },
    };
    const result = mergeHeaders([
      asHeaders([legacy, { name: 'X-Custom', value: SENTINEL }]),
      asHeaders([{ name: 'authorization', authSchemes: ['basic', 'arbitrary', 'bearer'] }]),
    ]);
    expect(result).toEqual([
      { name: 'authorization', authSchemes: ['basic', 'bearer'] },
      { name: 'x-custom' },
    ]);
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  it.each([false, true])(
    'exports shared header presence without values (metadata=%s)',
    (includeMetadata) => {
      const unsafe = asHeaders([{ name: 'X-Custom', example: SENTINEL, extra: SENTINEL }]);
      const doc = buildOpenApiDocument([schema('/one', unsafe), schema('/two', unsafe)], {
        includeMetadata,
      });
      for (const path of ['/one', '/two']) {
        expect(
          (doc.paths as Record<string, { get: { parameters: unknown[] } }>)[path].get.parameters,
        ).toContainEqual({
          name: 'x-custom',
          in: 'header',
          required: false,
          schema: { type: 'string' },
        });
      }
      expect(JSON.stringify(doc)).not.toContain(SENTINEL);
      expect(JSON.stringify(doc)).not.toContain('"example"');
      if (includeMetadata)
        expect(doc['x-specwatch-global-headers']).toEqual([{ name: 'x-custom' }]);
    },
  );

  it('raw JSON projection never reads example accessors or propagates unknown fields', () => {
    const unsafe = asHeaders([
      {
        name: 'X-Custom',
        secret: SENTINEL,
        get example() {
          throw new Error('legacy getter');
        },
      },
    ]);
    const data = buildJsonExport([schema('/one', unsafe)]);
    expect(() => JSON.stringify(data)).not.toThrow();
    expect((data.schemas as Array<{ requestHeaders: unknown }>)[0].requestHeaders).toEqual([
      { name: 'x-custom' },
    ]);
  });
});

async function realCapture(write: (res: http.ServerResponse) => void) {
  let resolvePair!: (pair: CapturedPair) => void;
  let rejectPair!: (error: unknown) => void;
  const pairPromise = new Promise<CapturedPair>((resolve, reject) => {
    resolvePair = resolve;
    rejectPair = reject;
  });
  void pairPromise.catch(() => undefined);
  const server = http.createServer((req, res) => {
    void captureRequestResponse(req, res).then(resolvePair, rejectPair);
    write(res);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address() as { port: number };
    const client = await new Promise<{
      status: number;
      headers: http.IncomingHttpHeaders;
      rawHeaders: string[];
      body: string;
    }>((resolve, reject) => {
      http
        .get(`http://127.0.0.1:${address.port}/fixture`, { agent: false }, (res) => {
          let body = '';
          res.on('data', (chunk) => {
            body += chunk;
          });
          res.on('end', () =>
            resolve({
              status: res.statusCode!,
              headers: res.headers,
              rawHeaders: res.rawHeaders,
              body,
            }),
          );
          res.on('error', reject);
        })
        .on('error', reject);
    });
    return { client, pair: await pairPromise };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

describe('real response header capture, not the writeHead mock', () => {
  it.each(['object', 'raw-array'])(
    'keeps only effective auth/content-type after %s overrides',
    async (variant) => {
      const { pair, client } = await realCapture((res) => {
        res.setHeader('Authorization', `Bearer ${SENTINEL}`);
        res.setHeader('Content-Type', 'text/plain');
        if (variant === 'object')
          res.writeHead(200, {
            Authorization: `Basic ${SENTINEL}`,
            'Content-Type': 'application/json',
          });
        else
          res.writeHead(200, [
            'Authorization',
            `Basic ${SENTINEL}`,
            'Content-Type',
            'application/json',
          ]);
        res.end('{"ok":true}');
      });
      expect(client.headers.authorization).toBe(`Basic ${SENTINEL}`);
      expect(pair.responseHeaders).toContainEqual({
        name: 'authorization',
        authSchemes: ['basic'],
      });
      expect(pair.responseBody).toEqual({ ok: true });
    },
  );

  it('preserves native duplicate-header semantics on the active Node runtime', async () => {
    const write = (res: http.ServerResponse, native = false) => {
      res.setHeader('Authorization', 'prior');
      const headers = [
        'Authorization',
        `Bearer ${SENTINEL}`,
        'Authorization',
        `Basic ${SENTINEL}`,
        'Content-Type',
        'text/plain',
        'Content-Type',
        'application/json',
      ];
      // Native control bypasses our instance wrapper. Node20 and Node22 differ:
      // cached raw-array duplicates are last-wins on 20, repeated on 22.
      if (native) http.ServerResponse.prototype.writeHead.call(res, 200, headers);
      else res.writeHead(200, headers);
      res.end('{"ok":true}');
    };
    const control = await realCapture((res) => write(res, true));
    const { pair, client } = await realCapture((res) => write(res));
    expect(client.headers.authorization).toBe(control.client.headers.authorization);
    expect(client.headers['content-type']).toBe(control.client.headers['content-type']);
    const authValues = (raw: string[]) =>
      raw.flatMap((name, index) =>
        index % 2 === 0 && name.toLowerCase() === 'authorization' ? [raw[index + 1]] : [],
      );
    expect(authValues(client.rawHeaders)).toEqual(authValues(control.client.rawHeaders));
    const schemes = [
      ...new Set(
        authValues(control.client.rawHeaders).map((value) => value.split(' ')[0].toLowerCase()),
      ),
    ].sort();
    expect(pair.responseHeaders).toContainEqual({ name: 'authorization', authSchemes: schemes });
    expect(pair.responseBody).toEqual(
      control.client.headers['content-type'] === 'application/json' ? { ok: true } : undefined,
    );
    expect(client.body).toBe(control.client.body);
  });

  it('does not swallow an original writeHead protocol error', async () => {
    const { client } = await realCapture((res) => {
      expect(() => res.writeHead(99)).toThrow(RangeError);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
    expect(client.status).toBe(200);
  });
  it.each(['object', 'status-message', 'raw-array', 'implicit', 'override'])(
    'observes %s headers and preserves real client bytes',
    async (variant) => {
      const { client, pair } = await realCapture((res) => {
        const values = { 'Content-Type': 'application/json', 'X-Fixture': SENTINEL };
        if (variant === 'implicit')
          for (const [name, value] of Object.entries(values)) res.setHeader(name, value);
        else if (variant === 'status-message') res.writeHead(200, 'OK', values);
        else if (variant === 'raw-array') res.writeHead(200, Object.entries(values).flat());
        else {
          if (variant === 'override') res.setHeader('X-Fixture', 'initial');
          res.writeHead(200, values);
        }
        res.end('{"ok":true}');
      });
      expect(client.body).toBe('{"ok":true}');
      expect(client.headers['x-fixture']).toBe(SENTINEL);
      expect(pair.responseBody).toEqual({ ok: true });
      expect(pair.responseHeaders).toContainEqual({ name: 'x-fixture' });
      expect(JSON.stringify(pair)).not.toContain(SENTINEL);
    },
  );

  it('projection failure cannot prevent a real writeHead response', async () => {
    const writeHead = vi.spyOn(http.ServerResponse.prototype, 'writeHead');
    const original = headersModule.captureHeaders;
    vi.spyOn(headersModule, 'captureHeaders').mockImplementation((input) => {
      if (Object.hasOwn(input, 'x-fixture')) throw new Error('synthetic projection failure');
      return original(input);
    });
    const result = await realCapture((res) => {
      res.setHeader('X-Fixture', SENTINEL);
      res.setHeader('Content-Type', 'application/json');
      expect(res.writeHead(200)).toBe(res);
      res.end('{"ok":true}');
    });
    expect(writeHead).toHaveBeenCalledExactlyOnceWith(200);
    expect(result.client.status).toBe(200);
    expect(result.client.headers['x-fixture']).toBe(SENTINEL);
    expect(result.pair.responseHeaders).toBeUndefined();
  });
});
