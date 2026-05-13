/**
 * Tests for unified-auth-middleware (REM-248)
 *
 * Strategy: mock the three external verifiers (verifyApiKey, verifyOAuthToken,
 * AuthService.verifyJWT) and a fake pg Pool to test routing + fail-fast logic
 * without hitting the database.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─────────────────────────────────────────────────────────
// Module mocks — must come before the subject import
// ─────────────────────────────────────────────────────────

vi.mock('./auth.js', () => ({
  verifyApiKey: vi.fn(),
  verifyOAuthToken: vi.fn(),
  AuthService: vi.fn().mockImplementation(() => ({
    verifyJWT: vi.fn(),
  })),
}));

import { authenticateRequest } from './unified-auth-middleware.js';
import { verifyApiKey, verifyOAuthToken, AuthService } from './auth.js';

// ─────────────────────────────────────────────────────────
// Shared fixtures
// ─────────────────────────────────────────────────────────

const TENANT_ID = '550e8400-e29b-41d4-a716-446655440000';
const USER_ID = '660e8400-e29b-41d4-a716-446655440001';
const API_KEY_ID = '770e8400-e29b-41d4-a716-446655440002';
const SESSION_ID = 'sess-abc123';

function makePool(sessionRow?: { tenant_id: string; project_id: string | null; user_id: string | null }) {
  return {
    query: vi.fn().mockResolvedValue({ rows: sessionRow ? [sessionRow] : [] }),
  };
}

function makeReq(headers: Record<string, string> = {}): any {
  return { headers };
}

// ─────────────────────────────────────────────────────────
// API Key tests
// ─────────────────────────────────────────────────────────

describe('authenticateRequest — API key', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns success with api_key authMethod on valid key', async () => {
    vi.mocked(verifyApiKey).mockResolvedValue({
      success: true,
      tenantId: TENANT_ID,
      apiKeyId: API_KEY_ID,
    });

    const result = await authenticateRequest(makePool() as any, makeReq({ 'x-api-key': 'mb_live_test' }));

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.authMethod).toBe('api_key');
      expect(result.tenantId).toBe(TENANT_ID);
      expect(result.apiKeyId).toBe(API_KEY_ID);
    }
  });

  it('fails fast on invalid API key — does not fall through to session auth', async () => {
    vi.mocked(verifyApiKey).mockResolvedValue({ success: false, error: 'Key not found' });

    const pool = makePool({ tenant_id: TENANT_ID, project_id: null, user_id: null });
    const result = await authenticateRequest(
      pool as any,
      makeReq({ 'x-api-key': 'mb_live_bad', 'mcp-session-id': SESSION_ID }),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      // Error is passed through from verifyApiKey (mock returns 'Key not found')
      expect(result.error).toBeTruthy();
      expect(result.attemptedMethod).toBe('api_key');
      expect(result.statusCode).toBe(401);
    }
    // Session should NOT have been queried
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('emits audit event for successful API key auth', async () => {
    vi.mocked(verifyApiKey).mockResolvedValue({ success: true, tenantId: TENANT_ID, apiKeyId: API_KEY_ID });
    const onAuditEvent = vi.fn();

    await authenticateRequest(makePool() as any, makeReq({ 'x-api-key': 'mb_live_ok' }), { onAuditEvent });

    expect(onAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'api_key', success: true, tenantId: TENANT_ID }),
    );
  });

  it('emits audit event for failed API key auth', async () => {
    vi.mocked(verifyApiKey).mockResolvedValue({ success: false, error: 'Bad key' });
    const onAuditEvent = vi.fn();

    await authenticateRequest(makePool() as any, makeReq({ 'x-api-key': 'mb_live_bad' }), { onAuditEvent });

    expect(onAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'api_key', success: false }),
    );
  });
});

// ─────────────────────────────────────────────────────────
// OAuth Bearer token tests
// ─────────────────────────────────────────────────────────

describe('authenticateRequest — OAuth Bearer', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns success with oauth authMethod on valid token', async () => {
    vi.mocked(verifyOAuthToken).mockResolvedValue({ success: true, tenantId: TENANT_ID, userId: USER_ID });

    const result = await authenticateRequest(
      makePool() as any,
      makeReq({ authorization: 'Bearer mcp_oauth_validtoken' }),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.authMethod).toBe('oauth');
      expect(result.userId).toBe(USER_ID);
    }
  });

  it('fails on invalid OAuth token — no fallthrough', async () => {
    vi.mocked(verifyOAuthToken).mockResolvedValue({ success: false, error: 'Token expired' });

    const pool = makePool({ tenant_id: TENANT_ID, project_id: null, user_id: null });
    const result = await authenticateRequest(
      pool as any,
      makeReq({
        authorization: 'Bearer mcp_oauth_expired',
        'mcp-session-id': SESSION_ID,
      }),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.attemptedMethod).toBe('oauth');
    }
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('returns 401 for malformed Authorization header', async () => {
    const result = await authenticateRequest(
      makePool() as any,
      makeReq({ authorization: 'NotBearer token' }),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.statusCode).toBe(401);
      expect(result.error).toContain('Malformed Authorization header');
    }
  });
});

// ─────────────────────────────────────────────────────────
// JWT Bearer token tests
// ─────────────────────────────────────────────────────────

describe('authenticateRequest — JWT Bearer', () => {
  let jwtVerify: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    jwtVerify = vi.fn();
    vi.mocked(AuthService).mockImplementation(() => ({ verifyJWT: jwtVerify } as any));
  });

  it('returns success with jwt authMethod on valid token', async () => {
    jwtVerify.mockReturnValue({ success: true, tenantId: TENANT_ID, userId: USER_ID });

    const result = await authenticateRequest(
      makePool() as any,
      makeReq({ authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig' }),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.authMethod).toBe('jwt');
    }
  });

  it('fails fast on invalid JWT — no fallthrough to session', async () => {
    jwtVerify.mockReturnValue({ success: false, error: 'JWT expired' });

    const pool = makePool({ tenant_id: TENANT_ID, project_id: null, user_id: null });
    const result = await authenticateRequest(
      pool as any,
      makeReq({
        authorization: 'Bearer badtoken',
        'mcp-session-id': SESSION_ID,
      }),
    );

    expect(result.success).toBe(false);
    if (!result.success) expect(result.attemptedMethod).toBe('jwt');
    expect(pool.query).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────
// Session auth tests
// ─────────────────────────────────────────────────────────

describe('authenticateRequest — session', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns success with session authMethod for valid session', async () => {
    const pool = makePool({ tenant_id: TENANT_ID, project_id: null, user_id: USER_ID });

    const result = await authenticateRequest(pool as any, makeReq({ 'mcp-session-id': SESSION_ID }));

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.authMethod).toBe('session');
      expect(result.sessionId).toBe(SESSION_ID);
      expect(result.tenantId).toBe(TENANT_ID);
      expect(result.userId).toBe(USER_ID);
    }
  });

  it('returns 401 for expired or missing session', async () => {
    const pool = makePool(undefined); // no row → session not found

    const result = await authenticateRequest(pool as any, makeReq({ 'mcp-session-id': 'bad-sess' }));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Session not found or expired');
      expect(result.statusCode).toBe(401);
    }
  });
});

// ─────────────────────────────────────────────────────────
// No credentials
// ─────────────────────────────────────────────────────────

describe('authenticateRequest — no credentials', () => {
  it('returns 401 with helpful error message', async () => {
    const result = await authenticateRequest(makePool() as any, makeReq({}));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.statusCode).toBe(401);
      expect(result.error).toContain('No valid authentication credentials');
    }
  });

  it('emits audit event with method=none', async () => {
    const onAuditEvent = vi.fn();
    await authenticateRequest(makePool() as any, makeReq({}), { onAuditEvent });
    expect(onAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ method: 'none', success: false }));
  });
});

// ─────────────────────────────────────────────────────────
// Precedence tests
// ─────────────────────────────────────────────────────────

describe('authenticateRequest — credential precedence', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('prefers API key over Bearer token', async () => {
    vi.mocked(verifyApiKey).mockResolvedValue({ success: true, tenantId: TENANT_ID, apiKeyId: API_KEY_ID });

    const result = await authenticateRequest(
      makePool() as any,
      makeReq({
        'x-api-key': 'mb_live_ok',
        authorization: 'Bearer mcp_oauth_something',
      }),
    );

    expect(result.success).toBe(true);
    if (result.success) expect(result.authMethod).toBe('api_key');
    expect(verifyOAuthToken).not.toHaveBeenCalled();
  });

  it('prefers Bearer over session', async () => {
    vi.mocked(verifyOAuthToken).mockResolvedValue({ success: true, tenantId: TENANT_ID, userId: USER_ID });

    const pool = makePool({ tenant_id: TENANT_ID, project_id: null, user_id: null });
    const result = await authenticateRequest(
      pool as any,
      makeReq({
        authorization: 'Bearer mcp_oauth_ok',
        'mcp-session-id': SESSION_ID,
      }),
    );

    expect(result.success).toBe(true);
    if (result.success) expect(result.authMethod).toBe('oauth');
    expect(pool.query).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────
// Audit callback resilience
// ─────────────────────────────────────────────────────────

describe('authenticateRequest — audit callback resilience', () => {
  it('does not crash if onAuditEvent throws', async () => {
    vi.mocked(verifyApiKey).mockResolvedValue({ success: true, tenantId: TENANT_ID, apiKeyId: API_KEY_ID });
    const onAuditEvent = vi.fn().mockImplementation(() => { throw new Error('audit failure'); });

    await expect(
      authenticateRequest(makePool() as any, makeReq({ 'x-api-key': 'mb_live_ok' }), { onAuditEvent }),
    ).resolves.toBeDefined();
  });
});
