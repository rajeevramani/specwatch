import { describe, it, expect } from 'vitest';
import { scoreSpec, extractRuntimeSignals, parseSpec } from '../src/index.js';
import type { ScoreResult } from '../src/index.js';

/**
 * A small but non-trivial OpenAPI 3.1 doc: one operation with an operationId,
 * description, parameter, request/response schemas, and an error response.
 * Enough for the JAIRF scorer to exercise every dimension.
 */
const SAMPLE_SPEC = {
  openapi: '3.1.0',
  info: { title: 'Sample API', version: '1.0.0' },
  paths: {
    '/customers/{customerId}': {
      get: {
        operationId: 'getCustomer',
        summary: 'Fetch a customer',
        description: 'Returns a single customer by its unique identifier.',
        parameters: [
          {
            name: 'customerId',
            in: 'path',
            required: true,
            description: 'Unique customer identifier.',
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': {
            description: 'The requested customer.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Customer' },
              },
            },
          },
          '404': {
            description: 'Customer not found.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Customer: {
        type: 'object',
        required: ['id', 'name'],
        properties: {
          id: { type: 'string', description: 'Unique customer identifier.' },
          name: { type: 'string', description: 'Customer display name.' },
        },
      },
      Error: {
        type: 'object',
        required: ['code', 'message'],
        properties: {
          code: { type: 'string' },
          message: { type: 'string' },
        },
      },
    },
  },
};

function signalScore(result: ScoreResult, categoryId: string, signalId: string): number | undefined {
  return result.categories
    .find((category) => category.id === categoryId)
    ?.signals?.find((signal) => signal.id === signalId)
    ?.score;
}

describe('@agentready/scoring', () => {
  it('exports scoreSpec as a callable', () => {
    expect(typeof scoreSpec).toBe('function');
  });

  it('returns a numeric JAIRF overall score for a sample OpenAPI doc', () => {
    const result: ScoreResult = scoreSpec(SAMPLE_SPEC);

    expect(typeof result.overall).toBe('number');
    expect(Number.isFinite(result.overall)).toBe(true);
    expect(result.overall).toBeGreaterThanOrEqual(0);
    expect(result.overall).toBeLessThanOrEqual(100);
    expect(['A', 'B', 'C', 'D', 'F']).toContain(result.grade);
    expect(result.operationCount).toBe(1);
    expect(result.apiTitle).toBe('Sample API');
  });

  it('returns a per-signal / per-dimension breakdown', () => {
    const result = scoreSpec(SAMPLE_SPEC);

    expect(Array.isArray(result.categories)).toBe(true);
    expect(result.categories.length).toBeGreaterThan(0);

    // JAIRF's six weighted dimensions.
    const ids = result.categories.map((c) => c.id.toUpperCase()).sort();
    expect(ids).toEqual(['AID', 'ARAX', 'AU', 'DXJ', 'FC', 'SEC']);

    for (const cat of result.categories) {
      expect(typeof cat.score).toBe('number');
      expect(Number.isFinite(cat.score)).toBe(true);
      expect(typeof cat.weight).toBe('number');
      expect(Array.isArray(cat.findings)).toBe(true);
    }

    // At least one dimension exposes a per-signal breakdown.
    const withSignals = result.categories.filter((c) => Array.isArray(c.signals) && c.signals.length);
    expect(withSignals.length).toBeGreaterThan(0);
    for (const cat of withSignals) {
      for (const sig of cat.signals!) {
        expect(typeof sig.id).toBe('string');
        expect(typeof sig.score).toBe('number');
      }
    }
  });

  it('scores a worse spec lower than the gold sample (sanity gradient)', () => {
    const stripped = JSON.parse(JSON.stringify(SAMPLE_SPEC));
    const op = stripped.paths['/customers/{customerId}'].get;
    delete op.operationId;
    delete op.description;
    delete op.summary;
    delete op.parameters[0].description;
    delete op.responses['404']; // remove error schema

    const good = scoreSpec(SAMPLE_SPEC).overall;
    const bad = scoreSpec(stripped).overall;
    expect(bad).toBeLessThan(good);
  });

  it('parseSpec round-trips a YAML string into a scorable object', () => {
    const yamlStr = [
      'openapi: 3.1.0',
      'info:',
      '  title: YAML API',
      '  version: 2.0.0',
      'paths: {}',
    ].join('\n');
    const parsed = parseSpec(yamlStr);
    expect(parsed.info.title).toBe('YAML API');
    const result = scoreSpec(parsed);
    expect(typeof result.overall).toBe('number');
  });

  it('extractRuntimeSignals is exported and handles empty input', () => {
    expect(typeof extractRuntimeSignals).toBe('function');
    const sig = extractRuntimeSignals([]);
    expect(sig.present).toBe(false);
    expect(sig.opsWithData).toBe(0);
  });

  it('scores static response completeness by overlapping read fields, not field count', () => {
    const spec = {
      openapi: '3.1.0',
      info: { title: 'Orders API', version: '1.0.0' },
      paths: {
        '/orders': {
          post: {
            operationId: 'createOrder',
            summary: 'Create order',
            description: 'Create an order.',
            responses: {
              '201': {
                description: 'Created',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        id: { type: 'string' },
                        status: { type: 'string' },
                        extra: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        '/orders/{orderId}': {
          get: {
            operationId: 'getOrder',
            summary: 'Get order',
            description: 'Get an order.',
            parameters: [
              {
                name: 'orderId',
                in: 'path',
                required: true,
                schema: { type: 'string' },
              },
            ],
            responses: {
              '200': {
                description: 'Order',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        id: { type: 'string' },
                        status: { type: 'string' },
                        total: { type: 'number' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    expect(signalScore(scoreSpec(spec), 'au', 'static_response_completeness')).toBe(67);
  });
});
