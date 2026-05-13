#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool
} from '@modelcontextprotocol/sdk/types.js';
import { MemoryDatabase } from './database.js';
import { MemoryService, MEMORY_CATEGORIES } from './memory-service.js';
import { ContextService } from './context-service.js';
import { SnapshotService } from './snapshot-service.js';
import { CompilationService } from './compilation-service.js';
import { getContextAnalytics } from './context-analytics.js';
import { createCheckpoint, getLatestCheckpoint, getCheckpointHistory } from './checkpoint-service.js';
import { monitorContext, getSessionState } from './context-monitor.js';
import { authenticateRequest, type AuthOutcome, type AuthMethod } from './unified-auth-middleware.js';
import {
  setBudget,
  getBudget,
  listBudgets,
  checkBudget,
  applyBudgetTemplate,
  BUDGET_TEMPLATES,
} from './budget-management.js';
import { AdvancedAnalyticsService } from './advanced-analytics-service.js';
import { RalphRLMService, type RLMSessionStatus, type IterationOutcome, type ACStatus } from './ralph-rlm.js';
import { AnalyticsReportingService, type CustomReportConfig, type Granularity, type ReportFormat } from './analytics-reporting.js';
import { EnhancedSearchService, type AdvancedFilter, type ExportFormat as SearchExportFormat } from './enhanced-search.js';
import { PIINLPEngine, type SensitivityLevel as NLPSensitivity, type RedactionMode as NLPRedactionMode } from './pii-nlp-engine.js';
import { ContextSnapshotTimelineService } from './context-snapshot-timeline.js';
import { OllamaEmbeddingProvider } from './ollama-provider.js';
import { validateToolInput } from './schemas.js';
import { AuthService, verifyApiKey, verifyOAuthToken, AuthResult } from './auth.js';
import { getMetrics, trackHttpRequest, trackMemoryOperation, trackAuthentication, trackMcpToolCall, trackMcpToolError, trackSearchOperation, updateEmbeddingBacklog } from './metrics.js';
import { RedisSessionStore, SessionData } from './session-store.js';
import { logger } from './logger.js';
import { OptimizationScheduler } from './optimization/scheduler.js';
import { DeduplicationService } from './optimization/deduplication-service.js';
import { TemporalAnalyzerService } from './optimization/temporal-analyzer-service.js';
import { RelationshipMaintainerService } from './optimization/relationship-maintainer-service.js';
// MemoryRelationshipService moved to routes/admin.ts (REM-262)
import { QualityScorerService } from './optimization/quality-scorer-service.js';
import { AttachmentService } from './attachment-service.js';
import { OllamaClient } from './ollama-client.js';
import { CausalReasoningService } from './causal-reasoning-service.js';
import { TemporalQueryService } from './temporal-query-service.js';
import { AuditLogger } from './audit-logger.js';
import { AuditMonitoringService, DEFAULT_THRESHOLDS } from './audit-monitoring.js';
import { WorkQueueService } from './work-queue.js';
import { GDPRComplianceService } from './gdpr-compliance.js';
import { handleManageTask, handleTaskState, handleTaskDependencies, handleTaskSearch, handleManageAcceptanceCriteria, acceptanceCriteriaToolDefinition } from './task-mcp-tools.js';
import { PIIDetectorService } from './pii-detector.js';
import { compressContent, previewCompression } from './smart-compression.js';
import { checkDailyTenantQuota, checkTransportRateLimit } from './rate-limiter.js';
import { createAdminRouter } from './routes/admin.js';
import { adminAuthMiddleware } from './middleware/admin-auth.js';
import { validateMemoryInput, validateContent, validateCategory, validateMetadata, validateRelevanceScore } from './validation/memory-input.js';
import { renderContradictionDashboard } from './ui-resources/contradiction-dashboard.js';
import { renderSnapshotTimeline } from './ui-resources/snapshot-timeline.js';
import { renderContextDiffViewer } from './ui-resources/context-diff-viewer.js';
// Phase 1: Consolidated Tools (41 → 11)
// Phase 2: Multi-Server Split (REM-38)
import {
  getConsolidatedTools,
  routeLegacyTool,
  TOOL_CONSOLIDATION_MAP,
  getLegacyToolMigration,
  wrapWithDeprecationWarning,
  getToolsByServerType,
  type ServerType
} from './tools/index.js';
import pkg from 'pg';
const { Pool } = pkg;
import type { Pool as PoolType } from 'pg';

interface AuthContext {
  tenantId: string;
  projectId?: string;
  userId?: string;
}

// UUID regex for validation
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Sanitize a string parameter that should be a UUID.
 * Strips ALL surrounding quote layers (single/double) and whitespace.
 * RAD-7: mcporter may double-quote UUIDs e.g. '""uuid""' — loop until clean.
 * Agents sometimes pass UUIDs as '"abc-123"' or "'abc-123'" or '""abc-123""'.
 */
// REM-28: UUID format regex — only allow valid UUID v4 format to prevent injection

function sanitizeUUID(value: unknown): string {
  if (typeof value !== 'string') return '';
  // RAD-7: Strip whitespace and ALL surrounding quote layers (loop handles double/triple quoting)
  let cleaned = value.trim();
  let prev: string;
  do {
    prev = cleaned;
    if ((cleaned.startsWith('"') && cleaned.endsWith('"')) ||
        (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
      cleaned = cleaned.slice(1, -1).trim();
    }
  } while (cleaned !== prev);
  // REM-28: Validate UUID format — reject anything that doesn't match
  if (cleaned && !UUID_REGEX.test(cleaned)) {
    return ''; // reject non-UUID to prevent injection via UUID fields
  }
  return cleaned;
}

/**
 * Sanitize all known UUID fields in MCP tool arguments.
 * Applied once before the tool switch statement to catch all cases.
 */
function sanitizeArgs(args: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!args) return args;
  
  const uuidFields = [
    'id', 'memory_id', 'context_id', 'snapshot_id', 'project_id',
    'cause_memory_id', 'effect_memory_id', 'link_id', 'resource_id',
    'source_memory_id', 'target_memory_id'
  ];
  const uuidArrayFields = ['memory_ids', 'context_ids'];
  
  const sanitized = { ...args };
  
  for (const field of uuidFields) {
    if (typeof sanitized[field] === 'string') {
      sanitized[field] = sanitizeUUID(sanitized[field]);
    }
  }
  
  for (const field of uuidArrayFields) {
    if (Array.isArray(sanitized[field])) {
      sanitized[field] = (sanitized[field] as unknown[]).map(v => 
        typeof v === 'string' ? sanitizeUUID(v) : v
      );
    }
  }
  
  return sanitized;
}

/**
 * Format bytes to human-readable string
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

/**
 * Add pagination metadata to MCP tool responses.
 * Enhances agent UX by providing execution stats and pagination hints.
 * 
 * REM-68: Standardized pagination metadata on all list/search responses.
 * 
 * Usage:
 *   const response = addPaginationToResponse({
 *     items: results,
 *     limit: 20,
 *     totalAvailable: 487,  // Total count from database
 *     startTime: Date.now(),
 *     suggestedFilters: ['category: "facts"'],
 *     relatedTools: ['get_context_insights']
 *   });
 */
function addPaginationToResponse(data: {
  items: unknown[];
  limit?: number;
  totalAvailable?: number;  // Optional for backward compatibility, but should be provided
  startTime: number;
  suggestedFilters?: string[];
  relatedTools?: string[];  // REM-68: related tools suggestion
}): {
  success: true;
  data: unknown[];
  metadata: {
    returned: number;
    total_available: number;  // Always present (uses items.length as fallback)
    execution_time_ms: number;
  };
  pagination?: {
    has_more: boolean;
    suggested_filters?: string[];
  };
  related_tools?: string[];  // REM-68
} {
  const { items, limit, totalAvailable, startTime, suggestedFilters, relatedTools } = data;
  const executionTimeMs = Date.now() - startTime;
  
  // Use provided totalAvailable, or fallback to items.length (REM-68)
  const total = totalAvailable !== undefined ? totalAvailable : items.length;
  const hasMore = limit !== undefined && items.length >= limit;

  const response: any = {
    success: true,
    data: items,
    metadata: {
      returned: items.length,
      total_available: total,  // Always present (REM-68)
      execution_time_ms: executionTimeMs
    }
  };

  // Add pagination section if there's more data or filters to suggest
  if (hasMore || (suggestedFilters && suggestedFilters.length > 0)) {
    response.pagination = {
      has_more: hasMore,
      ...(suggestedFilters && suggestedFilters.length > 0 && { suggested_filters: suggestedFilters })
    };
  }

  // Add related tools if provided (REM-68)
  if (relatedTools && relatedTools.length > 0) {
    response.related_tools = relatedTools;
  }

  return response;
}

class RembrServer {
  private db: MemoryDatabase;
  private embeddingProvider?: OllamaEmbeddingProvider;
  private app: express.Application;
  private port: number;
  private sessions: Map<string, { transport: StreamableHTTPServerTransport; server: Server }>;
  private sessionStore: RedisSessionStore;
  private authService: AuthService;
  private pool: PoolType;
  private optimizationScheduler?: OptimizationScheduler;
  private auditLogger!: AuditLogger;
  private serverType: ServerType;

  constructor(port: number = 3000, serverType: ServerType = 'all') {
    this.port = port;
    this.serverType = serverType;
    this.app = express();
    this.app.use(express.json());
    
    // Disable request timeout for streaming connections
    this.app.set('request timeout', 0); // No timeout
    
    // Enable keepalive and configure timeouts for better connection stability
    this.app.disable('x-powered-by');
    this.app.set('etag', false);
    
    // Increase payload size limit for large memory operations
    this.app.use(express.json({ limit: '50mb' }));
    this.app.use(express.urlencoded({ limit: '50mb', extended: true }));
    
    // Add keep-alive headers for all responses with extended timeout
    this.app.use((req, res, next) => {
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('Keep-Alive', 'timeout=3600, max=1000');  // 1 hour timeout, 1000 requests
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      next();
    });
    
    this.sessions = new Map();
    this.sessionStore = new RedisSessionStore();
    this.authService = new AuthService();

    // Initialize database (single shared pool)
    this.db = new MemoryDatabase();
    this.pool = this.db.dbPool;

    // Initialize audit logger
    this.auditLogger = new AuditLogger(this.pool);

    // Initialize embedding provider
    this.initializeEmbeddings();

    // Initialize optimization scheduler if enabled
    if (process.env.ENABLE_OPTIMIZATION === 'true') {
      this.initializeOptimizationScheduler();
    }

    // Clean up inactive sessions periodically (every 30 minutes)
    setInterval(() => {
      const now = Date.now();
      for (const [sessionId, session] of this.sessions.entries()) {
        // Clean up sessions that haven't been used in 30 minutes
        // We'll check if the transport is still active
        if ((session.server as any).lastUsed && now - (session.server as any).lastUsed > 30 * 60 * 1000) {
          console.log(`🗑️ Cleaning up inactive session: ${sessionId}`);
          this.sessions.delete(sessionId);
        }
      }
    }, 30 * 60 * 1000); // 30 minutes

    // Ensure default structure for all tenants
    this.ensureDefaults();

    // Request logging — production-safe: no credentials, no body content.
    // Full verbose logging is dev-only (NODE_ENV=development).
    this.app.use((req, res, next) => {
      if (process.env.NODE_ENV === 'development') {
        // Dev: structured but still scrubbed — no raw credential values, no body content
        console.log('📥', req.method, req.path, {
          ip: req.ip,
          'content-type': req.headers['content-type'],
          'content-length': req.headers['content-length'],
          'has-auth': !!(req.headers.authorization || req.headers['x-api-key']),
          'mcp-session-id': req.headers['mcp-session-id'] || undefined,
          'user-agent': req.headers['user-agent'],
          // Body keys only — never log body values (may contain PII/memory content)
          'body-keys': req.body && typeof req.body === 'object' ? Object.keys(req.body) : undefined
        });
      }
      // Production: path-level logging only (no credentials, no body)
      next();
    });

    // Metrics middleware
    this.app.use((req, res, next) => {
      const startTime = Date.now();
      res.on('finish', () => {
        trackHttpRequest(req, res, startTime);
      });
      next();
    });

    // Logging middleware
    this.app.use((req, res, next) => {
      if (req.path !== '/health' && req.path !== '/metrics') {
        console.log(`${new Date().toISOString()} ${req.method} ${req.path} from ${req.ip}`);
      }
      next();
    });

    // Metrics endpoint
    this.app.get('/metrics', async (req, res) => {
      // REM-28: Require METRICS_SECRET in production to avoid leaking internal metrics
      const metricsSecret = process.env.METRICS_SECRET;
      if (metricsSecret) {
        const authHeader = req.headers['authorization'] ?? '';
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : req.headers['x-metrics-token'];
        if (!token || token !== metricsSecret) {
          res.status(401).json({ error: 'Unauthorized: Bearer token required for /metrics' });
          return;
        }
      } else if (process.env.NODE_ENV === 'production') {
        // Fail-closed in production if METRICS_SECRET is not set
        console.warn('[Metrics] METRICS_SECRET not set — refusing /metrics in production');
        res.status(403).json({ error: 'Metrics endpoint is disabled. Set METRICS_SECRET to enable.' });
        return;
      }
      try {
        const metrics = await getMetrics();
        res.set('Content-Type', 'text/plain');
        res.send(metrics);
      } catch (error) {
        console.error('Error generating metrics:', error);
        res.status(500).send('Error generating metrics');
      }
    });

    // Health check endpoint — RAD-39: rich health data for system health dashboard
    this.app.get('/health', async (req, res) => {
      const t0 = Date.now();
      const health: Record<string, unknown> = {
        status: 'ok',
        service: 'rembr-mcp',
        version: process.env.APP_VERSION || 'unknown',
        timestamp: new Date().toISOString(),
        uptime_seconds: Math.round(process.uptime()),
      };

      // DB pool stats (pg Pool exposes .totalCount / .idleCount / .waitingCount)
      try {
        const dbStart = Date.now();
        await this.pool.query('SELECT 1');
        health.db = true;
        health.db_latency_ms = Date.now() - dbStart;
        health.db_pool = {
          total: (this.pool as any).totalCount ?? null,
          idle:  (this.pool as any).idleCount ?? null,
          waiting: (this.pool as any).waitingCount ?? null,
        };
      } catch {
        health.db = false;
        health.db_latency_ms = null;
        health.db_pool = null;
      }

      // Queue depth — work_queue pending items (best-effort)
      try {
        const qResult = await this.pool.query(
          `SELECT COUNT(*) AS depth FROM work_queue WHERE status = 'pending'`
        );
        health.queue_depth = parseInt(qResult.rows[0]?.depth ?? '0', 10);
      } catch {
        health.queue_depth = null;
      }

      // Ollama status — attempt a lightweight tag list
      try {
        const ollamaUrl = process.env.OLLAMA_BASE_URL || 'http://ollama:11434';
        const ollamaStart = Date.now();
        const ollamaRes = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
        if (ollamaRes.ok) {
          const tags = await ollamaRes.json() as { models?: Array<{ name: string; size?: number }> };
          health.ollama = true;
          health.ollama_latency_ms = Date.now() - ollamaStart;
          health.ollama_models = (tags.models ?? []).map(m => m.name);
        } else {
          health.ollama = false;
          health.ollama_latency_ms = null;
          health.ollama_models = [];
        }
      } catch {
        health.ollama = false;
        health.ollama_latency_ms = null;
        health.ollama_models = [];
      }

      // Redis: check session store liveness
      try {
        await this.sessionStore.listSessions();
        health.redis = true;
      } catch {
        health.redis = false;
      }

      // Error counts — read from Prometheus registry (process-lifetime totals)
      try {
        const { mcpToolErrors, mcpToolCalls } = await import('./metrics.js');
        const errorsJson = await mcpToolErrors.get();
        const callsJson  = await mcpToolCalls.get();
        const totalErrors = errorsJson.values.reduce((s, v) => s + (v.value ?? 0), 0);
        const totalCalls  = callsJson.values.reduce((s, v) => s + (v.value ?? 0), 0);
        health.mcp_total_calls  = Math.round(totalCalls);
        health.mcp_total_errors = Math.round(totalErrors);
        health.mcp_error_rate   = totalCalls > 0 ? +(totalErrors / totalCalls).toFixed(4) : 0;
      } catch {
        health.mcp_total_calls  = null;
        health.mcp_total_errors = null;
        health.mcp_error_rate   = null;
      }

      // Process info
      const mem = process.memoryUsage();
      health.process = {
        heap_used_mb:  Math.round(mem.heapUsed  / 1024 / 1024),
        heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024),
        rss_mb:        Math.round(mem.rss       / 1024 / 1024),
        node_version:  process.version,
      };

      health.check_duration_ms = Date.now() - t0;

      // Degrade overall status if any critical check failed
      if (health.db === false || health.redis === false) {
        health.status = 'degraded';
      }

      res.status(health.status === 'ok' ? 200 : 503).json(health);
    });

    // Keep-alive ping endpoint for long-lived connections
    this.app.get('/ping', (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-cache');
      res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });

    // Admin route guard: require X-Admin-Key header matching ADMIN_API_KEY env var.
    // ADMIN_API_KEY is required at startup (validate-env.ts) — server refuses to start without it.
    // RAD-45: Extracted to middleware/admin-auth.ts; replaces inline guard.
    this.app.use('/admin', adminAuthMiddleware);

    // Admin routes — extracted to routes/admin.ts (REM-262)
    this.app.use('/admin', createAdminRouter({
      db: this.db,
      optimizationScheduler: this.optimizationScheduler,
      embeddingProvider: this.embeddingProvider,
      pool: this.pool,
    }));

    // Claude Desktop start-auth endpoint
    this.app.get('/mcp/start-auth/:sessionId', async (req: Request, res: Response) => {
      const { sessionId } = req.params;
      const redirectUrl = req.query.redirect_url as string;
      
      if (process.env.NODE_ENV !== 'production') console.log(`Start auth request - sessionId: ${sessionId}, redirectUrl: ${redirectUrl}`);
      
      if (!process.env.PUBLIC_URL) {
        return res.status(500).json({ error: 'PUBLIC_URL environment variable not configured' });
      }
      
      // Redirect to the UI's OAuth flow with session tracking
      const authUrl = `${process.env.PUBLIC_URL}/api/mcp-auth?session_id=${sessionId}&redirect_url=${encodeURIComponent(redirectUrl || '')}`;
      res.redirect(authUrl);
    });

    // MCP endpoint with proper session management
    this.app.post('/mcp', async (req: Request, res: Response) => {
      const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const startTime = Date.now();
      
      // Production-safe request log: no raw credentials, no body content.
      if (process.env.NODE_ENV === 'development') {
        console.log('=== MCP POST REQUEST START ===', {
          requestId,
          timestamp: new Date().toISOString(),
          ip: req.ip,
          userAgent: req.headers['user-agent'],
          method: req.body?.method,
          id: req.body?.id,
          hasAuth: !!(req.headers.authorization || req.headers['x-api-key']),
          sessionId: req.headers['mcp-session-id'] || undefined,
          // Body param keys only — never log values (may contain PII/memory content)
          paramsKeys: req.body?.params ? Object.keys(req.body.params) : []
        });
      }

      try {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        
        // Check if this is an existing session - if so, skip authentication
        let authResult: AuthResult;
        if (sessionId && this.sessions.has(sessionId)) {
          // Session exists - get auth info from session store
          if (process.env.NODE_ENV !== 'production') console.log('🔓 Using cached auth from existing session:', {
            requestId,
            sessionId,
            timestamp: new Date().toISOString()
          });
          
          // Get tenant/project from the database session
          const sessionDbResult = await this.pool.query(
            'SELECT tenant_id, project_id FROM mcp_sessions WHERE session_id = $1 AND expires_at > NOW()',
            [sessionId]
          );
          
          if (sessionDbResult.rows.length > 0) {
            authResult = {
              success: true,
              tenantId: sessionDbResult.rows[0].tenant_id,
              projectId: sessionDbResult.rows[0].project_id
            };
          } else {
            // Session exists in memory but not in DB - authenticate again
            if (process.env.NODE_ENV !== 'production') console.log('⚠️ Session in memory but not in DB, re-authenticating...', {
              requestId,
              sessionId,
              timestamp: new Date().toISOString()
            });
            authResult = await this.authenticate(req);
          }
        } else {
          // No existing session - authenticate
          if (process.env.NODE_ENV !== 'production') console.log('📞 Starting authentication...', {
            requestId,
            hasAuthHeader: !!req.headers.authorization,
            authHeaderLength: req.headers.authorization ? req.headers.authorization.length : 0,
            hasSessionId: !!sessionId,
            timestamp: new Date().toISOString()
          });
          authResult = await this.authenticate(req);
        }
        
        if (!authResult.success) {
          console.error('❌ Authentication failed:', {
            requestId,
            error: authResult.error,
            hasAuth: !!(req.headers.authorization || req.headers['x-api-key']),
            timestamp: new Date().toISOString()
          });
          // Always set OAuth WWW-Authenticate header for failed auth
          if (process.env.PUBLIC_URL) {
            res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${process.env.PUBLIC_URL}/.well-known/oauth-protected-resource", scope="mcp:full"`);
          }
          return res.status(401).json({ error: authResult.error || 'Unauthorized' });
        }

        // Auth success — log at info level but only log tenant/project (not credentials)
        if (process.env.NODE_ENV !== 'production') console.log(`✅ Authenticated:`, {
          requestId,
          tenant: authResult.tenantId,
          project: authResult.projectId,
          timestamp: new Date().toISOString()
        });

        // Per-tenant daily quota check (REM-48)
        // Runs after auth so we have tenantId + plan available.
        if (authResult.tenantId) {
          const tenantPlanInfo = await this.db.getTenantPlan(authResult.tenantId);
          const tenantPlan = tenantPlanInfo?.plan || 'free';
          const transportQuota = await checkTransportRateLimit(req, tenantPlan);

          res.setHeader('X-RateLimit-Limit', transportQuota.limit);
          res.setHeader('X-RateLimit-Remaining', Math.max(0, transportQuota.limit - transportQuota.count));
          res.setHeader('X-RateLimit-Window', '60s');

          if (!transportQuota.allowed) {
            res.setHeader('Retry-After', transportQuota.retryAfterSeconds);
            return res.status(429).json({
              error: 'Too Many Requests',
              message: `Rate limit exceeded. Maximum ${transportQuota.limit} requests per 60 seconds.`,
              retry_after: transportQuota.retryAfterSeconds,
              plan: tenantPlan,
            });
          }

          const dailyQuota = await checkDailyTenantQuota(authResult.tenantId, tenantPlan);

          // Set daily quota headers on every response
          res.setHeader('X-RateLimit-Daily-Limit', dailyQuota.limit);
          res.setHeader('X-RateLimit-Daily-Remaining', Math.max(0, dailyQuota.limit - dailyQuota.count));

          if (!dailyQuota.allowed) {
            res.setHeader('Retry-After', dailyQuota.retryAfterSeconds);
            return res.status(429).json({
              error: 'Daily Quota Exceeded',
              message: `Daily request quota exceeded for plan '${tenantPlan}'. Limit: ${dailyQuota.limit.toLocaleString()} requests/day.`,
              retry_after: dailyQuota.retryAfterSeconds,
              plan: tenantPlan,
              daily_limit: dailyQuota.limit,
            });
          }
        }

        // Set request context for audit logging
        const ipAddress = (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim() || req.ip || 'unknown';
        const userAgent = req.headers['user-agent'] || 'unknown';
        this.auditLogger.setRequestContext({
          userId: authResult.userId,
          apiKeyId: authResult.apiKeyId,
          ipAddress,
          userAgent
        });

        let transport: StreamableHTTPServerTransport;

        // Session management — verbose log gated to non-production (session keys are sensitive)
        if (process.env.NODE_ENV !== 'production') console.log('🔧 Session management...', {
          requestId,
          sessionId,
          method: req.body?.method,
          hasExistingSession: sessionId ? this.sessions.has(sessionId) : false,
          isInitialize: isInitializeRequest(req.body),
          // Note: activeSessions omitted in production logs (session IDs are sensitive)
          totalSessions: this.sessions.size,
          timestamp: new Date().toISOString()
        });

        if (sessionId && this.sessions.has(sessionId)) {
          // Reuse existing session
          const session = this.sessions.get(sessionId)!;
          transport = session.transport;
          console.log('♻️ Reusing existing session:', {
            requestId,
            sessionId,
            method: req.body?.method,
            timestamp: new Date().toISOString()
          });
        } else if (isInitializeRequest(req.body)) {
          // New session initialization - regardless of whether sessionId is provided
          console.log('🆕 Creating new session for initialize request:', {
            requestId,
            providedSessionId: sessionId,
            timestamp: new Date().toISOString()
          });

          // Create MCP server first
          console.log('🏗️ Creating MCP server instance for new session...', {
            requestId,
            tenantId: authResult.tenantId,
            timestamp: new Date().toISOString()
          });
          
          const mcpServer = this.createMCPServer(authResult.tenantId!, authResult.projectId, authResult.userId);
          
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => {
              // Use the provided session ID if available, otherwise generate one
              const id = sessionId || `mcp_${Date.now()}_${Math.random().toString(36).substring(2)}`;
              console.log('🎫 Using session ID:', id);
              return id;
            },
            onsessioninitialized: async (id) => {
              console.log('✅ Session initialized:', {
                sessionId: id,
                requestId,
                timestamp: new Date().toISOString()
              });
              
              // Store session in both Redis, in-memory, AND database for auth caching
              const sessionData: SessionData = {
                transport,
                server: mcpServer,
                createdAt: Date.now(),
                lastAccessed: Date.now()
              };
              
              this.sessions.set(id, { transport, server: mcpServer });
              await this.sessionStore.set(id, sessionData);
              
              // Store in database for authentication caching
              try {
                const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
                await this.pool.query(
                  `INSERT INTO mcp_sessions (session_id, tenant_id, project_id, expires_at) 
                   VALUES ($1, $2, $3, $4)
                   ON CONFLICT (session_id) DO UPDATE SET 
                     tenant_id = EXCLUDED.tenant_id,
                     project_id = EXCLUDED.project_id,
                     expires_at = EXCLUDED.expires_at`,
                  [id, authResult.tenantId, authResult.projectId || null, expiresAt]
                );
                console.log('💾 Session stored in database for auth caching:', {
                  sessionId: id,
                  tenantId: authResult.tenantId,
                  projectId: authResult.projectId,
                  timestamp: new Date().toISOString()
                });
              } catch (error) {
                console.error('❌ Failed to store session in database:', {
                  sessionId: id,
                  error: error instanceof Error ? error.message : String(error),
                  timestamp: new Date().toISOString()
                });
              }
              
              console.log('💾 Session stored in Redis + memory:', {
                sessionId: id,
                totalSessions: this.sessions.size,
                allSessionIds: Array.from(this.sessions.keys()),
                timestamp: new Date().toISOString()
              });
            },
            onsessionclosed: async (id) => {
              console.log('🗑️ Session closed:', {
                sessionId: id,
                requestId,
                timestamp: new Date().toISOString()
              });
              // Remove from Redis, in-memory, AND database
              this.sessions.delete(id);
              await this.sessionStore.delete(id);
              try {
                await this.pool.query('DELETE FROM mcp_sessions WHERE session_id = $1', [id]);
                console.log('🗑️ Session removed from database:', id);
              } catch (error) {
                console.error('❌ Failed to remove session from database:', error);
              }
            },
            enableJsonResponse: true
          });

          transport.onclose = async () => {
            if (transport.sessionId) {
              console.log('🔌 Transport connection closed:', {
                sessionId: transport.sessionId,
                timestamp: new Date().toISOString()
              });
              // Remove from Redis, in-memory, AND database
              this.sessions.delete(transport.sessionId);
              await this.sessionStore.delete(transport.sessionId);
              try {
                await this.pool.query('DELETE FROM mcp_sessions WHERE session_id = $1', [transport.sessionId]);
                console.log('🗑️ Session removed from database on transport close:', transport.sessionId);
              } catch (error) {
                console.error('❌ Failed to remove session from database:', error);
              }
            }
          };

          console.log('🔗 Connecting MCP server to transport...', {
            requestId,
            timestamp: new Date().toISOString()
          });
          await mcpServer.connect(transport);
          
          console.log('🔍 Transport state after connection:', {
            requestId,
            transportSessionId: transport.sessionId,
            transportHasSessionId: !!transport.sessionId,
            timestamp: new Date().toISOString()
          });
          
          // Session should already be stored in onsessioninitialized callback
          if (!transport.sessionId) {
            console.error('❌ Transport has no session ID after connection:', {
              requestId,
              timestamp: new Date().toISOString()
            });
          }
        } else if (sessionId) {
          // Session ID provided but doesn't exist - this might be from a server restart
          console.log('⚠️ Session ID provided but not found, treating as new session:', {
            requestId,
            sessionId,
            method: req.body?.method,
            activeSessions: Array.from(this.sessions.keys()),
            timestamp: new Date().toISOString()
          });
          
          // Create a new session with the provided session ID
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => sessionId,
            onsessioninitialized: (id) => {
              console.log('✅ Session re-initialized:', {
                sessionId: id,
                requestId,
                timestamp: new Date().toISOString()
              });
            },
            onsessionclosed: async (id) => {
              console.log('🗑️ Session closed:', {
                sessionId: id,
                requestId,
                timestamp: new Date().toISOString()
              });
              // Remove from Redis, in-memory, AND database
              this.sessions.delete(id);
              await this.sessionStore.delete(id);
              try {
                await this.pool.query('DELETE FROM mcp_sessions WHERE session_id = $1', [id]);
                console.log('🗑️ Session removed from database:', id);
              } catch (error) {
                console.error('❌ Failed to remove session from database:', error);
              }
            },
            enableJsonResponse: true
          });

          // CRITICAL FIX: Mark transport as initialized for session recreation
          // When a session ID is provided but doesn't exist (after pod restart), we need to
          // set the internal _initialized flag and sessionId to prevent "Server not initialized" errors
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const webTransport = (transport as any)._webStandardTransport;
          if (webTransport) {
            webTransport._initialized = true;
            webTransport.sessionId = sessionId;
            console.log('🔧 Marked transport as initialized for POST session recreation:', {
              sessionId,
              requestId,
              timestamp: new Date().toISOString()
            });
          }

          const mcpServer = this.createMCPServer(authResult.tenantId!, authResult.projectId, authResult.userId);
          await mcpServer.connect(transport);
          
          console.log('🔍 Transport state after re-connection:', {
            requestId,
            transportSessionId: transport.sessionId,
            providedSessionId: sessionId,
            transportHasSessionId: !!transport.sessionId,
            timestamp: new Date().toISOString()
          });
          
          if (transport.sessionId) {
            const sessionData: SessionData = {
              transport,
              server: mcpServer,
              createdAt: Date.now(),
              lastAccessed: Date.now()
            };
            
            this.sessions.set(transport.sessionId, { transport, server: mcpServer });
            await this.sessionStore.set(transport.sessionId, sessionData);
            
            // Store in database for authentication caching
            try {
              const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
              await this.pool.query(
                `INSERT INTO mcp_sessions (session_id, tenant_id, project_id, expires_at) 
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (session_id) DO UPDATE SET 
                   tenant_id = EXCLUDED.tenant_id,
                   project_id = EXCLUDED.project_id,
                   expires_at = EXCLUDED.expires_at`,
                [transport.sessionId, authResult.tenantId, authResult.projectId || null, expiresAt]
              );
              console.log('💾 Session re-stored in database for auth caching:', {
                sessionId: transport.sessionId,
                tenantId: authResult.tenantId,
                projectId: authResult.projectId,
                timestamp: new Date().toISOString()
              });
            } catch (error) {
              console.error('❌ Failed to store session in database:', {
                sessionId: transport.sessionId,
                error: error instanceof Error ? error.message : String(error),
                timestamp: new Date().toISOString()
              });
            }
            
            console.log('💾 Session re-created and stored in Redis + memory:', {
              sessionId: transport.sessionId,
              totalSessions: this.sessions.size,
              allSessionIds: Array.from(this.sessions.keys()),
              timestamp: new Date().toISOString()
            });
          } else {
            console.error('❌ Transport has no session ID after re-connection:', {
              requestId,
              providedSessionId: sessionId,
              timestamp: new Date().toISOString()
            });
          }
        } else {
          // No session ID and not initialize - invalid
          console.error('❌ Invalid session state:', {
            requestId,
            sessionId,
            method: req.body?.method,
            isInitialize: isInitializeRequest(req.body),
            activeSessions: Array.from(this.sessions.keys()),
            timestamp: new Date().toISOString()
          });
          return res.status(400).json({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Invalid session or missing session ID' },
            id: req.body?.id || null
          });
        }

