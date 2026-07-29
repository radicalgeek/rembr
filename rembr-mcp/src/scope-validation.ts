/**
 * Scope Validation Middleware (REM-254)
 *
 * Problem:
 *   The stateless refactoring extracted scopes from JWT and OAuth tokens but never
 *   enforced them. Every authenticated request can call every tool regardless of the
 *   token's scope claim — a critical gap for least-privilege enforcement (OWASP A01/A02).
 *
 * Solution:
 *   This module defines per-tool scope requirements and provides middleware that
 *   validates the authenticated principal's scopes before a tool is executed.
 *   Requests with insufficient scopes receive a 403 Forbidden response.
 *
 * Scope model:
 *   - `memory:read`     — list_memories, get_memory, search_memory, stats, context, snapshot list/get
 *   - `memory:write`    — create/update/delete_memory, set_visibility, ingest
 *   - `admin`           — admin endpoints, user management, system config
 *   - `scope:validate`  — scope validation metadata endpoint
 *   - `*` (wildcard)    — grants all scopes (legacy / full-access tokens)
 *
 * Usage:
 *   Drop this middleware into the Express chain before the tool handler.
 *   It reads the auth context from `req.authScopeCtx` and rejects with 403
 *   when the required scope is missing.
 */

import type { Request, Response, NextFunction } from 'express';

// ---------------------------------------------------------------------------
// Scope constants
// ---------------------------------------------------------------------------

export const SCOPE_MEMORY_READ = 'memory:read';
export const SCOPE_MEMORY_WRITE = 'memory:write';
export const SCOPE_ADMIN = 'admin';
export const SCOPE_WILDCARD = '*';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Scope requirements per tool and operation.
 * Key format: "<toolName>:<operation>" or "*" for catch-all.
 */
export type ScopeRequirementMap = Record<string, string[]>;

/**
 * Auth context carrying scopes, populated by unified-auth-middleware.
 */
export interface AuthScopeContext {
  tenantId: string;
  projectId?: string;
  userId?: string;
  authMethod: 'oauth' | 'api_key' | 'jwt' | 'session';
  scopes?: string[];
}

/**
 * Extended Express Request with auth scope context attached.
 */
export interface ScopeRequest extends Request {
  authScopeCtx?: AuthScopeContext;
}

// ---------------------------------------------------------------------------
// Scope requirement definitions
// ---------------------------------------------------------------------------

/**
 * Maps every tool:operation to the minimum required scopes.
 * Each entry is an array — at least ONE scope must be present.
 *
 * Design principles:
 *   - Read-only operations need memory:read
 *   - Write operations need memory:write
 *   - Admin operations need admin
 *   - API keys get full scope (no scope claim on API keys)
 *   - Session auth gets full scope (legacy, deprecated)
 */
