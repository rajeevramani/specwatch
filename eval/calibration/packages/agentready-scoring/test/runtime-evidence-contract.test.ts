import { describe, it, expect } from 'vitest';
import { scoreSpec } from '../src/index.js';

/**
 * Contract test for the Specwatch -> Agent Ready Score bridge (bead specwatch-ag5.4).
 *
 * Phase-1 consumption path: ARS reads Specwatch runtime evidence from the embedded
 * `x-specwatch-agent` OpenAPI extension (camelCase contract:
 * responseCompleteness, missingFields, verificationLoopDetected,
 * verificationLoopCount, commonNextSteps). This test pins that the extension is
 * actually consumed AND that it shifts the score in the expected direction.
 */

interface AgentExt {
  responseCompleteness?: number;
  missingFields?: string[];
  verificationLoopDetected?: boolean;
  verificationLoopCount?: number;
  commonNextSteps?: string[];
}

/** A small but complete OpenAPI 3.1 doc with a write + read operation. */
function baseSpec(): any {
  return {
    openapi: '3.1.0',
    info: { title: 'Orders API', version: '1.0.0' },
    paths: {
      '/orders': {
        post: {
          operationId: 'createOrder',
          summary: 'Create an order',
          description: 'Creates a new order and returns its identifier.',
          requestBody: {
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Order' } },
            },
          },
          responses: {
            '201': {
              description: 'The created order.',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/Order' } },
              },
            },
          },
        },
      },
      '/orders/{orderId}': {
        get: {
          operationId: 'getOrder',
          summary: 'Fetch an order',
          description: 'Returns a single order by its unique identifier.',
          parameters: [
            {
              name: 'orderId',
              in: 'path',
              required: true,
              description: 'Unique order identifier.',
              schema: { type: 'string' },
            },
          ],
          responses: {
            '200': {
              description: 'The requested order.',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/Order' } },
              },
            },
            '404': {
              description: 'Order not found.',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/Error' } },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Order: {
          type: 'object',
          required: ['id', 'total'],
          properties: {
            id: { type: 'string', description: 'Unique order identifier.' },
            total: { type: 'number', description: 'Order total.' },
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
}

/** Deep-clone the base spec and attach an x-specwatch-agent extension to POST /orders. */
function withAgentExt(ext: AgentExt): any {
  const spec = JSON.parse(JSON.stringify(baseSpec()));
  spec.paths['/orders'].post['x-specwatch-agent'] = ext;
  return spec;
}

describe('Specwatch runtime evidence -> Agent Ready Score contract', () => {
  it('does not mark a spec runtime-verified without the x-specwatch-agent extension', () => {
    const result = scoreSpec(baseSpec());
    expect(result.runtimeVerified).toBeFalsy();
  });

  it('consumes the embedded x-specwatch-agent extension (runtimeVerified becomes true)', () => {
    const result = scoreSpec(
      withAgentExt({ responseCompleteness: 0.2, verificationLoopDetected: true }),
    );
    expect(result.runtimeVerified).toBe(true);
    expect(result.runtimeOps).toBeGreaterThanOrEqual(1);
  });

  it('thin runtime evidence lowers the score versus the same spec with no evidence', () => {
    const baseline = scoreSpec(baseSpec()).overall;
    const thin = scoreSpec(
      withAgentExt({
        responseCompleteness: 0.2,
        missingFields: ['id', 'total'],
        verificationLoopDetected: true,
        verificationLoopCount: 3,
      }),
    ).overall;

    expect(thin).toBeLessThan(baseline);
  });

  it('rich runtime evidence scores higher than thin runtime evidence (direction is correct)', () => {
    const thin = scoreSpec(
      withAgentExt({ responseCompleteness: 0.2, verificationLoopDetected: true }),
    ).overall;
    const rich = scoreSpec(
      withAgentExt({ responseCompleteness: 1.0, verificationLoopDetected: false }),
    ).overall;

    expect(rich).toBeGreaterThan(thin);
  });
});
