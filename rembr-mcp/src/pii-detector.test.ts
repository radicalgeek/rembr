import { describe, it, expect } from 'vitest';
import { PIIDetectorService, piiDetector } from './pii-detector';

describe('PIIDetectorService', () => {
  describe('detectPII', () => {
    it('detects email addresses', () => {
      const result = piiDetector.detectPII('Contact me at john@example.com');
      expect(result.hasPII).toBe(true);
      expect(result.types).toContain('email');
      expect(result.locations).toHaveLength(1);
      expect(result.locations[0].matched).toBe('john@example.com');
    });

    it('detects phone numbers', () => {
      const result = piiDetector.detectPII('Call me at +1-555-123-4567');
      expect(result.hasPII).toBe(true);
      expect(result.types).toContain('phone');
    });

    it('detects US SSN with validation', () => {
      const result = piiDetector.detectPII('SSN: 123-45-6789', 'high');
      expect(result.hasPII).toBe(true);
      expect(result.types).toContain('ssn');
    });

    it('rejects invalid SSN patterns', () => {
      // 000-xx-xxxx is invalid
      const result = piiDetector.detectPII('Invalid SSN: 000-12-3456', 'high');
      expect(result.types).not.toContain('ssn');
    });

    it('detects credit card numbers with Luhn validation', () => {
      // Valid test card number (Visa test)
      const result = piiDetector.detectPII('Card: 4111-1111-1111-1111', 'high');
      expect(result.hasPII).toBe(true);
      expect(result.types).toContain('credit_card');
    });

    it('rejects invalid credit card numbers', () => {
      // Invalid Luhn
      const result = piiDetector.detectPII('Card: 1234-5678-9012-3456', 'high');
      expect(result.types).not.toContain('credit_card');
    });

    it('detects UK National Insurance numbers', () => {
      const result = piiDetector.detectPII('NINO: AB 12 34 56 C', 'high');
      expect(result.hasPII).toBe(true);
      expect(result.types).toContain('uk_nino');
    });

    it('detects IP addresses at high sensitivity', () => {
      const result = piiDetector.detectPII('Server IP: 192.168.1.100', 'high');
      expect(result.hasPII).toBe(true);
      expect(result.types).toContain('ip_address');
    });

    it('does not detect IP at low sensitivity', () => {
      const result = piiDetector.detectPII('Server IP: 192.168.1.100', 'low');
      expect(result.types).not.toContain('ip_address');
    });

    it('detects crypto wallet addresses', () => {
      const ethAddress = '0x742d35Cc6634C0532925a3b844Bc9e7595f8E9D4';
      const result = piiDetector.detectPII(`Wallet: ${ethAddress}`, 'high');
      expect(result.hasPII).toBe(true);
      expect(result.types).toContain('crypto_wallet');
    });

    it('detects multiple PII types', () => {
      const content = 'Email: test@example.com, Phone: 555-123-4567, SSN: 123-45-6789';
      const result = piiDetector.detectPII(content, 'high');
      expect(result.hasPII).toBe(true);
      expect(result.types).toContain('email');
      expect(result.types).toContain('phone');
      expect(result.types).toContain('ssn');
      expect(result.locations.length).toBeGreaterThanOrEqual(3);
    });

    it('returns no PII for clean content', () => {
      const result = piiDetector.detectPII('This is a normal message with no personal info.');
      expect(result.hasPII).toBe(false);
      expect(result.types).toHaveLength(0);
      expect(result.locations).toHaveLength(0);
    });

    it('calculates confidence score', () => {
      const result = piiDetector.detectPII('SSN: 123-45-6789 and email: test@test.com', 'high');
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });
  });

  describe('redactPII', () => {
    it('masks PII with asterisks', () => {
      const result = piiDetector.redactPII('Call 555-123-4567', 'mask');
      expect(result).not.toContain('555-123-4567');
      expect(result).toContain('*');
    });

    it('replaces with type labels in hash mode', () => {
      const result = piiDetector.redactPII('Email: test@example.com', 'hash');
      expect(result).toContain('[EMAIL_REDACTED]');
      expect(result).not.toContain('test@example.com');
    });

    it('removes PII entirely in remove mode', () => {
      const result = piiDetector.redactPII('Email: test@example.com is private', 'remove');
      expect(result).not.toContain('test@example.com');
      expect(result).toBe('Email:  is private');
    });

    it('preserves non-PII content', () => {
      const result = piiDetector.redactPII('Hello world', 'mask');
      expect(result).toBe('Hello world');
    });

    it('handles multiple PII instances', () => {
      const content = 'Contact john@a.com or jane@b.com';
      const result = piiDetector.redactPII(content, 'hash');
      expect(result.match(/\[EMAIL_REDACTED\]/g)?.length).toBe(2);
    });
  });

  describe('detectAndRedact', () => {
    it('returns both detection result and redacted content', () => {
      const result = piiDetector.detectAndRedact('Email: test@example.com');
      expect(result.hasPII).toBe(true);
      expect(result.redactedContent).toBeDefined();
      expect(result.redactedContent).not.toContain('test@example.com');
    });

    it('does not include redactedContent when no PII found', () => {
      const result = piiDetector.detectAndRedact('Clean content');
      expect(result.hasPII).toBe(false);
      expect(result.redactedContent).toBeUndefined();
    });
  });
});
