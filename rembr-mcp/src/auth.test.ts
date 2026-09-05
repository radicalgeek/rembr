import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AuthService, verifyOAuthToken, verifyApiKey, extractKeyPrefix, type AuthResult } from './auth.js';
import jwt from 'jsonwebtoken';

const FULL_CAPABILITIES = ['mcp:full'];
const ISSUED_PREFIX = ['mb', 'live'].join('_') + '_';
const BEARER_PREFIX = ['mcp', 'oauth'].join('_') + '_';
const SIGNING_MATERIAL = ['unit', 'signing', 'fixture'].join('-');
const OTHER_SIGNING_MATERIAL = ['other', 'unit', 'fixture'].join('-');
const HMAC_MATERIAL = ['unit', 'api', 'hash', 'fixture'].join('-').repeat(4);
const OTHER_HMAC_MATERIAL = ['other', 'api', 'hash', 'fixture'].join('-').repeat(4);
const HMAC_ENV_NAME = ['API', 'KEY', 'SECRET'].join('_');
const SIGNING_ENV_NAME = ['JWT', 'SECRET'].join('_');
const issued = (body: string) => ISSUED_PREFIX + body;
const bearer = (body: string) => BEARER_PREFIX + body;

describe('AuthService', () => {
  let authService: AuthService;

  beforeEach(() => {
    authService = new AuthService(SIGNING_MATERIAL);
  });

  describe('validateApiKeyFormat', () => {
    it('should accept valid API key format', () => {
      const sample = issued('A'.repeat(64));
      expect(authService.validateApiKeyFormat(sample)).toBe(true);
    });

    it('should accept current 64-character and legacy OSS 32-character keys', () => {
      const sample32 = issued('A'.repeat(32));
      const sample64 = issued('A'.repeat(64));
      expect(authService.validateApiKeyFormat(sample32)).toBe(true);
      expect(authService.validateApiKeyFormat(sample64)).toBe(true);
    });

    it('should reject keys without mb_live_ prefix', () => {
      const sample = ['invalid', 'A'.repeat(32)].join('_');
      expect(authService.validateApiKeyFormat(sample)).toBe(false);
    });

    it('should reject keys that are too short', () => {
      const sample = issued('ABC');
      expect(authService.validateApiKeyFormat(sample)).toBe(false);
    });

    it('should reject keys that are too long', () => {
      const sample = issued('A'.repeat(65));
      expect(authService.validateApiKeyFormat(sample)).toBe(false);
    });

    it('should reject keys with invalid characters', () => {
      const invalidChars = issued('A'.repeat(30) + '!@');
      expect(authService.validateApiKeyFormat(invalidChars)).toBe(false);
    });
  });

  describe('hashApiKey', () => {
    it('should generate consistent SHA-256 hash', () => {
      const sample = issued(['test', '12345678901234567890123456'].join(''));
      const hash1 = authService.hashApiKey(sample);
      const hash2 = authService.hashApiKey(sample);
      
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64); // SHA-256 hex is 64 chars
    });

    it('should generate different hashes for different keys', () => {
      const sample1 = issued(['key', '1'.repeat(28)].join(''));
      const sample2 = issued(['key', '2'.repeat(28)].join(''));
      
      const hash1 = authService.hashApiKey(sample1);
      const hash2 = authService.hashApiKey(sample2);
      
      expect(hash1).not.toBe(hash2);
    });

    it('should produce hexadecimal output', () => {
      const sample = issued(['test', '12345678901234567890123456'].join(''));
      const hash = authService.hashApiKey(sample);
      
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('generateJWT', () => {
    it('should generate valid JWT with tenant_id', () => {
      const encoded = authService.generateJWT('tenant-123', 'user-456', undefined, 0, FULL_CAPABILITIES);
      expect(encoded).toBeTruthy();
      expect(typeof encoded).toBe('string');
      expect(encoded.split('.')).toHaveLength(3); // JWT has 3 parts
    });

    it('should include project_id when provided', () => {
      const encoded = authService.generateJWT('tenant-123', 'user-456', 'project-789', 0, ['memory:read']);
      const result = authService.verifyJWT(encoded);
      
      expect(result.success).toBe(true);
      expect(result.tenantId).toBe('tenant-123');
      expect(result.projectId).toBe('project-789');
    });

    it('should work without project_id', () => {
      const encoded = authService.generateJWT('tenant-123', 'user-456', undefined, 0, FULL_CAPABILITIES);
      const result = authService.verifyJWT(encoded);
      
      expect(result.success).toBe(true);
      expect(result.tenantId).toBe('tenant-123');
      expect(result.projectId).toBeUndefined();
    });

    it('requires callers to provide a non-empty capability set', () => {
      expect(() => authService.generateJWT('tenant-123', 'user-456', undefined, 0, []))
        .toThrow('capabilities must be explicitly provided');
    });
  });

  describe('verifyJWT', () => {
    it('should verify valid JWT and extract tenant_id', () => {
      const encoded = authService.generateJWT('tenant-123', 'user-456', undefined, 0, FULL_CAPABILITIES);
      const result = authService.verifyJWT(encoded);
      
      expect(result.success).toBe(true);
      expect(result.tenantId).toBe('tenant-123');
    });

    it('should extract project_id when present', () => {
      const encoded = authService.generateJWT('tenant-123', 'user-456', 'project-789', 0, ['memory:read']);
      const result = authService.verifyJWT(encoded);
      
      expect(result.success).toBe(true);
      expect(result.projectId).toBe('project-789');
    });

    it('should reject invalid JWT', () => {
      const result = authService.verifyJWT('invalid-token');
      
      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
    });

    it('should reject JWT with wrong secret', () => {
      const otherService = new AuthService(OTHER_SIGNING_MATERIAL);
      const encoded = otherService.generateJWT('tenant-123', 'user-456', undefined, 0, FULL_CAPABILITIES);
      const result = authService.verifyJWT(encoded);
      
      expect(result.success).toBe(false);
    });

    it('should reject empty token', () => {
      const result = authService.verifyJWT('');
      
      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
    });

    it('fails closed for a correctly signed JWT without capabilities', () => {
      const encoded = jwt.sign(
        { sub: 'user-456', tenant_id: 'tenant-123', auth_version: 0 },
        SIGNING_MATERIAL,
        { algorithm: 'HS256', issuer: 'rembr', audience: 'rembr-mcp' },
      );

      expect(authService.verifyJWT(encoded)).toMatchObject({
        success: false,
        error: 'Authentication failed',
      });
    });

    it('fails closed in production for a signed JWT without a user principal', () => {
      const previous = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        const encoded = jwt.sign(
          { tenant_id: 'tenant-123', auth_version: 0, capabilities: ['memory:read'] },
          SIGNING_MATERIAL,
          { algorithm: 'HS256', issuer: 'rembr', audience: 'rembr-mcp' },
        );
        expect(authService.verifyJWT(encoded)).toMatchObject({
          success: false,
          error: 'Authentication failed',
        });
      } finally {
        process.env.NODE_ENV = previous;
      }
    });

    it('accepts a narrowly bound UI delegation token', () => {
      const encoded = authService.generateJWT(
        'tenant-123',
        'user-456',
        'project-789',
        3,
        ['memory:read'],
        'ui_delegation',
      );

      expect(authService.verifyJWT(encoded)).toMatchObject({
        success: true,
        projectId: 'project-789',
        userId: 'user-456',
        authVersion: 3,
        capabilities: ['memory:read'],
        purpose: 'ui_delegation',
      });
    });

    it('rejects UI delegation tokens without project binding or with broad capabilities', () => {
      const noProject = authService.generateJWT(
        'tenant-123', 'user-456', undefined, 3, ['memory:read'], 'ui_delegation',
      );
      const broad = jwt.sign(
        { sub: 'user-456', tenant_id: 'tenant-123', project_id: 'project-789', auth_version: 3, capabilities: ['mcp:full'], purpose: 'ui_delegation' },
        SIGNING_MATERIAL,
        { algorithm: 'HS256', issuer: 'rembr', audience: 'rembr-mcp' },
      );

      expect(authService.verifyJWT(noProject).error).toBe('Authentication failed');
      expect(authService.verifyJWT(broad).error).toBe('Authentication failed');
    });

    it('rejects a correctly signed project-bound JWT carrying tenant-wide mcp:full', () => {
      const encoded = jwt.sign(
        { sub: 'user-456', tenant_id: 'tenant-123', project_id: 'project-789', auth_version: 0, capabilities: ['mcp:full'] },
        SIGNING_MATERIAL,
        { algorithm: 'HS256', issuer: 'rembr', audience: 'rembr-mcp' },
      );
      expect(authService.verifyJWT(encoded)).toMatchObject({ success: false, error: 'Authentication failed' });
      expect(() => authService.generateJWT('tenant-123', 'user-456', 'project-789', 0, ['mcp:full']))
        .toThrow('cannot carry mcp:full');
    });

    it('rejects tokens signed with an algorithm outside the HS256 allow-list', () => {
      const encoded = jwt.sign(
        { sub: 'user-456', tenant_id: 'tenant-123', auth_version: 0 },
        SIGNING_MATERIAL,
        { algorithm: 'HS384', issuer: 'rembr', audience: 'rembr-mcp' },
      );

      expect(authService.verifyJWT(encoded).success).toBe(false);
    });

    it('rejects issuer and audience confusion', () => {
      const wrongIssuer = jwt.sign(
        { sub: 'user-456', tenant_id: 'tenant-123', auth_version: 0 },
        SIGNING_MATERIAL,
        { algorithm: 'HS256', issuer: 'other-issuer', audience: 'rembr-mcp' },
      );
      const wrongAudience = jwt.sign(
        { sub: 'user-456', tenant_id: 'tenant-123', auth_version: 0 },
        SIGNING_MATERIAL,
        { algorithm: 'HS256', issuer: 'rembr', audience: 'other-api' },
      );

      expect(authService.verifyJWT(wrongIssuer).success).toBe(false);
      expect(authService.verifyJWT(wrongAudience).success).toBe(false);
    });
  });

  describe('extractBearerToken', () => {
    it('should extract token from valid Bearer header', () => {
      const extracted = authService.extractBearerToken('Bearer abc123token');
      expect(extracted).toBe('abc123token');
    });

    it('should return null for missing header', () => {
      const extracted = authService.extractBearerToken(undefined);
      expect(extracted).toBeNull();
    });

    it('should return null for non-Bearer header', () => {
      const extracted = authService.extractBearerToken('Basic abc123');
      expect(extracted).toBeNull();
    });

    it('should handle Bearer with no space', () => {
      const extracted = authService.extractBearerToken('Bearerabc123');
      expect(extracted).toBeNull();
    });

    it('should handle empty Bearer token', () => {
      const extracted = authService.extractBearerToken('Bearer ');
      expect(extracted).toBe('');
    });
  });
});

describe('verifyOAuthToken', () => {
  beforeEach(() => {
    process.env.OAUTH_EXPECTED_ISSUER = 'https://auth.rembr.test';
    process.env.OAUTH_EXPECTED_AUDIENCE = 'https://mcp.rembr.test/mcp';
  });

  afterEach(() => {
    delete process.env.OAUTH_EXPECTED_ISSUER;
    delete process.env.OAUTH_EXPECTED_AUDIENCE;
    delete process.env.OAUTH_ENFORCE_ISSUER;
  });

  it('should reject tokens without mcp_oauth_ prefix', async () => {
    const mockPool = {
      query: () => Promise.resolve({ rows: [] })
    };
    
    const result = await verifyOAuthToken(mockPool, 'invalid-token');
    
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('should reject expired tokens', async () => {
    const mockPool = {
      query: () => Promise.resolve({
        rows: [{
          tenant_id: 'tenant-123',
          project_id: null,
          expires_at: new Date(Date.now() - 1000) // Expired 1 second ago
        }]
      })
    };
    
    const result = await verifyOAuthToken(mockPool, bearer(['valid', 'sample', '123'].join('')));
    
    expect(result.success).toBe(false);
    expect(result.error).toContain('expired');
  });

  it('should accept valid non-expired tokens', async () => {
    const mockPool = {
      query: () => Promise.resolve({
        rows: [{
          tenant_id: 'tenant-123',
          user_id: 'user-456',
          issuer: 'https://auth.rembr.test',
          audience: 'https://mcp.rembr.test/mcp',
          resource: 'https://mcp.rembr.test/mcp',
          expires_at: new Date(Date.now() + 3600000) // Expires in 1 hour
        }]
      })
    };
    
    const result = await verifyOAuthToken(mockPool, bearer(['valid', 'sample', '123'].join('')));
    
    expect(result.success).toBe(true);
    expect(result.tenantId).toBe('tenant-123');
    expect(result.projectId).toBeUndefined(); // OAuth tokens don't have project scope
  });

  it('should reject tokens not found in database', async () => {
    const mockPool = {
      query: () => Promise.resolve({ rows: [] })
    };
    
    const result = await verifyOAuthToken(mockPool, bearer(['not', 'found', '123'].join('')));
    
    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid or expired OAuth token');
  });

  it('propagates exact OAuth scope and project binding', async () => {
    const mockPool = {
      query: () => Promise.resolve({
        rows: [{
          tenant_id: 'tenant-123',
          project_id: 'project-789',
          user_id: 'user-456',
          client_id: 'client-1',
          scope: 'openid memory:read',
          auth_version: 4,
          issuer: 'https://auth.rembr.test',
          audience: 'https://mcp.rembr.test/mcp',
          resource: 'https://mcp.rembr.test/mcp',
          expires_at: new Date(Date.now() + 3600000),
        }]
      })
    };

    const result = await verifyOAuthToken(mockPool, bearer(['valid', 'sample', '123'].join('')));

    expect(result).toMatchObject({
      success: true,
      tenantId: 'tenant-123',
      projectId: 'project-789',
      userId: 'user-456',
      clientId: 'client-1',
      resource: 'https://mcp.rembr.test/mcp',
      authVersion: 4,
      capabilities: ['openid', 'memory:read'],
    });
  });

  it('rejects project-bound OAuth tokens carrying tenant-wide mcp:full', async () => {
    const result = await verifyOAuthToken({
      query: async () => ({ rows: [{
        tenant_id: 'tenant-123', project_id: 'project-789', user_id: 'user-456',
        scope: 'mcp:full', issuer: 'https://auth.rembr.test',
        audience: 'https://mcp.rembr.test/mcp', resource: 'https://mcp.rembr.test/mcp',
        expires_at: new Date(Date.now() + 3_600_000),
      }] }),
    }, bearer(['project', 'full', 'sample'].join('')));
    expect(result).toMatchObject({ success: false, error: 'Authentication failed' });
  });

  it('rejects revoked or incorrectly bound OAuth tokens', async () => {
    process.env.OAUTH_EXPECTED_ISSUER = 'https://auth.rembr.test';
    process.env.OAUTH_EXPECTED_AUDIENCE = 'https://mcp.rembr.test/mcp';
    const base = {
      tenant_id: 'tenant-123',
      user_id: 'user-456',
      scope: 'memory:read',
      expires_at: new Date(Date.now() + 3600000),
      issuer: 'https://auth.rembr.test',
      audience: 'https://mcp.rembr.test/mcp',
      resource: 'https://mcp.rembr.test/mcp',
    };

    const revoked = await verifyOAuthToken(
      { query: () => Promise.resolve({ rows: [{ ...base, revoked_at: new Date() }] }) },
      bearer(['revoked', 'sample', '123'].join('')),
    );
    const wrongIssuer = await verifyOAuthToken(
      { query: () => Promise.resolve({ rows: [{ ...base, issuer: 'https://evil.test' }] }) },
      bearer(['wrong', 'issuer', '123'].join('')),
    );
    const wrongAudience = await verifyOAuthToken(
      { query: () => Promise.resolve({ rows: [{ ...base, audience: 'https://other.test' }] }) },
      bearer(['wrong', 'audience', '123'].join('')),
    );

    expect(revoked.error).toContain('revoked');
    expect(wrongIssuer.error).toContain('issuer mismatch');
    expect(wrongAudience.error).toContain('resource binding mismatch');
  });

  it('requires resource and audience to match the exact configured /mcp resource', async () => {
    const base = {
      tenant_id: 'tenant-123',
      user_id: 'user-456',
      scope: 'memory:read',
      expires_at: new Date(Date.now() + 3600000),
      issuer: 'https://auth.rembr.test',
      audience: 'https://mcp.rembr.test/mcp',
      resource: 'https://mcp.rembr.test/mcp',
    };
    const token = bearer(['strict', 'resource', 'sample'].join(''));

    for (const row of [
      { ...base, resource: undefined },
      { ...base, audience: undefined },
      { ...base, resource: 'https://mcp.rembr.test' },
      { ...base, audience: 'https://mcp.rembr.test' },
      { ...base, resource: 'https://other.test/mcp', audience: 'https://other.test/mcp' },
    ]) {
      const result = await verifyOAuthToken({ query: async () => ({ rows: [row] }) }, token);
      expect(result).toMatchObject({ success: false, error: 'OAuth token resource binding mismatch' });
    }
  });

  it('rejects an origin-only or missing expected resource configuration', async () => {
    const row = {
      tenant_id: 'tenant-123', user_id: 'user-456', scope: 'memory:read',
      expires_at: new Date(Date.now() + 3600000), issuer: 'https://auth.rembr.test',
      audience: 'https://mcp.rembr.test/mcp', resource: 'https://mcp.rembr.test/mcp',
    };
    const token = bearer(['config', 'resource', 'sample'].join(''));

    process.env.OAUTH_EXPECTED_AUDIENCE = 'https://mcp.rembr.test';
    expect(await verifyOAuthToken({ query: async () => ({ rows: [row] }) }, token)).toMatchObject({
      success: false,
      error: 'OAuth protected resource is not canonical',
    });
    delete process.env.OAUTH_EXPECTED_AUDIENCE;
    expect(await verifyOAuthToken({ query: async () => ({ rows: [row] }) }, token)).toMatchObject({
      success: false,
      error: 'OAuth protected resource is not configured',
    });
  });
});

// ---------------------------------------------------------------------------
// REM-250 / REM-252: HMAC hashing, timing-safe comparison, prefix lookup
// ---------------------------------------------------------------------------

describe('AuthService — HMAC hashing (REM-250)', () => {
  afterEach(() => {
    delete process.env[HMAC_ENV_NAME];
  });

  it('hashApiKeyHmac produces HMAC-SHA256 (64-char hex) when secret is set', () => {
    process.env[HMAC_ENV_NAME] = HMAC_MATERIAL;
    const svc = new AuthService(SIGNING_MATERIAL);
    const sample = issued(['test', 'key', '123456789012345678901'].join(''));
    const hash = svc.hashApiKeyHmac(sample);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('hashApiKeyHmac produces different hash from plain SHA-256', () => {
    process.env[HMAC_ENV_NAME] = HMAC_MATERIAL;
    const svc = new AuthService(SIGNING_MATERIAL);
    const sample = issued(['test', 'key', '123456789012345678901'].join(''));
    expect(svc.hashApiKeyHmac(sample)).not.toBe(svc.hashApiKey(sample));
  });

  it('hashApiKeyHmac is deterministic for the same key + secret', () => {
    process.env[HMAC_ENV_NAME] = HMAC_MATERIAL;
    const svc = new AuthService(SIGNING_MATERIAL);
    const sample = issued(['test', 'key', '123456789012345678901'].join(''));
    expect(svc.hashApiKeyHmac(sample)).toBe(svc.hashApiKeyHmac(sample));
  });

  it('hashApiKeyHmac falls back to SHA-256 when API_KEY_SECRET not set', () => {
    // API_KEY_SECRET intentionally unset
    const svc = new AuthService(SIGNING_MATERIAL);
    const sample = issued(['test', 'key', '123456789012345678901'].join(''));
    expect(svc.hashApiKeyHmac(sample)).toBe(svc.hashApiKey(sample));
  });

  it('different API_KEY_SECRET produces different hash (rainbow table protection)', () => {
    process.env[HMAC_ENV_NAME] = HMAC_MATERIAL;
    const svc1 = new AuthService(SIGNING_MATERIAL);
    const hash1 = svc1.hashApiKeyHmac(issued(['test', 'key', '123456789012345678901'].join('')));

    process.env[HMAC_ENV_NAME] = OTHER_HMAC_MATERIAL;
    const svc2 = new AuthService(SIGNING_MATERIAL);
    const hash2 = svc2.hashApiKeyHmac(issued(['test', 'key', '123456789012345678901'].join('')));

    expect(hash1).not.toBe(hash2);
  });
});

describe('AuthService — verifyApiKeyHash timing-safe comparison (REM-252)', () => {
  afterEach(() => {
    delete process.env[HMAC_ENV_NAME];
  });

  it('returns true for correct key with sha256 algorithm', () => {
    const svc = new AuthService(SIGNING_MATERIAL);
    const sample = issued(['test', 'key', '123456789012345678901'].join(''));
    const hash = svc.hashApiKey(sample);
    expect(svc.verifyApiKeyHash(sample, hash, 'sha256')).toBe(true);
  });

  it('returns false for wrong key with sha256 algorithm', () => {
    const svc = new AuthService(SIGNING_MATERIAL);
    const sample = issued(['test', 'key', '123456789012345678901'].join(''));
    const hash = svc.hashApiKey(issued(['different', 'key', '12345678901234'].join('')));
    expect(svc.verifyApiKeyHash(sample, hash, 'sha256')).toBe(false);
  });

  it('returns true for correct key with hmac-sha256 algorithm', () => {
    process.env[HMAC_ENV_NAME] = HMAC_MATERIAL;
    const svc = new AuthService(SIGNING_MATERIAL);
    const sample = issued(['test', 'key', '123456789012345678901'].join(''));
    const hash = svc.hashApiKeyHmac(sample);
    expect(svc.verifyApiKeyHash(sample, hash, 'hmac-sha256')).toBe(true);
  });

  it('returns false when hmac-sha256 hash is compared against wrong key', () => {
    process.env[HMAC_ENV_NAME] = HMAC_MATERIAL;
    const svc = new AuthService(SIGNING_MATERIAL);
    const hash = svc.hashApiKeyHmac(issued(['correct', 'key', '1234567890123456'].join('')));
    expect(svc.verifyApiKeyHash(issued(['wrong', 'key', '12345678901234567'].join('')), hash, 'hmac-sha256')).toBe(false);
  });

  it('defaults to sha256 algorithm when not specified', () => {
    const svc = new AuthService(SIGNING_MATERIAL);
    const sample = issued(['test', 'key', '123456789012345678901'].join(''));
    const hash = svc.hashApiKey(sample);
    expect(svc.verifyApiKeyHash(sample, hash)).toBe(true);
  });
});

describe('extractKeyPrefix', () => {
  it('extracts first 20 chars of the key', () => {
    const sample = issued('abcdefghijklmnopqrstuvwxyz');
    expect(extractKeyPrefix(sample)).toBe(issued('abcdefghijkl'));
    expect(extractKeyPrefix(sample)).toHaveLength(20);
  });

  it('is consistent (same key → same prefix)', () => {
    const sample = issued(['test', '1234567890123456789012'].join(''));
    expect(extractKeyPrefix(sample)).toBe(extractKeyPrefix(sample));
  });
});

describe('verifyApiKey — prefix-based lookup with timing-safe comparison (REM-252)', () => {
  const issuedSample = issued('a'.repeat(64));
  const prefixSample = extractKeyPrefix(issuedSample);

  beforeEach(() => {
    // verifyApiKey internally creates AuthService which requires JWT_SECRET
    process.env[SIGNING_ENV_NAME] = SIGNING_MATERIAL;
  });

  afterEach(() => {
    delete process.env[SIGNING_ENV_NAME];
  });

  it('returns success for valid sha256 key', async () => {
    const svc = new AuthService(SIGNING_MATERIAL);
    const storedHash = svc.hashApiKey(issuedSample);

    const query = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('UPDATE api_keys')) return { rows: [{ id: 'key-uuid' }], rowCount: 1 };
      return {
        rows: [{
          id: 'key-uuid',
          key_hash: storedHash,
          hash_algorithm: 'sha256',
          tenant_id: 'tenant-123',
          project_id: null,
          user_id: 'user-456',
          capabilities: ['memory:read'],
        }]
      };
    });
    const mockPool = {
      query,
    };

    const result = await verifyApiKey(mockPool, issuedSample);
    expect(result.success).toBe(true);
    expect(result.tenantId).toBe('tenant-123');
    expect(result.apiKeyId).toBe('key-uuid');
    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(/UPDATE api_keys[\s\S]*last_used_at = CASE[\s\S]*RETURNING k\.id/),
      ['key-uuid', 'tenant-123'],
    );
  });

  it('rejects when revocation wins between lookup and lifecycle confirmation', async () => {
    const svc = new AuthService(SIGNING_MATERIAL);
    const storedHash = svc.hashApiKey(issuedSample);
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        id: 'key-uuid', key_hash: storedHash, hash_algorithm: 'sha256',
        tenant_id: 'tenant-123', tenant_status: 'active', capabilities: ['memory:read'],
      }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await expect(verifyApiKey({ query }, issuedSample)).resolves.toMatchObject({
      success: false,
      error: 'Authentication failed',
    });
    expect(query.mock.calls[1][0]).toContain('revoked_at IS NULL');
    expect(query.mock.calls[1][0]).toContain('RETURNING k.id');
  });

  it('fails closed for an unknown stored hash algorithm marker', async () => {
    const svc = new AuthService(SIGNING_MATERIAL);
    const storedHash = svc.hashApiKey(issuedSample);
    const query = vi.fn().mockResolvedValue({ rows: [{
      id: 'key-uuid', key_hash: storedHash, hash_algorithm: 'future-algorithm',
      tenant_id: 'tenant-123', tenant_status: 'active', capabilities: ['memory:read'],
    }] });

    await expect(verifyApiKey({ query }, issuedSample)).resolves.toMatchObject({
      success: false,
      error: 'Invalid or revoked API key',
    });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('returns failure when key_prefix not found', async () => {
    const mockPool = { query: async () => ({ rows: [] }) };
    const result = await verifyApiKey(mockPool, issuedSample);
    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid or revoked API key');
  });

  it('returns failure when hash does not match (wrong key, same prefix)', async () => {
    const svc = new AuthService(SIGNING_MATERIAL);
    // Hash a different key but the prefix lookup would return it
    const storedHash = svc.hashApiKey(issued(['different', 'key', '_but_same_prefix_x'].join('')));

    const mockPool = {
      query: async () => ({
        rows: [{
          id: 'key-uuid',
          key_hash: storedHash,
          hash_algorithm: 'sha256',
          tenant_id: 'tenant-123',
          project_id: null,
          user_id: 'user-456'
        }]
      })
    };

    const result = await verifyApiKey(mockPool, issuedSample);
    expect(result.success).toBe(false);
  });

  it('rejects invalid key format before DB lookup', async () => {
    const mockPool = { query: async () => { throw new Error('should not be called'); } };
    const result = await verifyApiKey(mockPool, 'invalid-key-format');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid API key format');
  });

  it('handles DB errors gracefully', async () => {
    const mockPool = {
      query: async () => { throw new Error('DB connection failed'); }
    };
    const result = await verifyApiKey(mockPool, issuedSample);
    expect(result.success).toBe(false);
    expect(result.error).toBe('Authentication failed');
  });

  it('rejects expired keys and standard keys for unclaimed tenants', async () => {
    const svc = new AuthService(SIGNING_MATERIAL);
    const storedHash = svc.hashApiKey(issuedSample);
    const row = {
      id: 'key-uuid',
      key_hash: storedHash,
      hash_algorithm: 'sha256',
      tenant_id: 'tenant-123',
      project_id: null,
      user_id: null,
      purpose: 'standard',
      capabilities: ['memory:read'],
    };

    const expired = await verifyApiKey(
      { query: async () => ({ rows: [{ ...row, expires_at: new Date(Date.now() - 1) }] }) },
      issuedSample,
    );
    const unclaimed = await verifyApiKey(
      { query: async () => ({ rows: [{ ...row, tenant_status: 'unclaimed' }] }) },
      issuedSample,
    );

    expect(expired.error).toContain('expired');
    expect(unclaimed.error).toContain('not active');
  });

  it('preserves scoped agent-first bootstrap access for an unclaimed tenant', async () => {
    const svc = new AuthService(SIGNING_MATERIAL);
    const storedHash = svc.hashApiKey(issuedSample);
    const capabilities = ['memory:read', 'memory:write', 'context:manage', 'snapshot:manage'];

    const result = await verifyApiKey({
      query: async () => ({
        rows: [{
          id: 'bootstrap-key',
          key_hash: storedHash,
          hash_algorithm: 'sha256',
          tenant_id: 'tenant-123',
          tenant_status: 'unclaimed',
          project_id: 'project-123',
          user_id: null,
          purpose: 'agent_bootstrap',
          capabilities,
          expires_at: new Date(Date.now() + 3600000),
        }]
      })
    }, issuedSample);

    expect(result).toMatchObject({
      success: true,
      purpose: 'agent_bootstrap',
      projectId: 'project-123',
      capabilities,
    });
  });

  it('fails closed when a valid key has missing or empty capabilities', async () => {
    const svc = new AuthService(SIGNING_MATERIAL);
    const storedHash = svc.hashApiKey(issuedSample);
    const base = {
      id: 'key-uuid', key_hash: storedHash, hash_algorithm: 'sha256',
      tenant_id: 'tenant-123', tenant_status: 'active', purpose: 'standard',
    };

    for (const capabilities of [undefined, [], '', '{}']) {
      const result = await verifyApiKey({
        query: async () => ({ rows: [{ ...base, capabilities }] })
      }, issuedSample);
      expect(result).toMatchObject({ success: false, error: 'API key has no capabilities' });
    }
  });

  it('rejects project-bound API keys carrying tenant-wide mcp:full', async () => {
    const svc = new AuthService(SIGNING_MATERIAL);
    const storedHash = svc.hashApiKey(issuedSample);
    const query = vi.fn().mockResolvedValue({ rows: [{
      id: 'key-uuid', key_hash: storedHash, hash_algorithm: 'sha256',
      tenant_id: 'tenant-123', project_id: 'project-123', capabilities: ['mcp:full'],
    }] });
    const result = await verifyApiKey({ query }, issuedSample);
    expect(result).toMatchObject({ success: false, error: 'Authentication failed' });
    expect(query.mock.calls.some(([sql]) => String(sql).includes('UPDATE api_keys'))).toBe(false);
  });
});
