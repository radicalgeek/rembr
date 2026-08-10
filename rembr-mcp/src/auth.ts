import { createHash, createHmac, timingSafeEqual } from 'crypto';
import jwt from 'jsonwebtoken';

// ---------------------------------------------------------------------------
// Hashing utilities
// ---------------------------------------------------------------------------

/**
 * Hash an OAuth token for DB lookup (SHA-256, stored hashed in oauth_tokens).
 * Must match the hashing used by the OAuth issuer.
 */
function hashOAuthToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Timing-safe comparison of two strings (REM-252).
 *
 * Compares the HMAC-SHA256 of both values so that the comparison is always
 * constant-time regardless of string length or content.  Using raw
 * `timingSafeEqual` on variable-length inputs would only be safe when
 * lengths match; the HMAC wrapper eliminates that constraint.
 *
 * @internal
 */
function timingSafeCompare(a: string, b: string): boolean {
  // Derive fixed-length buffers via HMAC so length-mismatch can't leak timing
  const key = Buffer.from('rembr-safe-cmp');
  const ha = createHmac('sha256', key).update(a).digest();
  const hb = createHmac('sha256', key).update(b).digest();
  return timingSafeEqual(ha, hb);
}

// ---------------------------------------------------------------------------
// API Key prefix extraction
// ---------------------------------------------------------------------------

/**
 * Extract the stored `key_prefix` from a raw API key.
 * Format: `mb_live_<random>` — we take the first 20 chars of the full key
 * (prefix "mb_live_" + 12 random chars) to match what is stored in DB.
 */
export function extractKeyPrefix(apiKey: string): string {
  return apiKey.slice(0, 20);
}

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface AuthResult {
  success: boolean;
  tenantId?: string;
  projectId?: string;
  sessionId?: string;
  userId?: string;
  apiKeyId?: string;
  authMethod?: 'oauth' | 'api_key' | 'jwt' | 'session';
  /** Canonical, server-enforced capabilities carried by this credential. */
  capabilities?: string[];
  /** Principal version captured when a stateless credential was issued. */
  authVersion?: number;
  /** OAuth client / API-key purpose for audit and policy decisions. */
  clientId?: string;
  purpose?: string;
  /** RFC 8707 protected resource bound to this OAuth token. */
  resource?: string;
  error?: string;
}

export interface ApiKeyData {
  id: string;
  key_hash: string;
  key_salt?: string;
  hash_algorithm?: string;
  tenant_id: string;
  project_id?: string;
  name: string;
  created_at: Date;
}

export interface JWTPayload {
  sub: string; // user_id
  tenant_id: string;
  project_id?: string;
  auth_version?: number;
  capabilities?: string[];
  purpose?: string;
  iss?: string;
  aud?: string | string[];
  iat?: number;
  exp?: number;
}

// ---------------------------------------------------------------------------
// AuthService
// ---------------------------------------------------------------------------

export class AuthService {
  private jwtSecret: string;
  private apiKeySecret?: string;

  constructor(jwtSecret?: string) {
    const secret = jwtSecret || process.env.JWT_SECRET;
    if (!secret) {
      throw new Error(
        'JWT_SECRET environment variable is not set. ' +
        'Refusing to start with a hardcoded fallback JWT secret.'
      );
    }
    this.jwtSecret = secret;
    this.apiKeySecret = process.env.API_KEY_SECRET;

    if (!this.apiKeySecret && process.env.NODE_ENV !== 'production') {
      console.warn(
        '[AuthService] API_KEY_SECRET is not set. API key hashing uses plain SHA-256 ' +
        '(vulnerable to rainbow table attacks). Set API_KEY_SECRET to enable ' +
        'HMAC-SHA256 hashing for new API keys.'
      );
    }
  }

  // ---------------------------------------------------------------------------
  // API key hashing
  // ---------------------------------------------------------------------------

  /**
   * Hash an API key using plain SHA-256 (legacy / fallback).
   *
   * Used when `API_KEY_SECRET` is not set, and for verifying existing keys
   * that were created before HMAC support was added (REM-250).
   */
  hashApiKey(apiKey: string): string {
    return createHash('sha256').update(apiKey).digest('hex');
  }