        console.log('📨 Handling MCP request...', {
          requestId,
          method: req.body?.method,
          timestamp: new Date().toISOString()
        });
        
        // Set session ID in response headers if available
        if (transport.sessionId) {
          res.setHeader('mcp-session-id', transport.sessionId);
          console.log('🆔 Setting session ID in response headers:', {
            sessionId: transport.sessionId,
            requestId,
            timestamp: new Date().toISOString()
          });
        }
        
        await transport.handleRequest(req, res, req.body);
        
        console.log('✅ MCP request completed successfully', {
          requestId,
          duration: Date.now() - startTime,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        console.error('❌ MCP POST request error:', {
          requestId,
          error: error instanceof Error ? error.message : String(error),
          code: (error as any)?.code,
          stack: error instanceof Error ? error.stack?.split('\\n').slice(0, 3).join('\\n') : undefined,
          timestamp: new Date().toISOString(),
          duration: Date.now() - startTime
        });
        if (!res.headersSent) {
          res.status(500).json({ 
            error: 'Internal server error', 
            details: error instanceof Error ? error.message : String(error)
          });
        }
      }
    });

    this.app.get('/mcp', async (req: Request, res: Response) => {
      const sessionId = req.headers['mcp-session-id'] as string;
      console.log(`🌊 GET /mcp SSE connection attempt`, {
        providedSessionId: sessionId || 'none',
        allHeaders: {
          'mcp-session-id': req.headers['mcp-session-id'],
          'user-agent': req.headers['user-agent'],
          'connection': req.headers['connection'],
          'accept': req.headers['accept']
        },
        totalSessions: this.sessions.size,
        availableSessionIds: Array.from(this.sessions.keys()),
        timestamp: new Date().toISOString()
      });

      let session;
      let actualSessionId: string | undefined;
      
      if (sessionId && this.sessions.has(sessionId)) {
        session = this.sessions.get(sessionId);
        actualSessionId = sessionId;
        console.log('✅ Found session by provided ID:', sessionId);
      } else if (sessionId && await this.sessionStore.exists(sessionId)) {
        // Session exists in Redis but not in local memory - recreate it
        console.log('🔄 Session exists in Redis but not locally - recreating session:', {
          sessionId,
          podId: process.env.HOSTNAME || 'unknown',
          timestamp: new Date().toISOString()
        });
        
        // Get auth info from database
        const sessionDbResult = await this.pool.query(
          'SELECT tenant_id, project_id FROM mcp_sessions WHERE session_id = $1 AND expires_at > NOW()',
          [sessionId]
        );
        
        if (sessionDbResult.rows.length > 0) {
          const { tenant_id, project_id } = sessionDbResult.rows[0];
          
          // Recreate transport and server for this session
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => sessionId,
            onsessioninitialized: (id) => {
              console.log('✅ Session re-initialized for GET:', {
                sessionId: id,
                timestamp: new Date().toISOString()
              });
            },
            onsessionclosed: async (id) => {
              console.log('🗑️ Session closed:', {
                sessionId: id,
                timestamp: new Date().toISOString()
              });
              this.sessions.delete(id);
              await this.sessionStore.delete(id);
              try {
                await this.pool.query('DELETE FROM mcp_sessions WHERE session_id = $1', [id]);
              } catch (error) {
                console.error('❌ Failed to remove session from database:', error);
              }
            },
            enableJsonResponse: true
          });

          // CRITICAL FIX: Mark transport as initialized for session recreation
          // When recreating a session from Redis/DB, we're rejoining an existing session
          // so we need to set the internal _initialized flag to prevent "Server not initialized" errors
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const webTransport = (transport as any)._webStandardTransport;
          if (webTransport) {
            webTransport._initialized = true;
            webTransport.sessionId = sessionId;
            console.log('🔧 Marked transport as initialized for session recreation:', {
              sessionId,
              timestamp: new Date().toISOString()
            });
          }

          const mcpServer = this.createMCPServer(tenant_id, project_id, undefined);
          await mcpServer.connect(transport);
          
          // Store in local memory
          this.sessions.set(sessionId, { transport, server: mcpServer });
          
          session = this.sessions.get(sessionId);
          actualSessionId = sessionId;
          
          console.log('✅ Session recreated from Redis/DB for GET request:', {
            sessionId,
            tenantId: tenant_id,
            totalSessions: this.sessions.size,
            timestamp: new Date().toISOString()
          });
        } else {
          console.error('❌ Session in Redis but not in database:', {
            sessionId,
            timestamp: new Date().toISOString()
          });
          // Clean up orphaned Redis session
          await this.sessionStore.delete(sessionId);
          return res.status(400).json({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Session expired, please reinitialize' },
            id: null
          });
        }
      } else if (this.sessions.size === 1) {
        // If no session ID provided but only one active session, use it
        const [onlySessionId] = this.sessions.keys();
        session = this.sessions.get(onlySessionId);
        actualSessionId = onlySessionId;
        console.log('📡 Using only available session for GET request:', {
          requestedId: sessionId,
          usedId: onlySessionId,
          timestamp: new Date().toISOString()
        });
      } else if (this.sessions.size > 1) {
        // Try to find the most recent session if multiple exist
        const sessionIds = Array.from(this.sessions.keys());
        const mostRecentId = sessionIds[sessionIds.length - 1];
        session = this.sessions.get(mostRecentId);
        actualSessionId = mostRecentId;
        console.log('🔄 Multiple sessions, using most recent:', {
          requestedId: sessionId,
          usedId: mostRecentId,
          allSessions: sessionIds,
          timestamp: new Date().toISOString()
        });
      }

      if (!session) {
        console.error('❌ Session not found for GET request:', {
          requestedSessionId: sessionId,
          availableSessionIds: Array.from(this.sessions.keys()),
          totalSessions: this.sessions.size,
          timestamp: new Date().toISOString()
        });
        return res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: Server not initialized' },
          id: null
        });
      }

      console.log('📡 Handling SSE stream for session:', actualSessionId);
      
      // Set up SSE heartbeat to keep connection alive through proxies
      // Most proxies have 60-300 second timeouts, so send heartbeat every 30 seconds
      const heartbeatInterval = setInterval(() => {
        if (!res.writableEnded && !res.destroyed) {
          try {
            // SSE comment format - doesn't trigger event handlers but keeps connection alive
            res.write(': heartbeat\n\n');
          } catch (e) {
            // Connection closed, cleanup
            clearInterval(heartbeatInterval);
          }
        } else {
          clearInterval(heartbeatInterval);
        }
      }, 30000); // 30 second heartbeat

      // Clean up heartbeat on connection close
      res.on('close', () => {
        clearInterval(heartbeatInterval);
        console.log('🔌 SSE connection closed for session:', actualSessionId);
      });

      await session.transport.handleRequest(req, res);
    });

    this.app.delete('/mcp', async (req: Request, res: Response) => {
      const sessionId = req.headers['mcp-session-id'] as string;
      
      if (!sessionId) {
        return res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Session ID required for DELETE requests' },
          id: null
        });
      }

      const session = this.sessions.get(sessionId);
      if (!session) {
        // Check if session exists in Redis or database and clean it up
        if (await this.sessionStore.exists(sessionId)) {
          await this.sessionStore.delete(sessionId);
          console.log('🗑️ Cleaned up orphaned session from Redis:', sessionId);
        }
        try {
          await this.pool.query('DELETE FROM mcp_sessions WHERE session_id = $1', [sessionId]);
          console.log('🗑️ Cleaned up orphaned session from database:', sessionId);
        } catch (error) {
          console.error('❌ Failed to clean up session from database:', error);
        }
        return res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Invalid session ID' },
          id: null
        });
      }

      console.log('🗑️ Handling session termination for:', sessionId);
      // Clean up Redis, database, and in-memory
      await this.sessionStore.delete(sessionId);
      try {
        await this.pool.query('DELETE FROM mcp_sessions WHERE session_id = $1', [sessionId]);
        console.log('🗑️ Session removed from database:', sessionId);
      } catch (error) {
        console.error('❌ Failed to remove session from database:', error);
      }
      await session.transport.handleRequest(req, res);
    });

    // Initialize schema
    this.initializeDatabase();

    console.log('Member Berry MCP Server initialized');
  }

  private async initializeDatabase() {
    try {
      await this.db.initializeSchema();
      console.log('Database schema initialized');
    } catch (error) {
      console.error('Failed to initialize database:', error);
    }
  }

  private async initializeEmbeddings() {
    try {
      const ollamaHost = process.env.OLLAMA_HOST || 'http://localhost:11434';
      console.log(`🔮 Initializing embedding provider with host: ${ollamaHost}`);
      this.embeddingProvider = OllamaEmbeddingProvider.createDefault(ollamaHost);

      const isAvailable = await this.embeddingProvider.isAvailable();
      if (isAvailable) {
        console.log(`✅ Ollama embeddings available at ${ollamaHost}`);
        console.log(`📊 Embedding model: ${this.embeddingProvider.model}, dimensions: ${this.embeddingProvider.dimensions}`);
      } else {
        console.warn('⚠️  Ollama not available at startup, but embedding provider will retry on each request');
        // Don't set to undefined - let it retry on each request
      }
    } catch (error) {
      console.error('❌ Failed to initialize embeddings:', error);
      // Don't set to undefined - let it fail gracefully per request
    }
  }

  private async initializeOptimizationScheduler() {
    try {
      console.log('Initializing auto-optimization scheduler...');
      
      const ollamaClient = OllamaClient.getInstance();
      
      const deduplicationService = new DeduplicationService(this.db, ollamaClient);
      const temporalService = new TemporalAnalyzerService(this.db);
      const relationshipService = new RelationshipMaintainerService(this.db, ollamaClient);
      const qualityService = new QualityScorerService(this.db);
      
      this.optimizationScheduler = new OptimizationScheduler(
        this.db,
        deduplicationService,
        temporalService,
        relationshipService,
        qualityService
      );
      
      console.log('Auto-optimization scheduler initialized');
    } catch (error) {
      console.error('Failed to initialize optimization scheduler:', error);
      this.optimizationScheduler = undefined;
    }
  }

  private async ensureDefaults() {
    try {
      console.log('Ensuring default project/context structure...');
      
      // Get all tenants that don't have a default project
      const result = await this.pool.query(`
        SELECT DISTINCT t.id as tenant_id
        FROM tenants t
        LEFT JOIN projects p ON p.tenant_id = t.id AND p.name = 'default'
        WHERE p.id IS NULL
      `);

      for (const row of result.rows) {
        const tenantId = row.tenant_id;
        console.log(`Creating defaults for tenant ${tenantId}`);
        
        // Create default project
        const projectId = randomUUID();
        await this.pool.query(
          'INSERT INTO projects (id, tenant_id, name, description) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
          [projectId, tenantId, 'default', 'Default project for this tenant']
        );
        
        // Create default context
        const contextId = randomUUID();
        await this.pool.query(
          'INSERT INTO contexts (id, project_id, name, description) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
          [contextId, projectId, 'default', 'Default context for this project']
        );
      }

      console.log('Default structure ensured for all tenants');
    } catch (error) {
      console.error('Failed to ensure defaults:', error);
    }
  }

  private async authenticate(req: Request): Promise<AuthResult> {
    // REM-248: Use unified authentication middleware
    let authMethod: AuthMethod | 'none' = 'none';
    const outcome: AuthOutcome = await authenticateRequest(this.pool, req, {
      onAuditEvent: (event) => {
        authMethod = event.method;
        // Emit to audit logger if available
        console.log(`[AUTH] ${event.method} ${event.success ? 'success' : 'failure'}`, event.error || '');
      }
    });

    if (!outcome.success) {
      trackAuthentication((outcome.attemptedMethod as string) || 'api_key', 'error');
      return {
        success: false,
        error: outcome.error
      };
    }

    // Map AuthSuccess to AuthResult
    trackAuthentication(authMethod, 'success');
    return {
      success: true,
      tenantId: outcome.tenantId,
      projectId: outcome.projectId,
      userId: outcome.userId
    };
  }

  private createMCPServer(tenantId: string, projectId?: string, userId?: string): Server {
    const server = new Server(
      {
        name: 'rembr-server',
        version: '1.0.0',
        description: 'MCP-native memory service for AI agents. Never lose context.',
        icons: [
          {
            src: 'https://rembr.ai/icon.png',
            mimeType: 'image/png',
            sizes: ['192x192', '512x512']
          }
        ],
        websiteUrl: 'https://rembr.ai'
      },
      {
        capabilities: {
          tools: {}
        }
      }
    );

    // Create memory service for this tenant
    const memoryService = new MemoryService(
      tenantId,
      projectId,
      this.db,
      this.embeddingProvider,
      userId
    );

    // Create context service for this tenant
    const contextService = new ContextService(
      tenantId,
      projectId,
      this.db
    );

    // Create snapshot service for this tenant
    const snapshotService = new SnapshotService(this.db);

    // Create compilation service for this tenant
    const compilationService = new CompilationService(this.db);
    
    // Create advanced analytics service for Week 14 features
    const analyticsService = new AdvancedAnalyticsService(this.db, this.embeddingProvider);

    let attachmentService: AttachmentService | null = null;
    const getAttachmentService = () => {
      if (attachmentService) {
        return attachmentService;
      }

      const minioAccessKey = process.env.MINIO_ACCESS_KEY;
      const minioSecretKey = process.env.MINIO_SECRET_KEY;

      if (!minioAccessKey || !minioSecretKey) {
        throw new Error(
          'Attachment storage is not configured: MINIO_ACCESS_KEY and MINIO_SECRET_KEY are required.'
        );
      }

      attachmentService = new AttachmentService(
        this.db,
        process.env.MINIO_ENDPOINT || 'http://minio:9000',
        minioAccessKey,
        minioSecretKey,
        process.env.MINIO_BUCKET || 'rembr-attachments',
        parseInt(process.env.MAX_FILE_SIZE_MB || '20')
      );

      return attachmentService;
    };

    // Create causal reasoning service
    const causalService = new CausalReasoningService(this.pool, OllamaClient.getInstance());

    // Create temporal query service
    const temporalService = new TemporalQueryService(this.pool);

    // Define MCP tools - Phase 1: Consolidated tools first, then legacy for compatibility
    // Phase 2: Filter tools by server type (REM-38)
    const consolidatedTools = this.serverType === 'all'
      ? getConsolidatedTools()
      : getToolsByServerType(this.serverType);
    
    // Legacy tools (deprecated - route to consolidated equivalents)
    const legacyTools: Tool[] = [
      {
        name: 'store_memory',
        description: 'Store a new memory with optional metadata and category',
        inputSchema: {
          type: 'object',
          properties: {
            content: {
              type: 'string',
              description: 'The content to remember'
            },
            category: {
              type: 'string',
              enum: [...MEMORY_CATEGORIES],
              description: 'Category for organizing memories'
            },
            metadata: {
              type: 'object',
              description: 'Additional metadata as key-value pairs',
              additionalProperties: true
            },
            relevance_score: {
              type: 'number',
              description: 'Relevance score (0.0 to 1.0)',
              minimum: 0,
              maximum: 1
            }
          },
          required: ['content', 'category']
        }
      },
      {
        name: 'search_memory',
        description: 'Search memories using hybrid text and semantic search. Supports phrase search, metadata filtering, and multiple search modes for RLM context retrieval.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search query'
            },
            category: {
              type: 'string',
              enum: [...MEMORY_CATEGORIES],
              description: 'Optional category filter'
            },
            limit: {
              type: 'number',
              description: 'Maximum number of results (default 10)',
              minimum: 1,
              maximum: 50
            },
            min_similarity: {
              type: 'number',
              description: 'Minimum similarity score for semantic search (default 0.7)',
              minimum: 0,
              maximum: 1
            },
            search_mode: {
              type: 'string',
              enum: ['hybrid', 'semantic', 'text', 'phrase'],
              description: 'Search mode: hybrid (default, 0.7 semantic + 0.3 text), semantic (embeddings only), text (fuzzy matching), phrase (multi-word exact matching)'
            },
            metadata_filter: {
              type: 'object',
              description: 'Filter results by metadata fields (e.g., {"taskId": "rate-limit-2024", "area": "endpoints"})',
              additionalProperties: true
            },
            max_tokens: {
              type: 'number',
              description: 'Maximum total tokens to return across all results (RAD-88 budget-aware search). Results are ranked by relevance and truncated to fit. ~4 chars per token.',
              minimum: 100
            },
            token_budget_category: {
              type: 'string',
              description: 'Budget category name to check against active context_budgets allocation (RAD-88). If set, enforces the category token limit instead of max_tokens.'
            }
          },
          required: ['query']
        }
      },
      {
        name: 'list_memories',
        description: 'List recent memories with optional category filter',
        inputSchema: {
          type: 'object',
          properties: {
            category: {
              type: 'string',
              enum: [...MEMORY_CATEGORIES],
              description: 'Optional category filter'
            },
            limit: {
              type: 'number',
              description: 'Maximum number of memories (default 10)',
              minimum: 1,
              maximum: 50
            }
          }
        }
      },
      {
        name: 'get_memory',
        description: 'Get a specific memory by ID',
        inputSchema: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: 'Memory ID'
            }
          },
          required: ['id']
        }
      },
      {
        name: 'update_memory',
        description: 'Update an existing memory entry',
        inputSchema: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: 'Memory ID to update'
            },
            content: {
              type: 'string',
              description: 'New content (optional)'
            },
            category: {
              type: 'string',
              enum: [...MEMORY_CATEGORIES],
              description: 'New category (optional)'
            },
            metadata: {
              type: 'object',
              description: 'Updated metadata (optional)',
              additionalProperties: true
            },
            relevance_score: {
              type: 'number',
              description: 'New relevance score (optional)',
              minimum: 0,
              maximum: 1
            }
          },
          required: ['id']
        }
      },
      {
        name: 'delete_memory',
        description: 'Delete a memory by ID',
        inputSchema: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: 'Memory ID to delete'
            }
          },
          required: ['id']
        }
      },
      {
        name: 'find_similar_memories',
        description: 'Find memories similar to a specific memory using semantic similarity',
        inputSchema: {
          type: 'object',
          properties: {
            memory_id: {
              type: 'string',
              description: 'Memory ID to find similar memories for'
            },
            limit: {
              type: 'number',
              description: 'Maximum number of results (default 10)',
              minimum: 1,
              maximum: 50
            },
            min_similarity: {
              type: 'number',
              description: 'Minimum similarity score (default 0.7)',
              minimum: 0,
              maximum: 1
            },
            category: {
              type: 'string',
              enum: [...MEMORY_CATEGORIES],
              description: 'Optional category filter'
            }
          },
          required: ['memory_id']
        }
      },
      {
        name: 'get_stats',
        description: 'Get memory statistics and usage information',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'get_embedding_stats',
        description: 'Get statistics about stored embeddings and semantic search status',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'list_contexts',
        description: 'List all contexts in the current project. Contexts are logical groupings of related memories for RLM decomposition.',
        inputSchema: {
          type: 'object',
          properties: {
            category: {
              type: 'string',
              enum: [...MEMORY_CATEGORIES],
              description: 'Optional: filter by memory category'
            }
          }
        }
      },
      {
        name: 'create_context',
        description: 'Create a new context within the current project',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Context name (required)'
            },
            description: {
              type: 'string',
              description: 'Optional description'
            },
            category: {
              type: 'string',
              enum: [...MEMORY_CATEGORIES],
              description: 'Optional category link'
            }
          },
          required: ['name']
        }
      },
      {
        name: 'search_context',
        description: 'Search within a specific context. Scoped hybrid search for RLM sub-agents.',
        inputSchema: {
          type: 'object',
          properties: {
            context_id: {
              type: 'string',
              description: 'Context ID to search within (required)'
            },
            query: {
              type: 'string',
              description: 'Search query (required)'
            },
            limit: {
              type: 'number',
              description: 'Max results (default 10)',
              minimum: 1,
              maximum: 50
            },
            min_similarity: {
              type: 'number',
              description: 'Minimum similarity score 0-1 (default 0.7)',
              minimum: 0,
              maximum: 1
            }
          },
          required: ['context_id', 'query']
        }
      },
      {
        name: 'add_memory_to_context',
        description: 'Link an existing memory to a context (memories can be in multiple contexts)',
        inputSchema: {
          type: 'object',
          properties: {
            memory_id: {
              type: 'string',
              description: 'Memory ID (required)'
            },
            context_id: {
              type: 'string',
              description: 'Context ID (required)'
            },
            relevance_score: {
              type: 'number',
              description: 'Relevance score 0-1 (default 1.0)',
              minimum: 0,
              maximum: 1
            }
          },
          required: ['memory_id', 'context_id']
        }
      },
      // Phase 2: Context Snapshots
      {
        name: 'create_snapshot',
        description: 'Create an immutable snapshot of memories for sub-agent handoff. Supports TTL for automatic cleanup. ⚠️ REQUIRED: at least one of query, memory_ids, or context_ids must be provided — calling with only name/description will fail.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Optional snapshot name'
            },
            description: {
              type: 'string',
              description: 'Optional description'
            },
            query: {
              type: 'string',
              description: '⚑ At least one required (with memory_ids/context_ids). Search query to find memories to snapshot.'
            },
            context_ids: {
              type: 'array',
              items: { type: 'string' },
              description: '⚑ At least one required (with query/memory_ids). Context IDs to snapshot.'
            },
            memory_ids: {
              type: 'array',
              items: { type: 'string' },
              description: '⚑ At least one required (with query/context_ids). Specific memory IDs to snapshot.'
            },
            max_tokens: {
              type: 'number',
              description: 'Approximate max tokens (for context budget)'
            },
            ttl_hours: {
              type: 'number',
              description: 'Time-to-live in hours (default: no expiry)'
            }
          },
          // RAD-65: document the at-least-one constraint clearly for agent consumption
          description: 'At least one of query, memory_ids, or context_ids is required. Calling without any of these will return an error.'
        }
      },
      {
        name: 'get_snapshot',
        description: 'Retrieve a snapshot by ID with its immutable memory copies',
        inputSchema: {
          type: 'object',
          properties: {
            snapshot_id: {
              type: 'string',
              description: 'Snapshot ID'
            }
          },
          required: ['snapshot_id']
        }
      },
      {
        name: 'list_snapshots',
        description: 'List available snapshots (excludes expired ones)',
        inputSchema: {
          type: 'object',
          properties: {
            limit: {
              type: 'number',
              description: 'Max results (default 10)',
              minimum: 1,
              maximum: 50
            }
          }
        }
      },
      // Phase 3: Context Compilation
      {
        name: 'get_memory_graph',
        description: 'Get relationship graph for memories in a context. Shows connections, contradictions, and semantic links.',
        inputSchema: {
          type: 'object',
          properties: {
            context_id: {
              type: 'string',
              description: 'Context ID'
            }
          },
          required: ['context_id']
        }
      },
      {
        name: 'detect_contradictions',
        description: 'Find contradicting memories within a context. Useful for debugging RLM reasoning.',
        inputSchema: {
          type: 'object',
          properties: {
            context_id: {
              type: 'string',
              description: 'Context ID'
            }
          },
          required: ['context_id']
        }
      },
      {
        name: 'get_context_insights',
        description: 'Get pre-compiled insights for a context (category dist, temporal patterns, entities)',
        inputSchema: {
          type: 'object',
          properties: {
            context_id: {
              type: 'string',
              description: 'Context ID'
            },
            regenerate: {
              type: 'boolean',
              description: 'Force regeneration of insights (default false)'
            }
          },
          required: ['context_id']
        }
      },
      // Week 13: Context Intelligence Tools
      {
        name: 'classify_query_intent',
        description: 'Classify the intent of a query and suggest appropriate memory categories using RLM-optimized analysis',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Query to analyze for intent classification'
            },
            recent_categories: {
              type: 'array',
              items: { type: 'string' },
              description: 'Recently used categories for context'
            },
            project_domain: {
              type: 'string',
              description: 'Project domain context (e.g., software_engineering, data_science)'
            }
          },
          required: ['query']
        }
      },
      {
        name: 'infer_memory_relationships',
        description: 'Automatically detect and infer relationships between memories using semantic analysis',
        inputSchema: {
          type: 'object',
          properties: {
            memory_id: {
              type: 'string',
              description: 'Memory ID to analyze relationships for'
            },
            min_confidence: {
              type: 'number',
              description: 'Minimum confidence threshold for relationships (default 0.6)',
              minimum: 0,
              maximum: 1
            }
          },
          required: ['memory_id']
        }
      },
      {
        name: 'enhanced_search',
        description: 'Smart search with intent classification, contextual embeddings, and relationship inference',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search query'
            },
            enable_intent_classification: {
              type: 'boolean',
              description: 'Auto-classify query intent and suggest categories (default true)'
            },
            enable_relationship_expansion: {
              type: 'boolean', 
              description: 'Include related memories via inferred relationships (default false)'
            },
            domain_context: {
              type: 'string',
              enum: ['software_engineering', 'data_science', 'business_operations', 'research_development'],
              description: 'Domain context for contextual embeddings'
            },
            limit: {
              type: 'number',
              description: 'Maximum number of results (default 10)',
              minimum: 1,
              maximum: 50
            }
          },
          required: ['query']
        }
      },
      {
        name: 'get_memory_insights',
        description: 'Get analytical insights about memory patterns, relationships, and usage statistics',
        inputSchema: {
          type: 'object',
          properties: {
            analysis_type: {
              type: 'string',
              enum: ['patterns', 'relationships', 'usage', 'categories', 'domains'],
              description: 'Type of insight analysis to perform (default: patterns). RAD-66: optional, defaults to patterns.'
            },
            time_range_days: {
              type: 'number',
              description: 'Number of days to analyze (default 30)',
              minimum: 1,
              maximum: 365
            }
          },
          required: []
        }
      },
      // Week 14: Advanced Analytics Tools
      {
        name: 'detect_memory_contradictions',
        description: 'Advanced contradiction detection across memories using semantic analysis and logical patterns',
        inputSchema: {
          type: 'object',
          properties: {
            context_id: {
              type: 'string',
              description: 'Optional: analyze contradictions within a specific context only'
            },
            min_confidence: {
              type: 'number',
              description: 'Minimum confidence threshold for contradictions (default 0.7)',
              minimum: 0.5,
              maximum: 1.0
            },
            contradiction_types: {
              type: 'array',
              items: {
                type: 'string',
                enum: ['factual', 'temporal', 'logical', 'preference']
              },
              description: 'Types of contradictions to detect (default: all)'
            }
          }
        }
      },
      {
        name: 'generate_context_graph',
        description: 'Generate interactive context graph for visualization with nodes, edges, clusters, and metrics',
        inputSchema: {
          type: 'object',
          properties: {
            context_id: {
              type: 'string',
              description: 'Optional: generate graph for specific context only'
            },
            include_relationships: {
              type: 'boolean',
              description: 'Include semantic relationship edges (default true)'
            },
            min_edge_weight: {
              type: 'number',
              description: 'Minimum edge weight to include (default 0.3)',
              minimum: 0.0,
              maximum: 1.0
            },
            cluster_algorithm: {
              type: 'string',
              enum: ['category', 'semantic', 'temporal'],
              description: 'Clustering algorithm for grouping nodes (default: category)'
            }
          }
        }
      },
      {
        name: 'generate_memory_insights',
        description: 'Generate automated insights from memory patterns and usage analytics',
        inputSchema: {
          type: 'object',
          properties: {
            time_range_days: {
              type: 'number',
              description: 'Time range for pattern analysis (default 30)',
              minimum: 7,
              maximum: 365
            },
            insight_types: {
              type: 'array',
              items: {
                type: 'string',
                enum: ['growth', 'decay', 'cyclical', 'burst', 'steady']
              },
              description: 'Types of patterns to detect (default: all)'
            },
            min_confidence: {
              type: 'number',
              description: 'Minimum confidence for insights (default 0.6)',
              minimum: 0.4,
              maximum: 1.0
            }
          }
        }
      },
      {
        name: 'get_predictive_analytics',
        description: 'Get predictive analytics for memory growth, usage patterns, and quality trends',
        inputSchema: {
          type: 'object',
          properties: {
            prediction_horizon_days: {
              type: 'number',
              description: 'Days ahead to predict (default 30)',
              minimum: 7,
              maximum: 365
            },
            include_growth_prediction: {
              type: 'boolean',
              description: 'Include memory growth predictions (default true)'
            },
            include_usage_prediction: {
              type: 'boolean',
              description: 'Include category usage predictions (default true)'
            },
            include_quality_assessment: {
              type: 'boolean',
              description: 'Include quality degradation risk assessment (default true)'
            }
          }
        }
      },
      {
        name: 'set_memory_visibility',
        description: 'Change the visibility scope of a memory',
        inputSchema: {
          type: 'object',
          properties: {
            memory_id: {
              type: 'string',
              description: 'ID of memory to update'
            },
            visibility: {
              type: 'string',
              enum: ['personal', 'shared', 'project'],
              description: 'New visibility scope'
            }
          },
          required: ['memory_id', 'visibility']
        }
      },
      {
        name: 'list_personal_memories',
        description: 'List personal memories for the current user only',
        inputSchema: {
          type: 'object',
          properties: {
            limit: {
              type: 'number',
              description: 'Maximum number of memories to return (default 50)',
              minimum: 1,
              maximum: 1000
            },
            category: {
              type: 'string',
              description: 'Filter by memory category'
            }
          }
        }
      },
      // Causal Reasoning Tools
      {
        name: 'trace_causality',
        description: 'Trace causal reasoning chain from a memory (forward or backward). Critical for RLM debugging: understand why an agent made a decision.',
        inputSchema: {
          type: 'object',
          properties: {
            memory_id: {
              type: 'string',
              description: 'Memory ID to trace from'
            },
            direction: {
              type: 'string',
              enum: ['causes', 'caused_by'],
              description: 'Trace forward (what this caused) or backward (what caused this)'
            },
            max_depth: {
              type: 'number',
              description: 'Maximum chain depth (default 5)',
              minimum: 1,
              maximum: 20
            }
          },
          required: ['memory_id']
        }
      },
      {
        name: 'infer_causality',
        description: 'Infer causal relationship between two memories using LLM analysis. Automatically tracks cause-effect links.',
        inputSchema: {
          type: 'object',
          properties: {
            cause_memory_id: {
              type: 'string',
              description: 'Potential cause memory ID'
            },
            effect_memory_id: {
              type: 'string',
              description: 'Potential effect memory ID'
            }
          },
          required: ['cause_memory_id', 'effect_memory_id']
        }
      },
      {
        name: 'get_causal_links',
        description: 'Get all causal relationships for a memory',
        inputSchema: {
          type: 'object',
          properties: {
            memory_id: {
              type: 'string',
              description: 'Memory ID'
            },
            direction: {
              type: 'string',
              enum: ['causes', 'caused_by', 'both'],
              description: 'Filter by direction (default: both)'
            }
          },
          required: ['memory_id']
        }
      },
      {
        name: 'validate_causal_link',
        description: 'Provide user feedback on causal relationship accuracy',
        inputSchema: {
          type: 'object',
          properties: {
            link_id: {
              type: 'string',
              description: 'Causal link ID'
            },
            is_valid: {
              type: 'boolean',
              description: 'Whether the causal relationship is accurate'
            }
          },
          required: ['link_id', 'is_valid']
        }
      },
      // Temporal Query Tools
      {
        name: 'search_at_time',
        description: 'Search memories as they existed at a specific point in time (time travel). Debug RLM decisions: "What did the agent know when it chose X?"',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search query'
            },
            as_of_time: {
              type: 'string',
              format: 'date-time',
              description: 'ISO timestamp (e.g., "2026-01-15T10:30:00Z")'
            },
            category: {
              type: 'string',
              description: 'Optional category filter'
            },
            limit: {
              type: 'number',
              description: 'Max results (default 10)',
              minimum: 1,
              maximum: 50
            }
          },
          required: ['query', 'as_of_time']
        }
      },
      {
        name: 'get_memory_history',
        description: 'Get version history of a memory showing all changes over time',
        inputSchema: {
          type: 'object',
          properties: {
            memory_id: {
              type: 'string',
              description: 'Memory ID'
            }
          },
          required: ['memory_id']
        }
      },
      {
        name: 'create_temporal_snapshot',
        description: 'Create named snapshot of knowledge graph at specific time for fast temporal queries',
        inputSchema: {
          type: 'object',
          properties: {
            snapshot_name: {
              type: 'string',
              description: 'Unique snapshot name (preferred)'
            },
            name: {
              type: 'string',
              description: 'Snapshot name (alias for snapshot_name)'
            },
            as_of_time: {
              type: 'string',
              format: 'date-time',
              description: 'Optional: snapshot time (default: now)'
            }
          }
        }
      },
      {
        name: 'list_temporal_snapshots',
        description: 'List all temporal snapshots for this tenant',
        inputSchema: {
          type: 'object',
          properties: {
            limit: {
              type: 'number',
              description: 'Max results (default 50)',
              minimum: 1,
              maximum: 100
            }
          }
        }
      },
      {
        name: 'compare_snapshots',
        description: 'Compare knowledge graph between two timestamps to see what changed',
        inputSchema: {
          type: 'object',
          properties: {
            time_a: {
              type: 'string',
              format: 'date-time',
              description: 'First timestamp (ISO format)'
            },
            time_b: {
              type: 'string',
              format: 'date-time',
              description: 'Second timestamp (ISO format)'
            }
          },
          required: ['time_a', 'time_b']
        }
      },
      // Audit Logging Tools
      {
        name: 'query_audit_log',
        description: 'Query audit logs with filters (admin/compliance use)',
        inputSchema: {
          type: 'object',
          properties: {
            event_type: {
              type: 'string',
              description: 'Filter by event type (e.g., "memory.created", "memory.accessed")'
            },
            start_time: {
              type: 'string',
              format: 'date-time',
              description: 'Start of time range'
            },
            end_time: {
              type: 'string',
              format: 'date-time',
              description: 'End of time range'
            },
            resource_id: {
              type: 'string',
              description: 'Filter by resource ID'
            },
            action_result: {
              type: 'string',
              enum: ['success', 'failure', 'denied'],
              description: 'Filter by operation result'
            },
            limit: {
              type: 'number',
              description: 'Max results (default 100)',
              minimum: 1,
              maximum: 1000
            }
          }
        }
      },
      {
        name: 'generate_compliance_report',
        description: 'Generate SOC2/compliance audit report for a time period',
        inputSchema: {
          type: 'object',
          properties: {
            start_date: {
              type: 'string',
              format: 'date-time',
              description: 'Report start date'
            },
            end_date: {
              type: 'string',
              format: 'date-time',
              description: 'Report end date'
            }
          },
          required: ['start_date', 'end_date']
        }
      },
      {
        name: 'get_audit_stats',
        description: 'Get audit logging statistics and health metrics',
        inputSchema: {
          type: 'object',
          properties: {
            start_date: {
              type: 'string',
              format: 'date-time',
              description: 'Optional: start of analysis period'
            },
            end_date: {
              type: 'string',
              format: 'date-time',
              description: 'Optional: end of analysis period'
            }
          }
        }
      },

      // ── REM-30: Audit Monitoring ─────────────────────────────────────
      {
        name: 'audit_health',
        description: 'Real-time audit health dashboard: current metrics (failure rate, event rate, denied count), active alerts, anomaly score, and recent failures. One-stop monitoring status.',
        inputSchema: { type: 'object', properties: {} }
      },
      {
        name: 'audit_metrics',
        description: 'Current audit metrics snapshot: event counts, failure/error rates, events/min, unique users, top event types and resource types. Configurable time window.',
        inputSchema: {
          type: 'object',
          properties: {
            window_seconds: { type: 'number', description: 'Evaluation window in seconds (default: 300)' }
          }
        }
      },
      {
        name: 'audit_evaluate_thresholds',
        description: 'Evaluate all alert thresholds against current metrics. Returns any fired alerts. Uses built-in thresholds (failure rate, denied spike, error burst, event rate).',
        inputSchema: { type: 'object', properties: {} }
      },
      {
        name: 'audit_alerts',
        description: 'List active or historical alerts. Use operation=active for currently firing, operation=history for recent alert history, operation=acknowledge or operation=resolve to update an alert.',
        inputSchema: {
          type: 'object',
          properties: {
            operation: { type: 'string', enum: ['active', 'history', 'acknowledge', 'resolve'], description: 'Operation (default: active)' },
            alert_id:  { type: 'string', description: 'Alert ID (for acknowledge/resolve)' },
            limit:     { type: 'number', description: 'Max results for history (default: 50)' }
          }
        }
      },
      {
        name: 'audit_anomaly_detect',
        description: 'Run anomaly detection on recent audit events. Returns anomaly score (0–1), risk level (low/medium/high/critical), and triggered signals.',
        inputSchema: { type: 'object', properties: {} }
      },
      {
        name: 'audit_metrics_prometheus',
        description: 'Export current audit metrics in Prometheus text format for scraping by monitoring systems.',
        inputSchema: { type: 'object', properties: {} }
      },

      {
        name: 'pii',
        description: 'Detect, redact, and audit personally identifiable information (PII) in memories. Supports email, phone, SSN, credit cards, UK NINO, IP addresses, and crypto wallets.',
        inputSchema: {
          type: 'object',
          properties: {
            operation: {
              type: 'string',
              enum: ['detect', 'redact', 'audit', 'compliance_report', 'batch_scan'],
              description: 'Operation to perform: detect (scan text), redact (remove PII), audit (query access logs), compliance_report (GDPR report), batch_scan (backfill existing memories)'
            },
            text: {
              type: 'string',
              description: 'Text to scan for PII (for detect/redact operations)'
            },
            memory_id: {
              type: 'string',
              description: 'Memory ID to scan or audit (for detect/redact/audit operations)'
            },
            sensitivity: {
              type: 'string',
              enum: ['low', 'medium', 'high'],
              description: 'Detection sensitivity: low (email/phone), medium (+SSN/cards), high (+IP/crypto/DOB)',
              default: 'medium'
            },
            redaction_mode: {
              type: 'string',
              enum: ['mask', 'hash', 'remove'],
              description: 'How to redact PII: mask (****), hash ([TYPE_REDACTED]), remove (delete)',
              default: 'mask'
            },
            start_date: {
              type: 'string',
              format: 'date-time',
              description: 'Start date for audit/compliance_report operations'
            },
            end_date: {
              type: 'string',
              format: 'date-time',
              description: 'End date for audit/compliance_report operations'
            },
            limit: {
              type: 'number',
              description: 'Maximum records to return for audit/batch_scan',
              default: 100
            }
          },
          required: ['operation']
        }
      },
      // ─── File Attachments (REM-109) ────────────────────────────────────────
      {
        name: 'upload_attachment',
        description: 'Upload a file attachment to a memory (images, documents, PDFs, etc.)',
        inputSchema: {
          type: 'object',
          properties: {
            memory_id: {
              type: 'string',
              description: 'ID of the memory to attach the file to'
            },
            filename: {
              type: 'string',
              description: 'Original filename (e.g., "document.pdf")'
            },
            content_type: {
              type: 'string',
              description: 'MIME type (e.g., "image/png", "application/pdf", "text/plain")'
            },
            content_base64: {
              type: 'string',
              description: 'File content encoded as base64'
            },
            is_private: {
              type: 'boolean',
              description: 'If true, only the uploading user can access this file (default: false)',
              default: false
            },
            metadata: {
              type: 'object',
              description: 'Optional metadata (tags, description, etc.)',
              additionalProperties: true
            }
          },
          required: ['memory_id', 'filename', 'content_type', 'content_base64']
        }
      },
      {
        name: 'list_attachments',
        description: 'List all file attachments for a memory',
        inputSchema: {
          type: 'object',
          properties: {
            memory_id: {
              type: 'string',
              description: 'ID of the memory to list attachments for'
            }
          },
          required: ['memory_id']
        }
      },
      {
        name: 'get_attachment_url',
        description: 'Get a presigned download URL for an attachment (time-limited)',
        inputSchema: {
          type: 'object',
          properties: {
            attachment_id: {
              type: 'string',
              description: 'ID of the attachment'
            },
            expires_in_seconds: {
              type: 'number',
              description: 'URL expiration time in seconds (60-86400, default: 3600)',
              minimum: 60,
              maximum: 86400,
              default: 3600
            }
          },
          required: ['attachment_id']
        }
      },
      {
        name: 'delete_attachment',
        description: 'Delete a file attachment (only owner can delete)',
        inputSchema: {
          type: 'object',
          properties: {
            attachment_id: {
              type: 'string',
              description: 'ID of the attachment to delete'
            }
          },
          required: ['attachment_id']
        }
      },
      {
        name: 'get_storage_usage',
        description: 'Get storage usage statistics for the current tenant (used bytes, file count, quota)',
        inputSchema: {
          type: 'object',
          properties: {},
          required: []
        }
      },

      // ── REM-37: Ralph-RLM Integration ───────────────────────────────
      {
        name: 'rlm_session',
        description: 'Manage Ralph-RLM sessions: create a session with acceptance criteria and plan, get or list sessions, update status, or export/import full session state for cross-session persistence.',
        inputSchema: {
          type: 'object',
          properties: {
            operation:           { type: 'string', enum: ['create', 'get', 'list', 'update_status', 'export_state', 'import_state'], description: 'Operation' },
            session_id:          { type: 'string',  description: 'Session ID (for get/update_status/export_state)' },
            task_id:             { type: 'string',  description: 'Task identifier (for create/list)' },
            task_title:          { type: 'string',  description: 'Human-readable task title (for create)' },
            acceptance_criteria: { type: 'array',   items: { type: 'string' }, description: 'List of AC descriptions (for create)' },
            initial_plan:        { type: 'string',  description: 'Starting plan text (for create)' },
            status:              { type: 'string',  enum: ['active','complete','abandoned','regenerating'], description: 'New status (for update_status)' },
            plan:                { type: 'string',  description: 'Updated plan text (for update_status)' },
            state_json:          { type: 'string',  description: 'Serialised state JSON (for import_state)' },
            metadata:            { type: 'object',  description: 'Additional metadata' }
          },
        },
      },
