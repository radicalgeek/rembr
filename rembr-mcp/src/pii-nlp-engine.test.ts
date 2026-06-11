/**
 * Tests for PII NLP Engine (REM-64)
 */
import { describe, it, expect } from 'vitest';
import { PIINLPEngine, piiNLPEngine } from './pii-nlp-engine.js';

const engine = new PIINLPEngine();

// ─── Pattern detection ────────────────────────────────────────────────────────

describe('pattern detection — original types', () => {
  it('detects email addresses', () => {
    const r = engine.detect('Contact us at hello@example.com for support', 'low');
    expect(r.hasPII).toBe(true);
    expect(r.types).toContain('email');
    expect(r.matches[0].value).toBe('hello@example.com');
    expect(r.matches[0].confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('detects credit card with Luhn validation', () => {
    // Valid Luhn number
    const r = engine.detect('Card: 4532015112830366', 'medium');
    expect(r.hasPII).toBe(true);
    expect(r.types).toContain('credit_card');
  });

  it('rejects credit card failing Luhn check', () => {
    const r = engine.detect('Invalid: 1234 5678 9012 3456', 'medium');
    const ccMatch = r.matches.find(m => m.type === 'credit_card');
    expect(ccMatch).toBeUndefined();
  });

  it('detects UK NINO', () => {
    const r = engine.detect('NI number: AB 12 34 56 C', 'medium');
    expect(r.types).toContain('uk_nino');
  });

  it('detects IPv4 address', () => {
    const r = engine.detect('Server IP: 192.168.1.100', 'high');
    expect(r.types).toContain('ip_address');
  });

  it('detects JWT token', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const r = engine.detect(`Token: ${jwt}`, 'low');
    expect(r.types).toContain('jwt_token');
    expect(r.matches.find(m => m.type === 'jwt_token')!.confidence).toBeGreaterThanOrEqual(0.99);
  });

  it('detects AWS access key', () => {
    const r = engine.detect('Key: AKIAIOSFODNN7EXAMPLE', 'low');
    expect(r.types).toContain('aws_access_key');
  });

  it('detects URL with embedded credentials', () => {
    const r = engine.detect('Connect: postgres://admin:secret123@db.example.com/mydb', 'low');
    expect(r.types).toContain('url_with_credentials');
    expect(r.matches[0].confidence).toBeGreaterThanOrEqual(0.98);
  });
});

describe('pattern detection — new types', () => {
  it('detects UK postcode', () => {
    const r = engine.detect('Address: SW1A 1AA London', 'medium');
    expect(r.types).toContain('uk_postcode');
  });

  it('detects MAC address', () => {
    const r = engine.detect('Device MAC: 00:1A:2B:3C:4D:5E connected', 'high');
    expect(r.types).toContain('mac_address');
    expect(r.matches.find(m => m.type === 'mac_address')!.confidence).toBeGreaterThanOrEqual(0.95);
  });

  it('detects IBAN with mod-97 validation', () => {
    // Valid GB IBAN
    const r = engine.detect('IBAN: GB29NWBK60161331926819', 'medium');
    expect(r.types).toContain('iban');
  });

  it('detects NHS number with checksum', () => {
    // Valid NHS number: 943 476 5919
    const r = engine.detect('NHS: 943 476 5919', 'high');
    expect(r.types).toContain('uk_nhs_number');
  });

  it('detects UK driving licence', () => {
    const r = engine.detect('Licence: MORGA657054SM9IJ', 'high');
    expect(r.types).toContain('uk_driving_licence');
  });

  it('detects date of birth with context', () => {
    const r = engine.detect('DOB: 15/06/1985', 'medium');
    expect(r.types).toContain('date_of_birth');
  });
});

// ─── NLP heuristic detection ──────────────────────────────────────────────────

describe('NLP heuristic detection', () => {
  it('detects person name via honorific', () => {
    const r = engine.detect('Please contact Dr. Sarah Johnson regarding your appointment', 'high');
    expect(r.types).toContain('person_name');
    expect(r.matches.find(m => m.type === 'person_name')!.method).toBe('nlp');
  });

  it('detects organisation name', () => {
    const r = engine.detect('Invoice from Acme Technologies Ltd for services rendered', 'high');
    expect(r.types).toContain('organisation_name');
  });

  it('detects street address', () => {
    const r = engine.detect('Deliver to 42 Baker Street, London', 'maximum');
    expect(r.types).toContain('street_address');
    expect(r.matches.find(m => m.type === 'street_address')!.method).toBe('nlp');
  });
});

// ─── Context scoring ──────────────────────────────────────────────────────────

describe('context scoring', () => {
  it('boosts phone confidence with context keyword', () => {
    const withContext = engine.detect('Call our phone: +44 20 7946 0958', 'high');
    const withoutContext = engine.detect('+44 20 7946 0958', 'high');
    const confWith = withContext.matches.find(m => m.type === 'phone')?.confidence ?? 0;
    const confWithout = withoutContext.matches.find(m => m.type === 'phone')?.confidence ?? 0;
    expect(confWith).toBeGreaterThanOrEqual(confWithout);
  });

  it('suppresses IP confidence with version context', () => {
    const r = engine.detect('Using HTTP version 192.168.1.100 protocol', 'high');
    const ip = r.matches.find(m => m.type === 'ip_address');
    if (ip) {
      expect(ip.confidence).toBeLessThan(0.9);
    }
  });
});

// ─── Deduplication ────────────────────────────────────────────────────────────

describe('deduplication', () => {
  it('does not double-count overlapping matches', () => {
    const r = engine.detect('hello@test.com', 'maximum');
    const emails = r.matches.filter(m => m.type === 'email');
    expect(emails).toHaveLength(1);
  });
});

// ─── Redaction ────────────────────────────────────────────────────────────────

describe('detectAndRedact', () => {
  it('masks email address', () => {
    const r = engine.detectAndRedact('Email: hello@example.com please', 'medium', 'mask');
    expect(r.redactedContent).toBeDefined();
    expect(r.redactedContent).not.toContain('hello@example.com');
    expect(r.redactedContent).toContain('@example.com');
  });

  it('uses hash mode', () => {
    const r = engine.detectAndRedact('Email: hello@example.com', 'medium', 'hash');
    expect(r.redactedContent).toContain('[EMAIL_REDACTED]');
  });

  it('uses label mode', () => {
    const r = engine.detectAndRedact('Email: hello@example.com', 'medium', 'label');
    expect(r.redactedContent).toContain('[EMAIL]');
  });

  it('uses remove mode', () => {
    const r = engine.detectAndRedact('Email: hello@example.com here', 'medium', 'remove');
    expect(r.redactedContent).not.toContain('@');
  });

  it('respects minConfidence threshold', () => {
    // US zip codes have base confidence 0.50 — excluded at threshold 0.8
    const r = engine.detectAndRedact('ZIP: 90210', 'high', 'mask', 0.8);
    expect(r.redactedContent).not.toContain('*****');
  });

  it('masks credit card showing last 4 digits', () => {
    const r = engine.detectAndRedact('Card: 4532015112830366', 'medium', 'mask');
    expect(r.redactedContent).toContain('0366');
  });
});

// ─── Convenience methods ──────────────────────────────────────────────────────

describe('convenience methods', () => {
  it('containsPII returns true for PII content', () => {
    expect(piiNLPEngine.containsPII('My email is test@example.com')).toBe(true);
  });

  it('containsPII returns false for clean content', () => {
    expect(piiNLPEngine.containsPII('The weather is nice today')).toBe(false);
  });

  it('score returns non-zero for PII content', () => {
    const s = piiNLPEngine.score('hello@example.com');
    expect(s).toBeGreaterThan(0);
  });

  it('score returns 0 for clean content', () => {
    expect(piiNLPEngine.score('No personal data here at all')).toBe(0);
  });
});

// ─── Sensitivity tiers ────────────────────────────────────────────────────────

describe('sensitivity tiers', () => {
  it('low sensitivity only catches obvious types', () => {
    const r = engine.detect('192.168.1.1 and John Smith visited', 'low');
    expect(r.types).not.toContain('ip_address');
    expect(r.types).not.toContain('person_name');
  });

  it('maximum sensitivity catches everything', () => {
    const r = engine.detect('Dr. Jane Doe from Acme Ltd lives at 42 Baker Street SW1A 1AA', 'maximum');
    expect(r.types).toContain('person_name');
    expect(r.types).toContain('organisation_name');
    expect(r.types).toContain('street_address');
    expect(r.types).toContain('uk_postcode');
  });

  it('result summary is accurate', () => {
    const r = engine.detect('Contact aws@example.com, key AKIAIOSFODNN7EXAMPLE', 'low');
    expect(r.summary.patternMatches).toBeGreaterThan(0);
    expect(r.summary.nlpMatches).toBe(0);
    expect(r.summary.highConfidence + r.summary.mediumConfidence + r.summary.lowConfidence).toBe(r.matches.length);
  });
});
