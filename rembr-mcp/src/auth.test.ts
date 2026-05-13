import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AuthService, verifyOAuthToken, verifyApiKey, extractKeyPrefix, type AuthResult } from './auth.js';

describe('AuthService', () => {
  let authService: AuthService;

  beforeEach(() => {
    authService = new AuthService('test-jwt-secret');
  });

  describe('validateApiKeyFormat', () => {
    it('should accept valid API key format', () => {
      const validKey = 'mb_live_' + 'A'.repeat(32);
      expect(authService.validateApiKeyFormat(validKey)).toBe(true);
    });

    it('should accept API keys between 32-64 chars', () => {
      const key32 = 'mb_live_' + 'A'.repeat(32);
      const key64 = 'mb_live_' + 'A'.repeat(64);
      expect(authService.validateApiKeyFormat(key32)).toBe(true);
      expect(authService.validateApiKeyFormat(key64)).toBe(true);
    });

    it('should reject keys without mb_live_ prefix', () => {
      const invalidKey = 'invalid_' + 'A'.repeat(32);
      expect(authService.validateApiKeyFormat(invalidKey)).toBe(false);
    });

    it('should reject keys that are too short', () => {
      const shortKey = 'mb_live_ABC';
      expect(authService.validateApiKeyFormat(shortKey)).toBe(false);
    });

    it('should reject keys that are too long', () => {
      const longKey = 'mb_live_' + 'A'.repeat(65);
      expect(authService.validateApiKeyFormat(longKey)).toBe(false);
    });

    it('should reject keys with invalid characters', () => {
      const invalidChars = 'mb_live_' + 'A'.repeat(30) + '!@';
      expect(authService.validateApiKeyFormat(invalidChars)).toBe(false);
    });
  });

  describe('hashApiKey', () => {
    it('should generate consistent SHA-256 hash', () => {
      const apiKey = 'mb_live_test12345678901234567890123456';
      const hash1 = authService.hashApiKey(apiKey);
      const hash2 = authService.hashApiKey(apiKey);
      
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64); // SHA-256 hex is 64 chars
    });

    it('should generate different hashes for different keys', () => {
      const key1 = 'mb_live_key1111111111111111111111111111';
      const key2 = 'mb_live_key2222222222222222222222222222';
      
      const hash1 = authService.hashApiKey(key1);
      const hash2 = authService.hashApiKey(key2);
      
      expect(hash1).not.toBe(hash2);
    });

    it('should produce hexadecimal output', () => {
      const apiKey = 'mb_live_test12345678901234567890123456';
      const hash = authService.hashApiKey(apiKey);
      
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('generateJWT', () => {
    it('should generate valid JWT with tenant_id', () => {
      const token = authService.generateJWT('tenant-123', 'user-456');
      expect(token).toBeTruthy();
      expect(typeof token).toBe('string');
      expect(token.split('.')).toHaveLength(3); // JWT has 3 parts
    });

    it('should include project_id when provided', () => {
      const token = authService.generateJWT('tenant-123', 'user-456', 'project-789');
      const result = authService.verifyJWT(token);
      
      expect(result.success).toBe(true);
      expect(result.tenantId).toBe('tenant-123');
      expect(result.projectId).toBe('project-789');
    });

    it('should work without project_id', () => {
      const token = authService.generateJWT('tenant-123', 'user-456');
      const result = authService.verifyJWT(token);
      
      expect(result.success).toBe(true);
      expect(result.tenantId).toBe('tenant-123');
      expect(result.projectId).toBeUndefined();
    });
  });

  describe('verifyJWT', () => {
    it('should verify valid JWT and extract tenant_id', () => {
      const token = authService.generateJWT('tenant-123', 'user-456');
      const result = authService.verifyJWT(token);
      
      expect(result.success).toBe(true);
      expect(result.tenantId).toBe('tenant-123');
    });

    it('should extract project_id when present', () => {
      const token = authService.generateJWT('tenant-123', 'user-456', 'project-789');
      const result = authService.verifyJWT(token);
      
      expect(result.success).toBe(true);
      expect(result.projectId).toBe('project-789');
    });

    it('should reject invalid JWT', () => {
      const result = authService.verifyJWT('invalid-token');
      
      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
    });

    it('should reject JWT with wrong secret', () => {
      const otherService = new AuthService('different-secret');
      const token = otherService.generateJWT('tenant-123', 'user-456');
      const result = authService.verifyJWT(token);
      
      expect(result.success).toBe(false);
    });

    it('should reject empty token', () => {
      const result = authService.verifyJWT('');
      
      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
    });
  });

  describe('extractBearerToken', () => {
    it('should extract token from valid Bearer header', () => {
      const token = authService.extractBearerToken('Bearer abc123token');
      expect(token).toBe('abc123token');
    });

    it('should return null for missing header', () => {
      const token = authService.extractBearerToken(undefined);
      expect(token).toBeNull();
    });

    it('should return null for non-Bearer header', () => {
      const token = authService.extractBearerToken('Basic abc123');
      expect(token).toBeNull();
    });

    it('should handle Bearer with no space', () => {
      const token = authService.extractBearerToken('Bearerabc123');
      expect(token).toBeNull();
    });

    it('should handle empty Bearer token', () => {
      const token = authService.extractBearerToken('Bearer ');
      expect(token).toBe('');
    });
  });
});

describe('verifyOAuthToken', () => {
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
    
    const result = await verifyOAuthToken(mockPool, 'mcp_oauth_validtoken123');
    
    expect(result.success).toBe(false);
    expect(result.error).toContain('expired');
  });

  it('should accept valid non-expired tokens', async () => {
    const mockPool = {
      query: () => Promise.resolve({
        rows: [{
          tenant_id: 'tenant-123',
          user_id: 'user-456',
          expires_at: new Date(Date.now() + 3600000) // Expires in 1 hour
        }]
      })
    };
    
    const result = await verifyOAuthToken(mockPool, 'mcp_oauth_validtoken123');
    
    expect(result.success).toBe(true);
    expect(result.tenantId).toBe('tenant-123');
    expect(result.projectId).toBeUndefined(); // OAuth tokens don't have project scope
  });

  it('should reject tokens not found in database', async () => {
    const mockPool = {
      query: () => Promise.resolve({ rows: [] })
    };
    
    const result = await verifyOAuthToken(mockPool, 'mcp_oauth_notfound123');
    
    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid or expired OAuth token');
  });
});

// ---------------------------------------------------------------------------
// REM-250 / REM-252: HMAC hashing, timing-safe comparison, prefix lookup
// ---------------------------------------------------------------------------

describe('AuthService — HMAC hashing (REM-250)', () => {
  const TEST_API_KEY_SECRET = 'test-api-key-secret-64chars-padded-0000000000000000000000000000';

  afterEach(() => {
    delete process.env.API_KEY_SECRET;
  });

  it('hashApiKeyHmac produces HMAC-SHA256 (64-char hex) when secret is set', () => {
    process.env.API_KEY_SECRET = TEST_API_KEY_SECRET;
    const svc = new AuthService('test-jwt');
    const key = 'mb_live_testkey123456789012345678901';
    const hash = svc.hashApiKeyHmac(key);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('hashApiKeyHmac produces different hash from plain SHA-256', () => {
    process.env.API_KEY_SECRET = TEST_API_KEY_SECRET;
    const svc = new AuthService('test-jwt');
    const key = 'mb_live_testkey123456789012345678901';
    expect(svc.hashApiKeyHmac(key)).not.toBe(svc.hashApiKey(key));
  });

  it('hashApiKeyHmac is deterministic for the same key + secret', () => {
    process.env.API_KEY_SECRET = TEST_API_KEY_SECRET;
    const svc = new AuthService('test-jwt');
    const key = 'mb_live_testkey123456789012345678901';
    expect(svc.hashApiKeyHmac(key)).toBe(svc.hashApiKeyHmac(key));
  });

  it('hashApiKeyHmac falls back to SHA-256 when API_KEY_SECRET not set', () => {
    // API_KEY_SECRET intentionally unset
    const svc = new AuthService('test-jwt');
    const key = 'mb_live_testkey123456789012345678901';
    expect(svc.hashApiKeyHmac(key)).toBe(svc.hashApiKey(key));
  });

  it('different API_KEY_SECRET produces different hash (rainbow table protection)', () => {
    process.env.API_KEY_SECRET = TEST_API_KEY_SECRET;
    const svc1 = new AuthService('test-jwt');
    const hash1 = svc1.hashApiKeyHmac('mb_live_testkey123456789012345678901');

    process.env.API_KEY_SECRET = 'different-secret-64chars-padded-00000000000000000000000000000000';
    const svc2 = new AuthService('test-jwt');
    const hash2 = svc2.hashApiKeyHmac('mb_live_testkey123456789012345678901');

    expect(hash1).not.toBe(hash2);
  });
});

describe('AuthService — verifyApiKeyHash timing-safe comparison (REM-252)', () => {
  const TEST_API_KEY_SECRET = 'test-api-key-secret-64chars-padded-0000000000000000000000000000';

  afterEach(() => {
    delete process.env.API_KEY_SECRET;
  });

  it('returns true for correct key with sha256 algorithm', () => {
    const svc = new AuthService('test-jwt');
    const key = 'mb_live_testkey123456789012345678901';
    const hash = svc.hashApiKey(key);
    expect(svc.verifyApiKeyHash(key, hash, 'sha256')).toBe(true);
  });

  it('returns false for wrong key with sha256 algorithm', () => {
    const svc = new AuthService('test-jwt');
    const key = 'mb_live_testkey123456789012345678901';
    const hash = svc.hashApiKey('mb_live_differentkey12345678901234');
    expect(svc.verifyApiKeyHash(key, hash, 'sha256')).toBe(false);
  });

  it('returns true for correct key with hmac-sha256 algorithm', () => {
    process.env.API_KEY_SECRET = TEST_API_KEY_SECRET;
    const svc = new AuthService('test-jwt');
    const key = 'mb_live_testkey123456789012345678901';
    const hash = svc.hashApiKeyHmac(key);
    expect(svc.verifyApiKeyHash(key, hash, 'hmac-sha256')).toBe(true);
  });

  it('returns false when hmac-sha256 hash is compared against wrong key', () => {
    process.env.API_KEY_SECRET = TEST_API_KEY_SECRET;
    const svc = new AuthService('test-jwt');
    const hash = svc.hashApiKeyHmac('mb_live_correctkey1234567890123456');
    expect(svc.verifyApiKeyHash('mb_live_wrongkey12345678901234567', hash, 'hmac-sha256')).toBe(false);
  });

  it('defaults to sha256 algorithm when not specified', () => {
    const svc = new AuthService('test-jwt');
    const key = 'mb_live_testkey123456789012345678901';
    const hash = svc.hashApiKey(key);
    expect(svc.verifyApiKeyHash(key, hash)).toBe(true);
  });
});

describe('extractKeyPrefix', () => {
  it('extracts first 20 chars of the key', () => {
    const key = 'mb_live_abcdefghijklmnopqrstuvwxyz';
    expect(extractKeyPrefix(key)).toBe('mb_live_abcdefghijkl');
    expect(extractKeyPrefix(key)).toHaveLength(20);
  });

  it('is consistent (same key → same prefix)', () => {
    const key = 'mb_live_test1234567890123456789012';
    expect(extractKeyPrefix(key)).toBe(extractKeyPrefix(key));
  });
});

describe('verifyApiKey — prefix-based lookup with timing-safe comparison (REM-252)', () => {
  const validKey = 'mb_live_testkey123456789012345678901';
  const validPrefix = extractKeyPrefix(validKey);

  beforeEach(() => {
    // verifyApiKey internally creates AuthService which requires JWT_SECRET
    process.env.JWT_SECRET = 'test-jwt-secret';
  });

  afterEach(() => {
    delete process.env.JWT_SECRET;
  });

  it('returns success for valid sha256 key', async () => {
    const svc = new AuthService('test-jwt');
    const storedHash = svc.hashApiKey(validKey);

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

    const result = await verifyApiKey(mockPool, validKey);
    expect(result.success).toBe(true);
    expect(result.tenantId).toBe('tenant-123');
    expect(result.apiKeyId).toBe('key-uuid');
  });

  it('returns failure when key_prefix not found', async () => {
    const mockPool = { query: async () => ({ rows: [] }) };
    const result = await verifyApiKey(mockPool, validKey);
    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid or revoked API key');
  });

  it('returns failure when hash does not match (wrong key, same prefix)', async () => {
    const svc = new AuthService('test-jwt');
    // Hash a different key but the prefix lookup would return it
    const storedHash = svc.hashApiKey('mb_live_differentkey_but_same_prefix_x');

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

    const result = await verifyApiKey(mockPool, validKey);
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
    const result = await verifyApiKey(mockPool, validKey);
    expect(result.success).toBe(false);
    expect(result.error).toBe('Authentication failed');
  });
});
