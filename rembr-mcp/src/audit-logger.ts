/**
 * Audit Logger Service
 * 
 * Immutable audit trail for compliance (SOC2, HIPAA, GDPR).
 * Tracks all memory operations and user actions.
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
  payloadBefore?: any;
  payloadAfter?: any;
  queryParameters?: any;
  sessionId?: string;
  requestId?: string;
  metadata?: any;
}

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
  private defaultContext: Partial<AuditEvent> = {};
  
  constructor(private db: Pool) {}

  /**
   * Set default context for all audit logs (IP, user-agent, userId, etc.)
   * This should be called once per request
   */
  setRequestContext(context: Partial<AuditEvent>): void {
    this.defaultContext = context;
  }

  /**
   * Log an audit event (async, non-blocking)
   * Never throws - audit logging should never break main operations
   */
  async log(event: AuditEvent): Promise<void> {
    try {
      // Merge default context with event-specific data
      const fullEvent = { ...this.defaultContext, ...event };
      
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
        fullEvent.payloadBefore ? JSON.stringify(fullEvent.payloadBefore) : null,
        fullEvent.payloadAfter ? JSON.stringify(fullEvent.payloadAfter) : null,
        fullEvent.queryParameters ? JSON.stringify(fullEvent.queryParameters) : null,
        fullEvent.sessionId || null,
        fullEvent.requestId || null,
        fullEvent.metadata ? JSON.stringify(fullEvent.metadata) : null,
        fullEvent.userId || fullEvent.agentId || 'system',
        fullEvent.ipAddress ? 'authenticated' : 'system'
      ]);
    } catch (error) {
      // Never let audit logging break the main operation
      console.error('Audit logging failed (non-fatal):', error);
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
    const limit = filters.limit || 100;
    const offset = filters.offset || 0;

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
    userId: string
  ): Promise<AuditLogEntry[]> {
    const query = `
      SELECT * FROM audit_logs
      WHERE tenant_id = $1
        AND user_id = $2
      ORDER BY created_at DESC
    `;

    const result = await this.db.query(query, [tenantId, userId]);
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
    params.push(limit);

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

    const result = await this.db.query(query, [tenantId, limit]);
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

    const result = await this.db.query(query, [tenantId, resourceType, resourceId, limit]);
    return result.rows;
  }

  /**
   * Detect suspicious activity patterns
   */
  async detectSuspiciousActivity(
    tenantId: string,
    lookbackHours: number = 24
  ): Promise<any[]> {
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
          AND created_at > NOW() - INTERVAL '${lookbackHours} hours'
        GROUP BY user_id, agent_id, event_type
        HAVING COUNT(*) > 5
      )
      SELECT * FROM recent_failures
      ORDER BY failure_count DESC
    `;

    const result = await this.db.query(query, [tenantId]);
    return result.rows;
  }

  /**
   * Clean up old audit logs based on retention policy
   * (Should be run as a background job)
   */
  async cleanupExpiredLogs(): Promise<number> {
    const query = `
      DELETE FROM audit_logs
      WHERE retention_until < NOW()
      RETURNING id
    `;

    const result = await this.db.query(query);
    return result.rowCount || 0;
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
    const query = `
      SELECT 
        seq_num,
        id,
        tenant_id,
        user_id,
        agent_id,
        event_type,
        resource_type,
        resource_id,
        action_result,
        created_at,
        EXTRACT(EPOCH FROM created_at) AS created_at_epoch,
        entry_hash,
        prev_hash,
        LAG(entry_hash) OVER (ORDER BY seq_num) AS expected_prev_hash,
        LAG(seq_num) OVER (ORDER BY seq_num) AS prev_seq_num
      FROM audit_logs
      WHERE tenant_id = $1
      ORDER BY seq_num DESC
      LIMIT $2
    `;

    const result = await this.db.query(query, [tenantId, limit]);
    const violations: Array<{
      seq_num: number;
      id: string;
      violation_type: 'hash_mismatch' | 'chain_break' | 'sequence_gap';
      details: string;
    }> = [];

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

      // 2. Verify chain link (prev_hash should match previous entry_hash)
      if (row.expected_prev_hash !== null && row.prev_hash !== row.expected_prev_hash) {
        violations.push({
          seq_num: row.seq_num,
          id: row.id,
          violation_type: 'chain_break',
          details: `Chain break: prev_hash is ${row.prev_hash}, but previous entry_hash is ${row.expected_prev_hash}`
        });
      }

      // 3. Verify sequence continuity (no gaps)
      // Note: PostgreSQL BIGINT is returned as string by node-postgres, convert to number
      if (row.prev_seq_num !== null && Number(row.prev_seq_num) !== row.seq_num - 1) {
        violations.push({
          seq_num: row.seq_num,
          id: row.id,
          violation_type: 'sequence_gap',
          details: `Sequence gap: current seq_num is ${row.seq_num}, but previous is ${row.prev_seq_num} (expected ${row.seq_num - 1})`
        });
      }
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
      row.agent_id || '',
      row.event_type || '',
      row.resource_type || '',
      row.resource_id || '',
      row.action_result || '',
      epoch,
      row.prev_hash || 'GENESIS'
    ].join('|');

    return createHash('sha256').update(canonical).digest('hex');
  }

  /**
   * REM-251: Detect sequence gaps in audit logs (evidence of deleted records).
   * Returns an array of gaps: [{ start_seq, end_seq, gap_size }]
   */
  async detectGaps(tenantId: string): Promise<Array<{
    start_seq: number;
    end_seq: number;
    gap_size: number;
  }>> {
    const query = `
      SELECT 
        seq_num,
        LAG(seq_num) OVER (ORDER BY seq_num) AS prev_seq_num
      FROM audit_logs
      WHERE tenant_id = $1
      ORDER BY seq_num ASC
    `;

    const result = await this.db.query(query, [tenantId]);
    const gaps: Array<{ start_seq: number; end_seq: number; gap_size: number }> = [];

    for (const row of result.rows) {
      // Note: PostgreSQL BIGINT is returned as string by node-postgres, convert to number
      const currentSeq = Number(row.seq_num);
      const prevSeq = row.prev_seq_num !== null ? Number(row.prev_seq_num) : null;
      
      if (prevSeq !== null && currentSeq !== prevSeq + 1) {
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