  /**
   * Hash an API key using HMAC-SHA256 with the server-side `API_KEY_SECRET`
   * (REM-250, REM-252).
   *
   * Benefits over plain SHA-256:
   * - The server secret acts as a global salt — rainbow table attacks are
   *   impossible without knowing the secret.
   * - Output is still a fixed-length hex string that fits in `key_hash` column.
   * - Key rotation: change `API_KEY_SECRET` + re-issue keys to invalidate all.
   *
   * Requires `API_KEY_SECRET` env var to be set; falls back to SHA-256 with a
   * warning if not set (preserves backwards compatibility on upgrade).
   */
  hashApiKeyHmac(apiKey: string): string {
    if (!this.apiKeySecret) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('API_KEY_SECRET is required to verify hmac-sha256 API keys in production');
      }
      return this.hashApiKey(apiKey);
    }
    return createHmac('sha256', this.apiKeySecret).update(apiKey).digest('hex');
  }

  /**
   * Verify an API key against a stored hash using timing-safe comparison (REM-252).
   *
   * @param providedKey  — the raw API key from the request
   * @param storedHash   — the hash stored in the DB
   * @param algorithm    — 'sha256' | 'hmac-sha256' (from `hash_algorithm` column)
   */
  verifyApiKeyHash(
    providedKey: string,
    storedHash: string,
    algorithm: 'sha256' | 'hmac-sha256' = 'sha256'
  ): boolean {
    const computedHash =
      algorithm === 'hmac-sha256'
        ? this.hashApiKeyHmac(providedKey)
        : this.hashApiKey(providedKey);

    return timingSafeCompare(computedHash, storedHash);
  }

  // ---------------------------------------------------------------------------
  // API key format validation
  // ---------------------------------------------------------------------------

  /** Validate API key format (mb_live_...) */
  validateApiKeyFormat(apiKey: string): boolean {
    return /^mb_live_(?:[A-Za-z0-9]{32}|[A-Za-z0-9]{64})$/.test(apiKey);
  }

  // ---------------------------------------------------------------------------
  // JWT
  // ---------------------------------------------------------------------------

  /** Verify JWT token and extract tenant info */
  verifyJWT(token: string): AuthResult {
    const invalid = (): AuthResult => ({ success: false, error: 'Authentication failed' });
    try {
      const issuer = process.env.JWT_ISSUER || process.env.PUBLIC_URL || 'rembr';
      const audience = process.env.JWT_AUDIENCE || 'rembr-mcp';
      const payload = jwt.verify(token, this.jwtSecret, {
        algorithms: ['HS256'],
        issuer,
        audience,
      }) as JWTPayload;

      if (!payload.tenant_id) {
        return invalid();
      }

      const capabilities = Array.isArray(payload.capabilities)
        ? payload.capabilities.filter((value): value is string => typeof value === 'string' && value.length > 0)
        : [];
      if (capabilities.length === 0) {
        return invalid();
      }
      if (payload.project_id && capabilities.includes('mcp:full')) {
        return invalid();
      }
      if (process.env.NODE_ENV === 'production' &&
          (!payload.sub || !Number.isInteger(payload.auth_version))) {
        return invalid();
      }
      if (payload.purpose === 'ui_delegation') {
        if (!payload.sub || !payload.project_id || !Number.isInteger(payload.auth_version)) {
          return invalid();
        }
        if (capabilities.some(capability => capability !== 'memory:read')) {
          return invalid();
        }
      }

      return {
        success: true,
        tenantId: payload.tenant_id,
        projectId: payload.project_id,
        userId: payload.sub,
        authVersion: payload.auth_version,
        capabilities,
        purpose: payload.purpose,
        authMethod: 'jwt'
      };
    } catch {
      return invalid();
    }
  }

  /** Extract Bearer token from Authorization header */
  extractBearerToken(authHeader?: string): string | null {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return null;
    }
    return authHeader.slice(7);
  }

  /** Generate JWT token (for testing or internal use) */
  generateJWT(
    tenantId: string,
    userId: string,
    projectId: string | undefined,
    authVersion: number,
    capabilities: string[],
    purpose?: string,
  ): string {
    if (capabilities.length === 0) {
      throw new Error('JWT capabilities must be explicitly provided');
    }
    if (projectId && capabilities.includes('mcp:full')) {
      throw new Error('Project-bound JWTs cannot carry mcp:full');
    }
    const payload: JWTPayload = {
      sub: userId,
      tenant_id: tenantId,
      project_id: projectId,
      auth_version: authVersion,
      capabilities,
      purpose,
    };
    return jwt.sign(payload, this.jwtSecret, {
      algorithm: 'HS256',
      expiresIn: '7d',
      issuer: process.env.JWT_ISSUER || process.env.PUBLIC_URL || 'rembr',
      audience: process.env.JWT_AUDIENCE || 'rembr-mcp',
    });
  }
}

/** Parse a space-delimited OAuth scope or PostgreSQL text array. */
function parseCapabilities(value: unknown): string[] {
  if (Array.isArray(value)) {
    return [...new Set(value.filter((v): v is string => typeof v === 'string' && v.length > 0))];
  }
  if (typeof value !== 'string') return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  const values = trimmed.startsWith('{') && trimmed.endsWith('}')
    ? trimmed.slice(1, -1).split(',')
    : trimmed.split(/\s+/);
  return [...new Set(values.map(v => v.replace(/^"|"$/g, '').trim()).filter(Boolean))];
}