export const TOOL_SCOPE_REQUIREMENTS: ScopeRequirementMap = {
  // ── Memory tool ──────────────────────────────────────────────
  'memory:create':      [SCOPE_MEMORY_WRITE],
  'memory:get':         [SCOPE_MEMORY_READ],
  'memory:update':      [SCOPE_MEMORY_WRITE],
  'memory:delete':      [SCOPE_MEMORY_WRITE],
  'memory:list':        [SCOPE_MEMORY_READ],
  'memory:list_personal': [SCOPE_MEMORY_READ],
  'memory:set_visibility': [SCOPE_MEMORY_WRITE],
  'memory:ingest':      [SCOPE_MEMORY_WRITE],

  // ── Search tool ──────────────────────────────────────────────
  'search:query':       [SCOPE_MEMORY_READ],
  'search:smart':       [SCOPE_MEMORY_READ],
  'search:similar':     [SCOPE_MEMORY_READ],

  // ── Stats tool ───────────────────────────────────────────────
  'stats:usage':        [SCOPE_MEMORY_READ],
  'stats:embeddings':   [SCOPE_MEMORY_READ],
  'stats:insights':     [SCOPE_MEMORY_READ],
  'stats:generate_insights': [SCOPE_MEMORY_READ],
  'stats:predictions':  [SCOPE_MEMORY_READ],

  // ── Context tool ─────────────────────────────────────────────
  'context:create':     [SCOPE_MEMORY_WRITE],
  'context:get':        [SCOPE_MEMORY_READ],
  'context:list':       [SCOPE_MEMORY_READ],
  'context:search':     [SCOPE_MEMORY_READ],
  'context:add_memory': [SCOPE_MEMORY_WRITE],
  'context:delete':     [SCOPE_MEMORY_WRITE],

  // ── Snapshot tool ────────────────────────────────────────────
  'snapshot:create':    [SCOPE_MEMORY_WRITE],
  'snapshot:get':       [SCOPE_MEMORY_READ],
  'snapshot:list':      [SCOPE_MEMORY_READ],
  'snapshot:create_temporal': [SCOPE_MEMORY_WRITE],
  'snapshot:list_temporal':   [SCOPE_MEMORY_READ],

  // ── Graph tool ───────────────────────────────────────────────
  'graph:get':          [SCOPE_MEMORY_READ],
  'graph:generate':     [SCOPE_MEMORY_READ],
  'graph:insights':     [SCOPE_MEMORY_READ],
  'graph:infer':        [SCOPE_MEMORY_READ],
  'graph:compare':      [SCOPE_MEMORY_READ],
  'graph:explore':      [SCOPE_MEMORY_READ],

  // ── Contradictions tool ──────────────────────────────────────
  'contradictions:detect': [SCOPE_MEMORY_READ],

  // ── Context Analytics tool ───────────────────────────────────
  'context_analytics:get': [SCOPE_MEMORY_READ],

  // ── Checkpoint tool ──────────────────────────────────────────
  'checkpoint:create':  [SCOPE_MEMORY_WRITE],
  'checkpoint:get':     [SCOPE_MEMORY_READ],
  'checkpoint:history': [SCOPE_MEMORY_READ],

  // ── Budget tool ──────────────────────────────────────────────
  'budget:set':         [SCOPE_MEMORY_WRITE],
  'budget:get':         [SCOPE_MEMORY_READ],
  'budget:apply_template': [SCOPE_MEMORY_WRITE],
  'budget:list':        [SCOPE_MEMORY_READ],
  'budget:check':       [SCOPE_MEMORY_READ],

  // ── Compression tool ─────────────────────────────────────────
  'compression:compress':    [SCOPE_MEMORY_WRITE],
  'compression:preview':     [SCOPE_MEMORY_READ],

  // ── PII tool ─────────────────────────────────────────────────
  'pii:detect':      [SCOPE_MEMORY_READ],
  'pii:redact':      [SCOPE_MEMORY_READ],
  'pii:audit':       [SCOPE_MEMORY_READ],
  'pii:compliance_report': [SCOPE_MEMORY_READ],
  'pii:batch_scan':  [SCOPE_MEMORY_READ],

  // ── Context Monitor tool ─────────────────────────────────────
  'context_monitor:get_session_state': [SCOPE_MEMORY_READ],
  'context_monitor:monitor':           [SCOPE_MEMORY_READ],

  // ── Task MCP tools ───────────────────────────────────────────
  'task:state':         [SCOPE_MEMORY_READ],
  'task:search':        [SCOPE_MEMORY_READ],
  'task:dependencies':  [SCOPE_MEMORY_READ],
  'task:manage':        [SCOPE_MEMORY_WRITE],
  'task:acceptance_criteria': [SCOPE_MEMORY_WRITE],

  // ── RLM tools ────────────────────────────────────────────────
  'causality:infer':    [SCOPE_MEMORY_READ],
  'causality:trace':    [SCOPE_MEMORY_READ],
  'causality:get':      [SCOPE_MEMORY_READ],
  'causality:validate': [SCOPE_MEMORY_READ],

  'temporal:search':    [SCOPE_MEMORY_READ],
  'temporal:history':   [SCOPE_MEMORY_READ],

  'classify:intent':    [SCOPE_MEMORY_READ],

  'audit:query':        [SCOPE_MEMORY_READ],
  'audit:report':       [SCOPE_MEMORY_READ],
  'audit:stats':        [SCOPE_MEMORY_READ],

  // ── Task Export tool ─────────────────────────────────────────
  'task_export:export': [SCOPE_MEMORY_READ],
  'task_export:import': [SCOPE_MEMORY_WRITE],
  'task_export:validate': [SCOPE_MEMORY_READ],

  // ── Task Handoff tool ────────────────────────────────────────
  'task_handoff:create':  [SCOPE_MEMORY_WRITE],
  'task_handoff:accept':  [SCOPE_MEMORY_WRITE],
  'task_handoff:reject':  [SCOPE_MEMORY_WRITE],
  'task_handoff:list_pending': [SCOPE_MEMORY_READ],
  'task_handoff:get':     [SCOPE_MEMORY_READ],
  'task_handoff:history': [SCOPE_MEMORY_READ],

  // ── Task Analytics tool ──────────────────────────────────────
  'task_analytics:velocity':    [SCOPE_MEMORY_READ],
  'task_analytics:burndown':    [SCOPE_MEMORY_READ],
  'task_analytics:bottlenecks': [SCOPE_MEMORY_READ],

  // ── Task Iterations tool ─────────────────────────────────────
  'task_iterations:record':   [SCOPE_MEMORY_WRITE],
  'task_iterations:history':  [SCOPE_MEMORY_READ],
  'task_iterations:stuck_score': [SCOPE_MEMORY_READ],
  'task_iterations:detect_stuck': [SCOPE_MEMORY_READ],

  // ── Catch-all (any tool not listed) ──────────────────────────
  '*': [SCOPE_MEMORY_READ],
};

