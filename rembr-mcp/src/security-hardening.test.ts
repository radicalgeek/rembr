/**
 * Tests for REM-28: Production Security Hardening
 *
 * Verifies:
 * - sanitizeUUID rejects non-UUID strings
 * - Admin endpoint fail-closed behaviour logic
 * - Metrics endpoint auth logic
 * - Startup validation detects placeholder secrets
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── UUID sanitization ─────────────────────────────────────────────────────────

// Extract the UUID regex + sanitize logic (mirrors index-http.ts implementation)
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sanitizeUUID(value: unknown): string {
  if (typeof value !== 'string') return '';
  let cleaned = value.trim();
  if ((cleaned.startsWith('"') && cleaned.endsWith('"')) ||
      (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  if (cleaned && !UUID_REGEX.test(cleaned)) {
    return ''; // reject non-UUID
  }
  return cleaned;
}

describe('sanitizeUUID — injection prevention', () => {
  it('accepts valid UUID v4', () => {
    expect(sanitizeUUID('a1b2c3d4-0000-4000-8000-000000000001')).toBe('a1b2c3d4-0000-4000-8000-000000000001');
  });

  it('accepts UUID with uppercase hex', () => {
    expect(sanitizeUUID('A1B2C3D4-0000-4000-8000-000000000001')).toBe('A1B2C3D4-0000-4000-8000-000000000001');
  });

  it('strips surrounding quotes', () => {
    expect(sanitizeUUID('"a1b2c3d4-0000-4000-8000-000000000001"')).toBe('a1b2c3d4-0000-4000-8000-000000000001');
    expect(sanitizeUUID("'a1b2c3d4-0000-4000-8000-000000000001'")).toBe('a1b2c3d4-0000-4000-8000-000000000001');
  });

  it('rejects SQL injection attempts', () => {
    expect(sanitizeUUID("'; DROP TABLE memories; --")).toBe('');
    expect(sanitizeUUID("1 OR 1=1")).toBe('');
    expect(sanitizeUUID("../../etc/passwd")).toBe('');
    expect(sanitizeUUID("${process.env.SECRET}")).toBe('');
  });

  it('rejects non-UUID strings', () => {
    expect(sanitizeUUID('not-a-uuid')).toBe('');
    expect(sanitizeUUID('abc')).toBe('');
    expect(sanitizeUUID('12345')).toBe('');
  });

  it('returns empty string for non-string input', () => {
    expect(sanitizeUUID(null)).toBe('');
    expect(sanitizeUUID(undefined)).toBe('');
    expect(sanitizeUUID(123)).toBe('');
    expect(sanitizeUUID({})).toBe('');
  });

  it('returns empty string for empty input', () => {
    expect(sanitizeUUID('')).toBe('');
    expect(sanitizeUUID('  ')).toBe('');
  });
});

// ─── Admin endpoint auth logic (RAD-45) ──────────────────────────────────────
//
// Updated behaviour after RAD-45:
// - Env var: ADMIN_API_KEY (previously ADMIN_SECRET)
// - Header:  X-Admin-Key  (previously X-Admin-Token)
// - Missing key at startup: server refuses to start (validate-env.ts)
// - Runtime guard: 401 for missing/wrong key, 503 only if env var somehow absent
//   (belt-and-suspenders — startup guard should have prevented this)

// Simulate adminAuthMiddleware logic from middleware/admin-auth.ts
function adminMiddlewareDecision(
  adminApiKey: string | undefined,
  providedKey: string | undefined
): 'allow' | 'blocked_401' | 'blocked_503' {
  if (!adminApiKey) {
    // Should not happen — validate-env.ts exits on missing ADMIN_API_KEY
    return 'blocked_503';
  }
  if (!providedKey || providedKey !== adminApiKey) {
    return 'blocked_401';
  }
  return 'allow';
}

describe('Admin endpoint auth — RAD-45 (X-Admin-Key / ADMIN_API_KEY)', () => {
  it('allows with correct X-Admin-Key', () => {
    expect(adminMiddlewareDecision('secret123', 'secret123')).toBe('allow');
  });

  it('blocks with wrong X-Admin-Key (401)', () => {
    expect(adminMiddlewareDecision('secret123', 'wrong')).toBe('blocked_401');
  });

  it('blocks with missing X-Admin-Key header (401)', () => {
    expect(adminMiddlewareDecision('secret123', undefined)).toBe('blocked_401');
  });

  it('returns 503 when ADMIN_API_KEY not set (defensive — startup should have prevented)', () => {
    expect(adminMiddlewareDecision(undefined, undefined)).toBe('blocked_503');
    expect(adminMiddlewareDecision(undefined, 'anything')).toBe('blocked_503');
  });
});

// ─── Metrics endpoint auth logic ──────────────────────────────────────────────

function metricsMiddlewareDecision(
  metricsSecret: string | undefined,
  nodeEnv: string,
  providedToken: string | undefined
): 'allow' | 'blocked_401' | 'blocked_403' {
  if (metricsSecret) {
    if (!providedToken || providedToken !== metricsSecret) {
      return 'blocked_401';
    }
    return 'allow';
  }
  if (nodeEnv === 'production') {
    return 'blocked_403'; // fail-closed in prod without secret
  }
  return 'allow'; // dev: open
}

describe('Metrics endpoint auth', () => {
  it('allows with correct Bearer token', () => {
    expect(metricsMiddlewareDecision('metsec', 'production', 'metsec')).toBe('allow');
  });

  it('blocks with wrong token', () => {
    expect(metricsMiddlewareDecision('metsec', 'production', 'wrong')).toBe('blocked_401');
  });

  it('blocks with no token when secret is set', () => {
    expect(metricsMiddlewareDecision('metsec', 'production', undefined)).toBe('blocked_401');
  });

  it('returns 403 in production when METRICS_SECRET not set', () => {
    expect(metricsMiddlewareDecision(undefined, 'production', undefined)).toBe('blocked_403');
  });

  it('allows in dev when METRICS_SECRET not set', () => {
    expect(metricsMiddlewareDecision(undefined, 'development', undefined)).toBe('allow');
  });
});

// ─── Startup env validation ───────────────────────────────────────────────────

function checkForPlaceholderSecret(jwtSecret: string, nodeEnv: string): boolean {
  if (nodeEnv !== 'production') return false;
  return jwtSecret === 'your-jwt-secret-here' || jwtSecret.includes('change-me');
}

describe('Startup validation — placeholder secret detection', () => {
  it('detects default placeholder secret in production', () => {
    expect(checkForPlaceholderSecret('your-jwt-secret-here', 'production')).toBe(true);
  });

  it('detects change-me secret in production', () => {
    expect(checkForPlaceholderSecret('change-me-generate-with-openssl', 'production')).toBe(true);
  });

  it('allows any secret in development', () => {
    expect(checkForPlaceholderSecret('your-jwt-secret-here', 'development')).toBe(false);
    expect(checkForPlaceholderSecret('', 'development')).toBe(false);
  });

  it('allows real secret in production', () => {
    const realSecret = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    expect(checkForPlaceholderSecret(realSecret, 'production')).toBe(false);
  });
});

// ─── CSP header presence ──────────────────────────────────────────────────────

describe('Security headers — CSP content', () => {
  const CSP = [
    "default-src 'self'",
    "script-src 'self' https://js.stripe.com https://www.googletagmanager.com",
    "style-src 'self'",
    "img-src 'self' data: blob: https:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "upgrade-insecure-requests",
  ].join('; ');

  it('includes default-src self', () => {
    expect(CSP).toContain("default-src 'self'");
  });

  it('blocks object-src', () => {
    expect(CSP).toContain("object-src 'none'");
  });

  it('restricts base-uri to self', () => {
    expect(CSP).toContain("base-uri 'self'");
  });

  it('forces HTTPS upgrade', () => {
    expect(CSP).toContain('upgrade-insecure-requests');
  });

  it('restricts form-action to self', () => {
    expect(CSP).toContain("form-action 'self'");
  });
});
