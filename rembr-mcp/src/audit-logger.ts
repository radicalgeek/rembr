/**
 * Audit Logger Service
 * 
 * Best-effort operational audit capture backed by an immutable hash-chained
 * table. Compliance-reporting tools remain release-gated until mutations and
 * their audit evidence share one atomic transaction/outbox boundary.
 */

import { createHash } from 'node:crypto';
import { Pool } from 'pg';

export interface AuditEvent {
  tenantId?: string;
  userId?: string;
  apiKeyId?: string;
  agentId?: string;
  ipAddress?: string;
  userAgent?: string;
  eventType: string;
  resourceType: string;
  resourceId?: string;
  actionResult: 'success' | 'failure' | 'denied';
  errorMessage?: string;
  payloadBefore?: unknown;
  payloadAfter?: unknown;
  queryParameters?: unknown;
  sessionId?: string;
  requestId?: string;
  metadata?: unknown;
}

export type AuditRequestContext = Pick<AuditEvent,
  | 'tenantId'
  | 'userId'
  | 'apiKeyId'
  | 'agentId'
  | 'ipAddress'
  | 'userAgent'
  | 'sessionId'
  | 'requestId'
>;

export interface AuditQueryFilters {
  userId?: string;
  resourceType?: string;
  resourceId?: string;
  eventType?: string;
  startTime?: Date;
  endTime?: Date;
  actionResult?: 'success' | 'failure' | 'denied';
  agentId?: string;
  limit?: number;
  offset?: number;
}

export interface AuditLogEntry {
  id: string;
  tenant_id?: string;
  user_id?: string;
  api_key_id?: string;
  agent_id?: string;
  ip_address?: string;
  user_agent?: string;
  event_type: string;
  resource_type: string;
  resource_id?: string;
  action_result: string;
  error_message?: string;
  payload_before?: any;
  payload_after?: any;
  query_parameters?: any;
  session_id?: string;
  request_id?: string;
  metadata?: any;
  created_at: Date;
}

export interface ComplianceReport {
  tenantId: string;
  reportPeriod: { start: Date; end: Date };
  eventSummary: Array<{
    event_type: string;
    action_result: string;
    count: number;
    unique_users: number;
    unique_resources: number;
  }>;
  failureRate: number;
  totalEvents: number;
  generatedAt: Date;
}

export class AuditLogger {
  private static readonly MAX_AUDIT_JSON_BYTES = 16 * 1024;
  private static readonly MAX_QUERY_LIMIT = 500;

  constructor(
    private db: Pool,
    private readonly requestContext: Readonly<Partial<AuditRequestContext>> = Object.freeze({}),
  ) {}

  /**
   * Create an immutable request-scoped logger. The base logger carries no
   * mutable principal state, so concurrent requests cannot overwrite one
   * another's attribution.
   */
  withContext(context: Partial<AuditRequestContext>): AuditLogger {
    return new AuditLogger(this.db, Object.freeze({ ...context }));
  }

  /**
   * Persist a bounded, redacted audit event. Best-effort mode returns false on
   * failure; required mode throws a stable error. Callers must not advertise
   * compliance-grade evidence unless using an atomic required/outbox workflow.
   */
  async log(event: AuditEvent, mode: 'best_effort' | 'required' = 'best_effort'): Promise<boolean> {
    try {
      // Principal and transport attribution is authoritative for this request:
      // individual call sites cannot accidentally (or deliberately) replace it.
      const fullEvent = this.normaliseEvent({ ...event, ...this.requestContext });
      
      const query = `
        INSERT INTO audit_logs 
        (tenant_id, user_id, api_key_id, agent_id, ip_address, user_agent,
         event_type, resource_type, resource_id, action_result, error_message,
         payload_before, payload_after, query_parameters, session_id, request_id, metadata,
         type, user_identifier, provider, success)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
                $7, COALESCE($18, 'unknown'), COALESCE($19, 'mcp'), $10 = 'success')
      `;

      await this.db.query(query, [
        fullEvent.tenantId || null,
        fullEvent.userId || null,
        fullEvent.apiKeyId || null,
        fullEvent.agentId || null,
        fullEvent.ipAddress || null,
        fullEvent.userAgent || null,
        fullEvent.eventType,
        fullEvent.resourceType,
        fullEvent.resourceId || null,
        fullEvent.actionResult,
        fullEvent.errorMessage || null,
        this.serialiseAuditJson(fullEvent.payloadBefore),
        this.serialiseAuditJson(fullEvent.payloadAfter),
        this.serialiseAuditJson(fullEvent.queryParameters),
        fullEvent.sessionId || null,
        fullEvent.requestId || null,
        this.serialiseAuditJson(fullEvent.metadata),
        fullEvent.userId || fullEvent.agentId || 'system',
        fullEvent.ipAddress ? 'authenticated' : 'system'
      ]);
      return true;
    } catch (error) {
      console.error('Audit logging failed', {
        code: (error as any)?.code,
        timestamp: new Date().toISOString(),
      });
      if (mode === 'required') throw new Error('Required audit persistence failed');
      return false;
    }
  }

