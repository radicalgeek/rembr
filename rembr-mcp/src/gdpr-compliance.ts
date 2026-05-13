/**
 * GDPR Compliance Service (REM-29)
 *
 * Provides:
 * - Right to erasure (forget-me) — deletes all tenant/user data
 * - Retention policy management — per-memory TTL with scheduled cleanup
 * - Consent audit trail — append-only log of consent/deletion events
 * - Data export (GDPR Article 20 portability)
 */

import type { Pool, PoolClient } from 'pg';
import { randomUUID } from 'crypto';

// ─── Types ────────────────────────────────────────────────────────────────────

export type RetentionPolicy = 'standard' | 'extended' | 'minimal' | 'gdpr_deleted';
export type DeletionRequestType = 'full' | 'selective' | 'export';
export type DeletionStatus = 'pending' | 'processing' | 'completed' | 'failed';
export type ConsentEventType =
  | 'consent_given'
  | 'consent_withdrawn'
  | 'data_accessed'
  | 'data_exported'
  | 'data_deleted'
  | 'retention_policy_changed'
  | 'pii_detected'
  | 'pii_scanned';

export interface DeletionRequest {
  id: string;
  tenant_id: string;
  user_id?: string;
  requested_by_user_id?: string;
  request_type: DeletionRequestType;
  status: DeletionStatus;
  memories_deleted: number;
  contexts_deleted: number;
  snapshots_deleted: number;
  error_message?: string;
  completed_at?: Date;
  created_at: Date;
  updated_at: Date;
}

export interface ConsentEvent {
  id: string;
  tenant_id: string;
  user_id?: string;
  event_type: ConsentEventType;
  resource_type?: string;
  resource_id?: string;
  previous_value?: Record<string, unknown>;
  new_value?: Record<string, unknown>;
  ip_address?: string;
  user_agent?: string;
  created_at: Date;
}

export interface GDPRExport {
  tenant_id: string;
  exported_at: string;
  memories: Record<string, unknown>[];
  contexts: Record<string, unknown>[];
  consent_events: Record<string, unknown>[];
  total_memories: number;
  pii_detected_count: number;
}

export interface RetentionStats {
  total_memories: number;
  pii_detected: number;
  expired: number;
  by_policy: Record<RetentionPolicy, number>;
}

// ─── Retention policy TTLs (days) ─────────────────────────────────────────────

const RETENTION_DAYS: Record<RetentionPolicy, number | null> = {
  standard: 365,       // 1 year
  extended: 1825,      // 5 years
  minimal: 30,         // 30 days
  gdpr_deleted: 0,     // immediate (tombstone)
};

// ─── Service ──────────────────────────────────────────────────────────────────

export class GDPRComplianceService {
  constructor(private pool: Pool) {}

  // ── Schema ──────────────────────────────────────────────────────────────────

