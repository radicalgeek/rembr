/**
 * Work Queue & Agent Handoff — REM-36
 *
 * Persistent multi-agent work queue with:
 *  - Priority-based item scheduling (critical > high > normal > low)
 *  - Claim/complete/fail lifecycle with lease timeouts
 *  - Agent handoff payloads: structured context for the next agent
 *  - Dead-letter queue for repeatedly failed items
 *  - Queue stats and health metrics
 */

import type { Pool } from 'pg';

// ─── Types ────────────────────────────────────────────────────────────────────

export type QueuePriority = 'critical' | 'high' | 'normal' | 'low';
export type QueueItemStatus = 'pending' | 'claimed' | 'completed' | 'failed' | 'dead_letter';

export interface HandoffPayload {
  /** Summary for the receiving agent */
  summary: string;
  /** Key context the next agent needs */
  context: Record<string, unknown>;
  /** Memory IDs relevant to this handoff */
  memory_ids?: string[];
  /** Specific instructions for the next agent */
  instructions?: string;
  /** Agent type expected to pick this up */
  target_agent_type?: string;
  /** Arbitrary metadata */
  metadata?: Record<string, unknown>;
}

export interface EnqueueOptions {
  queue_name: string;
  task_type: string;
  priority?: QueuePriority;
  payload: Record<string, unknown>;
  handoff?: HandoffPayload;
  /** Seconds until lease expires when claimed (default: 300) */
  lease_seconds?: number;
  /** Max attempts before dead-lettering (default: 3) */
  max_attempts?: number;
  /** ISO timestamp — earliest time this item should be processed */
  scheduled_after?: string;
  /** Idempotency key — prevents duplicate enqueue */
  idempotency_key?: string;
}

export interface QueueItem {
  id: string;
  tenant_id: string;
  queue_name: string;
  task_type: string;
  priority: QueuePriority;
  status: QueueItemStatus;
  payload: Record<string, unknown>;
  handoff: HandoffPayload | null;
  attempt_count: number;
  max_attempts: number;
  claimed_by: string | null;
  claimed_at: string | null;
  lease_expires_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  failure_reason: string | null;
  scheduled_after: string | null;
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
}

export interface ClaimResult {
  item: QueueItem;
  lease_expires_at: string;
}

export interface QueueStats {
  queue_name: string;
  tenant_id: string;
  pending: number;
  claimed: number;
  completed: number;
  failed: number;
  dead_letter: number;
  total: number;
  oldest_pending_age_seconds: number | null;
  avg_completion_seconds: number | null;
}

// ─── Schema ───────────────────────────────────────────────────────────────────

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS work_queue (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        UUID NOT NULL,
    queue_name       TEXT NOT NULL,
    task_type        TEXT NOT NULL,
    priority         TEXT NOT NULL DEFAULT 'normal'
                     CHECK (priority IN ('critical','high','normal','low')),
    status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','claimed','completed','failed','dead_letter')),
    payload          JSONB NOT NULL DEFAULT '{}',
    handoff          JSONB,
    attempt_count    INTEGER NOT NULL DEFAULT 0,
    max_attempts     INTEGER NOT NULL DEFAULT 3,
    claimed_by       TEXT,
    claimed_at       TIMESTAMPTZ,
    lease_expires_at TIMESTAMPTZ,
    completed_at     TIMESTAMPTZ,
    failed_at        TIMESTAMPTZ,
    failure_reason   TEXT,
    scheduled_after  TIMESTAMPTZ,
    idempotency_key  TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, idempotency_key)
  );

  CREATE INDEX IF NOT EXISTS idx_work_queue_claim
    ON work_queue (tenant_id, queue_name, status, priority DESC, scheduled_after ASC, created_at ASC)
    WHERE status = 'pending';

  CREATE INDEX IF NOT EXISTS idx_work_queue_lease_expiry
    ON work_queue (lease_expires_at)
    WHERE status = 'claimed';
