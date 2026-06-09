import { describe, expect, it } from 'vitest';
import {
  collectOpenApiOperations,
  matchOpenApiOperation,
  parseOperationKey,
} from '../../src/analysis/spec-mapper.js';

describe('OpenAPI operation mapper', () => {
  const spec = {
    openapi: '3.1.0',
    paths: {
      '/products': {
        post: { operationId: 'createProduct' },
        get: { operationId: 'listProducts' },
      },
      '/products/{productId}': {
        get: { operationId: 'getProduct' },
        patch: { operationId: 'updateProduct' },
      },
    },
  };

  it('collects OpenAPI operations with JSON pointer locations', () => {
    const operations = collectOpenApiOperations(spec);

    expect(operations).toContainEqual({
      method: 'POST',
      path: '/products',
      operationId: 'createProduct',
      specLocation: '#/paths/~1products/post',
    });
    expect(operations).toContainEqual({
      method: 'GET',
      path: '/products/{productId}',
      operationId: 'getProduct',
      specLocation: '#/paths/~1products~1{productId}/get',
    });
  });

  it('matches exact paths before template-compatible paths', () => {
    const operations = collectOpenApiOperations(spec);
    const match = matchOpenApiOperation(operations, 'POST', '/products');

    expect(match.operation?.operationId).toBe('createProduct');
    expect(match.warning).toBeUndefined();
  });

  it('matches observed parameter names to spec parameter names', () => {
    const operations = collectOpenApiOperations(spec);
    const match = matchOpenApiOperation(operations, 'GET', '/products/{id}');

    expect(match.operation?.operationId).toBe('getProduct');
  });

  it('matches concrete observed paths to spec templates', () => {
    const operations = collectOpenApiOperations(spec);
    const match = matchOpenApiOperation(operations, 'GET', '/products/prod_123');

    expect(match.operation?.operationId).toBe('getProduct');
  });

  it('reports unmatched observations', () => {
    const operations = collectOpenApiOperations(spec);
    const match = matchOpenApiOperation(operations, 'DELETE', '/products/{id}');

    expect(match.operation).toBeUndefined();
    expect(match.warning).toContain('No OpenAPI operation matched');
  });

  it('parses REST operation keys', () => {
    expect(parseOperationKey('PATCH /products/{productId}')).toEqual({
      method: 'PATCH',
      path: '/products/{productId}',
    });
    expect(parseOperationKey('tools/call:create_product')).toBeUndefined();
  });
});
