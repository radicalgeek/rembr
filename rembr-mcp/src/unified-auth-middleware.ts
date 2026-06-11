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
 * Precedence (highest → lowest):
 *   1. API key (`x-api-key` header)  — always wins if the header is present
 *   2. OAuth Bearer token            — `Authorization: Bearer mcp_oauth_*`
 *   3. JWT Bearer token              — `Authorization: Bearer <jwt>`
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

  // ── 1. API key ────────────────────────────────────────────
  const apiKey = req.headers['x-api-key'] as string | undefined;
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
        error: result.error ?? 'Invalid API key',
        attemptedMethod: 'api_key',
        statusCode: 401,
      };
    }

    return {
      success: true,
      tenantId: result.tenantId!,
      projectId: result.projectId,
      apiKeyId: result.apiKeyId,
      authMethod: 'api_key',
      authenticatedAt: new Date(),
    };
  }

  // ── 2. Bearer token (OAuth or JWT) ────────────────────────
  const authHeader = req.headers.authorization as string | undefined;
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
        error: 'Malformed Authorization header — expected "Bearer <token>"',
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
          error: result.error ?? 'Invalid OAuth token',
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
        error: result.error ?? 'Invalid JWT token',
        attemptedMethod: 'jwt',
        statusCode: 401,
      };
    }

    return {
      success: true,
      tenantId: result.tenantId!,
      projectId: result.projectId,
      userId: result.userId,
      authMethod: 'jwt',
      authenticatedAt: new Date(),
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
    error:
      'No valid authentication credentials provided. ' +
      'Use OAuth (Authorization: Bearer mcp_oauth_*) ' +
      'or an API key (X-API-Key). Session-based authentication was removed ' +
      'with MCP 2026-07-28.',
    statusCode: 401,
  };
}