  async ensureSchema(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS gdpr_deletion_requests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL,
        user_id UUID,
        requested_by_user_id UUID,
        request_type VARCHAR(50) NOT NULL DEFAULT 'full',
        status VARCHAR(50) NOT NULL DEFAULT 'pending',
        memories_deleted INTEGER DEFAULT 0,
        contexts_deleted INTEGER DEFAULT 0,
        snapshots_deleted INTEGER DEFAULT 0,
        error_message TEXT,
        completed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS gdpr_consent_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL,
        user_id UUID,
        event_type VARCHAR(100) NOT NULL,
        resource_type VARCHAR(50),
        resource_id UUID,
        previous_value JSONB,
        new_value JSONB,
        ip_address INET,
        user_agent TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      DO $$ BEGIN
        ALTER TABLE memories ADD COLUMN IF NOT EXISTS pii_detected BOOLEAN DEFAULT FALSE;
        ALTER TABLE memories ADD COLUMN IF NOT EXISTS pii_types TEXT[] DEFAULT '{}';
        ALTER TABLE memories ADD COLUMN IF NOT EXISTS pii_confidence FLOAT;
        ALTER TABLE memories ADD COLUMN IF NOT EXISTS pii_scanned_at TIMESTAMPTZ;
        ALTER TABLE memories ADD COLUMN IF NOT EXISTS retention_policy VARCHAR(50) DEFAULT 'standard';
        ALTER TABLE memories ADD COLUMN IF NOT EXISTS retention_expires_at TIMESTAMPTZ;
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;

      CREATE INDEX IF NOT EXISTS idx_gdpr_deletion_tenant ON gdpr_deletion_requests(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_gdpr_deletion_status ON gdpr_deletion_requests(status);
      CREATE INDEX IF NOT EXISTS idx_gdpr_consent_tenant ON gdpr_consent_events(tenant_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memories_retention ON memories(retention_expires_at) WHERE retention_expires_at IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_memories_pii ON memories(tenant_id) WHERE pii_detected = TRUE;
    `);
  }

  // ── Right to Erasure ────────────────────────────────────────────────────────

  /**
   * Submit a GDPR deletion request. Processing is async — call processForgetMe() to execute.
   */
  async requestForgetMe(
    tenantId: string,
    opts: {
      user_id?: string;
      requested_by_user_id?: string;
      request_type?: DeletionRequestType;
      ip_address?: string;
      user_agent?: string;
    } = {}
  ): Promise<DeletionRequest> {
    await this.ensureSchema();

    const id = randomUUID();
    const res = await this.pool.query<DeletionRequest>(
      `INSERT INTO gdpr_deletion_requests
         (id, tenant_id, user_id, requested_by_user_id, request_type, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')
       RETURNING *`,
      [id, tenantId, opts.user_id ?? null, opts.requested_by_user_id ?? null, opts.request_type ?? 'full']
    );

    await this.logConsentEvent(tenantId, {
      event_type: 'consent_withdrawn',
      user_id: opts.user_id,
      resource_type: 'account',
      new_value: { deletion_request_id: id, request_type: opts.request_type ?? 'full' },
      ip_address: opts.ip_address,
      user_agent: opts.user_agent,
    });

    return res.rows[0];
  }

  /**
   * Execute a pending deletion request — deletes memories, contexts, snapshots.
   * Leaves the tenant record intact (billing/audit purposes) but marks memories as gdpr_deleted.
   */
  async processForgetMe(requestId: string, tenantId: string): Promise<DeletionRequest> {
    await this.ensureSchema();

    // Mark as processing
    await this.pool.query(
      `UPDATE gdpr_deletion_requests SET status = 'processing', updated_at = NOW() WHERE id = $1 AND tenant_id = $2`,
      [requestId, tenantId]
    );

    const client = await this.pool.connect();
    let memoriesDeleted = 0;
    let contextsDeleted = 0;
    let snapshotsDeleted = 0;

    try {
      await client.query('BEGIN');

      // 1. Count and soft-delete memories (overwrite content, mark gdpr_deleted)
      const memCount = await client.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM memories WHERE tenant_id = $1 AND retention_policy != 'gdpr_deleted'`,
        [tenantId]
      );
      memoriesDeleted = parseInt(memCount.rows[0].count, 10);

      await client.query(
        `UPDATE memories
         SET content = '[GDPR DELETED]',
             metadata = '{}',
             embedding = NULL,
             pii_detected = FALSE,
             pii_types = '{}',
             pii_confidence = NULL,
             retention_policy = 'gdpr_deleted',
             retention_expires_at = NOW(),
             updated_at = NOW()
         WHERE tenant_id = $1`,
        [tenantId]
      );

      // 2. Delete snapshot_memories associations
      const snapRes = await client.query<{ count: string }>(
        `SELECT COUNT(DISTINCT cs.id) as count
         FROM context_snapshots cs
         WHERE cs.context_id IN (
           SELECT id FROM contexts WHERE project_id IN (
             SELECT id FROM projects WHERE tenant_id = $1
           )
         )`,
        [tenantId]
      );
      snapshotsDeleted = parseInt(snapRes.rows[0]?.count ?? '0', 10);

      // Delete snapshot_memories but keep snapshot metadata for audit
      await client.query(
        `DELETE FROM snapshot_memories
         WHERE snapshot_id IN (
           SELECT cs.id FROM context_snapshots cs
           JOIN contexts c ON cs.context_id = c.id
           JOIN projects p ON c.project_id = p.id
           WHERE p.tenant_id = $1
         )`,
        [tenantId]
      );

      // 3. Purge memory_embeddings (vectors contain content-derived data)
      await client.query(
        `DELETE FROM memory_embeddings WHERE memory_id IN (SELECT id FROM memories WHERE tenant_id = $1)`,
        [tenantId]
      );

      // 4. Clear context_memories associations
      const ctxRes = await client.query<{ count: string }>(
        `SELECT COUNT(DISTINCT c.id) as count FROM contexts c
         JOIN projects p ON c.project_id = p.id WHERE p.tenant_id = $1`,
        [tenantId]
      );
      contextsDeleted = parseInt(ctxRes.rows[0]?.count ?? '0', 10);

      await client.query(
        `DELETE FROM context_memories
         WHERE context_id IN (
           SELECT c.id FROM contexts c
           JOIN projects p ON c.project_id = p.id
           WHERE p.tenant_id = $1
         )`,
        [tenantId]
      );

      // 5. Mark deletion request complete
      await client.query(
        `UPDATE gdpr_deletion_requests
         SET status = 'completed',
             memories_deleted = $2,
             contexts_deleted = $3,
             snapshots_deleted = $4,
             completed_at = NOW(),
             updated_at = NOW()
         WHERE id = $1`,
        [requestId, memoriesDeleted, contextsDeleted, snapshotsDeleted]
      );

      await client.query('COMMIT');

      // Log consent event
      await this.logConsentEvent(tenantId, {
        event_type: 'data_deleted',
        resource_type: 'account',
        new_value: {
          deletion_request_id: requestId,
          memories_deleted: memoriesDeleted,
          contexts_deleted: contextsDeleted,
          snapshots_deleted: snapshotsDeleted,
        },
      });

      const res = await this.pool.query<DeletionRequest>(
        `SELECT * FROM gdpr_deletion_requests WHERE id = $1`,
        [requestId]
      );
      return res.rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      await this.pool.query(
        `UPDATE gdpr_deletion_requests
         SET status = 'failed', error_message = $2, updated_at = NOW()
         WHERE id = $1`,
        [requestId, err instanceof Error ? err.message : String(err)]
      );
      throw err;
    } finally {
      client.release();
    }
  }

  getDeletionRequest(requestId: string, tenantId: string): Promise<DeletionRequest | null> {
    return this.ensureSchema().then(() =>
      this.pool.query<DeletionRequest>(
        `SELECT * FROM gdpr_deletion_requests WHERE id = $1 AND tenant_id = $2`,
        [requestId, tenantId]
      ).then(r => r.rows[0] ?? null)
    );
  }

  listDeletionRequests(tenantId: string): Promise<DeletionRequest[]> {
    return this.ensureSchema().then(() =>
      this.pool.query<DeletionRequest>(
        `SELECT * FROM gdpr_deletion_requests WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [tenantId]
      ).then(r => r.rows)
    );
  }

  // ── Retention Policies ──────────────────────────────────────────────────────

  async setRetentionPolicy(
    tenantId: string,
    memoryId: string,
    policy: RetentionPolicy,
    opts: { user_id?: string; ip_address?: string } = {}
  ): Promise<void> {
    await this.ensureSchema();

    const days = RETENTION_DAYS[policy];
    const expiresAt = days !== null && days > 0
      ? new Date(Date.now() + days * 86400 * 1000).toISOString()
      : null;

    const prev = await this.pool.query(
      `SELECT retention_policy FROM memories WHERE id = $1 AND tenant_id = $2`,
      [memoryId, tenantId]
    );

    await this.pool.query(
      `UPDATE memories
       SET retention_policy = $1, retention_expires_at = $2, updated_at = NOW()
       WHERE id = $3 AND tenant_id = $4`,
      [policy, expiresAt, memoryId, tenantId]
    );

    await this.logConsentEvent(tenantId, {
      event_type: 'retention_policy_changed',
      resource_type: 'memory',
      resource_id: memoryId,
      user_id: opts.user_id,
      previous_value: { retention_policy: prev.rows[0]?.retention_policy },
      new_value: { retention_policy: policy, retention_expires_at: expiresAt },
      ip_address: opts.ip_address,
    });
  }

  /**
   * Purge expired memories. Call this on a scheduled basis (e.g. daily cron).
   * Returns count of memories deleted.
   */
  /**
   * Purge expired memories for a specific tenant.
   * tenantId is required — cross-tenant purge is not supported (RLS violation).
   * For scheduled admin-level cleanup, call this once per tenant.
   */
  async purgeExpiredMemories(tenantId: string): Promise<number> {
    await this.ensureSchema();

    const res = await this.pool.query(
      `DELETE FROM memories
       WHERE tenant_id = $1
         AND retention_expires_at <= $2
         AND retention_policy != 'gdpr_deleted'
       RETURNING id`,
      [tenantId, new Date().toISOString()]
    );
    return res.rowCount ?? 0;
  }

  async getRetentionStats(tenantId: string): Promise<RetentionStats> {
    await this.ensureSchema();

    const res = await this.pool.query<{
      total: string; pii: string; expired: string;
      standard: string; extended: string; minimal: string; gdpr_deleted: string;
    }>(
      `SELECT
         COUNT(*) as total,
         COUNT(*) FILTER (WHERE pii_detected = TRUE) as pii,
         COUNT(*) FILTER (WHERE retention_expires_at <= NOW()) as expired,
         COUNT(*) FILTER (WHERE retention_policy = 'standard') as standard,
         COUNT(*) FILTER (WHERE retention_policy = 'extended') as extended,
         COUNT(*) FILTER (WHERE retention_policy = 'minimal') as minimal,
         COUNT(*) FILTER (WHERE retention_policy = 'gdpr_deleted') as gdpr_deleted
       FROM memories WHERE tenant_id = $1`,
      [tenantId]
    );

    const r = res.rows[0];
    return {
      total_memories: parseInt(r.total, 10),
      pii_detected: parseInt(r.pii, 10),
      expired: parseInt(r.expired, 10),
      by_policy: {
        standard: parseInt(r.standard, 10),
        extended: parseInt(r.extended, 10),
        minimal: parseInt(r.minimal, 10),
        gdpr_deleted: parseInt(r.gdpr_deleted, 10),
      },
    };
  }

  // ── Consent Audit Trail ──────────────────────────────────────────────────────

  async logConsentEvent(
    tenantId: string,
    event: {
      event_type: ConsentEventType;
      user_id?: string;
      resource_type?: string;
      resource_id?: string;
      previous_value?: Record<string, unknown>;
      new_value?: Record<string, unknown>;
      ip_address?: string;
      user_agent?: string;
    }
  ): Promise<ConsentEvent> {
    const res = await this.pool.query<ConsentEvent>(
      `INSERT INTO gdpr_consent_events
         (id, tenant_id, user_id, event_type, resource_type, resource_id,
          previous_value, new_value, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        randomUUID(), tenantId,
        event.user_id ?? null,
        event.event_type,
        event.resource_type ?? null,
        event.resource_id ?? null,
        event.previous_value ? JSON.stringify(event.previous_value) : null,
        event.new_value ? JSON.stringify(event.new_value) : null,
        event.ip_address ?? null,
        event.user_agent ?? null,
      ]
    );
    return res.rows[0];
  }

  async getConsentAuditTrail(
    tenantId: string,
    opts: { user_id?: string; limit?: number; offset?: number; event_type?: ConsentEventType }
  ): Promise<{ events: ConsentEvent[]; total: number }> {
    await this.ensureSchema();

    const conditions: string[] = ['tenant_id = $1'];
    const params: unknown[] = [tenantId];
    let p = 2;

    if (opts.user_id) { conditions.push(`user_id = $${p++}`); params.push(opts.user_id); }
    if (opts.event_type) { conditions.push(`event_type = $${p++}`); params.push(opts.event_type); }

    const where = conditions.join(' AND ');
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;

    const [events, total] = await Promise.all([
      this.pool.query<ConsentEvent>(
        `SELECT * FROM gdpr_consent_events WHERE ${where} ORDER BY created_at DESC LIMIT $${p} OFFSET $${p + 1}`,
        [...params, limit, offset]
      ),
      this.pool.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM gdpr_consent_events WHERE ${where}`,
        params
      ),
    ]);

    return { events: events.rows, total: parseInt(total.rows[0].count, 10) };
  }

  // ── Data Export (Article 20 portability) ────────────────────────────────────

  async exportData(tenantId: string, userId?: string): Promise<GDPRExport> {
    await this.ensureSchema();

    const userFilter = userId ? 'AND user_id = $2' : '';
    const params: unknown[] = [tenantId];
    if (userId) params.push(userId);

    const [memories, contexts, consentEvents] = await Promise.all([
      this.pool.query(
        `SELECT id, content, category, metadata, pii_detected, pii_types,
                retention_policy, created_at, updated_at
         FROM memories WHERE tenant_id = $1 ${userFilter}
         AND retention_policy != 'gdpr_deleted'
         ORDER BY created_at DESC`,
        params
      ),
      this.pool.query(
        `SELECT c.id, c.name, c.description, c.created_at
         FROM contexts c
         JOIN projects p ON c.project_id = p.id
         WHERE p.tenant_id = $1
         ORDER BY c.created_at DESC`,
        [tenantId]
      ),
      this.pool.query(
        `SELECT id, event_type, resource_type, resource_id, new_value, created_at
         FROM gdpr_consent_events WHERE tenant_id = $1 ${userFilter}
         ORDER BY created_at DESC LIMIT 500`,
        params
      ),
    ]);

    const piiCount = memories.rows.filter((m: any) => m.pii_detected).length;

    await this.logConsentEvent(tenantId, {
      event_type: 'data_exported',
      user_id: userId,
      resource_type: 'account',
      new_value: {
        memories_exported: memories.rows.length,
        exported_at: new Date().toISOString(),
      },
    });

    return {
      tenant_id: tenantId,
      exported_at: new Date().toISOString(),
      memories: memories.rows,
      contexts: contexts.rows,
      consent_events: consentEvents.rows,
      total_memories: memories.rows.length,
      pii_detected_count: piiCount,
    };
  }
}
