/**
 * Unified Authentication Middleware (REM-248)
 *
 * Problem:
 *   rembr supports multiple independent auth mechanisms — OAuth access tokens,
 *   API keys, and JWTs — each with its own validation path in
 *   `index-http.ts#authenticate()`.  There is no shared enforcement layer, so
 *   security policies (credential precedence, fail-fast on invalid credentials,
 *   audit-method tagging, consistent error format) must be duplicated or are
 *   simply absent.
 *
 * Solution:
 *   `authenticateRequest()` is a single entry-point that:
 *     1. Detects which credential is present (precedence: API key > OAuth Bearer > JWT).
 *     2. Validates it with the appropriate verifier.
 *     3. Returns a typed `AuthorizationContext` (from REM-253) so callers always
 *        know which mechanism succeeded and can make policy decisions downstream.
 *     4. Enforces fail-fast on ambiguous credentials (e.g. API key present but invalid
 *        → reject immediately, do not fall through to other mechanisms).
 *     5. Emits structured audit events via the `onAuditEvent` callback.
 *
 * MCP 2026-07-28 (SEP-2575): the former tier-4 session fallback (mcp-session-id
 * header → mcp_sessions table) was removed along with protocol sessions.
 *
 * Usage (drop-in for the existing `authenticate()` private method):
 *
 *   const ctx = await authenticateRequest(pool, req, { onAuditEvent: myLogger });
 *   if (!ctx.success) return res.status(401).json({ error: ctx.error });
 *
 * The returned object is an `AuthOutcome` — either a successful
 * `AuthorizationContext` (extended with `success: true`) or a typed failure.
 */

import type { Pool } from 'pg';
import type { Request } from 'express';
import { verifyOAuthToken, verifyApiKey, AuthService } from './auth.js';
import type { AuthorizationContext } from './authorization.js';
import { singleHeaderValue } from './security/secret-comparison.js';

const EXTERNAL_AUTH_FAILURE = 'Authentication failed';

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

export type AuthMethod = 'oauth' | 'api_key' | 'session' | 'jwt';

/** What authenticateRequest() returns on success */
export interface AuthSuccess extends AuthorizationContext {
  success: true;
}

/** What authenticateRequest() returns on failure */
export interface AuthFailure {
  success: false;
  error: string;
  /** Which mechanism was attempted before failure (helps audit logging) */
  attemptedMethod?: AuthMethod;
  /** HTTP status code to return to the caller */
  statusCode: 401 | 403;
}

export type AuthOutcome = AuthSuccess | AuthFailure;

export interface UnifiedAuthOptions {
  /** Called for every auth attempt regardless of outcome */
  onAuditEvent?: (event: AuthAuditEvent) => void;
}

export interface AuthAuditEvent {
  method: AuthMethod | 'none';
  success: boolean;
  tenantId?: string;
  userId?: string;
  apiKeyId?: string;
  sessionId?: string;
  error?: string;
  timestamp: Date;
}

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────

function extractBearerToken(authHeader: string): string | null {
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function readSingleCredentialHeader(
  req: Request,
  name: 'x-api-key' | 'authorization',
): { present: boolean; valid: boolean; value?: string } {
  const rawValue = req.headers[name];
  const rawHeaders = Array.isArray(req.rawHeaders) ? req.rawHeaders : [];
  let occurrences = 0;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === name) occurrences += 1;
  }

  if (rawValue === undefined && occurrences === 0) {
    return { present: false, valid: true };
  }

  const value = singleHeaderValue(rawValue);
  return {
    present: true,
    valid: occurrences <= 1 && value !== undefined && !value.includes(','),
    value,
  };
}

function emit(
  options: UnifiedAuthOptions | undefined,
  event: AuthAuditEvent,
): void {
  try {
    options?.onAuditEvent?.(event);
  } catch {
    // Never let audit callback crash the auth flow
  }
}

// ─────────────────────────────────────────────────────────
// Core function
// ─────────────────────────────────────────────────────────

/**
 * Authenticate an incoming HTTP request against all supported mechanisms.
 *
 * Exactly one mechanism may be supplied:
 *   1. API key (`x-api-key` header)
 *   2. OAuth Bearer token (`Authorization: Bearer mcp_oauth_*`)
 *   3. JWT Bearer token (`Authorization: Bearer <jwt>`)
 *
 * Fail-fast rules:
 *   - If an `x-api-key` header is present but the key is invalid → 401, no fallthrough.
 *   - If an `Authorization` header is present but cannot be parsed or verified → 401,
 *     no fallthrough.
 */