`;

// Priority ordering (higher number = picked first)
const PRIORITY_ORDER: Record<QueuePriority, number> = {
  critical: 4,
  high: 3,
  normal: 2,
  low: 1,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function rowToItem(row: any): QueueItem {
  const toISO = (v: any) => (v instanceof Date ? v.toISOString() : v ? String(v) : null);
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    queue_name: row.queue_name,
    task_type: row.task_type,
    priority: row.priority,
    status: row.status,
    payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : (row.payload ?? {}),
    handoff: row.handoff ? (typeof row.handoff === 'string' ? JSON.parse(row.handoff) : row.handoff) : null,
    attempt_count: parseInt(row.attempt_count, 10),
    max_attempts: parseInt(row.max_attempts, 10),
    claimed_by: row.claimed_by ?? null,
    claimed_at: toISO(row.claimed_at),
    lease_expires_at: toISO(row.lease_expires_at),
    completed_at: toISO(row.completed_at),
    failed_at: toISO(row.failed_at),
    failure_reason: row.failure_reason ?? null,
    scheduled_after: toISO(row.scheduled_after),
    idempotency_key: row.idempotency_key ?? null,
    created_at: toISO(row.created_at) ?? '',
    updated_at: toISO(row.updated_at) ?? '',
  };
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class WorkQueueService {
  private schemaEnsured = false;

  constructor(private readonly pool: Pool) {}

  private async ensureSchema(): Promise<void> {
    if (this.schemaEnsured) return;
    const existing = await this.pool.query(`SELECT to_regclass('public.work_queue') AS table_name`);
    if (existing.rows.length === 0 || existing.rows[0]?.table_name) {
      this.schemaEnsured = true;
      return;
    }

    await this.pool.query(SCHEMA_SQL);
    this.schemaEnsured = true;
  }

  /**
   * Enqueue a new work item. Idempotent if idempotency_key provided.
   */
  async enqueue(tenantId: string, options: EnqueueOptions): Promise<QueueItem> {
    await this.ensureSchema();

    const result = await this.pool.query(`
      INSERT INTO work_queue
        (tenant_id, queue_name, task_type, priority, payload, handoff,
         max_attempts, lease_expires_at, scheduled_after, idempotency_key)
      VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,$8,$9)
      ON CONFLICT (tenant_id, idempotency_key)
        DO UPDATE SET updated_at = NOW()
      RETURNING *
    `, [
      tenantId,
      options.queue_name,
      options.task_type,
      options.priority ?? 'normal',
      JSON.stringify(options.payload),
      options.handoff ? JSON.stringify(options.handoff) : null,
      options.max_attempts ?? 3,
      options.scheduled_after ?? null,
      options.idempotency_key ?? null,
    ]);

    return rowToItem(result.rows[0]);
  }

  /**
   * Claim the next available item from a queue.
   * Returns null if nothing is available.
   */
  async claim(
    tenantId: string,
    queueName: string,
    agentId: string,
    leaseSeconds = 300,
  ): Promise<ClaimResult | null> {
    await this.ensureSchema();

    // Re-queue expired leases first
    await this.pool.query(`
      UPDATE work_queue
      SET status = 'pending', claimed_by = NULL, claimed_at = NULL, lease_expires_at = NULL,
          updated_at = NOW()
      WHERE tenant_id = $1 AND queue_name = $2 AND status = 'claimed'
        AND lease_expires_at < NOW()
    `, [tenantId, queueName]);

    // Atomically claim the highest-priority oldest-pending item
    const result = await this.pool.query(`
      UPDATE work_queue SET
        status = 'claimed',
        claimed_by = $3,
        claimed_at = NOW(),
        lease_expires_at = NOW() + ($4 || ' seconds')::INTERVAL,
        attempt_count = attempt_count + 1,
        updated_at = NOW()
      WHERE id = (
        SELECT id FROM work_queue
        WHERE tenant_id = $1 AND queue_name = $2 AND status = 'pending'
          AND (scheduled_after IS NULL OR scheduled_after <= NOW())
        ORDER BY
          CASE priority
            WHEN 'critical' THEN 4
            WHEN 'high'     THEN 3
            WHEN 'normal'   THEN 2
            WHEN 'low'      THEN 1
            ELSE 0
          END DESC,
          created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
    `, [tenantId, queueName, agentId, leaseSeconds]);

    if (result.rows.length === 0) return null;

    const item = rowToItem(result.rows[0]);
    return { item, lease_expires_at: item.lease_expires_at! };
  }

  /**
   * Complete a claimed item. Optionally attach a handoff for the next agent.
   */
  async complete(
    tenantId: string,
    itemId: string,
    agentId: string,
    resultHandoff?: HandoffPayload,
  ): Promise<QueueItem> {
    await this.ensureSchema();

    const result = await this.pool.query(`
      UPDATE work_queue SET
        status = 'completed',
        completed_at = NOW(),
        lease_expires_at = NULL,
        handoff = COALESCE($4, handoff),
        updated_at = NOW()
      WHERE id = $1 AND tenant_id = $2 AND claimed_by = $3 AND status = 'claimed'
      RETURNING *
    `, [itemId, tenantId, agentId, resultHandoff ? JSON.stringify(resultHandoff) : null]);

    if (result.rows.length === 0) {
      throw new Error(`Item ${itemId} not found or not claimed by ${agentId}`);
    }
    return rowToItem(result.rows[0]);
  }

  /**
   * Fail a claimed item. Auto dead-letters if attempt_count >= max_attempts.
   */
  async fail(
    tenantId: string,
    itemId: string,
    agentId: string,
    reason: string,
  ): Promise<QueueItem> {
    await this.ensureSchema();

    const result = await this.pool.query(`
      UPDATE work_queue SET
        status = CASE
          WHEN attempt_count >= max_attempts THEN 'dead_letter'
          ELSE 'failed'
        END,
        failed_at = NOW(),
        failure_reason = $4,
        claimed_by = NULL,
        lease_expires_at = NULL,
        updated_at = NOW()
      WHERE id = $1 AND tenant_id = $2 AND claimed_by = $3 AND status = 'claimed'
      RETURNING *
    `, [itemId, tenantId, agentId, reason]);

    if (result.rows.length === 0) {
      throw new Error(`Item ${itemId} not found or not claimed by ${agentId}`);
    }
    return rowToItem(result.rows[0]);
  }

  /**
   * Retry a failed item (reset to pending).
   */
  async retry(tenantId: string, itemId: string): Promise<QueueItem> {
    await this.ensureSchema();

    const result = await this.pool.query(`
      UPDATE work_queue SET
        status = 'pending',
        failed_at = NULL,
        failure_reason = NULL,
        claimed_by = NULL,
        claimed_at = NULL,
        lease_expires_at = NULL,
        updated_at = NOW()
      WHERE id = $1 AND tenant_id = $2 AND status IN ('failed','dead_letter')
      RETURNING *
    `, [itemId, tenantId]);

    if (result.rows.length === 0) {
      throw new Error(`Item ${itemId} not found or not in a retriable state`);
    }
    return rowToItem(result.rows[0]);
  }

  /**
   * Renew the lease on a claimed item.
   */
  async renewLease(
    tenantId: string,
    itemId: string,
    agentId: string,
    leaseSeconds = 300,
  ): Promise<QueueItem> {
    await this.ensureSchema();

    const result = await this.pool.query(`
      UPDATE work_queue SET
        lease_expires_at = NOW() + ($4 || ' seconds')::INTERVAL,
        updated_at = NOW()
      WHERE id = $1 AND tenant_id = $2 AND claimed_by = $3 AND status = 'claimed'
      RETURNING *
    `, [itemId, tenantId, agentId, leaseSeconds]);

    if (result.rows.length === 0) {
      throw new Error(`Item ${itemId} not found or not claimed by ${agentId}`);
    }
    return rowToItem(result.rows[0]);
  }

  /**
   * List items in a queue with optional filters.
   */
  async list(
    tenantId: string,
    options: {
      queue_name?: string;
      status?: QueueItemStatus | QueueItemStatus[];
      task_type?: string;
      claimed_by?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<{ items: QueueItem[]; total: number }> {
    await this.ensureSchema();

    const conditions: string[] = ['tenant_id = $1'];
    const params: unknown[] = [tenantId];
    let idx = 2;

    if (options.queue_name) {
      conditions.push(`queue_name = $${idx++}`);
      params.push(options.queue_name);
    }
    if (options.status) {
      const statuses = Array.isArray(options.status) ? options.status : [options.status];
      conditions.push(`status = ANY($${idx++})`);
      params.push(statuses);
    }
    if (options.task_type) {
      conditions.push(`task_type = $${idx++}`);
      params.push(options.task_type);
    }
    if (options.claimed_by) {
      conditions.push(`claimed_by = $${idx++}`);
      params.push(options.claimed_by);
    }

    const where = conditions.join(' AND ');
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;

    const [dataRes, countRes] = await Promise.all([
      this.pool.query(
        `SELECT * FROM work_queue WHERE ${where} ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, limit, offset],
      ),
      this.pool.query(`SELECT COUNT(*) FROM work_queue WHERE ${where}`, params),
    ]);

    return {
      items: dataRes.rows.map(rowToItem),
      total: parseInt(countRes.rows[0].count, 10),
    };
  }

  /**
   * Get a single item by ID.
   */
  async get(tenantId: string, itemId: string): Promise<QueueItem | null> {
    await this.ensureSchema();
    const result = await this.pool.query(
      'SELECT * FROM work_queue WHERE id = $1 AND tenant_id = $2',
      [itemId, tenantId],
    );
    return result.rows.length > 0 ? rowToItem(result.rows[0]) : null;
  }

  /**
   * Queue statistics.
   */
  async getStats(tenantId: string, queueName?: string): Promise<QueueStats[]> {
    await this.ensureSchema();

    const params: unknown[] = [tenantId];
    const queueFilter = queueName ? 'AND queue_name = $2' : '';
    if (queueName) params.push(queueName);

    const result = await this.pool.query(`
      WITH queue_rollup AS (
        SELECT
          queue_name,
          COUNT(*) FILTER (WHERE status = 'pending')     AS pending,
          COUNT(*) FILTER (WHERE status = 'claimed')     AS claimed,
          COUNT(*) FILTER (WHERE status = 'completed')   AS completed,
          COUNT(*) FILTER (WHERE status = 'failed')      AS failed,
          COUNT(*) FILTER (WHERE status = 'dead_letter') AS dead_letter,
          COUNT(*) AS total,
          MIN(created_at) FILTER (WHERE status = 'pending') AS oldest_pending_at,
          AVG(EXTRACT(EPOCH FROM (completed_at - claimed_at)))
            FILTER (WHERE status = 'completed' AND claimed_at IS NOT NULL AND completed_at IS NOT NULL)
            AS avg_completion_seconds
        FROM work_queue
        WHERE tenant_id = $1 ${queueFilter}
        GROUP BY queue_name
      )
      SELECT
        queue_name,
        $1::text AS tenant_id,
        pending,
        claimed,
        completed,
        failed,
        dead_letter,
        total,
        EXTRACT(EPOCH FROM (NOW() - oldest_pending_at)) AS oldest_pending_age_seconds,
        avg_completion_seconds
      FROM queue_rollup
      ORDER BY queue_name
    `, params);

    return result.rows.map(r => ({
      queue_name: r.queue_name,
      tenant_id: tenantId,
      pending: parseInt(r.pending, 10),
      claimed: parseInt(r.claimed, 10),
      completed: parseInt(r.completed, 10),
      failed: parseInt(r.failed, 10),
      dead_letter: parseInt(r.dead_letter, 10),
      total: parseInt(r.total, 10),
      oldest_pending_age_seconds: r.oldest_pending_age_seconds ? parseFloat(r.oldest_pending_age_seconds) : null,
      avg_completion_seconds: r.avg_completion_seconds ? parseFloat(r.avg_completion_seconds) : null,
    }));
  }

  /**
   * Bulk enqueue multiple items in a single transaction.
   * Returns the successfully created items and any failures.
   * RAD-16: Bulk operations for productivity.
   */
  async bulkEnqueue(
    tenantId: string,
    items: EnqueueOptions[],
  ): Promise<{ enqueued: QueueItem[]; failed: Array<{ index: number; error: string }> }> {
    await this.ensureSchema();

    const enqueued: QueueItem[] = [];
    const failed: Array<{ index: number; error: string }> = [];

    // Process in a single transaction for atomicity
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (let i = 0; i < items.length; i++) {
        const options = items[i];
        try {
          const result = await client.query(`
            INSERT INTO work_queue
              (tenant_id, queue_name, task_type, priority, payload, handoff,
               max_attempts, lease_expires_at, scheduled_after, idempotency_key)
            VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,$8,$9)
            ON CONFLICT (tenant_id, idempotency_key)
              DO UPDATE SET updated_at = NOW()
            RETURNING *
          `, [
            tenantId,
            options.queue_name,
            options.task_type,
            options.priority ?? 'normal',
            JSON.stringify(options.payload),
            options.handoff ? JSON.stringify(options.handoff) : null,
            options.max_attempts ?? 3,
            options.scheduled_after ?? null,
            options.idempotency_key ?? null,
          ]);
          enqueued.push(rowToItem(result.rows[0]));
        } catch (err) {
          failed.push({ index: i, error: err instanceof Error ? err.message : String(err) });
        }
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    return { enqueued, failed };
  }

  /**
   * Bulk complete multiple claimed items (e.g. batch job completion).
   * Returns per-item success/failure.
   */
  async bulkComplete(
    tenantId: string,
    completions: Array<{ item_id: string; agent_id: string; handoff?: HandoffPayload }>,
  ): Promise<{ completed: QueueItem[]; failed: Array<{ item_id: string; error: string }> }> {
    await this.ensureSchema();

    const completed: QueueItem[] = [];
    const failed: Array<{ item_id: string; error: string }> = [];

    for (const { item_id, agent_id, handoff } of completions) {
      try {
        const item = await this.complete(tenantId, item_id, agent_id, handoff);
        completed.push(item);
      } catch (err) {
        failed.push({ item_id, error: err instanceof Error ? err.message : String(err) });
      }
    }

    return { completed, failed };
  }

  /**
   * Purge completed/dead-letter items older than N days.
   */
  async purge(tenantId: string, queueName: string, olderThanDays = 7): Promise<number> {
    await this.ensureSchema();
    const result = await this.pool.query(`
      DELETE FROM work_queue
      WHERE tenant_id = $1 AND queue_name = $2
        AND status IN ('completed', 'dead_letter')
        AND updated_at < NOW() - ($3 || ' days')::INTERVAL
    `, [tenantId, queueName, olderThanDays]);
    return result.rowCount ?? 0;
  }
}
