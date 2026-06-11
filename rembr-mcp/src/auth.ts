import { createHash, createHmac, timingSafeEqual } from 'crypto';
import jwt from 'jsonwebtoken';

// ---------------------------------------------------------------------------
// Hashing utilities
// ---------------------------------------------------------------------------

/**
 * Hash an OAuth token for DB lookup (SHA-256, stored hashed in oauth_tokens).
 * Must match the hashing in rembr-ui/src/lib/oauth.ts.
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
    return /^mb_live_[A-Za-z0-9]{4,64}$/.test(apiKey);
  }

  // ---------------------------------------------------------------------------
  // JWT
  // ---------------------------------------------------------------------------

  /** Verify JWT token and extract tenant info */
  verifyJWT(token: string): AuthResult {
    try {
      const payload = jwt.verify(token, this.jwtSecret) as JWTPayload;

      if (!payload.tenant_id) {
        return { success: false, error: 'Invalid token: missing tenant_id' };
      }

      return {
        success: true,
        tenantId: payload.tenant_id,
        projectId: payload.project_id,
        userId: payload.sub
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Invalid token'
      };
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
  generateJWT(tenantId: string, userId: string, projectId?: string): string {
    const payload: JWTPayload = {
      sub: userId,
      tenant_id: tenantId,
      project_id: projectId
    };
    return jwt.sign(payload, this.jwtSecret, { expiresIn: '7d' });
  }
}

// ---------------------------------------------------------------------------
// Standalone functions (used in middleware / index-http.ts)
// ---------------------------------------------------------------------------

/**
 * Verify an OAuth access token via DB lookup.
 *
 * SEP-837 / RFC 9207 (MCP 2026-07-28): tokens are bound to the authorization
 * server that issued them. When the `issuer` column is populated and an
 * expected issuer is configured (`OAUTH_EXPECTED_ISSUER`, falling back to
 * `PUBLIC_URL`), a mismatch is logged — and rejected when
 * `OAUTH_ENFORCE_ISSUER=true`. Advisory-first so tokens issued before the
 * issuer column existed keep working during rollout.
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

    // Include issuer when the column exists; fall back for pre-migration DBs
    // (42703 = undefined_column), mirroring verifyApiKey's hash_algorithm shim.
    let result;
    try {
      result = await pool.query(
        `SELECT tenant_id, user_id, scope, expires_at, issuer
         FROM oauth_tokens
         WHERE access_token = $1`,
        [hashOAuthToken(accessToken)]
      );
    } catch (colErr: any) {
      if (colErr?.code === '42703') {
        result = await pool.query(
          `SELECT tenant_id, user_id, scope, expires_at
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

    // Issuer binding (SEP-837 / RFC 9207)
    const expectedIssuer = process.env.OAUTH_EXPECTED_ISSUER || process.env.PUBLIC_URL;
    if (expectedIssuer && tokenData.issuer && tokenData.issuer !== expectedIssuer) {
      if (process.env.OAUTH_ENFORCE_ISSUER === 'true') {
        return { success: false, error: 'OAuth token issuer mismatch' };
      }
      console.warn(
        `[OAuth] Token issuer mismatch (advisory): expected "${expectedIssuer}", got "${tokenData.issuer}". ` +
        'Set OAUTH_ENFORCE_ISSUER=true to reject these tokens.'
      );
    }

    return {
      success: true,
      tenantId: tokenData.tenant_id,
      userId: tokenData.user_id
    };
  } catch (error) {
    console.error('OAuth token verification error:', error);
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
    // Try with hash_algorithm column; fall back to sha256 if column missing (pre-migration DBs)
    let result;
    let algorithm: 'sha256' | 'hmac-sha256' = 'sha256';
    try {
      result = await pool.query(
        `SELECT id, key_hash, hash_algorithm, tenant_id, project_id, user_id
         FROM api_keys
         WHERE key_prefix = $1 AND revoked_at IS NULL`,
        [prefix]
      );
      if (result.rows.length > 0) {
        algorithm = result.rows[0].hash_algorithm === 'hmac-sha256' ? 'hmac-sha256' : 'sha256';
      }
    } catch (colErr: any) {
      if (colErr?.code === '42703') {
        // column "hash_algorithm" does not exist — pre-migration DB, fall back
        result = await pool.query(
          `SELECT id, key_hash, tenant_id, project_id, user_id
           FROM api_keys
           WHERE key_prefix = $1 AND revoked_at IS NULL`,
          [prefix]
        );
        algorithm = 'sha256';
      } else {
        throw colErr;
      }
    }

    if (result.rows.length === 0) {
      return { success: false, error: 'Invalid or revoked API key' };
    }

    const record = result.rows[0];

    if (!authService.verifyApiKeyHash(apiKey, record.key_hash, algorithm)) {
      return { success: false, error: 'Invalid or revoked API key' };
    }

    return {
      success: true,
      tenantId: record.tenant_id,
      projectId: record.project_id,
      userId: record.user_id,
      apiKeyId: record.id
    };
  } catch (error) {
    console.error('API key verification error:', error);
    return { success: false, error: 'Authentication failed' };
  }
}