// ---------------------------------------------------------------------------
// Scope validation logic
// ---------------------------------------------------------------------------

/**
 * Check whether the given scopes satisfy at least one of the required scopes.
 *
 * Rules:
 *   - Wildcard `*` in the principal's scopes grants everything.
 *   - API keys and session auth are treated as full-access (no scope claim).
 *   - Otherwise, at least one required scope must be present.
 */
export function scopesSatisfy(
  principalScopes: string[] | undefined,
  requiredScopes: string[],
  authMethod: AuthScopeContext['authMethod']
): boolean {
  // API keys and sessions have no scope claim — treat as full-access
  if (authMethod === 'api_key' || authMethod === 'session') {
    return true;
  }

  // No scopes at all on the token — deny (fail-closed)
  if (!principalScopes || principalScopes.length === 0) {
    return false;
  }

  // Wildcard grants everything
  if (principalScopes.includes(SCOPE_WILDCARD)) {
    return true;
  }

  // Check if any required scope is present
  return requiredScopes.some((req) => principalScopes.includes(req));
}

/**
 * Build a human-readable scope requirement string for error messages.
 */
export function formatScopeRequirement(requiredScopes: string[]): string {
  return requiredScopes.join(' or ');
}

// ---------------------------------------------------------------------------
// Express middleware
// ---------------------------------------------------------------------------

/**
 * Scope validation middleware factory.
 *
 * Attach to the Express app before the tool handler:
 *   app.use(scopeValidationMiddleware());
 *
 * The middleware reads:
 *   - req.authScopeCtx  — AuthScopeContext (set by unified-auth-middleware)
 *   - req.body.method   — MCP method name (e.g. "tools/call")
 *   - req.body.params.tool  — Tool name and optionally operation
 *
 * It rejects with 403 when the required scope is missing.
 */
export function scopeValidationMiddleware() {
  return (req: ScopeRequest, res: Response, next: NextFunction) => {
    // Skip scope validation for non-tool endpoints (health, metrics, etc.)
    if (req.path !== '/mcp' || req.method !== 'POST') {
      return next();
    }

    const ctx = req.authScopeCtx;
    if (!ctx) {
      // Auth middleware didn't run or didn't set context — fall through
      // (the auth middleware itself will reject unauthenticated requests)
      return next();
    }

    // API keys and sessions skip scope enforcement (legacy behavior)
    if (ctx.authMethod === 'api_key' || ctx.authMethod === 'session') {
      return next();
    }

    // Extract tool name and operation from the MCP request body
    const body = req.body as Record<string, unknown> | undefined;
    if (!body) {
      return next();
    }

    const method = body.method as string | undefined;
    if (method !== 'tools/call') {
      // Non-tool calls (initialize, notifications, etc.) don't need scope checks
      return next();
    }

    const params = body.params as Record<string, unknown> | undefined;
    if (!params) {
      return next();
    }

    const toolName = params.tool as string | undefined;
    if (!toolName) {
      return next();
    }

    const operation = params.operation as string | undefined;

    // Build the scope requirement key
    const scopeKey = operation
      ? `${toolName}:${operation}`
      : `${toolName}:*`; // fallback: require read on the tool itself

    // Look up required scopes
    const requiredScopes = TOOL_SCOPE_REQUIREMENTS[scopeKey]
      || TOOL_SCOPE_REQUIREMENTS['*']
      || [SCOPE_MEMORY_READ];

    // Check scopes
    const allowed = scopesSatisfy(ctx.scopes, requiredScopes, ctx.authMethod);
    if (!allowed) {
      res.status(403).json({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: `Insufficient scopes for '${toolName}'${operation ? ` (${operation})` : ''}. Requires: ${formatScopeRequirement(requiredScopes)}. Your scopes: ${ctx.scopes?.join(', ') || '(none)'}`,
        },
        id: body.id || null,
      });
      return;
    }

    next();
  };
}

// ---------------------------------------------------------------------------
// Utility: Get scope requirements for a tool (for docs / metadata)
// ---------------------------------------------------------------------------

export function getToolScopeRequirements(toolName: string): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [key, scopes] of Object.entries(TOOL_SCOPE_REQUIREMENTS)) {
    if (key.startsWith(`${toolName}:`) || key === `${toolName}:*`) {
      const op = key.replace(`${toolName}:`, '');
      result[op] = scopes;
    }
  }
  return result;
}