// ── REM-39: Enhanced Search & Filtering ─────────────────────────
      {
        name: 'filter_memories',
        description: 'Advanced memory filtering with date range, multi-category, metadata conditions, content length, PII flag, sorting, and pagination. Use instead of search_memory when you need precise structured filtering rather than semantic/text search.',
        inputSchema: {
          type: 'object',
          properties: {
            query:               { type: 'string',  description: 'Optional full-text query to filter by content' },
            categories:          { type: 'array',   items: { type: 'string' }, description: 'One or more categories (OR logic)' },
            category:            { type: 'string',  description: 'Single category (shorthand for categories:[category])' },
            created_after:       { type: 'string',  description: 'ISO date — only memories created after this' },
            created_before:      { type: 'string',  description: 'ISO date — only memories created before this' },
            updated_after:       { type: 'string',  description: 'ISO date — only memories updated after this' },
            updated_before:      { type: 'string',  description: 'ISO date — only memories updated before this' },
            min_content_length:  { type: 'number',  description: 'Minimum content length in characters' },
            max_content_length:  { type: 'number',  description: 'Maximum content length in characters' },
            pii_only:            { type: 'boolean', description: 'Only return memories with PII detected' },
            exclude_pii:         { type: 'boolean', description: 'Exclude memories with PII' },
            metadata_conditions: { type: 'array',   description: 'Structured metadata conditions (AND logic)', items: { type: 'object', properties: { key: { type: 'string' }, operator: { type: 'string', enum: ['eq','neq','contains','exists','gt','lt'] }, value: {} } } },
            metadata_filter:     { type: 'object',  description: 'Simple key=value metadata filter' },
            sort_by:             { type: 'string',  enum: ['created_at','updated_at','content_length','category'], description: 'Sort field (default: created_at)' },
            sort_order:          { type: 'string',  enum: ['asc','desc'], description: 'Sort direction (default: desc)' },
            limit:               { type: 'number',  description: 'Max results (default: 50, max: 500)' },
            offset:              { type: 'number',  description: 'Pagination offset (default: 0)' }
          }
        }
      },
      {
        name: 'batch_memories',
        description: 'Batch operations on a filtered set of memories: delete or update (category/metadata) all matching memories in one call.',
        inputSchema: {
          type: 'object',
          properties: {
            operation: { type: 'string', enum: ['delete', 'update'], description: 'Operation to perform' },
            filter:    { type: 'object', description: 'Advanced filter (same shape as filter_memories). At least one condition required.' },
            updates:   { type: 'object', description: 'For update: { category?: string, metadata_merge?: object }', properties: { category: { type: 'string' }, metadata_merge: { type: 'object' } } }
          },
          required: ['operation', 'filter']
        }
      },
      {
        name: 'saved_searches',
        description: 'Manage saved search queries: save a filter for reuse, list saved searches, execute a saved search by name, or delete one.',
        inputSchema: {
          type: 'object',
          properties: {
            operation:   { type: 'string', enum: ['save', 'list', 'execute', 'delete'], description: 'Operation' },
            name:        { type: 'string',  description: 'Search name (required for save/execute/delete)' },
            description: { type: 'string',  description: 'Optional description (for save)' },
            filter:      { type: 'object',  description: 'Filter to save (required for save)' }
          },
          required: ['operation']
        }
      },
      {
        name: 'rlm_evaluate_ac',
        description: 'Evaluate acceptance criteria for an RLM session. Provide pass/fail status and evidence for each criterion. Session auto-completes when all AC are met/skipped.',
        inputSchema: {
          type: 'object',
          properties: {
            session_id:  { type: 'string', description: 'RLM session ID' },
            evaluations: {
              type: 'array',
              items: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string', enum: ['met','failed','skipped','pending'] }, evidence: { type: 'string' } }, required: ['id', 'status'] },
              description: 'AC evaluation results'
            }
          },
          required: ['session_id', 'evaluations']
        }
      },
      {
        name: 'rlm_iteration',
        description: 'Track RLM iteration cycles: start a new iteration with plan+approach, or complete an existing one with outcome, evidence, and AC results.',
        inputSchema: {
          type: 'object',
          properties: {
            operation:    { type: 'string', enum: ['start', 'complete'], description: 'start or complete an iteration' },
            session_id:   { type: 'string',  description: 'Session ID (for start)' },
            iteration_id: { type: 'string',  description: 'Iteration ID (for complete)' },
            plan_summary: { type: 'string',  description: 'What the plan says (for start)' },
            approach:     { type: 'string',  description: 'Specific approach to try (for start)' },
            outcome:      { type: 'string',  enum: ['success','partial','failed','blocked'], description: 'Result (for complete)' },
            evidence:     { type: 'array',   items: { type: 'string' }, description: 'Evidence strings (for complete)' },
            ac_met:       { type: 'array',   items: { type: 'string' }, description: 'AC IDs met this iteration (for complete)' },
            ac_failed:    { type: 'array',   items: { type: 'string' }, description: 'AC IDs that failed (for complete)' },
            error:        { type: 'string',  description: 'Error message if failed (for complete)' },
            duration_ms:  { type: 'number',  description: 'Iteration duration in ms (for complete)' }
          },
          required: ['operation']
        }
      },
      {
        name: 'rlm_regenerate',
        description: 'Request plan regeneration for a stuck RLM session. Provide the reason, evidence of being stuck, failed approaches, and constraints. Returns a structured prompt for the agent to generate a new plan.',
        inputSchema: {
          type: 'object',
          properties: {
            session_id:        { type: 'string', description: 'RLM session ID' },
            reason:            { type: 'string', description: 'Why regeneration is needed' },
            stuck_evidence:    { type: 'array',  items: { type: 'string' }, description: 'Evidence of being stuck' },
            failed_approaches: { type: 'array',  items: { type: 'string' }, description: 'Approaches already tried' },
            constraints:       { type: 'array',  items: { type: 'string' }, description: 'Constraints the new plan must respect' }
          },
          required: ['session_id', 'reason']
        }
      },

      // ── RAD-73: Plan Compaction Service ─────────────────────────────
      {
        name: 'plan_compaction',
        description: 'Memory compaction on plan downgrade. Operations: check (is compaction needed?), schedule (create 7-day grace period request), consent (user approves compaction), preview (dry-run to see what will merge), execute (run compaction for a consented schedule), history (list past schedules), cancel (allow temporary overage instead).',
        inputSchema: {
          type: 'object',
          properties: {
            operation:            { type: 'string', enum: ['check','schedule','consent','preview','execute','history','cancel'], description: 'Operation to perform' },
            old_plan:             { type: 'string', description: '[schedule] Previous plan name' },
            new_plan:             { type: 'string', description: '[schedule] New (downgraded) plan name' },
            old_memory_limit:     { type: 'number', description: '[schedule] Previous plan memory limit' },
            new_memory_limit:     { type: 'number', description: '[schedule/preview] New plan memory limit (target after compaction)' },
            execute_after:        { type: 'string', description: '[schedule] ISO 8601 date when compaction should execute. Auto-resolved from tenants.current_period_end if omitted. Enforces 24h minimum floor.' },
            grace_period_days:    { type: 'number', description: '[schedule] Fallback grace days if subscription end date not available (default: 7)' },
            schedule_id:          { type: 'string', description: '[consent/execute/cancel] Compaction schedule ID' },
            project_id:           { type: 'string', description: '[execute] Limit compaction to a specific project' },
            similarity_threshold: { type: 'number', description: '[preview/execute] Min similarity for merging (default 0.7)', minimum: 0, maximum: 1 },
            max_group_size:       { type: 'number', description: '[preview/execute] Max memories per merge group (default 5)' },
            limit:                { type: 'number', description: '[history] Max records (default 10)' }
          },
          required: ['operation']
        }
      },

      // ── RAD-60: Plan Regeneration Service ───────────────────────────
      {
        name: 'plan_regeneration',
        description: 'Plan Regeneration Service — auto-unstuck mechanism for task execution. Operations: trigger (request new plan for a stuck task), analyze_stuck (gather context without triggering), history (list past regenerations), resolve (mark regeneration complete with new plan).',
        inputSchema: {
          type: 'object',
          properties: {
            operation:       { type: 'string', enum: ['trigger', 'analyze_stuck', 'history', 'resolve'], description: 'Operation to perform' },
            task_id:         { type: 'string', description: '[trigger/analyze_stuck/history] Task ID to analyze or regenerate' },
            reason_type:     { type: 'string', enum: ['stuck_detection', 'manual', 'failure_threshold', 'timeout'], description: '[trigger] Reason category (default: manual)' },
            reason:          { type: 'string', description: '[trigger] Human-readable reason why regeneration is needed' },
            evidence:        { type: 'array', items: { type: 'string' }, description: '[trigger] Evidence of being stuck (error messages, observations)' },
            iteration_count: { type: 'number', description: '[trigger] Number of failed iterations so far' },
            failure_count:   { type: 'number', description: '[trigger] Number of failures' },
            elapsed_minutes: { type: 'number', description: '[trigger] Time elapsed since task started' },
            limit:           { type: 'number', description: '[history] Max records to return (default 10)' },
            regeneration_id: { type: 'string', description: '[resolve] Regeneration record ID to mark as resolved' },
            new_plan:        { type: 'string', description: '[resolve] The new plan that was adopted' }
          },
          required: ['operation']
        }
      },

      // ── REM-42: Advanced Analytics & Reporting ──────────────────────
      {
        name: 'get_usage_analytics',
        description: 'Time-series breakdown of memory and search usage. Shows memories stored, searches performed, tool calls, and PII detections grouped by hour/day/week/month.',
        inputSchema: {
          type: 'object',
          properties: {
            from:        { type: 'string', description: 'ISO date start (default: 30 days ago)' },
            to:          { type: 'string', description: 'ISO date end (default: now)' },
            granularity: { type: 'string', enum: ['hour', 'day', 'week', 'month'], description: 'Time bucket size (default: day)' }
          }
        }
      },
      {
        name: 'get_performance_metrics',
        description: 'Performance metrics over time: average and p95 latency for store_memory and search_memory, tool call counts, and error rates.',
        inputSchema: {
          type: 'object',
          properties: {
            from:        { type: 'string', description: 'ISO date start (default: 30 days ago)' },
            to:          { type: 'string', description: 'ISO date end (default: now)' },
            granularity: { type: 'string', enum: ['hour', 'day', 'week', 'month'], description: 'Time bucket size (default: day)' }
          }
        }
      },
      {
        name: 'get_memory_growth',
        description: 'Memory growth statistics for a time window: start/end counts, net change, growth rate %, average per day, and peak storage day.',
        inputSchema: {
          type: 'object',
          properties: {
            from: { type: 'string', description: 'ISO date start (default: 30 days ago)' },
            to:   { type: 'string', description: 'ISO date end (default: now)' }
          }
        }
      },
      {
        name: 'get_category_breakdown',
        description: 'Breakdown of stored memories by category: count, percentage of total, PII count, average content length, and last-used date.',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'get_pii_analytics',
        description: 'PII analytics: total memories, PII count and percentage, breakdown by PII type (email/phone/etc.) and by category.',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'build_report',
        description: 'Custom report builder. Assemble a report from selected metrics (usage, performance, growth, categories, pii_summary) for a time range, with export in JSON, CSV, or Markdown.',
        inputSchema: {
          type: 'object',
          properties: {
            title:       { type: 'string',  description: 'Report title' },
            metrics:     { type: 'array',   items: { type: 'string', enum: ['usage', 'performance', 'growth', 'categories', 'pii_summary'] }, description: 'Metrics to include' },
            granularity: { type: 'string',  enum: ['hour', 'day', 'week', 'month'], description: 'Time bucket size (default: day)' },
            from:        { type: 'string',  description: 'Report start date (ISO, default: 30 days ago)' },
            to:          { type: 'string',  description: 'Report end date (ISO, default: today)' },
            format:      { type: 'string',  enum: ['json', 'csv', 'markdown'], description: 'Export format (default: json)' }
          },
          required: ['metrics']
        }
      },

      // ── REM-39: Enhanced Search ──────────────────────────────────────