export async function authenticateRequest(
  pool: Pool,
  req: Request,
  options?: UnifiedAuthOptions,
): Promise<AuthOutcome> {
  const authService = new AuthService();
  const apiKeyHeader = readSingleCredentialHeader(req, 'x-api-key');
  const authorizationHeader = readSingleCredentialHeader(req, 'authorization');

  if (!apiKeyHeader.valid || !authorizationHeader.valid ||
      (apiKeyHeader.present && authorizationHeader.present)) {
    emit(options, {
      method: 'none',
      success: false,
      error: 'Ambiguous authentication credentials',
      timestamp: new Date(),
    });
    return {
      success: false,
      error: EXTERNAL_AUTH_FAILURE,
      statusCode: 401,
    };
  }

  // ── 1. API key ────────────────────────────────────────────
  const apiKey = apiKeyHeader.value;
  if (apiKey) {
    const result = await verifyApiKey(pool, apiKey);
    const event: AuthAuditEvent = {
      method: 'api_key',
      success: result.success,
      tenantId: result.tenantId,
      apiKeyId: result.apiKeyId,
      error: result.error,
      timestamp: new Date(),
    };
    emit(options, event);

    if (!result.success) {
      return {
        success: false,
        error: EXTERNAL_AUTH_FAILURE,
        attemptedMethod: 'api_key',
        statusCode: 401,
      };
    }

    return {
      success: true,
      tenantId: result.tenantId!,
      projectId: result.projectId,
      userId: result.userId,
      apiKeyId: result.apiKeyId,
      authMethod: 'api_key',
      authenticatedAt: new Date(),
      capabilities: result.capabilities || [],
      metadata: {
        purpose: result.purpose,
        authVersion: result.authVersion,
      },
    };
  }

  // ── 2. Bearer token (OAuth or JWT) ────────────────────────
  const authHeader = authorizationHeader.value;
  if (authHeader) {
    const token = extractBearerToken(authHeader);
    if (!token) {
      emit(options, {
        method: 'oauth',
        success: false,
        error: 'Malformed Authorization header',
        timestamp: new Date(),
      });
      return {
        success: false,
        error: EXTERNAL_AUTH_FAILURE,
        attemptedMethod: 'oauth',
        statusCode: 401,
      };
    }

    if (token.startsWith('mcp_oauth_')) {
      // OAuth access token
      const result = await verifyOAuthToken(pool, token);
      emit(options, {
        method: 'oauth',
        success: result.success,
        tenantId: result.tenantId,
        userId: result.userId,
        error: result.error,
        timestamp: new Date(),
      });

      if (!result.success) {
        return {
          success: false,
          error: EXTERNAL_AUTH_FAILURE,
          attemptedMethod: 'oauth',
          statusCode: 401,
        };
      }

      return {
        success: true,
        tenantId: result.tenantId!,
        projectId: result.projectId,
        userId: result.userId,
        authMethod: 'oauth',
        authenticatedAt: new Date(),
        capabilities: result.capabilities || [],
        metadata: {
          clientId: result.clientId,
          authVersion: result.authVersion,
        },
      };
    }

    // JWT
    const result = authService.verifyJWT(token);
    emit(options, {
      method: 'jwt',
      success: result.success,
      tenantId: result.tenantId,
      userId: result.userId,
      error: result.error,
      timestamp: new Date(),
    });

    if (!result.success) {
      return {
        success: false,
        error: EXTERNAL_AUTH_FAILURE,
        attemptedMethod: 'jwt',
        statusCode: 401,
      };
    }

    // Stateless JWT access is tied to current principal state. In production,
    // an auth_version claim is mandatory so logout/deactivation can invalidate
    // outstanding tokens immediately after the version is incremented.
    if (process.env.NODE_ENV === 'production' &&
        (!result.userId || !Number.isInteger(result.authVersion))) {
      return {
        success: false,
        error: EXTERNAL_AUTH_FAILURE,
        attemptedMethod: 'jwt',
        statusCode: 401,
      };
    }

    if (result.userId && Number.isInteger(result.authVersion)) {
      const principal = await pool.query(
        `SELECT t.status AS tenant_status, u.status AS user_status, u.auth_version
         FROM users u
         JOIN tenants t ON t.id = u.tenant_id
         WHERE u.id = $1 AND u.tenant_id = $2`,
        [result.userId, result.tenantId],
      );
      const row = principal.rows[0];
      if (!row || row.tenant_status !== 'active' || row.user_status !== 'active' || row.auth_version !== result.authVersion) {
        return {
          success: false,
          error: EXTERNAL_AUTH_FAILURE,
          attemptedMethod: 'jwt',
          statusCode: 401,
        };
      }
    }

    return {
      success: true,
      tenantId: result.tenantId!,
      projectId: result.projectId,
      userId: result.userId,
      authMethod: 'jwt',
      authenticatedAt: new Date(),
      capabilities: result.capabilities || [],
      metadata: {
        authVersion: result.authVersion,
        purpose: result.purpose,
      },
    };
  }

  // ── 3. No credentials ─────────────────────────────────────
  // MCP 2026-07-28 (SEP-2575): Mcp-Session-Id is removed from the protocol,
  // so the former session-auth fallback (tier 4) no longer exists. Clients
  // that relied on session cookies must migrate to API keys or OAuth.
  emit(options, {
    method: 'none',
    success: false,
    error: 'No credentials provided',
    timestamp: new Date(),
  });

  return {
    success: false,
    error: EXTERNAL_AUTH_FAILURE,
    statusCode: 401,
  };
}