  private normaliseEvent(event: AuditEvent): AuditEvent {
    const bounded = (value: unknown, maximum: number): string | undefined => {
      if (typeof value !== 'string') return undefined;
      const clean = value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, maximum);
      return clean || undefined;
    };
    const structured = (value: unknown, fallback: string): string => {
      const clean = bounded(value, 128);
      return clean && /^[A-Za-z0-9._:-]+$/.test(clean) ? clean : fallback;
    };
    return {
      tenantId: bounded(event.tenantId, 128),
      userId: bounded(event.userId, 128),
      apiKeyId: bounded(event.apiKeyId, 128),
      agentId: bounded(event.agentId, 128),
      ipAddress: bounded(event.ipAddress, 128),
      userAgent: bounded(event.userAgent, 512),
      eventType: structured(event.eventType, 'unknown'),
      resourceType: structured(event.resourceType, 'unknown'),
      resourceId: bounded(event.resourceId, 128),
      actionResult: event.actionResult,
      errorMessage: event.errorMessage ? 'operation_failed' : undefined,
      payloadBefore: this.redactAuditValue(event.payloadBefore),
      payloadAfter: this.redactAuditValue(event.payloadAfter),
      queryParameters: this.redactAuditValue(event.queryParameters),
      sessionId: bounded(event.sessionId, 128),
      requestId: bounded(event.requestId, 128),
      metadata: this.redactAuditValue(event.metadata),
    };
  }

  private redactAuditValue(value: unknown, depth = 0): unknown {
    if (value === undefined || value === null) return value;
    if (depth >= 4) return '[truncated]';
    if (typeof value === 'string') return value.slice(0, 1_024);
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'boolean') return value;
    if (Array.isArray(value)) return value.slice(0, 64).map(item => this.redactAuditValue(item, depth + 1));
    if (typeof value !== 'object') return String(value).slice(0, 128);
    const result: Record<string, unknown> = {};
    const sensitive = /(?:authorization|cookie|token|secret|password|api.?key|content|query|prompt)/i;
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 64)) {
      const safeKey = key.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 128);
      if (!safeKey) continue;
      result[safeKey] = sensitive.test(safeKey) ? '[redacted]' : this.redactAuditValue(item, depth + 1);
    }
    return result;
  }

  private serialiseAuditJson(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded, 'utf8') <= AuditLogger.MAX_AUDIT_JSON_BYTES) return encoded;
    return JSON.stringify({ redacted: 'payload_exceeded_audit_limit' });
  }

  private boundedLimit(value: number | undefined, fallback: number, maximum = AuditLogger.MAX_QUERY_LIMIT): number {
    if (value === undefined) return fallback;
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new Error(`Audit query limit must be between 1 and ${maximum}`);
    }
    return value;
  }

  private validateDateWindow(start: Date | undefined, end: Date | undefined, maximumDays = 366): void {
    for (const date of [start, end]) {
      if (date && (!Number.isFinite(date.getTime()))) throw new Error('Audit date is invalid');
    }
    if (start && end && (end < start || end.getTime() - start.getTime() > maximumDays * 86_400_000)) {
      throw new Error(`Audit date window must be ordered and no longer than ${maximumDays} days`);
    }
  }

  /**
   * Query audit logs with filters
   */
  async query(
    tenantId: string,
    filters: AuditQueryFilters
  ): Promise<AuditLogEntry[]> {
    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    // Always filter by tenant
    if (tenantId) {
      conditions.push(`tenant_id = $${paramIndex++}`);
      params.push(tenantId);
    }

    if (filters.userId) {
      conditions.push(`user_id = $${paramIndex++}`);
      params.push(filters.userId);
    }

    if (filters.agentId) {
      conditions.push(`agent_id = $${paramIndex++}`);
      params.push(filters.agentId);
    }

    if (filters.resourceType) {
      conditions.push(`resource_type = $${paramIndex++}`);
      params.push(filters.resourceType);
    }

    if (filters.resourceId) {
      conditions.push(`resource_id = $${paramIndex++}`);
      params.push(filters.resourceId);
    }

    if (filters.eventType) {
      conditions.push(`event_type = $${paramIndex++}`);
      params.push(filters.eventType);
    }

    if (filters.startTime) {
      conditions.push(`created_at >= $${paramIndex++}`);
      params.push(filters.startTime);
    }

    if (filters.endTime) {
      conditions.push(`created_at <= $${paramIndex++}`);
      params.push(filters.endTime);
    }

    if (filters.actionResult) {
      conditions.push(`action_result = $${paramIndex++}`);
      params.push(filters.actionResult);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    this.validateDateWindow(filters.startTime, filters.endTime);
    const limit = this.boundedLimit(filters.limit, 100);
    const offset = filters.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100_000) {
      throw new Error('Audit query offset must be between 0 and 100000');
    }

    const query = `
      SELECT * FROM audit_logs
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT $${paramIndex++}
      OFFSET $${paramIndex}
    `;
    params.push(limit, offset);

    const result = await this.db.query(query, params);
    return result.rows;
  }

  /**
   * Generate compliance report for SOC2/GDPR
   */
  async generateComplianceReport(
    tenantId: string,
    startDate: Date,
    endDate: Date
  ): Promise<ComplianceReport> {
    this.validateDateWindow(startDate, endDate);
    // Event summary by type and result
    const summaryQuery = `
      SELECT 
        event_type,
        action_result,
        COUNT(*) as count,
        COUNT(DISTINCT user_id) as unique_users,
        COUNT(DISTINCT resource_id) as unique_resources
      FROM audit_logs
      WHERE tenant_id = $1
        AND created_at BETWEEN $2 AND $3
      GROUP BY event_type, action_result
      ORDER BY count DESC
    `;

    const summaryResult = await this.db.query(summaryQuery, [tenantId, startDate, endDate]);

    // Calculate failure rate
    const failureQuery = `
      SELECT 
        COUNT(*) FILTER (WHERE action_result IN ('failure', 'denied'))::float /
        NULLIF(COUNT(*), 0) as failure_rate,
        COUNT(*) as total_events
      FROM audit_logs
      WHERE tenant_id = $1
        AND created_at BETWEEN $2 AND $3
    `;

    const failureResult = await this.db.query(failureQuery, [tenantId, startDate, endDate]);

    return {
      tenantId,
      reportPeriod: { start: startDate, end: endDate },
      eventSummary: summaryResult.rows,
      failureRate: parseFloat(failureResult.rows[0]?.failure_rate || '0'),
      totalEvents: parseInt(failureResult.rows[0]?.total_events || '0'),
      generatedAt: new Date()
    };
  }

  /**
   * GDPR: Export user's audit trail
   */
  async exportUserActivity(
    tenantId: string,
    userId: string,
    limit: number = 500,
    before?: Date,
  ): Promise<AuditLogEntry[]> {
    const boundedLimit = this.boundedLimit(limit, 500, 1_000);
    this.validateDateWindow(before, undefined);
    const query = `
      SELECT * FROM audit_logs
      WHERE tenant_id = $1
        AND user_id = $2
        AND ($3::timestamptz IS NULL OR created_at < $3)
      ORDER BY created_at DESC
      LIMIT $4
    `;

    const result = await this.db.query(query, [tenantId, userId, before || null, boundedLimit]);
    return result.rows;
  }

  /**
   * Get audit statistics
   */
  async getAuditStats(
    tenantId: string,
    startDate?: Date,
    endDate?: Date
  ): Promise<any> {
    this.validateDateWindow(startDate, endDate);
    const params: any[] = [tenantId];
    let dateFilter = '';
    
    if (startDate && endDate) {
      dateFilter = ' AND created_at BETWEEN $2 AND $3';
      params.push(startDate, endDate);
    } else if (startDate) {
      dateFilter = ' AND created_at >= $2';
      params.push(startDate);
    }

    const query = `
      SELECT 
        COUNT(*) as total_events,
        COUNT(DISTINCT user_id) as unique_users,
        COUNT(DISTINCT agent_id) as unique_agents,
        COUNT(DISTINCT resource_id) as unique_resources,
        COUNT(*) FILTER (WHERE action_result = 'success') as successful_events,
        COUNT(*) FILTER (WHERE action_result = 'failure') as failed_events,
        COUNT(*) FILTER (WHERE action_result = 'denied') as denied_events,
        MIN(created_at) as earliest_event,
        MAX(created_at) as latest_event
      FROM audit_logs
      WHERE tenant_id = $1
      ${dateFilter}
    `;

    const result = await this.db.query(query, params);
    return result.rows[0];
  }

  /**
   * Get recent events
   */
  async getRecentEvents(
    tenantId: string,
    limit: number = 50,
    eventType?: string
  ): Promise<AuditLogEntry[]> {
    let query = `
      SELECT * FROM audit_logs
      WHERE tenant_id = $1
    `;
    
    const params: any[] = [tenantId];
    
    if (eventType) {
      query += ` AND event_type = $2`;
      params.push(eventType);
    }

    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
    params.push(this.boundedLimit(limit, 50));

    const result = await this.db.query(query, params);
    return result.rows;
  }

  /**
   * Get failed operations for debugging
   */
  async getFailedOperations(
    tenantId: string,
    limit: number = 100
  ): Promise<AuditLogEntry[]> {
    const query = `
      SELECT * FROM audit_logs
      WHERE tenant_id = $1
        AND action_result IN ('failure', 'denied')
      ORDER BY created_at DESC
      LIMIT $2
    `;

    const result = await this.db.query(query, [tenantId, this.boundedLimit(limit, 100)]);
    return result.rows;
  }

  /**
   * Track specific resource access history
   */
  async getResourceHistory(
    tenantId: string,
    resourceType: string,
    resourceId: string,
    limit: number = 50
  ): Promise<AuditLogEntry[]> {
    const query = `
      SELECT * FROM audit_logs
      WHERE tenant_id = $1
        AND resource_type = $2
        AND resource_id = $3
      ORDER BY created_at DESC
      LIMIT $4
    `;

    const result = await this.db.query(query, [tenantId, resourceType, resourceId, this.boundedLimit(limit, 50)]);
    return result.rows;
  }

  /**
   * Detect suspicious activity patterns
   */
  async detectSuspiciousActivity(
    tenantId: string,
    lookbackHours: number = 24
  ): Promise<any[]> {
    if (!Number.isSafeInteger(lookbackHours) || lookbackHours < 1 || lookbackHours > 8_760) {
      throw new Error('lookbackHours must be an integer between 1 and 8760');
    }
    const query = `
      WITH recent_failures AS (
        SELECT 
          user_id,
          agent_id,
          event_type,
          COUNT(*) as failure_count,
          MAX(created_at) as last_failure
        FROM audit_logs
        WHERE tenant_id = $1
          AND action_result IN ('failure', 'denied')
          AND created_at > NOW() - ($2::int * INTERVAL '1 hour')
        GROUP BY user_id, agent_id, event_type
        HAVING COUNT(*) > 5
      )
      SELECT * FROM recent_failures
      ORDER BY failure_count DESC
    `;

    const result = await this.db.query(query, [tenantId, lookbackHours]);
    return result.rows;
  }

  /**
   * Clean up old audit logs based on retention policy
   * (Should be run as a background job)
   */
  async cleanupExpiredLogs(): Promise<number> {
    throw new Error('Audit-log retention cleanup is unavailable without an owner-authorised immutable-chain maintenance procedure');
  }

  /**
   * REM-251: Verify audit log chain integrity for a tenant.
   * Checks:
   *   1. Each record's entry_hash matches recomputed hash
   *   2. Each record's prev_hash matches the previous record's entry_hash
   *   3. No sequence gaps (deleted records)
   * 
   * Returns an array of integrity violations (empty if chain is intact).
   */
  async verifyIntegrity(tenantId: string, limit: number = 1000): Promise<Array<{
    seq_num: number;
    id: string;
    violation_type: 'hash_mismatch' | 'chain_break' | 'sequence_gap';
    details: string;
  }>> {
    const boundedLimit = this.boundedLimit(limit, 1_000, 10_000);
    const query = `
      WITH selected AS (
        SELECT tenant_seq_num
          FROM audit_logs
         WHERE tenant_id = $1
         ORDER BY tenant_seq_num DESC
         LIMIT $2
      ), bounds AS (
        SELECT MIN(tenant_seq_num) AS min_seq, MAX(tenant_seq_num) AS max_seq
          FROM selected
      )
      SELECT
        a.tenant_seq_num AS seq_num,
        a.id, a.tenant_id, a.user_id, a.api_key_id, a.agent_id,
        a.ip_address, a.user_agent, a.event_type, a.resource_type,
        a.resource_id, a.action_result, a.error_message,
        a.payload_before, a.payload_after, a.query_parameters,
        a.payload_before::text AS payload_before_canonical,
        a.payload_after::text AS payload_after_canonical,
        a.query_parameters::text AS query_parameters_canonical,
        a.session_id, a.request_id, a.metadata, a.type,
        a.metadata::text AS metadata_canonical,
        a.user_identifier, a.provider, a.success, a.created_at,
        EXTRACT(EPOCH FROM a.created_at) AS created_at_epoch,
        a.entry_hash, a.prev_hash,
        (a.tenant_seq_num < bounds.min_seq) AS is_anchor
      FROM audit_logs a
      CROSS JOIN bounds
      WHERE a.tenant_id = $1
        AND bounds.min_seq IS NOT NULL
        AND a.tenant_seq_num BETWEEN bounds.min_seq - 1 AND bounds.max_seq
      ORDER BY a.tenant_seq_num ASC
    `;

    const result = await this.db.query(query, [tenantId, boundedLimit]);
    const violations: Array<{
      seq_num: number;
      id: string;
      violation_type: 'hash_mismatch' | 'chain_break' | 'sequence_gap';
      details: string;
    }> = [];

    let previous: any | undefined;
    for (const row of result.rows) {
      // 1. Verify entry_hash
      const recomputed = this.recomputeHash(row);
      if (recomputed !== row.entry_hash) {
        violations.push({
          seq_num: row.seq_num,
          id: row.id,
          violation_type: 'hash_mismatch',
          details: `Entry hash mismatch: expected ${recomputed}, found ${row.entry_hash}`
        });
      }

      // The one predecessor anchor makes a recent LIMIT window verifiable
      // without scanning the tenant's complete history.
      if (previous && row.prev_hash !== previous.entry_hash) {
        violations.push({
          seq_num: row.seq_num,
          id: row.id,
          violation_type: 'chain_break',
          details: `Chain break at tenant sequence ${row.seq_num}`
        });
      } else if (!previous && !row.is_anchor && Number(row.seq_num) === 1 && row.prev_hash !== null) {
        violations.push({
          seq_num: Number(row.seq_num), id: row.id, violation_type: 'chain_break',
          details: 'Genesis audit entry has an unexpected predecessor',
        });
      }

      if (previous && Number(previous.seq_num) !== Number(row.seq_num) - 1) {
        violations.push({
          seq_num: Number(row.seq_num),
          id: row.id,
          violation_type: 'sequence_gap',
          details: `Sequence gap before tenant sequence ${row.seq_num}`
        });
      } else if (!previous && !row.is_anchor && Number(row.seq_num) !== 1) {
        violations.push({
          seq_num: Number(row.seq_num),
          id: row.id,
          violation_type: 'sequence_gap',
          details: `Sequence gap: tenant chain starts at ${row.seq_num} instead of 1`,
        });
      }
      previous = row;
    }

    return violations;
  }

  /**
   * REM-251: Recompute the SHA-256 entry_hash for a single audit log record.
   * Used by verifyIntegrity() to detect tampering.
   * 
   * Must match the hash computation in migration 006-audit-tamper-resistance.sql
   * 
   * CRITICAL: Use created_at_epoch (EXTRACT(EPOCH FROM created_at)) directly
   * from the database query, not new Date(created_at), to preserve microsecond
   * precision. JavaScript Date only has millisecond precision which causes
   * hash mismatches.
   */
  private recomputeHash(row: any): string {
    // Use the epoch value directly from PostgreSQL (preserves microsecond precision)
    // row.created_at_epoch comes from EXTRACT(EPOCH FROM created_at) in the query
    const epoch = row.created_at_epoch !== undefined 
      ? row.created_at_epoch.toString()
      : '';
    
    const canonical = [
      row.id || '',
      row.tenant_id || '',
      row.user_id || '',
      row.api_key_id || '',
      row.agent_id || '',
      row.ip_address || '',
      row.user_agent || '',
      row.event_type || '',
      row.resource_type || '',
      row.resource_id || '',
      row.action_result || '',
      row.error_message || '',
      row.payload_before_canonical || '',
      row.payload_after_canonical || '',
      row.query_parameters_canonical || '',
      row.session_id || '',
      row.request_id || '',
      row.metadata_canonical || '',
      row.type || '',
      row.user_identifier || '',
      row.provider || '',
      row.success === null || row.success === undefined ? '' : String(row.success),
      epoch,
      row.seq_num?.toString() || '',
      row.prev_hash || 'GENESIS'
    ].join('|');

    return createHash('sha256').update(canonical).digest('hex');
  }

  /**
   * REM-251: Detect sequence gaps in audit logs (evidence of deleted records).
   * Returns an array of gaps: [{ start_seq, end_seq, gap_size }]
   */
  async detectGaps(tenantId: string, limit: number = 10_000): Promise<Array<{
    start_seq: number;
    end_seq: number;
    gap_size: number;
  }>> {
    const query = `
      WITH selected AS (
        SELECT tenant_seq_num
          FROM audit_logs
         WHERE tenant_id = $1
         ORDER BY tenant_seq_num DESC
         LIMIT $2
      ), bounds AS (
        SELECT MIN(tenant_seq_num) AS min_seq, MAX(tenant_seq_num) AS max_seq
          FROM selected
      ), bounded AS (
        SELECT a.tenant_seq_num,
               (a.tenant_seq_num < bounds.min_seq) AS is_anchor
          FROM audit_logs a
          CROSS JOIN bounds
         WHERE a.tenant_id = $1
           AND bounds.min_seq IS NOT NULL
           AND a.tenant_seq_num BETWEEN bounds.min_seq - 1 AND bounds.max_seq
      )
      SELECT
        tenant_seq_num AS seq_num,
        LAG(tenant_seq_num) OVER (ORDER BY tenant_seq_num) AS prev_seq_num,
        is_anchor
      FROM bounded
      ORDER BY tenant_seq_num ASC
    `;

    const result = await this.db.query(query, [tenantId, this.boundedLimit(limit, 10_000, 10_000)]);
    const gaps: Array<{ start_seq: number; end_seq: number; gap_size: number }> = [];

    for (const row of result.rows) {
      // Note: PostgreSQL BIGINT is returned as string by node-postgres, convert to number
      const currentSeq = Number(row.seq_num);
      const prevSeq = row.prev_seq_num !== null ? Number(row.prev_seq_num) : null;
      
      // A predecessor row anchors a bounded recent window. Its sequence need
      // not be genesis, and treating it as such creates a false deletion alarm
      // for every tenant with more rows than the requested limit.
      if (prevSeq === null && !row.is_anchor && currentSeq !== 1) {
        gaps.push({ start_seq: 0, end_seq: currentSeq, gap_size: currentSeq - 1 });
      } else if (prevSeq !== null && currentSeq !== prevSeq + 1) {
        const gapSize = currentSeq - prevSeq - 1;
        // Only report actual gaps (gap_size > 0)
        if (gapSize > 0) {
          gaps.push({
            start_seq: prevSeq,
            end_seq: currentSeq,
            gap_size: gapSize
          });
        }
      }
    }

    return gaps;
  }
}