// ── REM-39: Enhanced Search tools ────────────────────────────────
      {
        name: 'export_memories',
        description: 'Export filtered memories to JSON, CSV, or Markdown. Supports same filter options as filter_memories.',
        inputSchema: {
          type: 'object',
          properties: {
            filter: { type: 'object', description: 'Advanced filter (same shape as filter_memories)' },
            format: { type: 'string', enum: ['json', 'csv', 'markdown'], description: 'Export format (default: json)' },
            title:  { type: 'string', description: 'Report title (used in Markdown export)' }
          }
        }
      },

      // ── REM-64: PII NLP Engine ───────────────────────────────────────
      {
        name: 'pii_nlp_detect',
        description: 'Detect PII in text using combined pattern + NLP heuristic engine. Supports 21 PII types including person names, org names, addresses, IBAN, NHS numbers, JWT tokens, AWS keys, MAC addresses.',
        inputSchema: {
          type: 'object',
          properties: {
            content:     { type: 'string', description: 'Text to analyse for PII' },
            sensitivity: { type: 'string', enum: ['low', 'medium', 'high', 'maximum'], description: 'Detection sensitivity (default: high)' }
          },
          required: ['content']
        }
      },
      {
        name: 'pii_nlp_redact',
        description: 'Detect and redact PII from text. Four redaction modes: mask (***), hash ([TYPE_REDACTED]), label ([TYPE]), remove.',
        inputSchema: {
          type: 'object',
          properties: {
            content:        { type: 'string', description: 'Text to redact' },
            sensitivity:    { type: 'string', enum: ['low', 'medium', 'high', 'maximum'], description: 'Detection sensitivity (default: high)' },
            mode:           { type: 'string', enum: ['mask', 'hash', 'label', 'remove'], description: 'Redaction mode (default: mask)' },
            min_confidence: { type: 'number', description: 'Minimum confidence to redact (0.0–1.0, default: 0.5)' }
          },
          required: ['content']
        }
      },
      {
        name: 'pii_nlp_score',
        description: 'Quickly score a piece of text for PII risk (0.0–1.0). Useful for filtering/ranking without full detection overhead.',
        inputSchema: {
          type: 'object',
          properties: {
            content:     { type: 'string', description: 'Text to score' },
            sensitivity: { type: 'string', enum: ['low', 'medium', 'high', 'maximum'], description: 'Detection sensitivity (default: high)' }
          },
          required: ['content']
        }
      },

      // ── REM-34: Context Snapshot Timeline ────────────────────────────
      {
        name: 'snapshot_timeline',
        description: 'Get a chronological timeline of context snapshots showing how memory evolved over time. Returns adjacent diffs, growth rates, category shifts, and summary stats.',
        inputSchema: {
          type: 'object',
          properties: {
            from:   { type: 'string', description: 'ISO date start filter (optional)' },
            to:     { type: 'string', description: 'ISO date end filter (optional)' },
            limit:  { type: 'number', description: 'Max snapshots (default 100)' },
            format: { type: 'string', enum: ['json', 'markdown'], description: 'Output format (default: json)' }
          }
        }
      },
      {
        name: 'snapshot_diff',
        description: 'Diff two named snapshots: see memory delta, growth %, categories added/removed/changed.',
        inputSchema: {
          type: 'object',
          properties: {
            snapshot_a: { type: 'string', description: 'Name of first snapshot (earlier)' },
            snapshot_b: { type: 'string', description: 'Name of second snapshot (later)' }
          },
          required: ['snapshot_a', 'snapshot_b']
        }
      },
      {
        name: 'snapshot_nearest',
        description: 'Find the nearest snapshot to a given timestamp. Returns the snapshot plus distance in seconds and direction (before/after/exact).',
        inputSchema: {
          type: 'object',
          properties: {
            timestamp: { type: 'string', description: 'ISO timestamp to look up' }
          },
          required: ['timestamp']
        }
      },
      {
        name: 'snapshot_category_evolution',
        description: 'Track how each memory category evolved across all snapshots. Returns per-snapshot counts for every category.',
        inputSchema: {
          type: 'object',
          properties: {
            from:  { type: 'string', description: 'ISO date start filter (optional)' },
            to:    { type: 'string', description: 'ISO date end filter (optional)' },
            limit: { type: 'number', description: 'Max snapshots (default 100)' }
          }
        }
      },

      // ── REM-36: Work Queue & Agent Handoff ────────────────────────────
      {
        name: 'work_queue',
        description: 'Multi-agent work queue with priority scheduling and handoff payloads. Operations: enqueue, bulk_enqueue, claim, complete, bulk_complete, fail, retry, renew_lease, list, get, stats, purge.',
        inputSchema: {
          type: 'object',
          properties: {
            operation:       { type: 'string', enum: ['enqueue','bulk_enqueue','claim','complete','bulk_complete','fail','retry','renew_lease','list','get','stats','purge'], description: 'Queue operation' },
            queue_name:      { type: 'string', description: 'Queue name (default: default)' },
            item_id:         { type: 'string', description: 'Item ID (for complete/fail/retry/renew_lease/get)' },
            agent_id:        { type: 'string', description: 'Agent identifier (for claim/complete/fail/renew_lease)' },
            task_type:       { type: 'string', description: 'Task type label (for enqueue)' },
            priority:        { type: 'string', enum: ['critical','high','normal','low'], description: 'Priority (default: normal)' },
            payload:         { type: 'object', description: 'Task payload (for enqueue)' },
            handoff:         { type: 'object', description: 'Handoff payload: {summary, context, memory_ids?, instructions?, target_agent_type?}' },
            failure_reason:  { type: 'string', description: 'Failure reason (for fail)' },
            lease_seconds:   { type: 'number', description: 'Lease duration in seconds (default: 300)' },
            max_attempts:    { type: 'number', description: 'Max retry attempts before dead-lettering (default: 3)' },
            scheduled_after: { type: 'string', description: 'ISO timestamp — earliest processing time (for enqueue)' },
            idempotency_key: { type: 'string', description: 'Deduplication key (for enqueue)' },
            status_filter:   { type: 'array',  items: { type: 'string' }, description: 'Status filter for list (e.g. ["pending","claimed"])' },
            limit:           { type: 'number', description: 'Max results (default: 50)' },
            offset:          { type: 'number', description: 'Pagination offset (default: 0)' },
            older_than_days: { type: 'number', description: 'Purge items older than N days (default: 7)' },
            items:           { type: 'array', items: { type: 'object' }, description: '[bulk_enqueue] Array of enqueue option objects (same fields as single enqueue, minus queue_name which is taken from root)' },
            completions:     { type: 'array', items: { type: 'object' }, description: '[bulk_complete] Array of {item_id, agent_id, handoff?} objects' }
          },
          required: ['operation']
        }
      },


      // ── REM-71: Task MCP Tools ────────────────────────────────────────
      {
        name: 'manage_task',
        description: 'Task CRUD and assignment. Operations: create, get, update, delete, list, assign.',
        inputSchema: {
          type: 'object',
          properties: {
            operation:         { type: 'string', enum: ['create','get','update','delete','list','assign'], description: 'Operation to perform' },
            board_id:          { type: 'string', description: 'Board ID (required for create, list)' },
            task_id:           { type: 'string', description: 'Task ID (required for get, update, delete, assign)' },
            title:             { type: 'string', description: 'Task title (required for create)' },
            description:       { type: 'string', description: 'Task description (markdown)' },
            status:            { type: 'string', enum: ['pending','in_progress','blocked','completed','failed'], description: 'Task status' },
            priority:          { type: 'string', enum: ['critical','high','medium','low'], description: 'Task priority (default: medium)' },
            assigned_agent_id: { type: 'string', description: 'Agent ID to assign task to' },
            agent_id:          { type: 'string', description: 'Agent ID for assign operation (null to unassign)' },
            due_at:            { type: 'string', description: 'Due date ISO string' },
            depends_on_task_ids: { type: 'array', items: { type: 'string' }, description: 'Task IDs this task depends on' },
            tag_ids:           { type: 'array', items: { type: 'string' }, description: 'Tag IDs' },
            include_deleted:   { type: 'boolean', description: 'Include soft-deleted tasks (list only)' },
            limit:             { type: 'number', description: 'Max results (default 50)' },
            offset:            { type: 'number', description: 'Pagination offset' }
          },
          required: ['operation']
        }
      },
      {
        name: 'task_state',
        description: 'Task state machine. State flow: pending→in_progress→blocked/completed/failed; blocked→in_progress/failed; failed→pending. Operations: transition, valid_next, history.',
        inputSchema: {
          type: 'object',
          properties: {
            operation: { type: 'string', enum: ['transition','valid_next','history'], description: 'State operation' },
            task_id:   { type: 'string', description: 'Task ID' },
            to_status: { type: 'string', enum: ['pending','in_progress','blocked','completed','failed'], description: 'Target status (for transition)' }
          },
          required: ['operation']
        }
      },
      {
        name: 'task_dependencies',
        description: 'Task dependency DAG management with cycle detection. Operations: add, remove, blocked_by, blocking, cycles, critical_path.',
        inputSchema: {
          type: 'object',
          properties: {
            operation:     { type: 'string', enum: ['add','remove','blocked_by','blocking','cycles','critical_path'], description: 'Dependency operation' },
            task_id:       { type: 'string', description: 'Task ID (required for add, remove, blocked_by, blocking, critical_path)' },
            depends_on_id: { type: 'string', description: 'Dependency task ID (required for add, remove)' },
            board_id:      { type: 'string', description: 'Board ID (required for cycles)' }
          },
          required: ['operation']
        }
      },
      {
        name: 'task_search',
        description: 'Task search, filter, and aggregation. Operations: search (full-text on title/description), filter (structured), aggregate (status/priority breakdown).',
        inputSchema: {
          type: 'object',
          properties: {
            operation:         { type: 'string', enum: ['search','filter','aggregate'], description: 'Search operation' },
            query:             { type: 'string', description: 'Full-text search query (search operation)' },
            board_id:          { type: 'string', description: 'Board ID filter (required for aggregate)' },
            status:            { type: 'string', enum: ['pending','in_progress','blocked','completed','failed'], description: 'Status filter' },
            priority:          { type: 'string', enum: ['critical','high','medium','low'], description: 'Priority filter' },
            assigned_agent_id: { type: 'string', description: 'Filter by assigned agent' },
            include_deleted:   { type: 'boolean', description: 'Include deleted tasks' },
            limit:             { type: 'number', description: 'Max results (default 50)' },
            offset:            { type: 'number', description: 'Pagination offset' }
          },
          required: ['operation']
        }
      },

      // ── REM-29: GDPR Compliance ────────────────────────────────────────
      {
        name: 'gdpr',
        description: 'GDPR compliance: right to erasure (forget-me), data retention policies, consent audit trail, and data export (Article 20 portability).',
        inputSchema: {
          type: 'object',
          properties: {
            operation: {
              type: 'string',
              enum: ['request_forget_me', 'process_forget_me', 'get_deletion_request', 'list_deletion_requests',
                     'set_retention_policy', 'purge_expired', 'retention_stats',
                     'log_consent', 'get_consent_trail', 'export_data'],
              description: 'GDPR operation'
            },
            request_id:      { type: 'string', description: 'Deletion request ID (for process/get)' },
            user_id:         { type: 'string', description: 'User ID scoping the operation' },
            memory_id:       { type: 'string', description: 'Memory ID (for set_retention_policy)' },
            retention_policy:{ type: 'string', enum: ['standard','extended','minimal','gdpr_deleted'], description: 'Retention policy' },
            request_type:    { type: 'string', enum: ['full','selective','export'], description: 'Deletion request type (default: full)' },
            event_type:      { type: 'string', description: 'Consent event type filter' },
            resource_type:   { type: 'string', description: 'Resource type for consent event' },
            resource_id:     { type: 'string', description: 'Resource ID for consent event' },
            previous_value:  { type: 'object', description: 'Previous value for consent event' },
            new_value:       { type: 'object', description: 'New value for consent event' },
            ip_address:      { type: 'string', description: 'Client IP (for consent events)' },
            limit:           { type: 'number', description: 'Max results (default 50)' },
            offset:          { type: 'number', description: 'Pagination offset' }
          },
          required: ['operation']
        }
      },

      // RAD-17: Acceptance criteria as a first-class RLM tool
      acceptanceCriteriaToolDefinition as unknown as Tool,
    ];

    // Combine: consolidated tools first (preferred), then legacy (deprecated), plus pii
    const tools: Tool[] = [...consolidatedTools, ...legacyTools];

    // Register handlers
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: rawArgs } = request.params;
      let args = sanitizeArgs(rawArgs);
      const startTime = Date.now();
      const correlationId = randomUUID();

      try {
        logger.mcpTool(name, 'start', { tenantId, projectId, correlationId });

        // ── Zod input validation (RAD-46) ──────────────────────────────
        const validation = validateToolInput(name, args as Record<string, unknown> | undefined);
        if (!validation.success) {
          const duration = (Date.now() - startTime) / 1000;
          trackMcpToolCall(name, 'error', tenantId, duration);
          trackMcpToolError(name, 'validation', tenantId);
          logger.mcpTool(name, 'error', {
            tenantId,
            projectId,
            correlationId,
            errorType: 'validation',
            validationErrors: validation.details
          }, duration * 1000);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  error: validation.error,
                  error_type: 'validation',
                  details: validation.details,
                  correlation_id: correlationId
                }, null, 2)
              }
            ],
            isError: true
          };
        }
        // Use validated + sanitised args from here on
        args = validation.data as Record<string, unknown>;
        // ────────────────────────────────────────────────────────────────

        // ── Phase 1: Route consolidated tools to legacy handlers ────────
        // Maps new consolidated tool operations to legacy tool names
        const CONSOLIDATED_TO_LEGACY: Record<string, Record<string, string>> = {
          'memory': {
            'create': 'store_memory',
            'get': 'get_memory',
            'update': 'update_memory',
            'delete': 'delete_memory',
            'list': 'list_memories',
            'list_personal': 'list_personal_memories',
            'set_visibility': 'set_memory_visibility',
            'ingest': 'ingest_document'
          },
          'search': {
            'query': 'search_memory',
            'smart': 'enhanced_search',
            'similar': 'find_similar_memories'
          },
          'stats': {
            'usage': 'get_stats',
            'embeddings': 'get_embedding_stats',
            'insights': 'get_memory_insights',
            'generate_insights': 'generate_memory_insights',
            'predictions': 'get_predictive_analytics'
          },
          'context': {
            'create': 'create_context',
            'list': 'list_contexts',
            'search': 'search_context',
            'add_memory': 'add_memory_to_context'
          },
          'snapshot': {
            'create': 'create_snapshot',
            'get': 'get_snapshot',
            'list': 'list_snapshots',
            'create_temporal': 'create_temporal_snapshot',
            'list_temporal': 'list_temporal_snapshots'
          },
          'graph': {
            'get': 'get_memory_graph',
            'generate': 'generate_context_graph',
            'insights': 'get_context_insights',
            'infer': 'infer_memory_relationships',
            'compare': 'compare_snapshots',
            'explore': 'explore_relationships'
          },
          'contradictions': {
            'detect': 'detect_memory_contradictions'
          },
          'causality': {
            'infer': 'infer_causality',
            'trace': 'trace_causality',
            'get': 'get_causal_links',
            'validate': 'validate_causal_link'
          },
          'temporal': {
            'search': 'search_at_time',
            'history': 'get_memory_history'
          },
          'audit': {
            'query': 'query_audit_log',
            'report': 'generate_compliance_report',
            'stats': 'get_audit_stats'
          },
          'classify': {
            'intent': 'classify_query_intent'
          }
        };

        // Route consolidated tools to their legacy implementations
        let effectiveName = name;
        let isConsolidatedCall = false;
        // RAD-51: track direct legacy calls so we can attach deprecation warnings
        const isDirectLegacyCall = !!TOOL_CONSOLIDATION_MAP[name];
        
        if (CONSOLIDATED_TO_LEGACY[name]) {
          const operation = args?.operation as string;
          const legacyName = CONSOLIDATED_TO_LEGACY[name]?.[operation];
          if (legacyName) {
            effectiveName = legacyName;
            isConsolidatedCall = true;
            logger.info(`Routing consolidated tool '${name}.${operation}' to legacy '${legacyName}'`);

            // Re-validate with the legacy tool schema now that we know the effective name
            const legacyValidation = validateToolInput(legacyName, args as Record<string, unknown> | undefined);
            if (!legacyValidation.success) {
              const duration = (Date.now() - startTime) / 1000;
              trackMcpToolCall(name, 'error', tenantId, duration);
              trackMcpToolError(name, 'validation', tenantId);
              return {
                content: [{
                  type: 'text',
                  text: JSON.stringify({
                    success: false,
                    error: `Validation failed for ${name}.${operation}`,
                    details: legacyValidation.details
                  }, null, 2)
                }],
                isError: true
              };
            }
            // Use sanitised args from legacy validation
            args = legacyValidation.data as Record<string, unknown>;
          } else {
            // Unknown operation for consolidated tool
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  error: `Unknown operation '${operation}' for tool '${name}'. Valid operations: ${Object.keys(CONSOLIDATED_TO_LEGACY[name]).join(', ')}`
                }, null, 2)
              }],
              isError: true
            };
          }
        }

        // RAD-51: Wrap switch in IIFE so we can post-process the result and inject
        // deprecation warnings when a legacy tool name was called directly.
        const toolResult = await (async () => {
        switch (effectiveName) {
          case 'store_memory': {
            // REM-258: validate inputs before reaching the database / embedding pipeline
            const storeValidation = validateMemoryInput(args || {});
            if (!storeValidation.valid) {
              return {
                content: [{
                  type: 'text',
                  text: JSON.stringify({
                    success: false,
                    error: 'Invalid input',
                    details: storeValidation.errors
                  })
                }],
                isError: true
              };
            }

            const memory = await memoryService.storeMemory({
              content: (args?.content as string).trim(),
              category: args?.category as string,
              metadata: args?.metadata as Record<string, any>,
              relevance_score: args?.relevance_score as number
            });

            const duration = (Date.now() - startTime) / 1000;
            trackMcpToolCall('store_memory', 'success', tenantId, duration);
            trackMemoryOperation('store', 'success', tenantId);
            logger.mcpTool('store_memory', 'success', { 
              tenantId, 
              projectId, 
              correlationId,
              category: args?.category as string
            }, duration * 1000);

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: true,
                    memory: {
                      id: memory.id,
                      content: memory.content,
                      category: memory.category,
                      metadata: memory.metadata,
                      created_at: memory.created_at
                    }
                  }, null, 2)
                }
              ]
            };
          }

          // REM-269: Bulk document ingestion — chunk document into memories.
          case 'ingest_document': {
            const rawContent = args?.content as string;
            const title = (args?.title as string) || 'Untitled Document';
            const category = (args?.category as string) || 'general';
            const source = args?.source as string | undefined;
            const chunkSize = Math.min(Math.max((args?.chunk_size as number) || 1000, 200), 5000);
            const userMetadata = (args?.metadata as Record<string, any>) || {};

            if (!rawContent || rawContent.trim().length === 0) {
              return {
                content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'content is required for ingest operation' }) }],
                isError: true
              };
            }

            // ----------------------------------------------------------------
            // Chunking strategy: paragraph-aware, respects sentence boundaries.
            // 1. Split on blank lines (paragraph breaks).
            // 2. Merge short consecutive paragraphs up to chunk_size.
            // 3. If a single paragraph exceeds chunk_size, split at sentence end.
            // ----------------------------------------------------------------
            function splitIntoChunks(text: string, maxChars: number): string[] {
              const paragraphs = text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
              const chunks: string[] = [];
              let current = '';

              for (const para of paragraphs) {
                if (para.length > maxChars) {
                  // Flush current buffer first
                  if (current.trim()) { chunks.push(current.trim()); current = ''; }
                  // Split oversized paragraph at sentence boundaries
                  const sentences = para.match(/[^.!?]+[.!?]+(\s|$)/g) || [para];
                  let sentBuf = '';
                  for (const sent of sentences) {
                    if ((sentBuf + sent).length > maxChars && sentBuf.trim()) {
                      chunks.push(sentBuf.trim());
                      sentBuf = sent;
                    } else {
                      sentBuf += sent;
                    }
                  }
                  if (sentBuf.trim()) chunks.push(sentBuf.trim());
                } else if ((current + '\n\n' + para).length > maxChars && current.trim()) {
                  chunks.push(current.trim());
                  current = para;
                } else {
                  current = current ? current + '\n\n' + para : para;
                }
              }
              if (current.trim()) chunks.push(current.trim());
              return chunks.filter(c => c.length > 0);
            }

            const chunks = splitIntoChunks(rawContent, chunkSize);
            const totalChunks = chunks.length;
            const memoryIds: string[] = [];
            const errors: string[] = [];

            for (let i = 0; i < chunks.length; i++) {
              try {
                const chunkMeta: Record<string, any> = {
                  ...userMetadata,
                  document_title: title,
                  chunk_index: i + 1,
                  total_chunks: totalChunks,
                  ...(source ? { source } : {})
                };

                const memory = await memoryService.storeMemory({
                  content: chunks[i],
                  category,
                  metadata: chunkMeta
                });
                memoryIds.push(memory.id);
              } catch (err) {
                errors.push(`Chunk ${i + 1}: ${(err as Error).message}`);
              }
            }

            const duration = (Date.now() - startTime) / 1000;
            trackMcpToolCall('ingest_document', 'success', tenantId, duration);

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: true,
                    document_title: title,
                    total_chunks: totalChunks,
                    stored: memoryIds.length,
                    failed: errors.length,
                    memory_ids: memoryIds,
                    ...(errors.length > 0 ? { errors } : {})
                  }, null, 2)
                }
              ]
            };
          }

          case 'search_memory': {
            const limit = args?.limit as number;
            const results = await memoryService.searchMemory({
              query: args?.query as string,
              category: args?.category as string,
              limit,
              min_similarity: args?.min_similarity as number,
              search_mode: args?.search_mode as 'hybrid' | 'semantic' | 'text' | 'phrase',
              metadata_filter: args?.metadata_filter as Record<string, any>,
              exclude_pii: args?.exclude_pii as boolean
            });
            const duration = (Date.now() - startTime) / 1000;
            const searchMode = (args?.search_mode as string) || 'hybrid';

            trackMcpToolCall('search_memory', 'success', tenantId, duration);
            trackMemoryOperation('search', 'success', tenantId);
            trackSearchOperation(searchMode, tenantId, duration);
            logger.mcpTool('search_memory', 'success', {
              tenantId,
              projectId,
              correlationId,
              searchMode,
              resultCount: results.length
            }, duration * 1000);

            // RAD-88: Budget-aware token truncation
            const maxTokens = args?.max_tokens as number | undefined;
            let budgetWarning: string | undefined;
            let effectiveMaxTokens = maxTokens;

            if (args?.token_budget_category && !effectiveMaxTokens) {
              // Look up budget allocation for this category
              try {
                const budgetRow = await this.pool.query(
                  `SELECT allocations FROM context_budgets WHERE tenant_id = $1 AND is_active = TRUE ORDER BY created_at DESC LIMIT 1`,
                  [tenantId]
                );
                if (budgetRow.rows.length > 0) {
                  const alloc = budgetRow.rows[0].allocations;
                  const cat = args.token_budget_category as string;
                  if (alloc[cat]) effectiveMaxTokens = Number(alloc[cat]);
                }
              } catch {
                // Non-fatal — no budget found, proceed without limit
              }
            }

            // Format results with pagination metadata (REM-38)
            // Apply token budget: include results until budget exhausted
            let tokenTotal = 0;
            const resultsFormatted: Array<{
              id: string;
              content: string;
              category: string;
              metadata: unknown;
              score: number;
              semantic_similarity: number | undefined;
              text_match: boolean | undefined;
              created_at: Date;
              token_estimate: number;
            }> = [];

            for (const r of results) {
              const tokenEstimate = Math.ceil(r.content.length / 4);
              if (effectiveMaxTokens && tokenTotal + tokenEstimate > effectiveMaxTokens) {
                if (resultsFormatted.length === 0) {
                  budgetWarning = `No results fit within token budget (${effectiveMaxTokens} tokens). Smallest result needs ~${tokenEstimate} tokens.`;
                }
                break;
              }
              tokenTotal += tokenEstimate;
              resultsFormatted.push({
                id: r.id,
                content: r.content,
                category: r.category,
                metadata: r.metadata,
                score: r.score,
                semantic_similarity: r.semantic_similarity,
                text_match: r.text_match,
                created_at: r.created_at,
                token_estimate: tokenEstimate,
              });
            }

            const responseData = addPaginationToResponse({
              items: resultsFormatted,
              limit,
              startTime,
              suggestedFilters: results.length === limit ? [
                'Add category filter',
                'Increase min_similarity',
                'Add metadata_filter'
              ] : undefined
            });

            // Preserve search_mode and budget info in response
            const finalResponse: Record<string, unknown> = {
              ...responseData,
              search_mode: searchMode,
              ...(effectiveMaxTokens ? { token_budget: { max_tokens: effectiveMaxTokens, used_tokens: tokenTotal, results_dropped: results.length - resultsFormatted.length } } : {}),
              ...(budgetWarning ? { budget_warning: budgetWarning } : {}),
            };

            // RAD-67: Include embedding_status when memories may not yet be indexed
            // This prevents agents from concluding "no results exist" when results are pending
            try {
              const embeddingStatus = await memoryService.getPendingEmbeddingCount();
              if (embeddingStatus.pending > 0) {
                const coverage = embeddingStatus.total > 0
                  ? Math.round((embeddingStatus.total - embeddingStatus.pending) / embeddingStatus.total * 100)
                  : 100;
                finalResponse.embedding_status = 'partial';
                finalResponse.embedding_coverage = `${coverage}%`;
                finalResponse.embedding_pending = embeddingStatus.pending;
                if (results.length === 0) {
                  finalResponse.search_note = `${embeddingStatus.pending} memories are still being indexed. Results may be incomplete — retry in a few seconds.`;
                }
              } else {
                finalResponse.embedding_status = 'ready';
              }
            } catch {
              // Non-fatal: embedding status check failed, omit from response
            }

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(finalResponse, null, 2)
                }
              ]
            };
          }

          case 'list_memories': {
            const limit = args?.limit as number;
            const memories = await memoryService.listMemories(
              limit,
              args?.category as string
            );

            const duration = (Date.now() - startTime) / 1000;
            trackMcpToolCall('list_memories', 'success', tenantId, duration);
            logger.mcpTool('list_memories', 'success', {
              tenantId,
              projectId,
              correlationId,
              category: args?.category as string,
              count: memories.length
            }, duration * 1000);

            // Format with pagination metadata (REM-38)
            const memoriesFormatted = memories.map(m => ({
              id: m.id,
              content: m.content,
              category: m.category,
              metadata: m.metadata,
              created_at: m.created_at
            }));

            const responseData = addPaginationToResponse({
              items: memoriesFormatted,
              limit,
              startTime,
              suggestedFilters: memories.length === limit ? ['Add category filter', 'Adjust limit'] : undefined
            });

            const result = {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(responseData, null, 2)
                }
              ]
            };
            
            return result;
          }

          case 'get_memory': {
            const memory = await memoryService.getMemory(args?.id as string);
            const duration = (Date.now() - startTime) / 1000;

            if (!memory) {
              trackMcpToolCall('get_memory', 'error', tenantId, duration);
              trackMcpToolError('get_memory', 'not_found', tenantId);
              logger.mcpTool('get_memory', 'error', {
                tenantId,
                projectId,
                correlationId,
                error: 'not_found',
                memoryId: args?.id as string
              }, duration * 1000);
              
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      success: false,
                      error: 'Memory not found'
                    }, null, 2)
                  }
                ]
              };
            }

            trackMcpToolCall('get_memory', 'success', tenantId, duration);
            logger.mcpTool('get_memory', 'success', {
              tenantId,
              projectId,
              correlationId
            }, duration * 1000);

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: true,
                    memory: {
                      id: memory.id,
                      content: memory.content,
                      category: memory.category,
                      metadata: memory.metadata,
                      created_at: memory.created_at,
                      updated_at: memory.updated_at
                    }
                  }, null, 2)
                }
              ]
            };
          }

          case 'update_memory': {
            // REM-258: validate provided fields (all optional for partial updates)
            if (!args?.id || typeof args.id !== 'string') {
              return {
                content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'id is required for update' }) }],
                isError: true
              };
            }
            const updateErrors = [
              ...(args.content !== undefined ? validateContent(args.content) : []),
              ...validateCategory(args.category),
              ...validateMetadata(args.metadata),
              ...validateRelevanceScore(args.relevance_score),
            ];
            if (updateErrors.length > 0) {
              return {
                content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Invalid input', details: updateErrors }) }],
                isError: true
              };
            }

            const updated = await memoryService.updateMemory(
              args?.id as string,
              {
                content: args?.content as string,
                category: args?.category as string,
                metadata: args?.metadata as Record<string, any>,
                relevance_score: args?.relevance_score as number
              }
            );
            const duration = (Date.now() - startTime) / 1000;

            if (!updated) {
              trackMcpToolCall('update_memory', 'error', tenantId, duration);
              trackMcpToolError('update_memory', 'not_found', tenantId);
              trackMemoryOperation('update', 'error', tenantId);
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      success: false,
                      error: 'Memory not found'
                    }, null, 2)
                  }
                ],
                isError: true
              };
            }

            trackMcpToolCall('update_memory', 'success', tenantId, duration);
            trackMemoryOperation('update', 'success', tenantId);

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: true,
                    memory: {
                      id: updated.id,
                      content: updated.content,
                      category: updated.category,
                      metadata: updated.metadata,
                      updated_at: updated.updated_at
                    }
                  }, null, 2)
                }
              ]
            };
          }

          case 'delete_memory': {
            const deleted = await memoryService.deleteMemory(args?.id as string);
            const duration = (Date.now() - startTime) / 1000;

            trackMcpToolCall('delete_memory', deleted ? 'success' : 'error', tenantId, duration);
            trackMemoryOperation('delete', deleted ? 'success' : 'error', tenantId);
            if (!deleted) {
              trackMcpToolError('delete_memory', 'not_found', tenantId);
            }

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: deleted,
                    message: deleted ? 'Memory deleted successfully' : 'Memory not found'
                  }, null, 2)
                }
              ]
            };
          }

          case 'find_similar_memories': {
            const similarLimit = (args?.limit as number) || 10;
            const results = await memoryService.findSimilarMemories(
              args?.memory_id as string,
              similarLimit,
              args?.min_similarity as number,
              args?.category as string
            );
            const duration = (Date.now() - startTime) / 1000;

            trackMcpToolCall('find_similar_memories', 'success', tenantId, duration);
            trackMemoryOperation('search', 'success', tenantId);

            // RAD-52: pagination metadata
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(addPaginationToResponse({
                    items: results.map(r => ({
                      id: r.id,
                      content: r.content,
                      category: r.category,
                      similarity: r.similarity,
                      created_at: r.created_at
                    })),
                    limit: similarLimit,
                    startTime,
                    suggestedFilters: results.length >= similarLimit
                      ? ['Increase min_similarity to narrow results', 'Filter by category']
                      : undefined,
                    relatedTools: ['search_memory', 'get_memory_graph']
                  }), null, 2)
                }
              ]
            };
          }

          case 'get_stats': {
            const stats = await memoryService.getStats();
            const duration = (Date.now() - startTime) / 1000;

            // Include PII plan capabilities in stats (RAD-35)
            const { getPIICapabilities, getPIIScanUsage } = await import('./pii-plan-limits.js');
            const statsPlanInfo = await this.db.getTenantPlan(tenantId);
            const statsPlan = statsPlanInfo?.plan || 'free';
            const statsPiiCaps = getPIICapabilities(statsPlan);

            // Include daily rate limit quota in stats (REM-48)
            const { getDailyTenantUsage } = await import('./rate-limiter.js');
            const statsQuota = await getDailyTenantUsage(tenantId, statsPlan);

            // Include monthly PII scan usage in stats (RAD-35)
            const piiScanUsage = await getPIIScanUsage(tenantId, statsPlan);

            trackMcpToolCall('get_stats', 'success', tenantId, duration);

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: true,
                    stats,
                    pii_capabilities: {
                      plan_tier: statsPlan,
                      max_sensitivity: statsPiiCaps.maxSensitivity,
                      auto_scan: statsPiiCaps.autoScan,
                      compliance_reports: statsPiiCaps.complianceReportEnabled,
                      compliance_frequency: statsPiiCaps.complianceFrequency,
                      batch_scan: statsPiiCaps.batchScanEnabled,
                      custom_rules: statsPiiCaps.customRulesEnabled,
                      // RAD-35: monthly scan quota
                      pii_scans_per_month: statsPiiCaps.piiScansPerMonth === Infinity ? 'unlimited' : statsPiiCaps.piiScansPerMonth,
                    },
                    pii_scan_quota: {
                      monthly_limit: piiScanUsage.limit === -1 ? 'unlimited' : piiScanUsage.limit,
                      monthly_used: piiScanUsage.count,
                      monthly_remaining: piiScanUsage.remaining === -1 ? 'unlimited' : piiScanUsage.remaining,
                      resets_at: piiScanUsage.resetsAt,
                    },
                    rate_limits: {
                      plan_tier: statsPlan,
                      daily_limit: statsQuota.limit,
                      daily_used: statsQuota.count,
                      daily_remaining: statsQuota.remaining,
                      resets_at: statsQuota.resetAt,
                    }
                  }, null, 2)
                }
              ]
            };
          }

          case 'get_embedding_stats': {
            const stats = await memoryService.getEmbeddingStats();
            const duration = (Date.now() - startTime) / 1000;

            trackMcpToolCall('get_embedding_stats', 'success', tenantId, duration);

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: true,
                    embedding_stats: stats
                  }, null, 2)
                }
              ]
            };
          }

          case 'list_contexts': {
            const contexts = await contextService.listContexts(
              args?.category as string
            );
            const duration = (Date.now() - startTime) / 1000;

            trackMcpToolCall('list_contexts', 'success', tenantId, duration);

            // Format with pagination metadata (REM-38)
            const responseData = addPaginationToResponse({
              items: contexts,
              startTime,
              suggestedFilters: contexts.length > 10 ? ['Add category filter'] : undefined
            });

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(responseData, null, 2)
                }
              ]
            };
          }

          case 'create_context': {
            const context = await contextService.createContext(
              args?.name as string,
              args?.description as string,
              args?.category as string
            );
            const duration = (Date.now() - startTime) / 1000;

            trackMcpToolCall('create_context', 'success', tenantId, duration);

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: true,
                    context
                  }, null, 2)
                }
              ]
            };
          }

          case 'search_context': {
            const limit = args?.limit as number;
            const results = await contextService.searchContext(
              args?.context_id as string,
              args?.query as string,
              limit,
              args?.min_similarity as number
            );
            const duration = (Date.now() - startTime) / 1000;

            trackMcpToolCall('search_context', 'success', tenantId, duration);

            // Format with pagination metadata (REM-38)
            const responseData = addPaginationToResponse({
              items: results,
              limit,
              startTime,
              suggestedFilters: results.length === limit ? [
                'Increase min_similarity',
                'Refine query'
              ] : undefined
            });

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(responseData, null, 2)
                }
              ]
            };
          }

          case 'add_memory_to_context': {
            await contextService.addMemoryToContext(
              args?.context_id as string,
              args?.memory_id as string,
              args?.relevance_score as number
            );
            const duration = (Date.now() - startTime) / 1000;

            trackMcpToolCall('add_memory_to_context', 'success', tenantId, duration);

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: true,
                    message: 'Memory added to context'
                  }, null, 2)
                }
              ]
            };
          }

          // Phase 2: Snapshot handlers
          case 'create_snapshot': {
            // At least one of memory_ids, context_ids, or query is required
            if (!args?.memory_ids && !args?.context_ids && !args?.query) {
              return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'At least one of memory_ids, context_ids, or query is required to create a snapshot' }) }] };
            }
            const authContext = { tenant_id: tenantId, project_id: projectId };
            const result = await snapshotService.createSnapshot(authContext, {
              name: args?.name as string,
              description: args?.description as string,
              query: args?.query as string,
              contextIds: args?.context_ids as string[],
              memoryIds: args?.memory_ids as string[],
              maxTokens: args?.max_tokens as number,
              ttlHours: args?.ttl_hours as number,
              projectId
            });
            const duration = (Date.now() - startTime) / 1000;

            trackMcpToolCall('create_snapshot', 'success', tenantId, duration);

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: true,
                    snapshot_id: result.snapshot.id,
                    memory_count: result.memories.length,
                    token_count: result.snapshot.token_count,
                    expires_at: result.snapshot.expires_at
                  }, null, 2)
                }
              ]
            };
          }

          case 'get_snapshot': {
            const authContext = { tenant_id: tenantId, project_id: projectId };
            const result = await snapshotService.getSnapshot(
              args?.snapshot_id as string,
              authContext
            );
            const duration = (Date.now() - startTime) / 1000;

            if (!result) {
              trackMcpToolCall('get_snapshot', 'error', tenantId, duration);
              trackMcpToolError('get_snapshot', 'not_found', tenantId);
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      success: false,
                      error: 'Snapshot not found or expired'
                    }, null, 2)
                  }
                ],
                isError: true
              };
            }

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: true,
                    snapshot: result.snapshot,
                    memories: result.memories.map(m => ({
                      content: m.content,
                      category: m.category,
                      position: m.position,
                      relevance_score: m.relevance_score
                    }))
                  }, null, 2)
                }
              ]
            };
          }

          case 'list_snapshots': {
            const limit = args?.limit as number || 10;
            const authContext = { tenant_id: tenantId, project_id: projectId };
            const snapshots = await snapshotService.listSnapshots(
              authContext,
              projectId,
              limit
            );
            const duration = (Date.now() - startTime) / 1000;

            trackMcpToolCall('list_snapshots', 'success', tenantId, duration);

            // Format snapshots with pagination metadata (REM-38)
            const snapshotsFormatted = snapshots.map(s => ({
              id: s.id,
              name: s.name,
              description: s.description,
              memory_count: s.memory_count,
              token_count: s.token_count,
              created_at: s.created_at,
              expires_at: s.expires_at
            }));

            const responseData = addPaginationToResponse({
              items: snapshotsFormatted,
              limit,
              startTime,
              suggestedFilters: snapshots.length === limit ? ['Adjust limit', 'Filter expired'] : undefined
            });

            const timelineHtml = renderSnapshotTimeline({ snapshots: snapshotsFormatted });

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(responseData, null, 2)
                },
                {
                  type: 'text',
                  text: timelineHtml,
                  mimeType: 'text/html'
                }
              ]
            };
          }

          // Phase 3: Compilation handlers
          case 'get_memory_graph': {
            const authContext = { tenant_id: tenantId, project_id: projectId };
            const graph = await compilationService.getMemoryGraph(
              args?.context_id as string,
              authContext
            );
            const duration = (Date.now() - startTime) / 1000;

            trackMcpToolCall('get_memory_graph', 'success', tenantId, duration);

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: true,
                    memory_count: graph.memories.length,
                    relationship_count: graph.relationships.length,
                    graph: {
                      memories: graph.memories,
                      relationships: graph.relationships.map(r => ({
                        source: r.source_memory_id,
                        target: r.target_memory_id,
                        type: r.relationship_type,
                        confidence: r.confidence,
                        evidence: r.evidence
                      })),
                      tags: graph.tags
                    }
                  }, null, 2)
                }
              ]
            };
          }

          case 'detect_contradictions': {
            const authContext = { tenant_id: tenantId, project_id: projectId };
            const contradictions = await compilationService.detectContradictions(
              args?.context_id as string,
              authContext
            );
            const duration = (Date.now() - startTime) / 1000;

            trackMcpToolCall('detect_contradictions', 'success', tenantId, duration);

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: true,
                    contradiction_count: contradictions.length,
                    contradictions: contradictions.map(c => ({
                      source_memory_id: c.source_memory_id,
                      target_memory_id: c.target_memory_id,
                      confidence: c.confidence,
                      evidence: c.evidence
                    }))
                  }, null, 2)
                }
              ]
            };
          }

