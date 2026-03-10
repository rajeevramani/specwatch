// Unit tests for header filtering and redaction — owned by Proxy Engineer

import { describe, it, expect } from 'vitest';
import { captureHeaders, redactHeader, isInfrastructureHeader } from './headers.js';

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

describe('redactHeader', () => {
  it('redacts Authorization Bearer token', () => {
    expect(redactHeader('authorization', 'Bearer abc123xyz')).toBe('Bearer ***');
  });

  it('redacts Authorization Basic credential', () => {
    expect(redactHeader('Authorization', 'Basic dXNlcjpwYXNz')).toBe('Basic ***');
  });

  it('redacts Authorization Token scheme', () => {
    expect(redactHeader('authorization', 'Token secret-token')).toBe('Token ***');
  });

  it('redacts Authorization with no scheme prefix', () => {
    expect(redactHeader('authorization', 'rawsecret')).toBe('***');
  });

  it('redacts Cookie header value', () => {
    expect(redactHeader('cookie', 'session=abc123; token=xyz')).toBe('***');
  });

  it('redacts X-API-Key header value', () => {
    expect(redactHeader('x-api-key', 'my-secret-key')).toBe('***');
  });

  it('returns original value for non-sensitive header', () => {
    expect(redactHeader('content-type', 'application/json')).toBe('application/json');
  });

  it('returns original value for Accept header', () => {
    expect(redactHeader('accept', 'application/json')).toBe('application/json');
  });

  it('is case-insensitive for Authorization', () => {
    expect(redactHeader('Authorization', 'Bearer token123')).toBe('Bearer ***');
  });

  it('is case-insensitive for Cookie', () => {
    expect(redactHeader('Cookie', 'session=abc')).toBe('***');
  });

  it('is case-insensitive for X-API-Key', () => {
    expect(redactHeader('X-API-Key', 'key-value')).toBe('***');
  });
});

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
    expect(result![0]).toEqual({ name: 'authorization', example: 'Bearer ***' });
  });

  it('redacts Cookie header', () => {
    const result = captureHeaders({
      cookie: 'session=abc',
    });
    expect(result).toBeDefined();
    expect(result![0]).toEqual({ name: 'cookie', example: '***' });
  });

  it('redacts X-API-Key header', () => {
    const result = captureHeaders({
      'x-api-key': 'my-secret',
    });
    expect(result).toBeDefined();
    expect(result![0]).toEqual({ name: 'x-api-key', example: '***' });
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

  it('handles array values by using the first element', () => {
    const result = captureHeaders({
      'set-cookie': ['session=abc; Path=/', 'token=xyz; Path=/'],
    });
    expect(result).toBeDefined();
    expect(result![0].example).toBe('session=abc; Path=/');
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
    const map = Object.fromEntries(result!.map((h) => [h.name, h.example]));
    expect(map['authorization']).toBe('Bearer ***');
    expect(map['content-type']).toBe('application/json');
    expect(map['accept']).toBe('application/json');
    expect(map['x-request-id']).toBe('abc-123');
    expect(map['connection']).toBeUndefined();
    expect(map['x-forwarded-for']).toBeUndefined();
  });
});