// ---------------------------------------------------------------------------
// Standalone functions (used in middleware / index-http.ts)
// ---------------------------------------------------------------------------

/**
 * Verify an OAuth access token via DB lookup.
 *
 * OAuth tokens are strictly bound to the configured issuer and RFC 8707
 * protected resource. Both stored `resource` and `audience` must equal the
 * exact origin + `/mcp`; legacy grants require reauthorisation.
 */
export async function verifyOAuthToken(
  pool: any,
  accessToken: string
): Promise<AuthResult> {
  try {
    if (!accessToken.startsWith('mcp_oauth_')) {
      return { success: false, error: 'Invalid OAuth token format' };
    }

    if (process.env.NODE_ENV !== 'production') console.log('Querying oauth_tokens table for token verification');

    // SECURITY DEFINER lookup is intentionally narrow: rembr_app cannot bypass
    // OAuth-token RLS before the tenant is known.
    let result;
    try {
      result = await pool.query(
        `SELECT * FROM rembr_lookup_oauth_token($1)`,
        [hashOAuthToken(accessToken)]
      );
    } catch (colErr: any) {
      if (colErr?.code === '42883' && process.env.NODE_ENV !== 'production') {
        result = await pool.query(
          `SELECT tenant_id, project_id, user_id, client_id, scope, expires_at,
                  issuer, audience, resource, revoked_at
           FROM oauth_tokens
           WHERE access_token = $1`,
          [hashOAuthToken(accessToken)]
        );
      } else {
        throw colErr;
      }
    }

    if (result.rows.length === 0) {
      return { success: false, error: 'Invalid or expired OAuth token' };
    }

    const tokenData = result.rows[0];

    if (new Date(tokenData.expires_at) < new Date()) {
      return { success: false, error: 'OAuth token expired' };
    }

    if (tokenData.revoked_at) {
      return { success: false, error: 'OAuth token revoked' };
    }
    if (tokenData.tenant_status !== undefined && tokenData.tenant_status !== 'active') {
      return { success: false, error: 'Tenant is not active' };
    }
    if (tokenData.user_status !== undefined && tokenData.user_status !== 'active') {
      return { success: false, error: 'User is not active' };
    }

    const expectedIssuer = process.env.OAUTH_EXPECTED_ISSUER;
    if (!expectedIssuer) {
      return { success: false, error: 'OAuth issuer is not configured' };
    }
    if (tokenData.issuer !== expectedIssuer) {
      return { success: false, error: 'OAuth token issuer mismatch' };
    }

    const expectedResource = process.env.OAUTH_EXPECTED_AUDIENCE;
    if (!expectedResource) {
      return { success: false, error: 'OAuth protected resource is not configured' };
    }
    try {
      const resourceUrl = new URL(expectedResource);
      if (!['https:', 'http:'].includes(resourceUrl.protocol) ||
          resourceUrl.username || resourceUrl.password || resourceUrl.search || resourceUrl.hash ||
          resourceUrl.pathname !== '/mcp' || expectedResource !== `${resourceUrl.origin}/mcp`) {
        return { success: false, error: 'OAuth protected resource is not canonical' };
      }
    } catch {
      return { success: false, error: 'OAuth protected resource is not canonical' };
    }
    if (tokenData.audience !== expectedResource || tokenData.resource !== expectedResource) {
      return { success: false, error: 'OAuth token resource binding mismatch' };
    }

    const capabilities = parseCapabilities(tokenData.scope);
    if (tokenData.project_id && capabilities.includes('mcp:full')) {
      return { success: false, error: 'Authentication failed' };
    }
    return {
      success: true,
      tenantId: tokenData.tenant_id,
      projectId: tokenData.project_id,
      userId: tokenData.user_id,
      clientId: tokenData.client_id,
      resource: tokenData.resource,
      authVersion: tokenData.auth_version,
      capabilities,
      authMethod: 'oauth'
    };
  } catch (error) {
    console.error('OAuth token verification failed');
    return { success: false, error: 'Authentication failed' };
  }
}