case 'context_analytics': {
            // REM-101: Context usage analytics
            const sessionId = args?.session_id as string;
            if (!sessionId) {
              throw new Error('session_id is required');
            }

            const periodStart = args?.period_start ? new Date(args.period_start as string) : undefined;
            const periodEnd = args?.period_end ? new Date(args.period_end as string) : undefined;

            const analytics = await getContextAnalytics(
              this.pool,
              tenantId,
              sessionId,
              periodStart,
              periodEnd
            );

            const duration = (Date.now() - startTime) / 1000;
            trackMcpToolCall('context_analytics', 'success', tenantId, duration);

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: true,
                    analytics: {
                      session_id: analytics.session_id,
                      period: {
                        start: analytics.period_start,
                        end: analytics.period_end,
                      },
                      usage: {
                        total_tokens: analytics.total_tokens_used,
                        peak_tokens: analytics.peak_tokens,
                        avg_per_hour: analytics.avg_tokens_per_hour,
                        by_category: analytics.usage_by_category,
                        timeline: analytics.usage_timeline,
                      },
                      compression: {
                        total_events: analytics.total_compressions,
                        tokens_saved: analytics.total_tokens_saved,
                        avg_compression_ratio: analytics.avg_compression_ratio,
                        events: analytics.compression_events,
                      },
                      waste: {
                        total_tokens: analytics.total_waste_tokens,
                        percentage: analytics.waste_percentage,
                        detected: analytics.waste_detected,
                      },
                      efficiency: analytics.efficiency,
                      recommendations: analytics.recommendations,
                    }
                  }, null, 2)
                }
              ]
            };
          }

          case 'checkpoint': {
            // REM-98: Pre-compression checkpoints
            const operation = args?.operation as string;
            const sessionId = args?.session_id as string;

            if (!operation) {
              throw new Error('operation is required');
            }
            if (!sessionId) {
              throw new Error('session_id is required');
            }

            switch (operation) {
              case 'create': {
                const tokenCountBefore = args?.token_count_before as number;
                if (tokenCountBefore === undefined) {
                  throw new Error('token_count_before is required for create');
                }

                const decisions = (args?.decisions as Array<{
                  timestamp: string;
                  decision: string;
                  rationale?: string;
                  impact?: string;
                }> || []).map(d => ({
                  timestamp: new Date(d.timestamp),
                  decision: d.decision,
                  rationale: d.rationale,
                  impact: d.impact,
                }));

                const pendingItems = args?.pending_items as Array<{
                  type: 'task' | 'action' | 'question' | 'file';
                  description: string;
                  priority?: 'critical' | 'high' | 'medium' | 'low';
                  due_by?: string;
                }> || [];

                const checkpoint = await createCheckpoint(this.pool, tenantId, {
                  session_id: sessionId,
                  checkpoint_type: (args?.checkpoint_type as 'compression' | 'manual' | 'scheduled') || 'manual',
                  token_count_before: tokenCountBefore,
                  current_task: args?.current_task as string | undefined,
                  objective: args?.objective as string | undefined,
                  decisions,
                  pending_items: pendingItems.map(p => ({
                    ...p,
                    due_by: p.due_by ? new Date(p.due_by) : undefined,
                  })),
                  file_paths: args?.file_paths as string[] | undefined,
                  success_signal: args?.success_signal as string | undefined,
                  compression_strategy: args?.compression_strategy as string | undefined,
                });

                const duration = (Date.now() - startTime) / 1000;
                trackMcpToolCall('checkpoint', 'success', tenantId, duration);

                return {
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify({
                        success: true,
                        checkpoint: {
                          id: checkpoint.id,
                          session_id: checkpoint.session_id,
                          checkpoint_type: checkpoint.checkpoint_type,
                          token_count_before: checkpoint.token_count_before,
                          created_at: checkpoint.created_at,
                          lifeboat: checkpoint.lifeboat_snapshot,
                          decisions_count: checkpoint.decisions_snapshot.length,
                          pending_count: checkpoint.pending_snapshot.length,
                        }
                      }, null, 2)
                    }
                  ]
                };
              }

              case 'get': {
                const checkpoint = await getLatestCheckpoint(this.pool, tenantId, sessionId);

                const duration = (Date.now() - startTime) / 1000;
                trackMcpToolCall('checkpoint', 'success', tenantId, duration);

                return {
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify({
                        success: true,
                        checkpoint: checkpoint ? {
                          id: checkpoint.id,
                          session_id: checkpoint.session_id,
                          checkpoint_type: checkpoint.checkpoint_type,
                          token_count_before: checkpoint.token_count_before,
                          token_count_after: checkpoint.token_count_after,
                          created_at: checkpoint.created_at,
                          lifeboat: checkpoint.lifeboat_snapshot,
                          decisions_snapshot: checkpoint.decisions_snapshot,
                          pending_snapshot: checkpoint.pending_snapshot,
                          compression_strategy: checkpoint.compression_strategy,
                        } : null
                      }, null, 2)
                    }
                  ]
                };
              }

              case 'history': {
                const limit = (args?.limit as number) || 10;
                const history = await getCheckpointHistory(this.pool, tenantId, sessionId, limit);

                const duration = (Date.now() - startTime) / 1000;
                trackMcpToolCall('checkpoint', 'success', tenantId, duration);

                return {
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify({
                        success: true,
                        history: {
                          total_count: history.total_count,
                          compression_count: history.compression_count,
                          manual_count: history.manual_count,
                          checkpoints: history.checkpoints.map(c => ({
                            id: c.id,
                            checkpoint_type: c.checkpoint_type,
                            token_count_before: c.token_count_before,
                            token_count_after: c.token_count_after,
                            created_at: c.created_at,
                            lifeboat: c.lifeboat_snapshot,
                          })),
                        }
                      }, null, 2)
                    }
                  ]
                };
              }

              default:
                throw new Error(`Unknown checkpoint operation: ${operation}`);
            }
          }

          case 'context_monitor': {
            // REM-97: Context usage tracking and alerts
            const operation = args?.operation as string;
            const sessionId = args?.session_id as string;

            if (!operation) {
              throw new Error('operation is required');
            }
            if (!sessionId) {
              throw new Error('session_id is required');
            }

            switch (operation) {
              case 'monitor': {
                const currentUsage = args?.current_usage as Record<string, number>;
                if (!currentUsage || typeof currentUsage !== 'object') {
                  throw new Error('current_usage is required for monitor');
                }

                const result = await monitorContext(this.pool, tenantId, {
                  session_id: sessionId,
                  current_usage: currentUsage,
                  max_tokens: args?.max_tokens as number | undefined,
                  thresholds: args?.thresholds as number[] | undefined,
                  top_n: args?.top_n as number | undefined,
                  trend_window_hours: args?.trend_window_hours as number | undefined,
                });

                const duration = (Date.now() - startTime) / 1000;
                trackMcpToolCall('context_monitor', 'success', tenantId, duration);

                return {
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify({
                        success: true,
                        monitor: {
                          session_id: result.session_id,
                          timestamp: result.timestamp,
                          usage: {
                            total_tokens_used: result.total_tokens_used,
                            max_tokens: result.max_tokens,
                            utilization_percent: result.utilization_percent,
                            tokens_remaining: result.tokens_remaining,
                          },
                          breakdown: result.breakdown_by_category,
                          top_consumers: result.top_consumers,
                          alerts: result.alerts,
                          trend: result.usage_trend.slice(-10), // Last 10 data points
                          peak: {
                            usage: result.peak_usage,
                            time: result.peak_usage_time,
                          },
                          recommendations: {
                            should_checkpoint: result.should_checkpoint,
                            should_compress: result.should_compress,
                            estimated_time_to_full_minutes: result.estimated_time_to_full,
                          },
                        }
                      }, null, 2)
                    }
                  ]
                };
              }

              case 'state': {
                const state = await getSessionState(this.pool, tenantId, sessionId);

                const duration = (Date.now() - startTime) / 1000;
                trackMcpToolCall('context_monitor', 'success', tenantId, duration);

                return {
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify({
                        success: true,
                        state: state ? {
                          current_usage: state.current_usage,
                          peak_usage: state.peak_usage,
                          max_tokens: state.max_tokens,
                          session_state: state.session_state,
                          created_at: state.created_at,
                          updated_at: state.updated_at,
                        } : null
                      }, null, 2)
                    }
                  ]
                };
              }

              default:
                throw new Error(`Unknown context_monitor operation: ${operation}`);
            }
          }

          case 'budget': {
            // REM-100: Token budget management
            const operation = args?.operation as string;
            
            if (operation === 'set') {
              const budgetName = args?.budget_name as string;
              const totalTokens = args?.total_tokens as number;
              const allocations = args?.allocations as Record<string, number>;
              
              if (!budgetName || !totalTokens || !allocations) {
                throw new Error('budget_name, total_tokens, and allocations are required for set operation');
              }
              
              const budget = await setBudget(
                this.pool,
                tenantId,
                budgetName,
                totalTokens,
                allocations,
                {
                  thresholds: args?.thresholds as any,
                  compressionTriggerPercent: args?.compression_trigger_percent as number,
                }
              );
              
              const duration = (Date.now() - startTime) / 1000;
              trackMcpToolCall('budget', 'success', tenantId, duration);
              
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      success: true,
                      budget: {
                        budget_name: budget.budget_name,
                        total_tokens: budget.total_tokens,
                        allocations: budget.allocations,
                        thresholds: budget.thresholds,
                        compression_trigger_percent: budget.compression_trigger_percent,
                        is_active: budget.is_active,
                      }
                    }, null, 2)
                  }
                ]
              };
            }
            
            if (operation === 'check') {
              const budgetName = args?.budget_name as string;
              const currentUsage = args?.current_usage as Record<string, number>;
              
              if (!budgetName || !currentUsage) {
                throw new Error('budget_name and current_usage are required for check operation');
              }
              
              const result = await checkBudget(this.pool, tenantId, budgetName, currentUsage);
              
              const duration = (Date.now() - startTime) / 1000;
              trackMcpToolCall('budget', 'success', tenantId, duration);
              
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      success: true,
                      check: result,
                    }, null, 2)
                  }
                ]
              };
            }
            
            if (operation === 'list') {
              const activeOnly = args?.active_only !== false;  // Default: true
              const budgets = await listBudgets(this.pool, tenantId, activeOnly);
              
              const duration = (Date.now() - startTime) / 1000;
              trackMcpToolCall('budget', 'success', tenantId, duration);
              
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      success: true,
                      budget_count: budgets.length,
                      budgets: budgets.map(b => ({
                        budget_name: b.budget_name,
                        total_tokens: b.total_tokens,
                        allocations: b.allocations,
                        is_active: b.is_active,
                      }))
                    }, null, 2)
                  }
                ]
              };
            }
            
            if (operation === 'apply_template') {
              const budgetName = args?.budget_name as string;
              const template = args?.template as keyof typeof BUDGET_TEMPLATES;
              
              if (!budgetName || !template) {
                throw new Error('budget_name and template are required for apply_template operation');
              }
              
              const budget = await applyBudgetTemplate(
                this.pool,
                tenantId,
                budgetName,
                template,
                {
                  totalTokens: args?.custom_total_tokens as number,
                  allocationAdjustments: args?.allocation_adjustments as any,
                  thresholds: args?.thresholds as any,
                }
              );
              
              const duration = (Date.now() - startTime) / 1000;
              trackMcpToolCall('budget', 'success', tenantId, duration);
              
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      success: true,
                      budget: {
                        budget_name: budget.budget_name,
                        total_tokens: budget.total_tokens,
                        allocations: budget.allocations,
                        thresholds: budget.thresholds,
                        compression_trigger_percent: budget.compression_trigger_percent,
                        template_applied: template,
                        template_description: BUDGET_TEMPLATES[template].description,
                      }
                    }, null, 2)
                  }
                ]
              };
            }
            
            throw new Error(`Unknown budget operation: ${operation}`);
          }

          case 'get_context_insights': {
            const authContext = { tenant_id: tenantId, project_id: projectId };
            
            // Check if we should regenerate
            const shouldRegenerate = args?.regenerate as boolean;
            
            let insights = await compilationService.getContextInsights(
              args?.context_id as string,
              authContext
            );

            if (shouldRegenerate || insights.length === 0) {
              insights = await compilationService.generateInsights(
                args?.context_id as string,
                authContext
              );
            }
            const duration = (Date.now() - startTime) / 1000;

            trackMcpToolCall('get_context_insights', 'success', tenantId, duration);

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: true,
                    insight_count: insights.length,
                    insights: insights.map(i => ({
                      type: i.insight_type,
                      content: i.content,
                      metadata: i.metadata,
                      confidence: i.confidence,
                      created_at: i.created_at
                    }))
                  }, null, 2)
                }
              ]
            };
          }

          // Week 13: Context Intelligence Tools
          case 'classify_query_intent': {
            const intent = await memoryService.classifyQueryIntent({
              query: args?.query as string,
              recent_categories: args?.recent_categories as string[],
              project_domain: args?.project_domain as string
            });
            const duration = (Date.now() - startTime) / 1000;

            trackMcpToolCall('classify_query_intent', 'success', tenantId, duration);

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: true,
                    intent: {
                      primary_category: intent.primary_category,
                      confidence: intent.confidence,
                      suggested_categories: intent.suggested_categories,
                      intent_type: intent.intent_type,
                      reasoning: intent.reasoning
                    }
                  }, null, 2)
                }
              ]
            };
          }

          // REM-99: ContextPilot Smart Compression
          case 'compression': {
            const operation = args?.operation as string;
            
            if (operation === 'compress') {
              const result = await compressContent(
                args?.content as string,
                args?.source as 'user' | 'agent',
                {
                  compression_ratios: args?.compression_ratios as any,
                  agent_compression_multiplier: args?.agent_compression_multiplier as number,
                  target_ratio: args?.target_ratio as number
                }
              );
              const duration = (Date.now() - startTime) / 1000;
              trackMcpToolCall('compression', 'success', tenantId, duration);

              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      success: true,
                      result: {
                        original_tokens: result.original_tokens,
                        compressed_tokens: result.compressed_tokens,
                        compression_ratio: result.compression_ratio,
                        compressed_content: result.compressed_content,
                        blocks_compressed: result.blocks_compressed,
                        blocks_preserved: result.blocks_preserved,
                        preserved_decisions: result.preserved_decisions
                      }
                    }, null, 2)
                  }
                ]
              };
            } else if (operation === 'preview') {
              const preview = await previewCompression(
                args?.content as string,
                args?.source as 'user' | 'agent',
                {
                  compression_ratios: args?.compression_ratios as any,
                  agent_compression_multiplier: args?.agent_compression_multiplier as number,
                  target_ratio: args?.target_ratio as number
                }
              );
              const duration = (Date.now() - startTime) / 1000;
              trackMcpToolCall('compression', 'success', tenantId, duration);

              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      success: true,
                      preview: {
                        original_tokens: (preview as any).original_tokens,
                        estimated_compressed_tokens: (preview as any).estimated_compressed_tokens,
                        blocks: (preview as any).blocks?.map((b: any) => ({
                          importance: b.importance,
                          source: (b as any).source,
                          tokens: (b as any).tokens,
                          will_be_compressed: b.will_be_compressed
                        }))
                      }
                    }, null, 2)
                  }
                ]
              };
            } else {
              return {
                content: [{
                  type: 'text',
                  text: JSON.stringify({
                    success: false,
                    error: `Unknown compression operation: ${operation}`
                  }, null, 2)
                }],
                isError: true
              };
            }
          }

          case 'infer_memory_relationships': {
            const relationships = await memoryService.inferMemoryRelationships(
              args?.memory_id as string,
              args?.min_confidence as number || 0.6
            );
            const duration = (Date.now() - startTime) / 1000;

            trackMcpToolCall('infer_memory_relationships', 'success', tenantId, duration);

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: true,
                    relationships: relationships.map(r => ({
                      source_memory_id: r.source_memory_id,
                      target_memory_id: r.target_memory_id,
                      relationship_type: r.relationship_type,
                      confidence: r.confidence,
                      evidence: r.evidence,
                      similarity_score: r.similarity_score
                    }))
                  }, null, 2)
                }
              ]
            };
          }

          // REM-271: Traverse the relationship graph starting from a specific memory.
          // Uses a recursive CTE with cycle detection for safe multi-hop traversal.
          case 'explore_relationships': {
            const startMemoryId = args?.memory_id as string;
            if (!startMemoryId) {
              return {
                content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'memory_id is required for explore operation' }) }],
                isError: true
              };
            }

            const maxDepth = Math.min(Math.max(1, (args?.depth as number) || 2), 3);
            const minConfidence = (args?.min_confidence as number) ?? 0.5;
            const filterTypes = args?.relationship_types as string[] | undefined;

            const client = await this.pool.connect();
            try {
              await client.query('SELECT set_config($1, $2, true)', ['app.current_tenant', tenantId]);

              // Recursive CTE: BFS traversal up to maxDepth hops with cycle detection.
              // node_id = current node, depth = distance from start, path = visited IDs.
              const traversalQuery = `
                WITH RECURSIVE graph_traversal(node_id, depth, path) AS (
                  -- Base: seed with the starting memory
                  SELECT $1::uuid, 0, ARRAY[$1::uuid]

                  UNION ALL

                  -- Recursive: follow relationship edges outward
                  SELECT
                    CASE
                      WHEN mr.source_memory_id = gt.node_id THEN mr.target_memory_id
                      ELSE mr.source_memory_id
                    END AS node_id,
                    gt.depth + 1,
                    gt.path || CASE
                      WHEN mr.source_memory_id = gt.node_id THEN mr.target_memory_id
                      ELSE mr.source_memory_id
                    END
                  FROM graph_traversal gt
                  JOIN memory_relationships mr
                    ON (mr.source_memory_id = gt.node_id OR mr.target_memory_id = gt.node_id)
                  WHERE gt.depth < $2
                    -- Cycle detection: don't revisit nodes already in path
                    AND NOT (
                      CASE WHEN mr.source_memory_id = gt.node_id
                           THEN mr.target_memory_id
                           ELSE mr.source_memory_id
                      END = ANY(gt.path)
                    )
                    AND mr.confidence >= $3
                    ${filterTypes && filterTypes.length > 0 ? 'AND mr.relationship_type = ANY($5)' : ''}
                ),
                -- Deduplicate: keep each node at its minimum depth
                closest AS (
                  SELECT node_id, MIN(depth) AS depth
                  FROM graph_traversal
                  WHERE depth > 0
                  GROUP BY node_id
                )
                SELECT
                  m.id,
                  m.content,
                  m.category,
                  m.created_at,
                  c.depth,
                  mr.relationship_type,
                  mr.confidence,
                  mr.evidence,
                  CASE WHEN mr.source_memory_id = m.id THEN mr.target_memory_id
                       ELSE mr.source_memory_id END AS connected_to
                FROM closest c
                JOIN memories m ON m.id = c.node_id AND m.tenant_id = $4
                -- Re-join relationships to get edge details for the closest path
                LEFT JOIN LATERAL (
                  SELECT mr2.relationship_type, mr2.confidence, mr2.evidence,
                         mr2.source_memory_id, mr2.target_memory_id
                  FROM memory_relationships mr2
                  WHERE (mr2.source_memory_id = c.node_id OR mr2.target_memory_id = c.node_id)
                    AND mr2.confidence >= $3
                    ${filterTypes && filterTypes.length > 0 ? 'AND mr2.relationship_type = ANY($5)' : ''}
                  ORDER BY mr2.confidence DESC
                  LIMIT 1
                ) mr ON true
                ORDER BY c.depth ASC, mr.confidence DESC
                LIMIT 200
              `;

              const queryParams: any[] = [startMemoryId, maxDepth, minConfidence, tenantId];
              if (filterTypes && filterTypes.length > 0) queryParams.push(filterTypes);

              // Fetch starting memory details
              const startResult = await client.query(
                'SELECT id, content, category, created_at FROM memories WHERE id = $1 AND tenant_id = $2',
                [startMemoryId, tenantId]
              );

              if (startResult.rows.length === 0) {
                return {
                  content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Starting memory not found or access denied' }) }],
                  isError: true
                };
              }

              const neighborResult = await client.query(traversalQuery, queryParams);
              const duration = (Date.now() - startTime) / 1000;

              trackMcpToolCall('explore_relationships', 'success', tenantId, duration);

              // Group results by depth for easy agent consumption
              const byDepth: Record<number, any[]> = {};
              for (const row of neighborResult.rows) {
                const d = row.depth;
                if (!byDepth[d]) byDepth[d] = [];
                byDepth[d].push({
                  id: row.id,
                  content: row.content,
                  category: row.category,
                  created_at: row.created_at,
                  relationship_type: row.relationship_type,
                  confidence: row.confidence ? parseFloat(row.confidence) : null,
                  evidence: row.evidence
                });
              }

              // RAD-52: pagination metadata on relationship traversal
              const exploreResponse = addPaginationToResponse({
                items: neighborResult.rows,
                startTime,
                relatedTools: ['get_memory_graph', 'infer_memory_relationships']
              });
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      ...exploreResponse,
                      start_memory: startResult.rows[0],
                      max_depth: maxDepth,
                      min_confidence: minConfidence,
                      by_depth: byDepth
                    }, null, 2)
                  }
                ]
              };
            } finally {
              client.release();
            }
          }

          case 'enhanced_search': {
            const enhancedLimit = (args?.limit as number) || 10;
            const results = await memoryService.enhancedSearch({
              query: args?.query as string,
              enable_intent_classification: (args?.enable_intent_classification as boolean) ?? true,
              enable_relationship_expansion: (args?.enable_relationship_expansion as boolean) ?? false,
              domain_context: args?.domain_context as string,
              limit: enhancedLimit
            });
            const duration = (Date.now() - startTime) / 1000;

            trackMcpToolCall('enhanced_search', 'success', tenantId, duration);

            // RAD-52: pagination metadata
            const enhancedResponse = addPaginationToResponse({
              items: results.memories,
              limit: enhancedLimit,
              startTime,
              suggestedFilters: results.memories.length >= enhancedLimit
                ? ['Add category filter', 'Increase min_similarity', 'Try phrase search mode']
                : undefined,
              relatedTools: ['search_memory', 'get_memory_insights']
            });
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    ...enhancedResponse,
                    intent_classification: results.intent,
                    domain_context: results.domain_context,
                    relationship_expansion: results.relationship_expansion
                  }, null, 2)
                }
              ]
            };
          }

          case 'get_memory_insights': {
            const validTypes = ['patterns', 'relationships', 'usage', 'categories', 'domains'];
            const analysisType = (args?.analysis_type as string) || 'patterns';
            if (!validTypes.includes(analysisType)) {
              return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: `Invalid analysis_type: "${analysisType}". Valid types: ${validTypes.join(', ')}` }) }] };
            }
            const insights = await memoryService.getMemoryInsights(
              analysisType,
              args?.time_range_days as number || 30
            );
            const duration = (Date.now() - startTime) / 1000;

            trackMcpToolCall('get_memory_insights', 'success', tenantId, duration);

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: true,
                    analysis_type: analysisType,
                    time_range_days: args?.time_range_days || 30,
                    insights
                  }, null, 2)
                }
              ]
            };
          }

          // Week 14: Advanced Analytics Tool Handlers
          case 'detect_memory_contradictions': {
            // Read pre-detected contradictions from DB (stored during memory ingestion)
            // instead of triggering expensive live LLM analysis
            const minConfidence = args?.min_confidence as number || 0.7;
            const contextId = args?.context_id as string;

            let contradictionQuery: string;
            let contradictionParams: any[];

            if (contextId) {
              // Scoped to a context: get contradictions for memories in that context
              contradictionQuery = `
                SELECT mr.source_memory_id, mr.target_memory_id, mr.confidence, mr.evidence,
                       ms.content as source_content, mt.content as target_content,
                       ms.category as source_category, mt.category as target_category
                FROM memory_relationships mr
                JOIN memories ms ON mr.source_memory_id = ms.id
                JOIN memories mt ON mr.target_memory_id = mt.id
                JOIN context_memories cm ON (cm.memory_id = mr.source_memory_id OR cm.memory_id = mr.target_memory_id)
                WHERE mr.relationship_type = 'contradicts'
                  AND mr.confidence >= $1
                  AND cm.context_id = $2
                  AND ms.tenant_id = $3
                ORDER BY mr.confidence DESC
              `;
              contradictionParams = [minConfidence, contextId, tenantId];
            } else {
              // All contradictions for this tenant
              contradictionQuery = `
                SELECT mr.source_memory_id, mr.target_memory_id, mr.confidence, mr.evidence,
                       ms.content as source_content, mt.content as target_content,
                       ms.category as source_category, mt.category as target_category
                FROM memory_relationships mr
                JOIN memories ms ON mr.source_memory_id = ms.id
                JOIN memories mt ON mr.target_memory_id = mt.id
                WHERE mr.relationship_type = 'contradicts'
                  AND mr.confidence >= $1
                  AND ms.tenant_id = $2
                ORDER BY mr.confidence DESC
                LIMIT 50
              `;
              contradictionParams = [minConfidence, tenantId];
            }

            const contradictionResult = await this.pool.query(contradictionQuery, contradictionParams);
            const contradictions = contradictionResult.rows.map((row: any) => ({
              memory_a: {
                id: row.source_memory_id,
                content: row.source_content,
                category: row.source_category
              },
              memory_b: {
                id: row.target_memory_id,
                content: row.target_content,
                category: row.target_category
              },
              confidence: row.confidence,
              evidence: (() => {
                if (!row.evidence) return null;
                if (typeof row.evidence === 'object') return row.evidence;
                try { return JSON.parse(row.evidence); } catch { return row.evidence; }
              })()
            }));

            const duration = (Date.now() - startTime) / 1000;
            trackMcpToolCall('detect_memory_contradictions', 'success', tenantId, duration);

            // Render interactive Contradiction Detection Dashboard (UI for MCP clients)
            const dashboardHtml = renderContradictionDashboard({
              contradictions: contradictions.map(c => ({
                memory_a: {
                  id: c.memory_a.id,
                  content: c.memory_a.content,
                  category: c.memory_a.category,
                  created_at: new Date(),
                },
                memory_b: {
                  id: c.memory_b.id,
                  content: c.memory_b.content,
                  category: c.memory_b.category,
                  created_at: new Date(),
                },
                contradiction_type: (
                  (c.evidence as any)?.type as 'factual' | 'temporal' | 'logical' | 'preference'
                ) || 'factual',
                confidence: c.confidence,
                explanation: (c.evidence as any)?.explanation ||
                  `Contradiction detected with ${(c.confidence * 100).toFixed(0)}% confidence`,
                severity: c.confidence >= 0.9 ? 'high' : c.confidence >= 0.7 ? 'medium' : 'low',
                resolution_suggestions: (c.evidence as any)?.suggestions || [
                  'Review both memories and keep the more recent one',
                  'Merge if both contain valid information',
                ],
              })),
            });

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: true,
                    context_id: contextId || null,
                    min_confidence: minConfidence,
                    contradictions_found: contradictions.length,
                    contradictions,
                    note: 'Contradictions are detected automatically during memory ingestion. This tool returns pre-computed results.'
                  }, null, 2)
                },
                {
                  type: 'text',
                  text: dashboardHtml,
                  mimeType: 'text/html'
                }
              ]
            };
          }

          case 'generate_context_graph': {
            trackMcpToolCall('generate_context_graph', 'success');

            const graph = await analyticsService.generateContextGraph(
              tenantId,
              args?.context_id as string,
              args?.include_relationships !== false
            );

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: true,
                    context_id: args?.context_id,
                    graph_metrics: graph.metrics,
                    graph
                  }, null, 2)
                }
              ]
            };
          }

          case 'generate_memory_insights': {
            trackMcpToolCall('generate_memory_insights', 'success');

            const insights = await analyticsService.generateInsights(
              tenantId,
              args?.time_range_days as number || 30,
              projectId
            );

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: true,
                    time_range_days: args?.time_range_days || 30,
                    insights_found: insights.length,
                    insights
                  }, null, 2)
                }
              ]
            };
          }

          case 'get_predictive_analytics': {
            trackMcpToolCall('get_predictive_analytics', 'success');

            const analytics = await analyticsService.generatePredictiveAnalytics(
              tenantId,
              projectId
            );

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: true,
                    prediction_horizon_days: args?.prediction_horizon_days || 30,
                    analytics
                  }, null, 2)
                }
              ]
            };
          }

          case 'set_memory_visibility': {
            const memoryId = args?.memory_id as string;
            const visibility = args?.visibility as string;
            
            const result = await this.pool.query(`
              UPDATE memories SET visibility = $1 WHERE id = $2 AND tenant_id = $3
              RETURNING id, content, visibility, user_id
            `, [visibility, memoryId, tenantId]);
            const duration = (Date.now() - startTime) / 1000;
            
            if (result.rows.length === 0) {
              trackMcpToolCall('set_memory_visibility', 'error', tenantId, duration);
              trackMcpToolError('set_memory_visibility', 'not_found', tenantId);
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      success: false,
                      error: 'Memory not found'
                    }, null, 2)
                  }
                ],
                isError: true
              };
            }
            
            trackMcpToolCall('set_memory_visibility', 'success', tenantId, duration);
            
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: true,
                    memory: {
                      id: result.rows[0].id,
                      visibility: result.rows[0].visibility,
                      content: result.rows[0].content.substring(0, 100) + '...'
                    }
                  }, null, 2)
                }
              ]
            };
          }

          case 'list_personal_memories': {
            // Note: API key auth doesn't have user context, so we list shared/project memories instead
            // For true personal memories, use OAuth authentication which provides user_id
            const limit = (args?.limit as number) || 50;
            const category = args?.category as string;
            
            let query = `
              SELECT id, content, category, metadata, created_at, updated_at
              FROM memories 
              WHERE tenant_id = $1 AND visibility IN ('shared', 'project')
            `;
            let params: (string | number)[] = [tenantId];
            
            if (category) {
              query += ` AND category = $2`;
              params.push(category);
            }
            
            query += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
            params.push(limit);
            
            const result = await this.pool.query(query, params);
            const duration = (Date.now() - startTime) / 1000;
            
            trackMcpToolCall('list_personal_memories', 'success', tenantId, duration);
            
            // Format with pagination metadata (REM-38)
            const responseData = addPaginationToResponse({
              items: result.rows,
              limit,
              startTime,
              suggestedFilters: result.rows.length === limit ? ['Add category filter'] : undefined
            });

            // Add note about OAuth requirement for personal memories
            const finalResponse = {
              ...responseData,
              note: 'API key auth shows shared/project memories. Use OAuth for personal memories.'
            };
            
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(finalResponse, null, 2)
                }
              ]
            };
          }

          // Causal Reasoning Cases
          case 'trace_causality': {
            const memoryId = args?.memory_id as string;
            const direction = (args?.direction as 'causes' | 'caused_by') || 'causes';
            const maxDepth = (args?.max_depth as number) || 5;

            const chain = await causalService.traceCausalChain(
              tenantId,
              memoryId,
              direction,
              maxDepth,
              projectId
            );

            trackMcpToolCall('trace_causality', 'success');

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: true,
                    chain,
                    summary: `Found ${chain.total_links} causal links with max depth ${chain.depth}`
                  }, null, 2)
                }
              ]
            };
          }

          case 'infer_causality': {
            const causeMemoryId = args?.cause_memory_id as string;
            const effectMemoryId = args?.effect_memory_id as string;

            const link = await causalService.inferCausality(
              tenantId,
              causeMemoryId,
              effectMemoryId,
              projectId
            );

            trackMcpToolCall('infer_causality', 'success');

            if (link) {
              // Log to audit
              await this.auditLogger.log({
                tenantId,
                eventType: 'causality.inferred',
                resourceType: 'causal_link',
                resourceId: link.id,
                actionResult: 'success',
                metadata: {
                  cause_memory_id: causeMemoryId,
                  effect_memory_id: effectMemoryId,
                  causal_type: link.causal_type,
                  strength: link.causal_strength
                }
              });

              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      success: true,
                      link,
                      message: `Inferred ${link.causal_type} relationship (strength: ${link.causal_strength})`
                    }, null, 2)
                  }
                ]
              };
            } else {
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      success: false,
                      message: 'No significant causal relationship detected'
                    }, null, 2)
                  }
                ]
              };
            }
          }

          case 'get_causal_links': {
            const memoryId = args?.memory_id as string;
            const direction = args?.direction as 'causes' | 'caused_by' | undefined;

            const links = await causalService.getCausalLinks(
              tenantId,
              memoryId,
              direction,
              projectId
            );

            trackMcpToolCall('get_causal_links', 'success');

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: true,
                    count: links.length,
                    links
                  }, null, 2)
                }
              ]
            };
          }

          case 'validate_causal_link': {
            const linkId = args?.link_id as string;
            const isValid = args?.is_valid as boolean;

            await causalService.validateCausalLink(tenantId, linkId, isValid, projectId);

            trackMcpToolCall('validate_causal_link', 'success');

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: true,
                    message: `Causal link marked as ${isValid ? 'valid' : 'invalid'}`
                  }, null, 2)
                }
              ]
            };
          }

          // Temporal Query Cases
          case 'search_at_time': {
            const query = args?.query as string;
            // Accept both 'as_of_time' and 'timestamp' for flexibility
            const rawTime = (args?.as_of_time || args?.timestamp) as string;
            if (!rawTime) {
              return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'as_of_time is required (ISO 8601 format, e.g. "2026-01-15T10:30:00Z")' }) }] };
            }
            const asOfTime = new Date(rawTime);
            if (isNaN(asOfTime.getTime())) {
              return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: `Invalid timestamp: "${rawTime}". Use ISO 8601 format (e.g. "2026-01-15T10:30:00Z")` }) }] };
            }
            const category = args?.category as string;
            const limit = (args?.limit as number) || 10;

            // Get embedding for query
            let embedding: number[] | undefined;
            if (this.embeddingProvider) {
              embedding = await this.embeddingProvider.generateEmbedding(query);
            }

            const results = await temporalService.searchAtTime(
              tenantId,
              query,
              asOfTime,
              {
                embedding: embedding || [],
                projectId,
                category,
                limit
              }
            );

            trackMcpToolCall('search_at_time', 'success');

            // Format with pagination metadata (REM-38)
            const responseData = addPaginationToResponse({
              items: results,
              limit,
              startTime,
              suggestedFilters: results.length === limit ? ['Add category filter', 'Adjust time range'] : undefined
            });

            // Add as_of_time to response
            const finalResponse = {
              ...responseData,
              as_of_time: asOfTime.toISOString()
            };

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(finalResponse, null, 2)
                }
              ]
            };
          }

          case 'get_memory_history': {
            const memoryId = args?.memory_id as string;

            const history = await temporalService.getMemoryHistory(
              tenantId,
              memoryId,
              projectId
            );

            trackMcpToolCall('get_memory_history', 'success');

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: true,
                    memory_id: memoryId,
                    versions: history.length,
                    history
                  }, null, 2)
                }
              ]
            };
          }

          case 'create_temporal_snapshot': {
            // Accept both 'snapshot_name' and 'name' for flexibility
            const snapshotName = (args?.snapshot_name || args?.name) as string;
            if (!snapshotName) {
              return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'snapshot_name is required' }) }] };
            }
            const rawSnapTime = (args?.as_of_time || args?.timestamp) as string | undefined;
            let asOfTime: Date | undefined;
            if (rawSnapTime) {
              asOfTime = new Date(rawSnapTime);
              if (isNaN(asOfTime.getTime())) {
                return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: `Invalid timestamp: "${rawSnapTime}". Use ISO 8601 format.` }) }] };
              }
            }

            const snapshotId = await temporalService.createSnapshot(
              tenantId,
              snapshotName,
              asOfTime,
              projectId
            );

            trackMcpToolCall('create_temporal_snapshot', 'success');

            // Log to audit
            await this.auditLogger.log({
              tenantId,
              eventType: 'snapshot.created',
              resourceType: 'temporal_snapshot',
              resourceId: snapshotId,
              actionResult: 'success',
              metadata: { snapshot_name: snapshotName, as_of_time: asOfTime?.toISOString() }
            });

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: true,
                    snapshot_id: snapshotId,
                    snapshot_name: snapshotName
                  }, null, 2)
                }
              ]
            };
          }

          case 'list_temporal_snapshots': {
            const limit = (args?.limit as number) || 50;

            const snapshots = await temporalService.listSnapshots(tenantId, projectId, limit);

            trackMcpToolCall('list_temporal_snapshots', 'success');

            // Format with pagination metadata (REM-38)
            const responseData = addPaginationToResponse({
              items: snapshots,
              limit,
              startTime,
              suggestedFilters: snapshots.length === limit ? ['Adjust limit'] : undefined
            });

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(responseData, null, 2)
                }
              ]
            };
          }

          case 'compare_snapshots': {
            if (!args?.time_a || !args?.time_b) {
              return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Both time_a and time_b are required (ISO 8601 format)' }) }] };
            }
            const timeA = new Date(args.time_a as string);
            const timeB = new Date(args.time_b as string);
            if (isNaN(timeA.getTime()) || isNaN(timeB.getTime())) {
              return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: `Invalid timestamp(s). time_a="${args.time_a}", time_b="${args.time_b}". Use ISO 8601 format.` }) }] };
            }

            const diff = await temporalService.compareSnapshots(
              tenantId,
              timeA,
              timeB,
              projectId
            );

            trackMcpToolCall('compare_snapshots', 'success');

            const diffHtml = renderContextDiffViewer({
              timeA: diff.timeA,
              timeB: diff.timeB,
              added: diff.added,
              removed: diff.removed,
              modified: diff.modified,
              details: diff.details,
            });

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: true,
                    comparison: {
                      time_a: timeA.toISOString(),
                      time_b: timeB.toISOString(),
                      added: diff.added,
                      removed: diff.removed,
                      modified: diff.modified
                    },
                    details: diff.details
                  }, null, 2)
                },
                {
                  type: 'text',
                  text: diffHtml,
                  mimeType: 'text/html'
                }
              ]
            };
          }

          // Audit Logging Cases
          case 'query_audit_log': {
            const auditLimit = (args?.limit as number) || 100;
            const filters = {
              eventType: args?.event_type as string,
              startTime: args?.start_time ? new Date(args.start_time as string) : undefined,
              endTime: args?.end_time ? new Date(args.end_time as string) : undefined,
              resourceId: args?.resource_id as string,
              actionResult: args?.action_result as 'success' | 'failure' | 'denied',
              limit: auditLimit
            };

            const logs = await this.auditLogger.query(tenantId, filters);

            trackMcpToolCall('query_audit_log', 'success');

            // RAD-52: pagination metadata
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(addPaginationToResponse({
                    items: logs,
                    limit: auditLimit,
                    startTime,
                    suggestedFilters: logs.length >= auditLimit
                      ? ['Filter by event_type', 'Narrow date range with start_time/end_time', 'Filter by action_result']
                      : undefined,
                    relatedTools: ['get_audit_stats', 'generate_compliance_report']
                  }), null, 2)
                }
              ]
            };
          }

          case 'generate_compliance_report': {
            // Default to last 30 days if no dates provided
            const rawStart = args?.start_date as string;
            const rawEnd = args?.end_date as string;
            const endDate = rawEnd ? new Date(rawEnd) : new Date();
            const startDate = rawStart ? new Date(rawStart) : new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);
            if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
              return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Invalid date(s). Use ISO 8601 format.' }) }] };
            }

            const report = await this.auditLogger.generateComplianceReport(
              tenantId,
              startDate,
              endDate
            );

            trackMcpToolCall('generate_compliance_report', 'success');

            // Log report generation to audit
            await this.auditLogger.log({
              tenantId,
              eventType: 'report.generated',
              resourceType: 'compliance_report',
              actionResult: 'success',
              metadata: {
                report_period: report.reportPeriod,
                total_events: report.totalEvents,
                failure_rate: report.failureRate
              }
            });

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: true,
                    report
                  }, null, 2)
                }
              ]
            };
          }

          case 'get_audit_stats': {
            const startDate = args?.start_date ? new Date(args.start_date as string) : undefined;
            const endDate = args?.end_date ? new Date(args.end_date as string) : undefined;

            const stats = await this.auditLogger.getAuditStats(tenantId, startDate, endDate);

            trackMcpToolCall('get_audit_stats', 'success');

            // RAD-52: execution time metadata
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: true,
                    stats,
                    metadata: { execution_time_ms: Date.now() - startTime },
                    related_tools: ['query_audit_log', 'generate_compliance_report']
                  }, null, 2)
                }
              ]
            };
          }

          // ──────────────────────────────────────────────
          // REM-30: Audit Monitoring
          // ──────────────────────────────────────────────

          case 'audit_health': {
            const monSvc = new AuditMonitoringService(this.pool);
            const health = await monSvc.getHealthStatus(tenantId);
            trackMcpToolCall('audit_health', 'success', tenantId, (Date.now() - startTime) / 1000);
            return { content: [{ type: 'text', text: JSON.stringify({ success: true, ...health }, null, 2) }] };
          }

          case 'audit_metrics': {
            const windowSec = typeof args?.window_seconds === 'number' ? args.window_seconds : 300;
            const monSvc = new AuditMonitoringService(this.pool);
            const metrics = await monSvc.getMetrics(tenantId, windowSec);
            trackMcpToolCall('audit_metrics', 'success', tenantId, (Date.now() - startTime) / 1000);
            return { content: [{ type: 'text', text: JSON.stringify({ success: true, ...metrics }, null, 2) }] };
          }

          case 'audit_evaluate_thresholds': {
            const monSvc = new AuditMonitoringService(this.pool);
            const alerts = await monSvc.evaluateThresholds(tenantId, DEFAULT_THRESHOLDS);
            trackMcpToolCall('audit_evaluate_thresholds', 'success', tenantId, (Date.now() - startTime) / 1000);
            return { content: [{ type: 'text', text: JSON.stringify({ success: true, fired_alerts: alerts, count: alerts.length }, null, 2) }] };
          }

          case 'audit_alerts': {
            const monSvc = new AuditMonitoringService(this.pool);
            const op = (args?.operation as string) || 'active';
            if (op === 'active') {
              const active = await monSvc.getActiveAlerts(tenantId);
              trackMcpToolCall('audit_alerts', 'success', tenantId, (Date.now() - startTime) / 1000);
              return { content: [{ type: 'text', text: JSON.stringify({ success: true, alerts: active, count: active.length }, null, 2) }] };
            } else if (op === 'history') {
              const limit = typeof args?.limit === 'number' ? args.limit : 50;
              const history = await monSvc.getAlertHistory(tenantId, limit);
              trackMcpToolCall('audit_alerts', 'success', tenantId, (Date.now() - startTime) / 1000);
              return { content: [{ type: 'text', text: JSON.stringify({ success: true, alerts: history, count: history.length }, null, 2) }] };
            } else if (op === 'acknowledge') {
              const alertId = args?.alert_id as string;
              if (!alertId) return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'alert_id is required' }) }], isError: true };
              const ok = await monSvc.acknowledgeAlert(tenantId, alertId);
              trackMcpToolCall('audit_alerts', 'success', tenantId, (Date.now() - startTime) / 1000);
              return { content: [{ type: 'text', text: JSON.stringify({ success: ok, alert_id: alertId, status: ok ? 'acknowledged' : 'not_found' }, null, 2) }] };
            } else if (op === 'resolve') {
              const alertId = args?.alert_id as string;
              if (!alertId) return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'alert_id is required' }) }], isError: true };
              const ok = await monSvc.resolveAlert(tenantId, alertId);
              trackMcpToolCall('audit_alerts', 'success', tenantId, (Date.now() - startTime) / 1000);
              return { content: [{ type: 'text', text: JSON.stringify({ success: ok, alert_id: alertId, status: ok ? 'resolved' : 'not_found' }, null, 2) }] };
            }
            return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: `Unknown operation: ${op}` }) }], isError: true };
          }

          case 'audit_anomaly_detect': {
            const monSvc = new AuditMonitoringService(this.pool);
            const anomaly = await monSvc.detectAnomalies(tenantId);
            trackMcpToolCall('audit_anomaly_detect', 'success', tenantId, (Date.now() - startTime) / 1000);
            return { content: [{ type: 'text', text: JSON.stringify({ success: true, ...anomaly }, null, 2) }] };
          }

          case 'audit_metrics_prometheus': {
            const monSvc = new AuditMonitoringService(this.pool);
            const promText = await monSvc.exportPrometheusMetrics(tenantId);
            trackMcpToolCall('audit_metrics_prometheus', 'success', tenantId, (Date.now() - startTime) / 1000);
            return { content: [{ type: 'text', text: promText }] };
          }

          case 'pii': {
            const { piiDetector } = await import('./pii-detector.js');
            const { getPIICapabilities, clampSensitivity, assertPIIOperationAllowed, checkPIIScanQuota } = await import('./pii-plan-limits.js');
            const operation = args?.operation as string;

            // Resolve tenant plan for capability gating (RAD-35)
            const tenantPlanInfo = await this.db.getTenantPlan(tenantId);
            const tenantPlan = tenantPlanInfo?.plan || 'free';
            const piiCaps = getPIICapabilities(tenantPlan);

            // Clamp sensitivity to plan maximum (free capped at 'medium')
            const requestedSensitivity = (args?.sensitivity as 'low' | 'medium' | 'high') || 'medium';
            const sensitivity = clampSensitivity(requestedSensitivity, tenantPlan);

            const redactionMode = (args?.redaction_mode as 'mask' | 'hash' | 'remove') || 'mask';

            switch (operation) {
              case 'detect': {
                const text = args?.text as string;
                if (!text) {
                  throw new Error('text is required for detect operation');
                }
                // RAD-35: enforce monthly PII scan quota
                const detectQuota = await checkPIIScanQuota(tenantId, tenantPlan);
                if (!detectQuota.allowed) {
                  return {
                    content: [{
                      type: 'text',
                      text: JSON.stringify({
                        success: false,
                        error: `Monthly PII scan limit reached (${detectQuota.count}/${detectQuota.limit}). ` +
                               `Quota resets ${detectQuota.resetsAt}. Upgrade your plan for more scans.`,
                        error_type: 'quota_exceeded',
                        quota: { count: detectQuota.count, limit: detectQuota.limit, resets_at: detectQuota.resetsAt }
                      }, null, 2)
                    }],
                    isError: true
                  };
                }
                const result = piiDetector.detectPII(text, sensitivity);
                trackMcpToolCall('pii', 'success', tenantId, (Date.now() - startTime) / 1000);
                return {
                  content: [{
                    type: 'text',
                    text: JSON.stringify({
                      success: true, operation: 'detect', plan_tier: tenantPlan,
                      effective_sensitivity: sensitivity,
                      quota: { count: detectQuota.count, limit: detectQuota.limit === -1 ? 'unlimited' : detectQuota.limit, remaining: detectQuota.remaining === -1 ? 'unlimited' : detectQuota.remaining },
                      ...result
                    }, null, 2)
                  }]
                };
              }

              case 'redact': {
                const text = args?.text as string;
                if (!text) {
                  throw new Error('text is required for redact operation');
                }
                // RAD-35: enforce monthly PII scan quota
                const redactQuota = await checkPIIScanQuota(tenantId, tenantPlan);
                if (!redactQuota.allowed) {
                  return {
                    content: [{
                      type: 'text',
                      text: JSON.stringify({
                        success: false,
                        error: `Monthly PII scan limit reached (${redactQuota.count}/${redactQuota.limit}). ` +
                               `Quota resets ${redactQuota.resetsAt}. Upgrade your plan for more scans.`,
                        error_type: 'quota_exceeded',
                        quota: { count: redactQuota.count, limit: redactQuota.limit, resets_at: redactQuota.resetsAt }
                      }, null, 2)
                    }],
                    isError: true
                  };
                }
                const result = piiDetector.detectAndRedact(text, redactionMode, sensitivity);
                trackMcpToolCall('pii', 'success', tenantId, (Date.now() - startTime) / 1000);
                return {
                  content: [{
                    type: 'text',
                    text: JSON.stringify({ success: true, operation: 'redact', ...result }, null, 2)
                  }]
                };
              }

              case 'audit': {
                const memoryId = args?.memory_id as string;
                const limit = (args?.limit as number) || 100;
                const client = await this.pool.connect();
                try {
                  await client.query('SELECT set_config($1, $2, true)', ['app.current_tenant', tenantId]);
                  const result = await client.query(
                    `SELECT * FROM pii_access_logs 
                     WHERE tenant_id = $1 
                     ${memoryId ? 'AND memory_id = $2' : ''} 
                     ORDER BY accessed_at DESC LIMIT $${memoryId ? '3' : '2'}`,
                    memoryId ? [tenantId, memoryId, limit] : [tenantId, limit]
                  );
                  trackMcpToolCall('pii', 'success', tenantId, (Date.now() - startTime) / 1000);
                  return {
                    content: [{
                      type: 'text',
                      text: JSON.stringify({ success: true, operation: 'audit', logs: result.rows, count: result.rowCount }, null, 2)
                    }]
                  };
                } finally {
                  client.release();
                }
              }

              case 'compliance_report': {
                // Gate compliance_report by plan (REM-51)
                assertPIIOperationAllowed('compliance_report', tenantPlan);
                const startDateStr = args?.start_date as string;
                const endDateStr = args?.end_date as string;
                const client = await this.pool.connect();
                try {
                  await client.query('SELECT set_config($1, $2, true)', ['app.current_tenant', tenantId]);
                  
                  // Get PII statistics
                  const piiStats = await client.query(
                    `SELECT 
                       COUNT(*) as total_memories,
                       COUNT(*) FILTER (WHERE pii_detected = true) as pii_flagged,
                       array_agg(DISTINCT unnest(pii_types)) as pii_types_found
                     FROM memories 
                     WHERE tenant_id = $1
                       ${startDateStr ? "AND created_at >= $2" : ''}
                       ${endDateStr ? `AND created_at <= $${startDateStr ? '3' : '2'}` : ''}`,
                    [tenantId, startDateStr, endDateStr].filter(Boolean)
                  );
                  
                  // Get access log stats
                  const accessStats = await client.query(
                    `SELECT action, COUNT(*) as count
                     FROM pii_access_logs 
                     WHERE tenant_id = $1
                       ${startDateStr ? "AND accessed_at >= $2" : ''}
                       ${endDateStr ? `AND accessed_at <= $${startDateStr ? '3' : '2'}` : ''}
                     GROUP BY action`,
                    [tenantId, startDateStr, endDateStr].filter(Boolean)
                  );

                  trackMcpToolCall('pii', 'success', tenantId, (Date.now() - startTime) / 1000);
                  return {
                    content: [{
                      type: 'text',
                      text: JSON.stringify({
                        success: true,
                        operation: 'compliance_report',
                        plan_tier: tenantPlan,
                        report_frequency: piiCaps.complianceFrequency,
                        report: {
                          period: { start: startDateStr || 'all time', end: endDateStr || 'now' },
                          memories: piiStats.rows[0],
                          access_logs: accessStats.rows,
                          generated_at: new Date().toISOString()
                        }
                      }, null, 2)
                    }]
                  };
                } finally {
                  client.release();
                }
              }

              case 'batch_scan': {
                // Gate batch_scan by plan (RAD-35 / REM-51)
                assertPIIOperationAllowed('batch_scan', tenantPlan);
                const limit = (args?.limit as number) || 100;
                const client = await this.pool.connect();
                try {
                  await client.query('SELECT set_config($1, $2, true)', ['app.current_tenant', tenantId]);
                  
                  // Get unscanned memories
                  const memories = await client.query(
                    `SELECT id, content FROM memories 
                     WHERE tenant_id = $1 AND pii_scanned_at IS NULL 
                     LIMIT $2`,
                    [tenantId, limit]
                  );

                  // RAD-35: enforce monthly scan quota for the entire batch upfront
                  if (memories.rows.length > 0) {
                    const batchQuota = await checkPIIScanQuota(tenantId, tenantPlan, memories.rows.length);
                    if (!batchQuota.allowed) {
                      return {
                        content: [{
                          type: 'text',
                          text: JSON.stringify({
                            success: false,
                            error: `Monthly PII scan limit would be exceeded by this batch. ` +
                                   `Current: ${batchQuota.count}/${batchQuota.limit}, batch needs ${memories.rows.length}. ` +
                                   `Quota resets ${batchQuota.resetsAt}.`,
                            error_type: 'quota_exceeded',
                            quota: { count: batchQuota.count, limit: batchQuota.limit, resets_at: batchQuota.resetsAt, batch_size: memories.rows.length }
                          }, null, 2)
                        }],
                        isError: true
                      };
                    }
                  }
                  
                  let scanned = 0;
                  let piiFound = 0;
                  
                  for (const memory of memories.rows) {
                    const result = piiDetector.detectPII(memory.content, sensitivity);
                    await client.query(
                      `UPDATE memories SET 
                         pii_detected = $1, 
                         pii_types = $2, 
                         pii_confidence = $3, 
                         pii_scanned_at = NOW() 
                       WHERE id = $4`,
                      [result.hasPII, result.types, result.confidence, memory.id]
                    );
                    scanned++;
                    if (result.hasPII) piiFound++;
                  }

                  trackMcpToolCall('pii', 'success', tenantId, (Date.now() - startTime) / 1000);
                  return {
                    content: [{
                      type: 'text',
                      text: JSON.stringify({
                        success: true,
                        operation: 'batch_scan',
                        scanned,
                        pii_found: piiFound,
                        remaining: memories.rowCount === limit ? 'more available' : 'complete'
                      }, null, 2)
                    }]
                  };
                } finally {
                  client.release();
                }
              }

              default:
                throw new Error(`Unknown PII operation: ${operation}. Valid: detect, redact, audit, compliance_report, batch_scan`);
            }
          }

          // ─── File Attachments (REM-109) ────────────────────────────────────────
          
          case 'upload_attachment': {
            trackMcpToolCall('upload_attachment', 'success');

            const { memory_id, filename, content_type, content_base64, is_private, metadata } = args as {
              memory_id: string;
              filename: string;
              content_type: string;
              content_base64: string;
              is_private?: boolean;
              metadata?: Record<string, any>;
            };

            // Decode base64 to buffer
            const buffer = Buffer.from(content_base64, 'base64');

            // Upload via AttachmentService
            const attachment = await getAttachmentService().uploadAttachment({
              memoryId: memory_id,
              tenantId,
              userId: userId || 'system',
              filename,
              contentType: content_type,
              buffer,
              isPrivate: is_private,
              metadata
            });

            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  attachment: {
                    id: attachment.id,
                    filename: attachment.filename,
                    size_bytes: attachment.size_bytes,
                    content_type: attachment.content_type,
                    uploaded_at: attachment.uploaded_at,
                    is_private: attachment.is_private
                  }
                }, null, 2)
              }]
            };
          }

          case 'list_attachments': {
            trackMcpToolCall('list_attachments', 'success');

            const { memory_id } = args as { memory_id: string };

            const attachments = await getAttachmentService().listAttachments(
              memory_id,
              tenantId,
              projectId || undefined
            );

            // Format attachments with pagination metadata (REM-38)
            const attachmentsFormatted = attachments.map(a => ({
              id: a.id,
              filename: a.filename,
              size_bytes: a.size_bytes,
              content_type: a.content_type,
              uploaded_at: a.uploaded_at,
              is_private: a.is_private
            }));

            const responseData = addPaginationToResponse({
              items: attachmentsFormatted,
              startTime
              // No limit parameter for list_attachments - returns all for a memory
            });

            return {
              content: [{
                type: 'text',
                text: JSON.stringify(responseData, null, 2)
              }]
            };
          }

          case 'get_attachment_url': {
            trackMcpToolCall('get_attachment_url', 'success');

            const { attachment_id, expires_in_seconds } = args as {
              attachment_id: string;
              expires_in_seconds?: number;
            };

            const url = await getAttachmentService().getDownloadUrl(
              attachment_id,
              tenantId,
              userId || 'system',
              expires_in_seconds
            );

            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  download_url: url,
                  expires_in: expires_in_seconds || 3600
                }, null, 2)
              }]
            };
          }

          case 'delete_attachment': {
            trackMcpToolCall('delete_attachment', 'success');

            const { attachment_id } = args as { attachment_id: string };

            await getAttachmentService().deleteAttachment(
              attachment_id,
              tenantId,
              userId || 'system'
            );

            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  message: 'Attachment deleted successfully'
                }, null, 2)
              }]
            };
          }

          case 'get_storage_usage': {
            trackMcpToolCall('get_storage_usage', 'success');

            const usage = await getAttachmentService().getStorageUsage(tenantId);

            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  storage: {
                    used_bytes: usage.total_bytes,
                    used_formatted: formatBytes(usage.total_bytes),
                    quota_bytes: usage.quota_bytes,
                    quota_formatted: formatBytes(usage.quota_bytes),
                    file_count: usage.file_count,
                    percent_used: Math.round((usage.total_bytes / usage.quota_bytes) * 100),
                    updated_at: usage.updated_at
                  }
                }, null, 2)
              }]
            };
          }

          // REM-57: Task Export/Import for RLM Portability
          case 'task_export': {
            const operation = args?.operation as string;

            // Import task export service
            const { TaskExportService } = await import('./task-export.js');
            const taskExportService = new TaskExportService(this.pool);

            if (operation === 'export') {
              const taskIds = args?.task_ids as string[];
              if (!taskIds || !Array.isArray(taskIds) || taskIds.length === 0) {
                return {
                  content: [{
                    type: 'text',
                    text: JSON.stringify({
                      success: false,
                      error: 'task_ids array is required for export operation'
                    }, null, 2)
                  }],
                  isError: true
                };
              }

              const exportData = await taskExportService.exportTasks(taskIds);
              const duration = (Date.now() - startTime) / 1000;
              trackMcpToolCall('task_export', 'success', tenantId, duration);

              return {
                content: [{
                  type: 'text',
                  text: JSON.stringify({
                    success: true,
                    export: exportData
                  }, null, 2)
                }]
              };

            } else if (operation === 'import') {
              const exportData = args?.export_data as any;
              if (!exportData) {
                return {
                  content: [{
                    type: 'text',
                    text: JSON.stringify({
                      success: false,
                      error: 'export_data is required for import operation'
                    }, null, 2)
                  }],
                  isError: true
                };
              }

              const boardId = args?.board_id as string | undefined;
              const result = await taskExportService.importTasks(exportData, boardId, tenantId);
              const duration = (Date.now() - startTime) / 1000;
              trackMcpToolCall('task_export', 'success', tenantId, duration);

              return {
                content: [{
                  type: 'text',
                  text: JSON.stringify({
                    success: true,
                    result: {
                      imported: result.imported,
                      failed: result.failed,
                      criteria_imported: result.criteria_imported,
                      task_ids: result.task_ids,
                      errors: result.errors
                    }
                  }, null, 2)
                }]
              };

            } else if (operation === 'validate') {
              const exportData = args?.export_data as any;
              if (!exportData) {
                return {
                  content: [{
                    type: 'text',
                    text: JSON.stringify({
                      success: false,
                      error: 'export_data is required for validate operation'
                    }, null, 2)
                  }],
                  isError: true
                };
              }

              const isValid = taskExportService.validateExportData(exportData);
              const duration = (Date.now() - startTime) / 1000;
              trackMcpToolCall('task_export', 'success', tenantId, duration);

              return {
                content: [{
                  type: 'text',
                  text: JSON.stringify({
                    success: true,
                    valid: isValid,
                    message: isValid ? 'Export data is valid' : 'Export data is invalid'
                  }, null, 2)
                }]
              };

            } else {
              return {
                content: [{
                  type: 'text',
                  text: JSON.stringify({
                    success: false,
                    error: `Unknown task_export operation: ${operation}`
                  }, null, 2)
                }],
                isError: true
              };
            }
          }

          // RAD-57: Task Handoff Service - Inter-Agent Transfer
          case 'task_handoff': {
            const operation = args?.operation as string;

            const {
              createHandoff,
              acceptHandoff,
              rejectHandoff,
              listPendingHandoffs,
              getHandoff,
              getTaskHandoffHistory,
            } = await import('./task-handoff.js');

            const dur = (Date.now() - startTime) / 1000;

            switch (operation) {
              case 'create': {
                const taskId    = args?.task_id as string;
                const fromAgent = args?.from_agent as string;
                const toAgent   = args?.to_agent as string;
                const reason    = args?.reason as string;
                if (!taskId)    return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'task_id is required' }) }], isError: true };
                if (!fromAgent) return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'from_agent is required' }) }], isError: true };
                if (!toAgent)   return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'to_agent is required' }) }], isError: true };
                if (!reason)    return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'reason is required' }) }], isError: true };
                const context = (args?.context as Record<string, unknown>) ?? {};
                const handoff = await createHandoff(this.pool, tenantId, taskId, fromAgent, toAgent, reason, context);
                trackMcpToolCall('task_handoff', 'success', tenantId, dur);
                return { content: [{ type: 'text', text: JSON.stringify({ success: true, handoff }, null, 2) }] };
              }

              case 'accept': {
                const handoffId = args?.handoff_id as string;
                const toAgent   = args?.to_agent as string;
                if (!handoffId) return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'handoff_id is required' }) }], isError: true };
                if (!toAgent)   return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'to_agent is required' }) }], isError: true };
                const handoff = await acceptHandoff(this.pool, tenantId, handoffId, toAgent);
                trackMcpToolCall('task_handoff', 'success', tenantId, dur);
                return { content: [{ type: 'text', text: JSON.stringify({ success: true, handoff }, null, 2) }] };
              }

              case 'reject': {
                const handoffId = args?.handoff_id as string;
                const toAgent   = args?.to_agent as string;
                const reason    = (args?.reason as string) ?? 'Rejected';
                if (!handoffId) return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'handoff_id is required' }) }], isError: true };
                if (!toAgent)   return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'to_agent is required' }) }], isError: true };
                const handoff = await rejectHandoff(this.pool, tenantId, handoffId, toAgent, reason);
                trackMcpToolCall('task_handoff', 'success', tenantId, dur);
                return { content: [{ type: 'text', text: JSON.stringify({ success: true, handoff }, null, 2) }] };
              }

              case 'list_pending': {
                const agentId     = args?.agent_id as string;
                const includeFrom = (args?.include_from as boolean) ?? false;
                const includeTo   = (args?.include_to as boolean) ?? true;
                if (!agentId) return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'agent_id is required' }) }], isError: true };
                const handoffs = await listPendingHandoffs(this.pool, tenantId, agentId, { includeFrom, includeTo });
                trackMcpToolCall('task_handoff', 'success', tenantId, dur);
                return { content: [{ type: 'text', text: JSON.stringify({ success: true, handoffs, count: handoffs.length }, null, 2) }] };
              }

              case 'get': {
                const handoffId = args?.handoff_id as string;
                if (!handoffId) return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'handoff_id is required' }) }], isError: true };
                const handoff = await getHandoff(this.pool, tenantId, handoffId);
                if (!handoff) return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Handoff not found' }) }], isError: true };
                trackMcpToolCall('task_handoff', 'success', tenantId, dur);
                return { content: [{ type: 'text', text: JSON.stringify({ success: true, handoff }, null, 2) }] };
              }

              case 'history': {
                const taskId = args?.task_id as string;
                const limit  = (args?.limit as number) ?? 10;
                if (!taskId) return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'task_id is required' }) }], isError: true };
                const handoffs = await getTaskHandoffHistory(this.pool, tenantId, taskId, limit);
                trackMcpToolCall('task_handoff', 'success', tenantId, dur);
                return { content: [{ type: 'text', text: JSON.stringify({ success: true, task_id: taskId, handoffs, count: handoffs.length }, null, 2) }] };
              }

              default:
                return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: `Unknown task_handoff operation: ${operation}. Valid: create, accept, reject, list_pending, get, history` }) }], isError: true };
            }
          }

          case 'task_analytics': {
            const operation = args?.operation as string;

            // Import task analytics service
            const { TaskAnalyticsService } = await import('./task-analytics.js');
            const taskAnalyticsService = new TaskAnalyticsService(this.pool);
            
            const projectId = args?.project_id as string | undefined;

            if (operation === 'velocity') {
              const period = (args?.period as 'day' | 'week' | 'month') || 'week';
              const periods = (args?.periods as number) || 8;

              const velocity = await taskAnalyticsService.calculateVelocity(
                tenantId,
                period,
                projectId,
                periods
              );

              const duration = (Date.now() - startTime) / 1000;
              trackMcpToolCall('task_analytics', 'success', tenantId, duration);

              return {
                content: [{
                  type: 'text',
                  text: JSON.stringify({
                    success: true,
                    operation: 'velocity',
                    result: velocity
                  }, null, 2)
                }]
              };

            } else if (operation === 'burndown') {
              const startDate = args?.start_date ? new Date(args.start_date as string) : undefined;
              const targetDate = args?.target_date ? new Date(args.target_date as string) : undefined;

              const burndown = await taskAnalyticsService.calculateBurndown(
                tenantId,
                projectId,
                startDate,
                targetDate
              );

              const duration = (Date.now() - startTime) / 1000;
              trackMcpToolCall('task_analytics', 'success', tenantId, duration);

              return {
                content: [{
                  type: 'text',
                  text: JSON.stringify({
                    success: true,
                    operation: 'burndown',
                    result: burndown
                  }, null, 2)
                }]
              };

            } else if (operation === 'bottlenecks') {
              const thresholds = args?.thresholds as {
                blocked_hours?: number;
                cycle_time_hours?: number;
                agent_task_limit?: number;
                transition_hours?: number;
              } | undefined;

              const bottlenecks = await taskAnalyticsService.identifyBottlenecks(
                tenantId,
                projectId,
                thresholds as any
              );

              const duration = (Date.now() - startTime) / 1000;
              trackMcpToolCall('task_analytics', 'success', tenantId, duration);

              return {
                content: [{
                  type: 'text',
                  text: JSON.stringify({
                    success: true,
                    operation: 'bottlenecks',
                    result: bottlenecks
                  }, null, 2)
                }]
              };

            } else {
              return {
                content: [{
                  type: 'text',
                  text: JSON.stringify({
                    success: false,
                    error: `Unknown task_analytics operation: ${operation}`
                  }, null, 2)
                }],
                isError: true
              };
            }
          }

          // ──────────────────────────────────────────────
          // RAD-59: Iteration Tracking & Stuck Detection
          // ──────────────────────────────────────────────

          case 'task_iterations': {
            const { IterationTrackingService } = await import('./iteration-tracking.js');
            const iterSvc = new IterationTrackingService(this.pool);
            const operation = args?.operation as string;
            const dur = (Date.now() - startTime) / 1000;

            switch (operation) {
              case 'record': {
                const taskId   = args?.task_id as string;
                const approach = args?.approach as string;
                const outcome  = args?.outcome as string;
                if (!taskId)   return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'task_id is required' }) }], isError: true };
                if (!approach) return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'approach is required' }) }], isError: true };
                if (!outcome)  return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'outcome is required' }) }], isError: true };
                const record = await iterSvc.recordIteration(tenantId, {
                  task_id:          taskId,
                  approach,
                  outcome,
                  error:            args?.error as string | undefined,
                  duration_seconds: args?.duration_seconds as number | undefined,
                  metadata:         args?.metadata as Record<string, unknown> | undefined,
                });
                trackMcpToolCall('task_iterations', 'success', tenantId, dur);
                return { content: [{ type: 'text', text: JSON.stringify({ success: true, record }, null, 2) }] };
              }

              case 'history': {
                const taskId = args?.task_id as string;
                const limit  = (args?.limit as number) ?? 50;
                if (!taskId) return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'task_id is required' }) }], isError: true };
                const iterations = await iterSvc.getIterationHistory(tenantId, taskId, limit);
                trackMcpToolCall('task_iterations', 'success', tenantId, dur);
                return { content: [{ type: 'text', text: JSON.stringify({ success: true, task_id: taskId, iterations, count: iterations.length }, null, 2) }] };
              }

              case 'stuck_score': {
                const taskId   = args?.task_id as string;
                const criteria = args?.criteria as Record<string, number> | undefined;
                if (!taskId) return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'task_id is required' }) }], isError: true };
                const stuckScore = await iterSvc.calculateStuckScore(tenantId, taskId, criteria ?? {});
                trackMcpToolCall('task_iterations', 'success', tenantId, dur);
                return { content: [{ type: 'text', text: JSON.stringify({ success: true, ...stuckScore }, null, 2) }] };
              }

              case 'detect_stuck': {
                const criteria = args?.criteria as Record<string, number> | undefined;
                const stuckTasks = await iterSvc.detectStuckTasks(tenantId, criteria ?? {});
                trackMcpToolCall('task_iterations', 'success', tenantId, dur);
                return { content: [{ type: 'text', text: JSON.stringify({ success: true, stuck_tasks: stuckTasks, count: stuckTasks.length }, null, 2) }] };
              }

              default:
                return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: `Unknown task_iterations operation: ${operation}. Valid: record, history, stuck_score, detect_stuck` }) }], isError: true };
            }
          }

          // ──────────────────────────────────────────────
          // REM-37: Ralph-RLM Integration
          // ──────────────────────────────────────────────

          case 'rlm_session': {
            const rlm = new RalphRLMService(this.pool, tenantId);
            const operation = args?.operation as string;
            let result: unknown;

            if (operation === 'create') {
              result = await rlm.createSession(
                args?.task_id as string,
                args?.task_title as string,
                (args?.acceptance_criteria as string[]) ?? [],
                args?.initial_plan as string | undefined,
                (args?.metadata as Record<string, unknown>) ?? {},
              );
            } else if (operation === 'get') {
              result = await rlm.getSession(args?.session_id as string);
              if (!result) return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Session not found' }) }], isError: true };
            } else if (operation === 'list') {
              result = await rlm.listSessions(args?.task_id as string | undefined, args?.status as RLMSessionStatus | undefined);
            } else if (operation === 'update_status') {
              result = await rlm.updateSessionStatus(args?.session_id as string, args?.status as RLMSessionStatus, args?.plan as string | undefined);
            } else if (operation === 'export_state') {
              const session = await rlm.getSession(args?.session_id as string);
              if (!session) return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Session not found' }) }], isError: true };
              result = { state_json: rlm.exportState(session) };
            } else if (operation === 'import_state') {
              result = await rlm.importState(args?.state_json as string);
            } else {
              return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: `Unknown rlm_session operation: ${operation}` }) }], isError: true };
            }

            const duration = (Date.now() - startTime) / 1000;
            trackMcpToolCall('rlm_session', 'success', tenantId, duration);
            return { content: [{ type: 'text', text: JSON.stringify({ success: true, operation, result }, null, 2) }] };
          }

          case 'rlm_evaluate_ac': {
            const rlm = new RalphRLMService(this.pool, tenantId);
            const evaluations = (args?.evaluations as Array<{ id: string; status: ACStatus; evidence?: string }>) ?? [];
            const session = await rlm.evaluateAC(args?.session_id as string, evaluations);
            if (!session) return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Session not found' }) }], isError: true };

            const allMet = session.acceptance_criteria.every(ac => ac.status === 'met' || ac.status === 'skipped');
            const duration = (Date.now() - startTime) / 1000;
            trackMcpToolCall('rlm_evaluate_ac', 'success', tenantId, duration);
            return { content: [{ type: 'text', text: JSON.stringify({ success: true, session_status: session.status, all_ac_met: allMet, acceptance_criteria: session.acceptance_criteria }, null, 2) }] };
          }

          case 'rlm_iteration': {
            const rlm = new RalphRLMService(this.pool, tenantId);
            const operation = args?.operation as string;
            let result: unknown;

            if (operation === 'start') {
              result = await rlm.startIteration(
                args?.session_id as string,
                args?.plan_summary as string,
                args?.approach as string,
                (args?.metadata as Record<string, unknown>) ?? {},
              );
            } else if (operation === 'complete') {
              result = await rlm.completeIteration(
                args?.iteration_id as string,
                (args?.outcome as IterationOutcome) ?? 'failed',
                (args?.evidence as string[]) ?? [],
                (args?.ac_met as string[]) ?? [],
                (args?.ac_failed as string[]) ?? [],
                args?.error as string | undefined,
                args?.duration_ms as number | undefined,
              );
            } else {
              return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: `Unknown rlm_iteration operation: ${operation}` }) }], isError: true };
            }

            const duration = (Date.now() - startTime) / 1000;
            trackMcpToolCall('rlm_iteration', 'success', tenantId, duration);
            return { content: [{ type: 'text', text: JSON.stringify({ success: true, operation, result }, null, 2) }] };
          }

          case 'rlm_regenerate': {
            const rlm = new RalphRLMService(this.pool, tenantId);
            const result = await rlm.requestRegeneration({
              session_id:        args?.session_id as string,
              reason:            args?.reason as string,
              stuck_evidence:    (args?.stuck_evidence as string[]) ?? [],
              failed_approaches: (args?.failed_approaches as string[]) ?? [],
              constraints:       (args?.constraints as string[]) ?? [],
            });

            const duration = (Date.now() - startTime) / 1000;
            trackMcpToolCall('rlm_regenerate', 'success', tenantId, duration);
            return { content: [{ type: 'text', text: JSON.stringify({ success: true, ...result }, null, 2) }] };
          }

          // ──────────────────────────────────────────────
          // REM-42: Advanced Analytics & Reporting
          // ──────────────────────────────────────────────

          case 'get_usage_analytics': {
            const reportingService = new AnalyticsReportingService(this.pool, tenantId);
            const from = new Date((args?.from as string) || new Date(Date.now() - 30 * 86400000).toISOString());
            const to   = new Date((args?.to   as string) || new Date().toISOString());
            const granularity = ((args?.granularity as Granularity) || 'day');

            let data;
            try {
              data = await reportingService.getUsageAnalytics(from, to, granularity);
            } catch {
              data = await reportingService.getUsageAnalyticsFallback(from, to, granularity);
            }

            const duration = (Date.now() - startTime) / 1000;
            trackMcpToolCall('get_usage_analytics', 'success', tenantId, duration);

            return {
              content: [{
                type: 'text',
                text: JSON.stringify({ success: true, from: from.toISOString(), to: to.toISOString(), granularity, data }, null, 2)
              }]
            };
          }

          case 'get_performance_metrics': {
            const reportingService = new AnalyticsReportingService(this.pool, tenantId);
            const from = new Date((args?.from as string) || new Date(Date.now() - 30 * 86400000).toISOString());
            const to   = new Date((args?.to   as string) || new Date().toISOString());
            const granularity = ((args?.granularity as Granularity) || 'day');

            const data = await reportingService.getPerformanceMetrics(from, to, granularity);

            const duration = (Date.now() - startTime) / 1000;
            trackMcpToolCall('get_performance_metrics', 'success', tenantId, duration);

            return {
              content: [{
                type: 'text',
                text: JSON.stringify({ success: true, from: from.toISOString(), to: to.toISOString(), granularity, data }, null, 2)
              }]
            };
          }

          case 'get_memory_growth': {
            const reportingService = new AnalyticsReportingService(this.pool, tenantId);
            const from = new Date((args?.from as string) || new Date(Date.now() - 30 * 86400000).toISOString());
            const to   = new Date((args?.to   as string) || new Date().toISOString());

            const data = await reportingService.getMemoryGrowthStats(from, to);

            const duration = (Date.now() - startTime) / 1000;
            trackMcpToolCall('get_memory_growth', 'success', tenantId, duration);

            return {
              content: [{
                type: 'text',
                text: JSON.stringify({ success: true, from: from.toISOString(), to: to.toISOString(), ...data }, null, 2)
              }]
            };
          }

          case 'get_category_breakdown': {
            const reportingService = new AnalyticsReportingService(this.pool, tenantId);
            const data = await reportingService.getCategoryBreakdown();

            const duration = (Date.now() - startTime) / 1000;
            trackMcpToolCall('get_category_breakdown', 'success', tenantId, duration);

            return {
              content: [{
                type: 'text',
                text: JSON.stringify({ success: true, categories: data }, null, 2)
              }]
            };
          }

          case 'get_pii_analytics': {
            const reportingService = new AnalyticsReportingService(this.pool, tenantId);
            const data = await reportingService.getPIISummary();

            const duration = (Date.now() - startTime) / 1000;
            trackMcpToolCall('get_pii_analytics', 'success', tenantId, duration);

            return {
              content: [{
                type: 'text',
                text: JSON.stringify({ success: true, ...data }, null, 2)
              }]
            };
          }

          case 'build_report': {
            const reportingService = new AnalyticsReportingService(this.pool, tenantId);

            const config: CustomReportConfig = {
              title:       (args?.title       as string)      || 'Custom Report',
              metrics:     (args?.metrics     as CustomReportConfig['metrics']) || ['growth', 'categories'],
              granularity: ((args?.granularity as Granularity) || 'day'),
              from:        (args?.from        as string)      || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10),
              to:          (args?.to          as string)      || new Date().toISOString().slice(0, 10),
              format:      ((args?.format     as ReportFormat) || 'json'),
            };

            const report = await reportingService.buildReport(config);
            const exported = reportingService.export(report, config.format);

            const duration = (Date.now() - startTime) / 1000;
            trackMcpToolCall('build_report', 'success', tenantId, duration);

            return {
              content: [{
                type: 'text',
                text: config.format === 'json' ? exported : JSON.stringify({ success: true, format: config.format, report: exported }, null, 2)
              }]
            };
          }
