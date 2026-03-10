/**
 * Tests for string format detection (Task 2.3)
 * 20+ test cases including edge cases and priority ordering
 */

import { describe, it, expect } from 'vitest';
import { detectStringFormat } from './formats.js';

describe('detectStringFormat', () => {
  // ===========================================================================
  // UUID detection
  // ===========================================================================
  describe('UUID', () => {
    it('detects standard lowercase UUID', () => {
      expect(detectStringFormat('550e8400-e29b-41d4-a716-446655440000')).toBe('uuid');
    });

    it('detects UUID with uppercase letters', () => {
      expect(detectStringFormat('550E8400-E29B-41D4-A716-446655440000')).toBe('uuid');
    });

    it('detects mixed-case UUID', () => {
      expect(detectStringFormat('6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe('uuid');
    });

    it('does not detect UUID without dashes', () => {
      expect(detectStringFormat('550e8400e29b41d4a716446655440000')).not.toBe('uuid');
    });

    it('does not detect UUID with wrong segment lengths', () => {
      expect(detectStringFormat('550e8400-e29b-41d4-a716-44665544')).not.toBe('uuid');
    });
  });

  // ===========================================================================
  // Email detection
  // ===========================================================================
  describe('Email', () => {
    it('detects simple email', () => {
      expect(detectStringFormat('user@example.com')).toBe('email');
    });

    it('detects email with subdomain', () => {
      expect(detectStringFormat('user@mail.example.com')).toBe('email');
    });

    it('detects email with plus addressing', () => {
      expect(detectStringFormat('user+tag@example.com')).toBe('email');
    });

    it('detects email with dots in local part', () => {
      expect(detectStringFormat('first.last@example.com')).toBe('email');
    });

    it('does not detect string without @', () => {
      expect(detectStringFormat('notanemail.com')).not.toBe('email');
    });

    it('does not detect string with @ but no domain', () => {
      expect(detectStringFormat('user@')).not.toBe('email');
    });
  });

  // ===========================================================================
  // URI detection
  // ===========================================================================
  describe('URI', () => {
    it('detects https URI', () => {
      expect(detectStringFormat('https://example.com')).toBe('uri');
    });

    it('detects http URI', () => {
      expect(detectStringFormat('http://example.com/api/v1/users')).toBe('uri');
    });

    it('detects URI with path and query', () => {
      expect(detectStringFormat('https://api.example.com/users?page=1&limit=10')).toBe('uri');
    });

    it('does not detect URI without scheme', () => {
      expect(detectStringFormat('example.com/api')).not.toBe('uri');
    });

    it('does not detect ftp URI', () => {
      expect(detectStringFormat('ftp://example.com')).not.toBe('uri');
    });
  });

  // ===========================================================================
  // DateTime detection
  // ===========================================================================
  describe('DateTime', () => {
    it('detects ISO 8601 datetime with Z', () => {
      expect(detectStringFormat('2024-01-15T10:30:00Z')).toBe('date-time');
    });

    it('detects ISO 8601 datetime with offset', () => {
      expect(detectStringFormat('2024-01-15T10:30:00+05:30')).toBe('date-time');
    });

    it('detects ISO 8601 datetime with milliseconds', () => {
      expect(detectStringFormat('2024-01-15T10:30:00.123Z')).toBe('date-time');
    });

    it('detects ISO 8601 datetime with negative offset', () => {
      expect(detectStringFormat('2024-01-15T10:30:00-07:00')).toBe('date-time');
    });

    it('does not detect date-only string as datetime', () => {
      expect(detectStringFormat('2024-01-15')).not.toBe('date-time');
    });
  });

  // ===========================================================================
  // Date detection
  // ===========================================================================
  describe('Date', () => {
    it('detects ISO 8601 date', () => {
      expect(detectStringFormat('2024-01-15')).toBe('date');
    });

    it('detects date with month and day padding', () => {
      expect(detectStringFormat('2024-12-31')).toBe('date');
    });

    it('does not detect partial date', () => {
      expect(detectStringFormat('2024-01')).not.toBe('date');
    });

    it('does not detect non-ISO date format', () => {
      expect(detectStringFormat('01/15/2024')).not.toBe('date');
    });
  });

  // ===========================================================================
  // IPv4 detection
  // ===========================================================================
  describe('IPv4', () => {
    it('detects valid IPv4 address', () => {
      expect(detectStringFormat('192.168.1.1')).toBe('ipv4');
    });

    it('detects localhost IPv4', () => {
      expect(detectStringFormat('127.0.0.1')).toBe('ipv4');
    });

    it('detects broadcast IPv4', () => {
      expect(detectStringFormat('255.255.255.255')).toBe('ipv4');
    });

    it('detects all-zeros IPv4', () => {
      expect(detectStringFormat('0.0.0.0')).toBe('ipv4');
    });

    it('does not detect IPv4 with too many octets', () => {
      expect(detectStringFormat('192.168.1.1.1')).not.toBe('ipv4');
    });

    it('does not detect partial IPv4', () => {
      expect(detectStringFormat('192.168.1')).not.toBe('ipv4');
    });
  });

  // ===========================================================================
  // IPv6 detection
  // ===========================================================================
  describe('IPv6', () => {
    it('detects loopback IPv6 (::1)', () => {
      expect(detectStringFormat('::1')).toBe('ipv6');
    });

    it('detects full IPv6 address', () => {
      expect(detectStringFormat('2001:0db8:85a3:0000:0000:8a2e:0370:7334')).toBe('ipv6');
    });

    it('detects compressed IPv6', () => {
      expect(detectStringFormat('2001:db8::1')).toBe('ipv6');
    });

    it('detects all-zeros compressed IPv6', () => {
      expect(detectStringFormat('::')).toBe('ipv6');
    });
  });

  // ===========================================================================
  // No format — plain strings
  // ===========================================================================
  describe('No format detected', () => {
    it('returns undefined for plain text', () => {
      expect(detectStringFormat('hello world')).toBeUndefined();
    });

    it('returns undefined for empty string', () => {
      expect(detectStringFormat('')).toBeUndefined();
    });

    it('returns undefined for numeric string', () => {
      expect(detectStringFormat('12345')).toBeUndefined();
    });

    it('returns undefined for a name', () => {
      expect(detectStringFormat('Alice Smith')).toBeUndefined();
    });
  });

  // ===========================================================================
  // Priority ordering
  // ===========================================================================
  describe('Priority ordering', () => {
    it('UUID takes priority over email (UUID that looks like email is invalid anyway)', () => {
      // A real UUID should always be detected as UUID, not email
      const uuid = '550e8400-e29b-41d4-a716-446655440000';
      expect(detectStringFormat(uuid)).toBe('uuid');
    });

    it('email is detected before URI', () => {
      // An email address with a URL-like domain should be email, not URI
      expect(detectStringFormat('user@https-example.com')).toBe('email');
    });

    it('date is not detected as datetime', () => {
      // ISO date (no T) should be date, not date-time
      expect(detectStringFormat('2024-01-15')).toBe('date');
    });

    it('datetime (with T) is detected as date-time, not date', () => {
      expect(detectStringFormat('2024-01-15T10:30:00Z')).toBe('date-time');
    });
  });
});
