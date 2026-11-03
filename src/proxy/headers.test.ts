// Unit tests for header filtering and redaction — owned by Proxy Engineer

import { describe, it, expect } from 'vitest';
import { captureHeaders, isInfrastructureHeader } from './headers.js';

// ---------------------------------------------------------------------------
// isInfrastructureHeader
// ---------------------------------------------------------------------------

describe('isInfrastructureHeader', () => {
  it('returns true for hop-by-hop: connection', () => {
    expect(isInfrastructureHeader('connection')).toBe(true);
  });

  it('returns true for hop-by-hop: transfer-encoding', () => {
    expect(isInfrastructureHeader('transfer-encoding')).toBe(true);
  });

  it('returns true for hop-by-hop: keep-alive', () => {
    expect(isInfrastructureHeader('keep-alive')).toBe(true);
  });

  it('returns true for hop-by-hop: upgrade', () => {
    expect(isInfrastructureHeader('upgrade')).toBe(true);
  });

  it('returns true for hop-by-hop: te', () => {
    expect(isInfrastructureHeader('te')).toBe(true);
  });

  it('returns true for hop-by-hop: trailer', () => {
    expect(isInfrastructureHeader('trailer')).toBe(true);
  });

  it('returns true for infrastructure: x-forwarded-for', () => {
    expect(isInfrastructureHeader('x-forwarded-for')).toBe(true);
  });

  it('returns true for infrastructure: x-forwarded-proto', () => {
    expect(isInfrastructureHeader('x-forwarded-proto')).toBe(true);
  });

  it('returns true for infrastructure: x-forwarded-host', () => {
    expect(isInfrastructureHeader('x-forwarded-host')).toBe(true);
  });

  it('returns true for infrastructure: via', () => {
    expect(isInfrastructureHeader('via')).toBe(true);
  });

  it('returns true for infrastructure: host', () => {
    expect(isInfrastructureHeader('host')).toBe(true);
  });

  it('returns false for content-type', () => {
    expect(isInfrastructureHeader('content-type')).toBe(false);
  });

  it('returns false for x-request-id', () => {
    expect(isInfrastructureHeader('x-request-id')).toBe(false);
  });

  it('returns false for accept', () => {
    expect(isInfrastructureHeader('accept')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isInfrastructureHeader('Transfer-Encoding')).toBe(true);
    expect(isInfrastructureHeader('X-Forwarded-For')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// redactHeader
// ---------------------------------------------------------------------------

describe('structural replacement for value redaction', () => {
  it.each([
    ['authorization', 'Bearer abc123xyz', ['bearer']],
    ['Authorization', 'Basic dXNlcjpwYXNz', ['basic']],
    ['authorization', 'Token secret-token', undefined],
    ['authorization', 'rawsecret', undefined],
    ['cookie', 'session=abc123; token=xyz', undefined],
    ['x-api-key', 'my-secret-key', undefined],
    ['content-type', 'application/json', undefined],
    ['accept', 'application/json', undefined],
    ['Authorization', 'Bearer token123', ['bearer']],
    ['Cookie', 'session=abc', undefined],
    ['X-API-Key', 'key-value', undefined],
  ])('retains only structural metadata for %s (%s)', (name, value, authSchemes) => {
    const result = captureHeaders({ [name as string]: value });
    expect(result).toEqual([authSchemes ? { name: (name as string).toLowerCase(), authSchemes } : { name: (name as string).toLowerCase() }]);
    expect(JSON.stringify(result)).not.toContain(value);
    expect(result![0]).not.toHaveProperty('example');
  });
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// captureHeaders
// ---------------------------------------------------------------------------

describe('captureHeaders', () => {
  it('returns undefined for empty headers', () => {
    expect(captureHeaders({})).toBeUndefined();
  });

  it('returns undefined when all headers are infrastructure/hop-by-hop', () => {
    const result = captureHeaders({
      connection: 'keep-alive',
      'transfer-encoding': 'chunked',
      'x-forwarded-for': '1.2.3.4',
    });
    expect(result).toBeUndefined();
  });

  it('captures content-type and accept headers', () => {
    const result = captureHeaders({
      'content-type': 'application/json',
      accept: 'application/json',
    });
    expect(result).toBeDefined();
    expect(result).toHaveLength(2);
    const names = result!.map((h) => h.name);
    expect(names).toContain('content-type');
    expect(names).toContain('accept');
  });

  it('redacts Authorization header', () => {
    const result = captureHeaders({
      authorization: 'Bearer secret-token',
    });
    expect(result).toBeDefined();
    expect(result![0]).toEqual({ name: 'authorization', authSchemes: ['bearer'] });
  });

  it('redacts Cookie header', () => {
    const result = captureHeaders({
      cookie: 'session=abc',
    });
    expect(result).toBeDefined();
    expect(result![0]).toEqual({ name: 'cookie' });
  });

  it('redacts X-API-Key header', () => {
    const result = captureHeaders({
      'x-api-key': 'my-secret',
    });
    expect(result).toBeDefined();
    expect(result![0]).toEqual({ name: 'x-api-key' });
  });

  it('filters out hop-by-hop headers while keeping application headers', () => {
    const result = captureHeaders({
      connection: 'keep-alive',
      'transfer-encoding': 'chunked',
      'content-type': 'application/json',
      'x-request-id': 'req-123',
    });
    expect(result).toBeDefined();
    const names = result!.map((h) => h.name);
    expect(names).not.toContain('connection');
    expect(names).not.toContain('transfer-encoding');
    expect(names).toContain('content-type');
    expect(names).toContain('x-request-id');
  });

  it('filters out infrastructure headers', () => {
    const result = captureHeaders({
      'x-forwarded-for': '10.0.0.1',
      'x-forwarded-proto': 'https',
      via: '1.1 proxy',
      'content-type': 'text/html',
    });
    expect(result).toBeDefined();
    const names = result!.map((h) => h.name);
    expect(names).not.toContain('x-forwarded-for');
    expect(names).not.toContain('x-forwarded-proto');
    expect(names).not.toContain('via');
    expect(names).toContain('content-type');
  });

  it('records array-valued header presence without keeping any element', () => {
    const result = captureHeaders({
      'set-cookie': ['session=abc; Path=/', 'token=xyz; Path=/'],
    });
    expect(result).toBeDefined();
    expect(result).toEqual([{ name: 'set-cookie' }]);
  });

  it('skips undefined values', () => {
    const result = captureHeaders({
      'content-type': undefined,
      accept: 'application/json',
    });
    expect(result).toBeDefined();
    expect(result).toHaveLength(1);
    expect(result![0].name).toBe('accept');
  });

  it('returns headers sorted alphabetically by name', () => {
    const result = captureHeaders({
      'x-request-id': 'req-1',
      accept: 'application/json',
      'content-type': 'application/json',
    });
    expect(result).toBeDefined();
    const names = result!.map((h) => h.name);
    expect(names).toEqual([...names].sort());
  });

  it('captures a realistic request header set with redaction', () => {
    const result = captureHeaders({
      authorization: 'Bearer jwt.token.here',
      'content-type': 'application/json',
      accept: 'application/json',
      'x-request-id': 'abc-123',
      connection: 'keep-alive',
      'x-forwarded-for': '10.0.0.1',
    });
    expect(result).toBeDefined();
    expect(result).toEqual([
      { name: 'accept' }, { name: 'authorization', authSchemes: ['bearer'] },
      { name: 'content-type' }, { name: 'x-request-id' },
    ]);
    expect(JSON.stringify(result)).not.toContain('jwt.token.here');
    expect(JSON.stringify(result)).not.toContain('abc-123');
  });
});