// REM-39: Enhanced Search & Filtering
          // ──────────────────────────────────────────────

          case 'filter_memories': {
            const searchSvc = new EnhancedSearchService(this.pool, tenantId, projectId);
            const filter = (args?.filter as AdvancedFilter) ?? (args as AdvancedFilter);
            const result = await searchSvc.filterMemories(filter);
            const duration = (Date.now() - startTime) / 1000;
            trackMcpToolCall('filter_memories', 'success', tenantId, duration);
            return {
              content: [{ type: 'text', text: JSON.stringify({ success: true, ...result }, null, 2) }]
            };
          }

          case 'batch_memories': {
            const searchSvc = new EnhancedSearchService(this.pool, tenantId, projectId);
            const operation = args?.operation as string;
            const filter    = (args?.filter as AdvancedFilter) ?? {};
            const updates   = args?.updates as { category?: string; metadata_merge?: Record<string, unknown> } | undefined;

            let result;
            if (operation === 'delete') {
              result = await searchSvc.batchDelete(filter);
            } else if (operation === 'update') {
              result = await searchSvc.batchUpdate(filter, updates ?? {});
            } else {
              return {
                content: [{ type: 'text', text: JSON.stringify({ success: false, error: `Unknown batch operation: ${operation}` }, null, 2) }],
                isError: true
              };
            }

            const duration = (Date.now() - startTime) / 1000;
            trackMcpToolCall('batch_memories', 'success', tenantId, duration);
            return {
              content: [{ type: 'text', text: JSON.stringify({ success: result.errors.length === 0, operation, ...result }, null, 2) }]
            };
          }

          case 'saved_searches': {
            const searchSvc = new EnhancedSearchService(this.pool, tenantId, projectId);
            const operation = args?.operation as string;

            let result: unknown;
            if (operation === 'save') {
              result = await searchSvc.saveSearch(
                args?.name as string,
                (args?.filter as AdvancedFilter) ?? {},
                args?.description as string | undefined,
              );
            } else if (operation === 'list') {
              result = await searchSvc.listSavedSearches();
            } else if (operation === 'execute') {
              result = await searchSvc.executeSavedSearch(args?.name as string);
            } else if (operation === 'delete') {
              result = { deleted: await searchSvc.deleteSavedSearch(args?.name as string) };
            } else {
              return {
                content: [{ type: 'text', text: JSON.stringify({ success: false, error: `Unknown saved_searches operation: ${operation}` }, null, 2) }],
                isError: true
              };
            }

            const duration = (Date.now() - startTime) / 1000;
            trackMcpToolCall('saved_searches', 'success', tenantId, duration);
            return {
              content: [{ type: 'text', text: JSON.stringify({ success: true, operation, result }, null, 2) }]
            };
          }

          case 'export_memories': {
            const searchSvc = new EnhancedSearchService(this.pool, tenantId, projectId);
            const filter    = (args?.filter as AdvancedFilter) ?? {};
            const format    = ((args?.format as SearchExportFormat) ?? 'json');
            const title     = args?.title as string | undefined;

            const { items } = await searchSvc.filterMemories({ ...filter, limit: 500 });
            const exported  = searchSvc.export(items, format, { title });

            const duration = (Date.now() - startTime) / 1000;
            trackMcpToolCall('export_memories', 'success', tenantId, duration);
            return {
              content: [{
                type: 'text',
                text: format === 'json' ? exported : JSON.stringify({ success: true, format, count: items.length, export: exported }, null, 2)
              }]
            };
          }

          // ──────────────────────────────────────────────
          // REM-64: PII NLP Engine
          // ──────────────────────────────────────────────

          case 'pii_nlp_detect': {
            const startTime = Date.now();
            const nlp = new PIINLPEngine();
            const content = args?.content as string;
            if (!content) return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'content is required' }) }], isError: true };
            const sensitivity = (args?.sensitivity as NLPSensitivity) || 'high';
            const result = nlp.detect(content, sensitivity);
            const duration = (Date.now() - startTime) / 1000;
            trackMcpToolCall('pii_nlp_detect', 'success', tenantId, duration);
            return { content: [{ type: 'text', text: JSON.stringify({ success: true, ...result }, null, 2) }] };
          }

          case 'pii_nlp_redact': {
            const startTime = Date.now();
            const nlp = new PIINLPEngine();
            const content = args?.content as string;
            if (!content) return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'content is required' }) }], isError: true };
            const sensitivity = (args?.sensitivity as NLPSensitivity) || 'high';
            const mode = (args?.mode as NLPRedactionMode) || 'mask';
            const minConf = typeof args?.min_confidence === 'number' ? args.min_confidence : 0.5;
            const result = nlp.detectAndRedact(content, sensitivity, mode, minConf);
            const duration = (Date.now() - startTime) / 1000;
            trackMcpToolCall('pii_nlp_redact', 'success', tenantId, duration);
            return { content: [{ type: 'text', text: JSON.stringify({ success: true, ...result }, null, 2) }] };
          }

          case 'pii_nlp_score': {
            const startTime = Date.now();
            const nlp = new PIINLPEngine();
            const content = args?.content as string;
            if (!content) return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'content is required' }) }], isError: true };
            const sensitivity = (args?.sensitivity as NLPSensitivity) || 'high';
            const score = nlp.score(content, sensitivity);
            const hasPII = nlp.containsPII(content, sensitivity);
            const duration = (Date.now() - startTime) / 1000;
            trackMcpToolCall('pii_nlp_score', 'success', tenantId, duration);
            return { content: [{ type: 'text', text: JSON.stringify({ success: true, score, hasPII }, null, 2) }] };
          }

          // ──────────────────────────────────────────────
          // REM-34: Context Snapshot Timeline
          // ──────────────────────────────────────────────

          case 'snapshot_timeline': {
            const startTime = Date.now();
            const tlSvc = new ContextSnapshotTimelineService(this.pool);
            const from = args?.from ? new Date(args.from as string) : undefined;
            const to = args?.to ? new Date(args.to as string) : undefined;
            const limit = typeof args?.limit === 'number' ? args.limit : 100;
            const fmt = (args?.format as string) || 'json';
            let output: string;
            let timelineHtmlContent: string | null = null;
            if (fmt === 'markdown') {
              output = await tlSvc.exportAsMarkdown({ tenantId, projectId, from, to, limit });
              output = JSON.stringify({ success: true, format: 'markdown', content: output }, null, 2);
            } else {
              const result = await tlSvc.getTimeline({ tenantId, projectId, from, to, limit });
              output = JSON.stringify({ success: true, ...result }, null, 2);
              // Render interactive timeline UI from timeline entries
              const snapshotsForUi = result.entries.map(entry => ({
                id: entry.snapshot_id,
                name: entry.snapshot_name,
                description: null as string | null,
                memory_count: entry.total_memories,
                token_count: 0,  // not available in timeline service
                created_at: new Date(entry.snapshot_time),
                expires_at: null as Date | null
              }));
              timelineHtmlContent = renderSnapshotTimeline({ snapshots: snapshotsForUi });
            }
            const duration = (Date.now() - startTime) / 1000;
            trackMcpToolCall('snapshot_timeline', 'success', tenantId, duration);
            const content: Array<{ type: string; text: string; mimeType?: string }> = [
              { type: 'text', text: output }
            ];
            if (timelineHtmlContent) {
              content.push({ type: 'text', text: timelineHtmlContent, mimeType: 'text/html' });
            }
            return { content };
          }

          case 'snapshot_diff': {
            const startTime = Date.now();
            const nameA = args?.snapshot_a as string;
            const nameB = args?.snapshot_b as string;
            if (!nameA || !nameB) return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'snapshot_a and snapshot_b are required' }) }], isError: true };
            const tlSvc = new ContextSnapshotTimelineService(this.pool);
            const diff = await tlSvc.diffSnapshots(tenantId, nameA, nameB);
            const duration = (Date.now() - startTime) / 1000;
            trackMcpToolCall('snapshot_diff', 'success', tenantId, duration);
            return { content: [{ type: 'text', text: JSON.stringify({ success: true, ...diff }, null, 2) }] };
          }

          case 'snapshot_nearest': {
            const startTime = Date.now();
            const ts = args?.timestamp as string;
            if (!ts) return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'timestamp is required' }) }], isError: true };
            const tlSvc = new ContextSnapshotTimelineService(this.pool);
            const nearest = await tlSvc.getNearestSnapshot(tenantId, new Date(ts), projectId);
            const duration = (Date.now() - startTime) / 1000;
            trackMcpToolCall('snapshot_nearest', 'success', tenantId, duration);
            return { content: [{ type: 'text', text: JSON.stringify({ success: true, result: nearest }, null, 2) }] };
          }

          case 'snapshot_category_evolution': {
            const startTime = Date.now();
            const tlSvc = new ContextSnapshotTimelineService(this.pool);
            const from = args?.from ? new Date(args.from as string) : undefined;
            const to = args?.to ? new Date(args.to as string) : undefined;
            const limit = typeof args?.limit === 'number' ? args.limit : 100;
            const evo = await tlSvc.getCategoryEvolution({ tenantId, projectId, from, to, limit });
            const duration = (Date.now() - startTime) / 1000;
            trackMcpToolCall('snapshot_category_evolution', 'success', tenantId, duration);
            return { content: [{ type: 'text', text: JSON.stringify({ success: true, ...evo }, null, 2) }] };
          }

          // ──────────────────────────────────────────────
          // REM-36: Work Queue & Agent Handoff
          // ──────────────────────────────────────────────

          case 'work_queue': {
            const wqSvc = new WorkQueueService(this.pool);
            const op = args?.operation as string;
            const queueName = (args?.queue_name as string) || 'default';
            const agentId = (args?.agent_id as string) || tenantId;

            switch (op) {
              case 'enqueue': {
                if (!args?.task_type) return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'task_type is required' }) }], isError: true };
                const item = await wqSvc.enqueue(tenantId, {
                  queue_name: queueName,
                  task_type: args.task_type as string,
                  priority: args?.priority as any,
                  payload: (args?.payload as Record<string, unknown>) || {},
                  handoff: args?.handoff as any,
                  lease_seconds: args?.lease_seconds as number,
                  max_attempts: args?.max_attempts as number,
                  scheduled_after: args?.scheduled_after as string,
                  idempotency_key: args?.idempotency_key as string,
                });
                trackMcpToolCall('work_queue', 'success', tenantId, (Date.now() - startTime) / 1000);
                return { content: [{ type: 'text', text: JSON.stringify({ success: true, item }, null, 2) }] };
              }
              case 'bulk_enqueue': {
                // RAD-16: Bulk operations for productivity
                const rawItems = args?.items as Array<Record<string, unknown>>;
                if (!rawItems || !Array.isArray(rawItems) || rawItems.length === 0) {
                  return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'items array is required and must not be empty' }) }], isError: true };
                }
                const enqueueItems = rawItems.map(it => ({
                  queue_name:      (it.queue_name as string) || queueName,
                  task_type:       it.task_type as string,
                  priority:        it.priority as any,
                  payload:         (it.payload as Record<string, unknown>) || {},
                  handoff:         it.handoff as any,
                  lease_seconds:   it.lease_seconds as number,
                  max_attempts:    it.max_attempts as number,
                  scheduled_after: it.scheduled_after as string,
                  idempotency_key: it.idempotency_key as string,
                }));
                const bulkResult = await wqSvc.bulkEnqueue(tenantId, enqueueItems);
                trackMcpToolCall('work_queue', 'success', tenantId, (Date.now() - startTime) / 1000);
                return { content: [{ type: 'text', text: JSON.stringify({ success: true, enqueued: bulkResult.enqueued.length, failed: bulkResult.failed.length, items: bulkResult.enqueued, errors: bulkResult.failed }, null, 2) }] };
              }
              case 'bulk_complete': {
                const rawCompletions = args?.completions as Array<{ item_id: string; agent_id?: string; handoff?: any }>;
                if (!rawCompletions || !Array.isArray(rawCompletions) || rawCompletions.length === 0) {
                  return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'completions array is required and must not be empty' }) }], isError: true };
                }
                const completions = rawCompletions.map(c => ({
                  item_id:  c.item_id,
                  agent_id: c.agent_id || agentId,
                  handoff:  c.handoff,
                }));
                const bulkCompleteResult = await wqSvc.bulkComplete(tenantId, completions);
                trackMcpToolCall('work_queue', 'success', tenantId, (Date.now() - startTime) / 1000);
                return { content: [{ type: 'text', text: JSON.stringify({ success: true, completed: bulkCompleteResult.completed.length, failed: bulkCompleteResult.failed.length, items: bulkCompleteResult.completed, errors: bulkCompleteResult.failed }, null, 2) }] };
              }
              case 'claim': {
                const result = await wqSvc.claim(tenantId, queueName, agentId, (args?.lease_seconds as number) || 300);
                trackMcpToolCall('work_queue', 'success', tenantId, (Date.now() - startTime) / 1000);
                return { content: [{ type: 'text', text: JSON.stringify({ success: true, result }, null, 2) }] };
              }
              case 'complete': {
                if (!args?.item_id) return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'item_id is required' }) }], isError: true };
                const item = await wqSvc.complete(tenantId, args.item_id as string, agentId, args?.handoff as any);
                trackMcpToolCall('work_queue', 'success', tenantId, (Date.now() - startTime) / 1000);
                return { content: [{ type: 'text', text: JSON.stringify({ success: true, item }, null, 2) }] };
              }
              case 'fail': {
                if (!args?.item_id) return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'item_id is required' }) }], isError: true };
                const item = await wqSvc.fail(tenantId, args.item_id as string, agentId, (args?.failure_reason as string) || 'unknown');
                trackMcpToolCall('work_queue', 'success', tenantId, (Date.now() - startTime) / 1000);
                return { content: [{ type: 'text', text: JSON.stringify({ success: true, item }, null, 2) }] };
              }
              case 'retry': {
                if (!args?.item_id) return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'item_id is required' }) }], isError: true };
                const item = await wqSvc.retry(tenantId, args.item_id as string);
                trackMcpToolCall('work_queue', 'success', tenantId, (Date.now() - startTime) / 1000);
                return { content: [{ type: 'text', text: JSON.stringify({ success: true, item }, null, 2) }] };
              }
              case 'renew_lease': {
                if (!args?.item_id) return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'item_id is required' }) }], isError: true };
                const item = await wqSvc.renewLease(tenantId, args.item_id as string, agentId, (args?.lease_seconds as number) || 300);
                trackMcpToolCall('work_queue', 'success', tenantId, (Date.now() - startTime) / 1000);
                return { content: [{ type: 'text', text: JSON.stringify({ success: true, item }, null, 2) }] };
              }
              case 'list': {
                const statusFilter = args?.status_filter as string[] | undefined;
                const result = await wqSvc.list(tenantId, {
                  queue_name: queueName === 'default' && !args?.queue_name ? undefined : queueName,
                  status: statusFilter as any,
                  task_type: args?.task_type as string,
                  claimed_by: args?.agent_id as string,
                  limit: (args?.limit as number) || 50,
                  offset: (args?.offset as number) || 0,
                });
                trackMcpToolCall('work_queue', 'success', tenantId, (Date.now() - startTime) / 1000);
                return { content: [{ type: 'text', text: JSON.stringify({ success: true, ...result }, null, 2) }] };
              }
              case 'get': {
                if (!args?.item_id) return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'item_id is required' }) }], isError: true };
                const item = await wqSvc.get(tenantId, args.item_id as string);
                trackMcpToolCall('work_queue', 'success', tenantId, (Date.now() - startTime) / 1000);
                return { content: [{ type: 'text', text: JSON.stringify({ success: true, item }, null, 2) }] };
              }
              case 'stats': {
                const stats = await wqSvc.getStats(tenantId, args?.queue_name as string);
                trackMcpToolCall('work_queue', 'success', tenantId, (Date.now() - startTime) / 1000);
                return { content: [{ type: 'text', text: JSON.stringify({ success: true, queues: stats }, null, 2) }] };
              }
              case 'purge': {
                const deleted = await wqSvc.purge(tenantId, queueName, (args?.older_than_days as number) || 7);
                trackMcpToolCall('work_queue', 'success', tenantId, (Date.now() - startTime) / 1000);
                return { content: [{ type: 'text', text: JSON.stringify({ success: true, deleted }, null, 2) }] };
              }
              default:
                return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: `Unknown work_queue operation: ${op}` }) }], isError: true };
            }
          }


          // ──────────────────────────────────────────────
          // REM-71: Task MCP Tools
          // ──────────────────────────────────────────────

          case 'manage_task': {
            const result = await handleManageTask(this.pool, args as Record<string, unknown>, tenantId);
            const duration = (Date.now() - startTime) / 1000;
            trackMcpToolCall('manage_task', 'success', tenantId, duration);
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
          }

          case 'task_state': {
            const result = await handleTaskState(this.pool, args as Record<string, unknown>);
            const duration = (Date.now() - startTime) / 1000;
            trackMcpToolCall('task_state', 'success', tenantId, duration);
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
          }

          case 'task_dependencies': {
            const result = await handleTaskDependencies(this.pool, args as Record<string, unknown>);
            const duration = (Date.now() - startTime) / 1000;
            trackMcpToolCall('task_dependencies', 'success', tenantId, duration);
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
          }

          case 'task_search': {
            const result = await handleTaskSearch(this.pool, args as Record<string, unknown>);
            const duration = (Date.now() - startTime) / 1000;
            trackMcpToolCall('task_search', 'success', tenantId, duration);
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
          }

          // RAD-17: Acceptance criteria — RLM integration
          case 'manage_acceptance_criteria': {
            const result = await handleManageAcceptanceCriteria(this.pool, args as Record<string, unknown>, tenantId);
            const duration = (Date.now() - startTime) / 1000;
            trackMcpToolCall('manage_acceptance_criteria', 'success', tenantId, duration);
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
          }

          // ──────────────────────────────────────────────
          // RAD-60: Plan Regeneration Service
          // ──────────────────────────────────────────────

          case 'plan_regeneration': {
            const {
              triggerRegeneration: triggerRegen,
              analyzeStuckContext: analyzeStuck,
              getRegenerationHistory: getRegenHistory,
              resolveRegeneration: resolveRegen,
            } = await import('./plan-regeneration.js');

            const operation = args?.operation as string;
            const taskId = args?.task_id as string;
            const dur = (Date.now() - startTime) / 1000;

            switch (operation) {
              case 'trigger': {
                if (!taskId) {
                  return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'task_id is required for trigger operation' }) }], isError: true };
                }
                const reason = {
                  type: (args?.reason_type as any) || 'manual',
                  description: (args?.reason as string) || 'Manual regeneration requested',
                  evidence: (args?.evidence as string[]) || [],
                  iteration_count: args?.iteration_count as number,
                  failure_count: args?.failure_count as number,
                  elapsed_minutes: args?.elapsed_minutes as number,
                };
                const record = await triggerRegen(this.pool, tenantId, taskId, reason);
                trackMcpToolCall('plan_regeneration', 'success', tenantId, dur);
                return { content: [{ type: 'text', text: JSON.stringify({ success: true, operation: 'trigger', record }, null, 2) }] };
              }

              case 'analyze_stuck': {
                if (!taskId) {
                  return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'task_id is required for analyze_stuck operation' }) }], isError: true };
                }
                const context = await analyzeStuck(this.pool, tenantId, taskId);
                trackMcpToolCall('plan_regeneration', 'success', tenantId, dur);
                return { content: [{ type: 'text', text: JSON.stringify({ success: true, operation: 'analyze_stuck', context }, null, 2) }] };
              }

              case 'history': {
                if (!taskId) {
                  return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'task_id is required for history operation' }) }], isError: true };
                }
                const limit = (args?.limit as number) || 10;
                const history = await getRegenHistory(this.pool, tenantId, taskId, limit);
                trackMcpToolCall('plan_regeneration', 'success', tenantId, dur);
                return { content: [{ type: 'text', text: JSON.stringify({ success: true, operation: 'history', task_id: taskId, regenerations: history, count: history.length }, null, 2) }] };
              }

              case 'resolve': {
                const regenId = args?.regeneration_id as string;
                const newPlan = args?.new_plan as string;
                if (!regenId || !newPlan) {
                  return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'regeneration_id and new_plan are required for resolve operation' }) }], isError: true };
                }
                await resolveRegen(this.pool, tenantId, regenId, newPlan);
                trackMcpToolCall('plan_regeneration', 'success', tenantId, dur);
                return { content: [{ type: 'text', text: JSON.stringify({ success: true, operation: 'resolve', regeneration_id: regenId }, null, 2) }] };
              }

              default:
                return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: `Unknown plan_regeneration operation: ${operation}. Valid: trigger, analyze_stuck, history, resolve` }) }], isError: true };
            }
          }

          // ──────────────────────────────────────────────
          // RAD-73: Plan Compaction Service
          // ──────────────────────────────────────────────

          case 'plan_compaction': {
            const {
              isCompactionNeeded: checkNeeded,
              compactMemories: runCompact,
              scheduleCompaction: scheduleCompact,
              consentToCompaction,
              getCompactionHistory,
              executeScheduledCompaction,
              cancelCompaction,
              getSubscriptionEndDate,
            } = await import('./optimization/compaction-service.js');

            const operation = args?.operation as string;
            const dur = () => (Date.now() - startTime) / 1000;

            switch (operation) {
              case 'check': {
                const status = await checkNeeded(this.pool, tenantId);
                trackMcpToolCall('plan_compaction', 'success', tenantId, dur());
                return {
                  content: [{ type: 'text', text: JSON.stringify({
                    success: true, operation: 'check',
                    needed: status.needed, currentCount: status.currentCount, limit: status.limit
                  }, null, 2) }]
                };
              }

              case 'schedule': {
                // Schedule a compaction after plan downgrade
                const oldPlan = args?.old_plan as string;
                const newPlan = args?.new_plan as string;
                const oldLimit = args?.old_memory_limit as number;
                const newLimit = args?.new_memory_limit as number;
                const graceDays = (args?.grace_period_days as number) ?? 7;

                if (!oldPlan || !newPlan || oldLimit == null || newLimit == null) {
                  return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'old_plan, new_plan, old_memory_limit, new_memory_limit are required for schedule operation' }) }], isError: true };
                }

                const countResult = await this.pool.query(
                  'SELECT COUNT(*) as count FROM memories WHERE tenant_id = $1', [tenantId]
                );
                const currentCount = parseInt(countResult.rows[0].count, 10);

                // RAD-73: use subscription end date (user paid through this date) as execute_after
                const subEndDate = await getSubscriptionEndDate(this.pool, tenantId);

                const schedule = await scheduleCompact(this.pool, tenantId, {
                  old_plan: oldPlan, new_plan: newPlan,
                  old_memory_limit: oldLimit, new_memory_limit: newLimit,
                  current_memory_count: currentCount,
                  execute_after: subEndDate ?? undefined,
                  grace_period_days: graceDays,
                });

                trackMcpToolCall('plan_compaction', 'success', tenantId, dur());
                return {
                  content: [{ type: 'text', text: JSON.stringify({
                    success: true, operation: 'schedule', schedule,
                    execute_after: schedule?.execute_after,
                    subscription_end_used: !!subEndDate,
                    message: subEndDate
                      ? `Compaction scheduled for subscription end date (${subEndDate.toISOString().slice(0,10)}). User keeps full access until their paid period ends.`
                      : `Compaction scheduled with ${graceDays}-day grace period (no subscription end date found).`,
                    notifications_required: ['email', 'in-app', 'support-thread']
                  }, null, 2) }]
                };
              }

              case 'consent': {
                const scheduleId = args?.schedule_id as string;
                if (!scheduleId) {
                  return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'schedule_id is required' }) }], isError: true };
                }
                const updated = await consentToCompaction(this.pool, tenantId, scheduleId);
                if (!updated) {
                  return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Schedule not found or already consented/executed' }) }], isError: true };
                }
                trackMcpToolCall('plan_compaction', 'success', tenantId, dur());
                return {
                  content: [{ type: 'text', text: JSON.stringify({
                    success: true, operation: 'consent', schedule: updated,
                    message: 'Consent recorded. Compaction will execute after grace period expires.'
                  }, null, 2) }]
                };
              }

              case 'preview': {
                const previewLimit = args?.new_memory_limit as number;
                if (previewLimit == null) {
                  return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'new_memory_limit is required for preview' }) }], isError: true };
                }
                const previewResult = await runCompact(this.pool, tenantId, previewLimit, {
                  dry_run: true,
                  similarity_threshold: args?.similarity_threshold as number,
                  max_group_size: args?.max_group_size as number,
                });
                trackMcpToolCall('plan_compaction', 'success', tenantId, dur());
                return {
                  content: [{ type: 'text', text: JSON.stringify({
                    success: previewResult.success, operation: 'preview', dry_run: true,
                    initial_count: previewResult.initial_count,
                    final_count: previewResult.final_count,
                    target_limit: previewResult.target_limit,
                    merged_groups: previewResult.merged_groups,
                    error: previewResult.error,
                  }, null, 2) }]
                };
              }

              case 'execute': {
                const execScheduleId = args?.schedule_id as string;
                if (!execScheduleId) {
                  return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'schedule_id is required for execute' }) }], isError: true };
                }
                const execResult = await executeScheduledCompaction(this.pool, tenantId, execScheduleId, {
                  project_id: args?.project_id as string,
                  dry_run: false,
                  similarity_threshold: args?.similarity_threshold as number,
                  max_group_size: args?.max_group_size as number,
                });
                trackMcpToolCall('plan_compaction', 'success', tenantId, dur());
                return {
                  content: [{ type: 'text', text: JSON.stringify({
                    success: execResult.success, operation: 'execute',
                    initial_count: execResult.initial_count,
                    final_count: execResult.final_count,
                    target_limit: execResult.target_limit,
                    merged_groups: execResult.merged_groups,
                    audit_log_id: execResult.audit_log_id,
                    error: execResult.error,
                  }, null, 2) }]
                };
              }

              case 'history': {
                const historyLimit = (args?.limit as number) || 10;
                const history = await getCompactionHistory(this.pool, tenantId, historyLimit);
                trackMcpToolCall('plan_compaction', 'success', tenantId, dur());
                return {
                  content: [{ type: 'text', text: JSON.stringify({
                    success: true, operation: 'history',
                    schedules: history, count: history.length
                  }, null, 2) }]
                };
              }

              case 'cancel': {
                const cancelId = args?.schedule_id as string;
                if (!cancelId) {
                  return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'schedule_id is required for cancel' }) }], isError: true };
                }
                const cancelled = await cancelCompaction(this.pool, tenantId, cancelId);
                if (!cancelled) {
                  return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Schedule not found or already executed' }) }], isError: true };
                }
                trackMcpToolCall('plan_compaction', 'success', tenantId, dur());
                return {
                  content: [{ type: 'text', text: JSON.stringify({
                    success: true, operation: 'cancel', schedule: cancelled,
                    message: 'Compaction cancelled. Temporary overage allowed.'
                  }, null, 2) }]
                };
              }

              default:
                return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: `Unknown plan_compaction operation: ${operation}. Valid: check, schedule, consent, preview, execute, history, cancel` }) }], isError: true };
            }
          }

          // ──────────────────────────────────────────────
          // REM-29: GDPR Compliance
          // ──────────────────────────────────────────────

          case 'gdpr': {
            const gdprSvc = new GDPRComplianceService(this.pool);
            const op = args?.operation as string;
            const dur = () => (Date.now() - startTime) / 1000;

            switch (op) {
              case 'request_forget_me': {
                const req = await gdprSvc.requestForgetMe(tenantId, {
                  user_id: args?.user_id as string,
                  requested_by_user_id: tenantId,
                  request_type: args?.request_type as any,
                  ip_address: args?.ip_address as string,
                });
                trackMcpToolCall('gdpr', 'success', tenantId, dur());
                return { content: [{ type: 'text', text: JSON.stringify({ success: true, request: req }, null, 2) }] };
              }
              case 'process_forget_me': {
                if (!args?.request_id) return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'request_id required' }) }], isError: true };
                const req = await gdprSvc.processForgetMe(args.request_id as string, tenantId);
                trackMcpToolCall('gdpr', 'success', tenantId, dur());
                return { content: [{ type: 'text', text: JSON.stringify({ success: true, request: req }, null, 2) }] };
              }
              case 'get_deletion_request': {
                if (!args?.request_id) return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'request_id required' }) }], isError: true };
                const req = await gdprSvc.getDeletionRequest(args.request_id as string, tenantId);
                trackMcpToolCall('gdpr', 'success', tenantId, dur());
                return { content: [{ type: 'text', text: JSON.stringify({ success: true, request: req }, null, 2) }] };
              }
              case 'list_deletion_requests': {
                const requests = await gdprSvc.listDeletionRequests(tenantId);
                trackMcpToolCall('gdpr', 'success', tenantId, dur());
                return { content: [{ type: 'text', text: JSON.stringify({ success: true, requests }, null, 2) }] };
              }
              case 'set_retention_policy': {
                if (!args?.memory_id) return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'memory_id required' }) }], isError: true };
                if (!args?.retention_policy) return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'retention_policy required' }) }], isError: true };
                await gdprSvc.setRetentionPolicy(tenantId, args.memory_id as string, args.retention_policy as any, {
                  user_id: args?.user_id as string,
                  ip_address: args?.ip_address as string,
                });
                trackMcpToolCall('gdpr', 'success', tenantId, dur());
                return { content: [{ type: 'text', text: JSON.stringify({ success: true, memory_id: args.memory_id, retention_policy: args.retention_policy }, null, 2) }] };
              }
              case 'purge_expired': {
                const deleted = await gdprSvc.purgeExpiredMemories(tenantId);
                trackMcpToolCall('gdpr', 'success', tenantId, dur());
                return { content: [{ type: 'text', text: JSON.stringify({ success: true, deleted }, null, 2) }] };
              }
              case 'retention_stats': {
                const stats = await gdprSvc.getRetentionStats(tenantId);
                trackMcpToolCall('gdpr', 'success', tenantId, dur());
                return { content: [{ type: 'text', text: JSON.stringify({ success: true, stats }, null, 2) }] };
              }
              case 'log_consent': {
                if (!args?.event_type) return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'event_type required' }) }], isError: true };
                const event = await gdprSvc.logConsentEvent(tenantId, {
                  event_type: args.event_type as any,
                  user_id: args?.user_id as string,
                  resource_type: args?.resource_type as string,
                  resource_id: args?.resource_id as string,
                  previous_value: args?.previous_value as any,
                  new_value: args?.new_value as any,
                  ip_address: args?.ip_address as string,
                });
                trackMcpToolCall('gdpr', 'success', tenantId, dur());
                return { content: [{ type: 'text', text: JSON.stringify({ success: true, event }, null, 2) }] };
              }
              case 'get_consent_trail': {
                const result = await gdprSvc.getConsentAuditTrail(tenantId, {
                  user_id: args?.user_id as string,
                  event_type: args?.event_type as any,
                  limit: args?.limit as number,
                  offset: args?.offset as number,
                });
                trackMcpToolCall('gdpr', 'success', tenantId, dur());
                return { content: [{ type: 'text', text: JSON.stringify({ success: true, ...result }, null, 2) }] };
              }
              case 'export_data': {
                const exportResult = await gdprSvc.exportData(tenantId, args?.user_id as string);
                trackMcpToolCall('gdpr', 'success', tenantId, dur());
                return { content: [{ type: 'text', text: JSON.stringify({ success: true, export: exportResult }, null, 2) }] };
              }
              default:
                return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: `Unknown gdpr operation: ${op}` }) }], isError: true };
            }
          }

          default:
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: false,
                    error: `Unknown tool: ${name}`
                  }, null, 2)
                }
              ],
              isError: true
            };
        }
        })(); // end IIFE

        // RAD-51: Inject deprecation warning when a legacy tool was called directly.
        // This is separate from the consolidated→legacy routing path (isConsolidatedCall).
        if (isDirectLegacyCall && !isConsolidatedCall && toolResult) {
          return wrapWithDeprecationWarning(toolResult as any, name);
        }
        return toolResult;
      } catch (error) {
        const duration = (Date.now() - startTime) / 1000;
        const err = error as Error;
        
        // Categorize error type
        let errorType: 'validation' | 'database' | 'embedding' | 'timeout' | 'not_found' | 'permission' | 'unknown' = 'unknown';
        
        if (err.message?.includes('not found') || err.message?.includes('does not exist')) {
          errorType = 'not_found';
        } else if (err.message?.includes('permission') || err.message?.includes('unauthorized')) {
          errorType = 'permission';
        } else if (err.message?.includes('timeout') || err.message?.includes('ETIMEDOUT')) {
          errorType = 'timeout';
        } else if (err.message?.includes('required') || err.message?.includes('invalid')) {
          errorType = 'validation';
        } else if (err.message?.includes('database') || err.message?.includes('query') || (err as any).code?.startsWith('PG')) {
          errorType = 'database';
        } else if (err.message?.includes('embedding') || err.message?.includes('ollama')) {
          errorType = 'embedding';
        }

        // Track error metrics
        trackMcpToolCall(name, 'error', tenantId, duration);
        trackMcpToolError(name, errorType, tenantId);
        
        // Log structured error
        logger.mcpTool(name, 'error', {
          tenantId,
          projectId,
          correlationId,
          errorType
        }, duration * 1000, err);
        
        // Track specific operation errors
        if (name === 'store_memory') {
          trackMemoryOperation('store', 'error', tenantId);
        } else if (name === 'search_memory') {
          trackMemoryOperation('search', 'error', tenantId);
        } else if (name === 'update_memory') {
          trackMemoryOperation('update', 'error', tenantId);
        } else if (name === 'delete_memory') {
          trackMemoryOperation('delete', 'error', tenantId);
        }
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: false,
                error: err.message,
                error_type: errorType,
                correlation_id: correlationId
              }, null, 2)
            }
          ],
          isError: true
        };
      }
    });

    return server;
  }

  async cleanup() {
    console.log('🧹 Cleaning up Redis sessions...');
    try {
      // Clear all sessions from Redis
      const sessionIds = await this.sessionStore.listSessions();
      for (const sessionId of sessionIds) {
        await this.sessionStore.delete(sessionId);
      }
      await this.sessionStore.cleanup();
      console.log('✅ Redis session cleanup completed');
    } catch (error) {
      console.error('❌ Error during Redis cleanup:', error);
    }
  }

  async start(): Promise<void> {
    console.log('🚀 Starting REMBR MCP server initialization...');
    console.log(`   - Port: ${this.port}`);
    console.log(`   - Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`   - Timestamp: ${new Date().toISOString()}`);
    console.log(`   - Auto-optimization: ${process.env.ENABLE_OPTIMIZATION === 'true' ? 'ENABLED' : 'DISABLED'}`);
    
    const httpServer = this.app.listen(this.port, () => {
      console.log('✅ REMBR MCP server listening on port', this.port);
      console.log(`Health check: http://localhost:${this.port}/health`);
      console.log(`MCP endpoint: POST http://localhost:${this.port}/mcp`);
      console.log(`Server started at: ${new Date().toISOString()}`);
    });

    // Start optimization scheduler if enabled
    if (this.optimizationScheduler) {
      console.log('🔄 Starting auto-optimization scheduler...');
      await this.optimizationScheduler.start();
      console.log('✅ Auto-optimization scheduler started');
    }

    // Periodic embedding backlog gauge update (every 60s)
    // Updates Prometheus gauge so alerting can detect growing backlogs
    setInterval(async () => {
      try {
        const result = await this.db.query(`
          SELECT m.tenant_id, COUNT(*) - COUNT(e.memory_id) as backlog
          FROM memories m
          LEFT JOIN memory_embeddings e ON m.id = e.memory_id
          GROUP BY m.tenant_id
          HAVING COUNT(*) - COUNT(e.memory_id) > 0
        `);
        for (const row of result.rows) {
          updateEmbeddingBacklog(row.tenant_id, parseInt(row.backlog));
        }
      } catch (error) {
        console.error('Failed to update embedding backlog gauge:', error);
      }
    }, 60_000);

    // Periodic embedding backfill (every 5 minutes)
    // Catches any orphaned memories from transient failures
    if (this.embeddingProvider) {
      setInterval(async () => {
        try {
          const result = await this.db.query(`
            SELECT m.id, m.content, m.tenant_id
            FROM memories m
            LEFT JOIN memory_embeddings me ON m.id = me.memory_id
            WHERE me.memory_id IS NULL
            ORDER BY m.created_at DESC
            LIMIT 10
          `);

          if (result.rows.length === 0) return;

          console.log(`🔄 Backfill: found ${result.rows.length} memories without embeddings`);
          let generated = 0;
          let failed = 0;

          for (const row of result.rows) {
            try {
              const embedding = await this.embeddingProvider!.generateEmbedding(row.content);
              await this.db.storeEmbedding(
                row.id,
                row.tenant_id,
                embedding,
                this.embeddingProvider!.name,
                this.embeddingProvider!.model
              );
              generated++;
            } catch (error: any) {
              failed++;
              console.error(`❌ Backfill failed for ${row.id}:`, error?.message || error);
              // Stop on timeout/connection errors — Ollama is likely overloaded
              if (error?.message?.includes('timeout') || error?.message?.includes('ECONNREFUSED')) {
                console.warn('⚠️  Backfill: stopping batch due to Ollama unavailability');
                break;
              }
            }
          }

          if (generated > 0 || failed > 0) {
            console.log(`📊 Backfill complete: ${generated} generated, ${failed} failed, from ${result.rows.length} attempted`);
          }
        } catch (error) {
          console.error('Backfill job failed:', error);
        }
      }, 5 * 60_000); // Every 5 minutes
      console.log('✅ Embedding backfill job scheduled (every 5 minutes)');
    }

    console.log('🔧 Configuring HTTP server timeouts...');
    
    // Disable socket timeouts for streaming connections
    httpServer.setTimeout(0); // No timeout for individual requests
    httpServer.keepAliveTimeout = 3600 * 1000; // 1 hour keep-alive timeout for streaming connections
    httpServer.headersTimeout = 3610 * 1000; // 1 hour + 10 seconds for headers
    
    console.log('✅ Server timeouts configured:');
    console.log('  - Socket timeout: disabled (0)');
    console.log(`  - Keep-alive timeout: ${httpServer.keepAliveTimeout / 1000}s`);
    console.log(`  - Headers timeout: ${httpServer.headersTimeout / 1000}s`);

    // Add connection tracking with detailed logging
    httpServer.on('connection', (socket) => {
      console.log('🔌 New HTTP connection established:', {
        remoteAddress: socket.remoteAddress,
        remotePort: socket.remotePort,
        localPort: socket.localPort,
        timestamp: new Date().toISOString()
      });
      
      socket.on('close', () => {
        console.log('🔌 HTTP connection closed:', {
          remoteAddress: socket.remoteAddress,
          remotePort: socket.remotePort,
          timestamp: new Date().toISOString()
        });
      });
      
      socket.on('error', (err) => {
        console.error('❌ Socket error:', {
          code: (err as any).code,
          message: err.message,
          syscall: (err as any).syscall,
          remoteAddress: socket.remoteAddress,
          remotePort: socket.remotePort,
          timestamp: new Date().toISOString()
        });
      });
      
      socket.on('timeout', () => {
        console.log('⏰ Socket timeout triggered:', {
          remoteAddress: socket.remoteAddress,
          remotePort: socket.remotePort,
          timestamp: new Date().toISOString()
        });
      });
    });

    // Handle client errors gracefully with detailed logging
    httpServer.on('clientError', (err: any, socket) => {
      console.error('❌ Client socket error:', {
        code: err?.code,
        message: err?.message,
        errno: err?.errno,
        syscall: err?.syscall,
        address: err?.address,
        port: err?.port,
        timestamp: new Date().toISOString()
      });
      if (socket.writable) {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      }
    });
    
    // Add connection tracking
    httpServer.on('connection', (socket) => {
      console.log('🔌 New HTTP connection established:', {
        remoteAddress: socket.remoteAddress,
        remotePort: socket.remotePort,
        timestamp: new Date().toISOString()
      });
      
      socket.on('close', () => {
        console.log('🔌 HTTP connection closed:', {
          remoteAddress: socket.remoteAddress,
          remotePort: socket.remotePort,
          timestamp: new Date().toISOString()
        });
      });
      
      socket.on('error', (err) => {
        console.error('❌ Socket error:', {
          code: (err as any).code,
          message: err.message,
          syscall: (err as any).syscall,
          remoteAddress: socket.remoteAddress,
          remotePort: socket.remotePort,
          timestamp: new Date().toISOString()
        });
      });
      
      socket.on('timeout', () => {
        console.log('⏰ Socket timeout triggered:', {
          remoteAddress: socket.remoteAddress,
          remotePort: socket.remotePort,
          timestamp: new Date().toISOString()
        });
      });
    });

    // Add periodic server status logging to track connection patterns
    setInterval(() => {
      console.log('📊 Server Status Report:', {
        timestamp: new Date().toISOString(),
        activeSessions: this.sessions.size,
        uptime: Math.round(process.uptime()),
        memory: {
          used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
          total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + 'MB'
        }
      });
    }, 5 * 60 * 1000); // Every 5 minutes - same interval as the timeout pattern

    // Add process-level error handlers
    process.on('uncaughtException', (error) => {
      console.error('💥 Uncaught Exception:', {
        error: error.message,
        code: (error as any).code,
        stack: error.stack?.split('\n').slice(0, 5).join('\n'),
        timestamp: new Date().toISOString()
      });
    });

    process.on('unhandledRejection', (reason) => {
      console.error('💥 Unhandled Rejection:', {
        reason: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack?.split('\n').slice(0, 5).join('\n') : undefined,
        timestamp: new Date().toISOString()
      });
    });
  }

  async close(): Promise<void> {
    console.log('🛑 Shutting down REMBR MCP server...');
    
    // Stop optimization scheduler first
    if (this.optimizationScheduler) {
      console.log('🔄 Stopping auto-optimization scheduler...');
      await this.optimizationScheduler.stop();
      console.log('✅ Auto-optimization scheduler stopped');
    }
    
    await this.cleanup();
    await this.db.close();
    await this.pool.end();
    console.log('✅ Server shutdown complete');
  }
}