/**
 * Verify an API key via DB lookup with timing-safe hash comparison (REM-252).
 *
 * ## Lookup strategy (REM-250 / REM-252)
 *
 * Old approach: `WHERE key_hash = $1`
 * - Comparison happens in the database (constant-time at DB level).
 * - Hash is plain SHA-256 — rainbow table attacks possible for guessable keys.
 *
 * New approach (this implementation):
 * 1. Look up by `key_prefix` (first 20 chars of the raw key, stored at creation).
 *    This is a non-sensitive prefix — knowing it does not allow deriving the key.
 * 2. Compute the expected hash using the algorithm stored in `hash_algorithm`:
 *    - `'hmac-sha256'`: HMAC-SHA256 with `API_KEY_SECRET` (new keys)
 *    - `'sha256'`:      plain SHA-256 (legacy keys created before this change)
 * 3. Compare computed vs. stored hash using `timingSafeEqual` — prevents
 *    timing-based oracle attacks that could enumerate valid key_prefixes.
 *
 * ## Migration notes
 * Existing keys keep `hash_algorithm = 'sha256'` and continue to work.
 * New keys issued after deploying this change use `hash_algorithm = 'hmac-sha256'`.
 * No re-hashing of existing keys is required (plaintext is not stored).
 */
export async function verifyApiKey(
  pool: any,
  apiKey: string
): Promise<AuthResult> {
  const authService = new AuthService();

  if (!authService.validateApiKeyFormat(apiKey)) {
    return { success: false, error: 'Invalid API key format' };
  }

  const prefix = extractKeyPrefix(apiKey);

  try {
    // The lookup function is the only pre-tenant path through API-key RLS.
    let result;
    try {
      result = await pool.query(
        `SELECT * FROM rembr_lookup_api_key($1)`,
        [prefix]
      );
    } catch (colErr: any) {
      if (colErr?.code === '42883' && process.env.NODE_ENV !== 'production') {
        // Development-only compatibility for a pre-migration local database.
        result = await pool.query(
          `SELECT id, key_hash, tenant_id, project_id, user_id
           FROM api_keys
           WHERE key_prefix = $1 AND revoked_at IS NULL`,
          [prefix]
        );
      } else {
        throw colErr;
      }
    }

    if (result.rows.length === 0) {
      return { success: false, error: 'Invalid or revoked API key' };
    }

    const record = result.rows.find((candidate: any) => {
      if (candidate.hash_algorithm !== 'sha256' && candidate.hash_algorithm !== 'hmac-sha256') {
        return false;
      }
      const algorithm = candidate.hash_algorithm;
      return authService.verifyApiKeyHash(apiKey, candidate.key_hash, algorithm);
    });

    if (!record) {
      return { success: false, error: 'Invalid or revoked API key' };
    }

    if (record.expires_at && new Date(record.expires_at) <= new Date()) {
      return { success: false, error: 'API key expired' };
    }
    const validTenantState = record.tenant_status === undefined ||
      record.tenant_status === 'active' ||
      (record.purpose === 'agent_bootstrap' && record.tenant_status === 'unclaimed');
    if (!validTenantState) {
      return { success: false, error: 'Tenant is not active for this credential' };
    }
    if (record.user_id && record.user_status !== undefined && record.user_status !== 'active') {
      return { success: false, error: 'User is not active' };
    }
    const capabilities = parseCapabilities(record.capabilities);
    if (capabilities.length === 0) {
      return { success: false, error: 'API key has no capabilities' };
    }
    if (record.project_id && capabilities.includes('mcp:full')) {
      return { success: false, error: 'Authentication failed' };
    }

    // Successful API-key use is lifecycle state, not optional analytics. Agent
    // cleanup uses this timestamp to distinguish an active autonomous agent
    // from an abandoned never-used bootstrap tenant. Throttle the physical
    // update to once per hour while guaranteeing that first use is recorded.
    const lifecycle = await pool.query(
      `UPDATE api_keys k
       SET last_used_at = CASE
         WHEN k.last_used_at IS NULL OR k.last_used_at < NOW() - INTERVAL '1 hour'
           THEN NOW()
         ELSE k.last_used_at
       END
       FROM tenants t
       WHERE k.id = $1 AND k.tenant_id = $2
         AND t.id = k.tenant_id
         AND k.revoked_at IS NULL
         AND (k.expires_at IS NULL OR k.expires_at > NOW())
         AND (
           t.status = 'active'
           OR (k.purpose = 'agent_bootstrap' AND t.status = 'unclaimed')
         )
         AND (
           k.user_id IS NULL OR EXISTS (
             SELECT 1 FROM users u
             WHERE u.id = k.user_id AND u.tenant_id = k.tenant_id
               AND u.status = 'active'
           )
         )
       RETURNING k.id, k.last_used_at`,
      [record.id, record.tenant_id],
    );
    if (lifecycle.rows.length === 0) {
      return { success: false, error: 'Authentication failed' };
    }

    return {
      success: true,
      tenantId: record.tenant_id,
      projectId: record.project_id,
      userId: record.user_id,
      apiKeyId: record.id,
      authVersion: record.auth_version,
      purpose: record.purpose || 'standard',
      capabilities,
      authMethod: 'api_key'
    };
  } catch (error) {
    console.error('API key verification failed');
    return { success: false, error: 'Authentication failed' };
  }
}
