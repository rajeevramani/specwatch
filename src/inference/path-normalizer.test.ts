/**
 * Tests for path normalization (Task 2.6)
 * 15+ test cases
 */

import { describe, it, expect } from 'vitest';
import { normalizePath } from './path-normalizer.js';

describe('normalizePath', () => {
  // ===========================================================================
  // Basic normalization
  // ===========================================================================
  describe('numeric IDs', () => {
    it('normalizes numeric user ID', () => {
      expect(normalizePath('/users/123')).toBe('/users/{userId}');
    });

    it('normalizes numeric order ID', () => {
      expect(normalizePath('/orders/456')).toBe('/orders/{orderId}');
    });

    it('normalizes numeric product ID', () => {
      expect(normalizePath('/products/789')).toBe('/products/{productId}');
    });

    it('normalizes large numeric ID', () => {
      expect(normalizePath('/posts/9999999')).toBe('/posts/{postId}');
    });
  });

  // ===========================================================================
  // UUID detection
  // ===========================================================================
  describe('UUID segments', () => {
    it('normalizes UUID in users path', () => {
      expect(normalizePath('/users/550e8400-e29b-41d4-a716-446655440000')).toBe('/users/{userId}');
    });

    it('normalizes UUID in orders path', () => {
      expect(normalizePath('/orders/6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe('/orders/{orderId}');
    });
  });

  // ===========================================================================
  // Date detection
  // ===========================================================================
  describe('date segments', () => {
    it('normalizes date in events path', () => {
      expect(normalizePath('/events/2024-01-15')).toBe('/events/{eventDate}');
    });

    it('normalizes date in reports path', () => {
      expect(normalizePath('/reports/2024-12-31')).toBe('/reports/{reportDate}');
    });
  });

  // ===========================================================================
  // Alphanumeric codes
  // ===========================================================================
  describe('alphanumeric codes', () => {
    it('normalizes alphanumeric product code', () => {
      expect(normalizePath('/products/ABC123')).toBe('/products/{productCode}');
    });

    it('normalizes alphanumeric SKU', () => {
      expect(normalizePath('/items/SKU456')).toBe('/items/{itemCode}');
    });
  });

  // ===========================================================================
  // Compound paths
  // ===========================================================================
  describe('compound paths', () => {
    it('normalizes nested resource path', () => {
      expect(normalizePath('/users/123/orders/456')).toBe('/users/{userId}/orders/{orderId}');
    });

    it('normalizes deeply nested path', () => {
      expect(normalizePath('/users/123/orders/456/items/789')).toBe(
        '/users/{userId}/orders/{orderId}/items/{itemId}',
      );
    });

    it('normalizes UUID in nested path', () => {
      expect(normalizePath('/organizations/550e8400-e29b-41d4-a716-446655440000/members/123')).toBe(
        '/organizations/{organizationId}/members/{memberId}',
      );
    });
  });

  // ===========================================================================
  // Consecutive dynamic segments
  // ===========================================================================
  describe('consecutive dynamic segments', () => {
    it('second consecutive numeric uses fallback {id}', () => {
      expect(normalizePath('/items/123/456')).toBe('/items/{itemId}/{id}');
    });
  });

  // ===========================================================================
  // Literal keyword preservation
  // ===========================================================================
  describe('literal keyword preservation', () => {
    it('preserves api prefix', () => {
      expect(normalizePath('/api/users/123')).toBe('/api/users/{userId}');
    });

    it('preserves v1 version prefix', () => {
      expect(normalizePath('/v1/users/123')).toBe('/v1/users/{userId}');
    });

    it('preserves v2 version prefix', () => {
      expect(normalizePath('/api/v2/users/123')).toBe('/api/v2/users/{userId}');
    });

    it('preserves admin prefix', () => {
      expect(normalizePath('/admin/users/123')).toBe('/admin/users/{userId}');
    });

    it('preserves health endpoint', () => {
      expect(normalizePath('/health')).toBe('/health');
    });

    it('preserves plain word segments', () => {
      expect(normalizePath('/api/v1/users')).toBe('/api/v1/users');
    });
  });

  // ===========================================================================
  // Query string stripping
  // ===========================================================================
  describe('query string stripping', () => {
    it('strips query string before normalizing', () => {
      expect(normalizePath('/users/123?page=1')).toBe('/users/{userId}');
    });

    it('strips query string from complex path', () => {
      expect(normalizePath('/users/123/orders?limit=10&offset=20')).toBe(
        '/users/{userId}/orders',
      );
    });
  });

  // ===========================================================================
  // Already-parameterized paths
  // ===========================================================================
  describe('already-parameterized paths', () => {
    it('passes through already-parameterized path', () => {
      expect(normalizePath('/users/{userId}')).toBe('/users/{userId}');
    });

    it('passes through compound parameterized path', () => {
      expect(normalizePath('/users/{userId}/orders/{orderId}')).toBe(
        '/users/{userId}/orders/{orderId}',
      );
    });
  });

  // ===========================================================================
  // Edge cases
  // ===========================================================================
  describe('edge cases', () => {
    it('handles root path', () => {
      expect(normalizePath('/')).toBe('/');
    });

    it('handles empty path', () => {
      expect(normalizePath('')).toBe('/');
    });

    it('handles path with only a resource name', () => {
      expect(normalizePath('/users')).toBe('/users');
    });

    it('strips query string from root path', () => {
      expect(normalizePath('/?key=value')).toBe('/');
    });
  });

  // ===========================================================================
  // Plural to singular conversion
  // ===========================================================================
  describe('plural-to-singular for parameter naming', () => {
    it('converts plural "users" to singular "user" in param name', () => {
      expect(normalizePath('/users/1')).toBe('/users/{userId}');
    });

    it('converts plural "events" to singular "event" in param name', () => {
      expect(normalizePath('/events/1')).toBe('/events/{eventId}');
    });

    it('converts plural "categories" to singular "category" in param name', () => {
      expect(normalizePath('/categories/1')).toBe('/categories/{categoryId}');
    });
  });
});