// Start server
import { validateEnvironment } from './validate-env.js';

// Validate required environment variables before startup (REM-63)
validateEnvironment();

// Phase 2: Multi-Server Split (REM-38) - read SERVER_TYPE from environment
const port = parseInt(process.env.PORT || '3000');
const serverType = (process.env.SERVER_TYPE || 'all') as ServerType;
console.log(`🚀 Starting REMBR MCP Server - ${serverType} tools`);
const server = new RembrServer(port, serverType);
server.start().catch(console.error);

process.on('SIGINT', async () => {
  console.log('\nShutting down gracefully...');
  await server.close();
  process.exit(0);
});

// SIGTERM: sent by Kubernetes on pod termination
process.on('SIGTERM', async () => {
  console.log('\n🛑 SIGTERM received — draining background jobs before shutdown...');

  // Wait for in-flight background jobs (embedding, contradiction) to complete
  // before closing DB connections, to avoid silent data loss on deploy.
  const DRAIN_TIMEOUT_MS = 30_000; // Max 30s drain (Kubernetes default termination grace period)
  const POLL_INTERVAL_MS = 500;
  const deadline = Date.now() + DRAIN_TIMEOUT_MS;

  while (MemoryService.totalInflight > 0 && Date.now() < deadline) {
    console.log(`⏳ Waiting for ${MemoryService.totalInflight} in-flight background job(s) to finish...`);
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  if (MemoryService.totalInflight > 0) {
    console.warn(`⚠️  Timed out waiting for background jobs; ${MemoryService.totalInflight} job(s) may be lost.`);
  } else {
    console.log('✅ All background jobs drained.');
  }

  await server.close();
  process.exit(0);
});
