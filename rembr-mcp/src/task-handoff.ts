/**
 * Task Handoff Service (REM-73)
 * 
 * Manages inter-agent task handoffs with workflow support.
 * Enables tasks to be transferred between agents with context preservation.
 */

import type { Pool } from 'pg';
import { randomUUID } from 'crypto';

export interface HandoffContext {
  current_state?: string;
  progress?: string;
  blockers?: string[];
  notes?: string;
  artifacts?: string[];
  [key: string]: unknown;
}

export interface TaskHandoff {
  id: string;
  tenant_id: string;
  task_id: string;
  from_agent: string;
  to_agent: string;
  reason: string;
  context: HandoffContext;
  status: 'pending' | 'accepted' | 'rejected';
  created_at: Date;
  accepted_at?: Date;
  rejected_at?: Date;
  rejection_reason?: string;
  metadata: Record<string, unknown>;
}

/**
 * Create a task handoff request
 */
export async function createHandoff(
  pool: Pool,
  tenantId: string,
  taskId: string,
  fromAgent: string,
  toAgent: string,
  reason: string,
  context: HandoffContext = {}
): Promise<TaskHandoff> {
  const query = `
    INSERT INTO task_handoffs (
      id,
      tenant_id,
      task_id,
      from_agent,
      to_agent,
      reason,
      context,
      status,
      metadata
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', '{}')
    RETURNING *
  `;

  const result = await pool.query(query, [
    randomUUID(),
    tenantId,
    taskId,
    fromAgent,
    toAgent,
    reason,
    JSON.stringify(context),
  ]);

  const row = result.rows[0];

  return {
    id: row.id,
    tenant_id: row.tenant_id,
    task_id: row.task_id,
    from_agent: row.from_agent,
    to_agent: row.to_agent,
    reason: row.reason,
    context: row.context,
    status: row.status,
    created_at: row.created_at,
    accepted_at: row.accepted_at,
    rejected_at: row.rejected_at,
    rejection_reason: row.rejection_reason,
    metadata: row.metadata,
  };
}

/**
 * Accept a handoff
 */
export async function acceptHandoff(
  pool: Pool,
  tenantId: string,
  handoffId: string,
  toAgent: string
): Promise<TaskHandoff> {
  // Verify the handoff is for this agent and is pending
  const checkQuery = `
    SELECT * FROM task_handoffs
    WHERE tenant_id = $1 AND id = $2 AND to_agent = $3 AND status = 'pending'
  `;

  const checkResult = await pool.query(checkQuery, [tenantId, handoffId, toAgent]);

  if (checkResult.rows.length === 0) {
    throw new Error('Handoff not found, not for this agent, or already processed');
  }

  // Update handoff status
  const updateQuery = `
    UPDATE task_handoffs
    SET status = 'accepted', accepted_at = NOW()
    WHERE tenant_id = $1 AND id = $2
    RETURNING *
  `;

  const result = await pool.query(updateQuery, [tenantId, handoffId]);
  const row = result.rows[0];

  return {
    id: row.id,
    tenant_id: row.tenant_id,
    task_id: row.task_id,
    from_agent: row.from_agent,
    to_agent: row.to_agent,
    reason: row.reason,
    context: row.context,
    status: row.status,
    created_at: row.created_at,
    accepted_at: row.accepted_at,
    rejected_at: row.rejected_at,
    rejection_reason: row.rejection_reason,
    metadata: row.metadata,
  };
}

/**
 * Reject a handoff
 */
export async function rejectHandoff(
  pool: Pool,
  tenantId: string,
  handoffId: string,
  toAgent: string,
  rejectionReason: string
): Promise<TaskHandoff> {
  // Verify the handoff is for this agent and is pending
  const checkQuery = `
    SELECT * FROM task_handoffs
    WHERE tenant_id = $1 AND id = $2 AND to_agent = $3 AND status = 'pending'
  `;

  const checkResult = await pool.query(checkQuery, [tenantId, handoffId, toAgent]);

  if (checkResult.rows.length === 0) {
    throw new Error('Handoff not found, not for this agent, or already processed');
  }

  // Update handoff status
  const updateQuery = `
    UPDATE task_handoffs
    SET status = 'rejected', rejected_at = NOW(), rejection_reason = $3
    WHERE tenant_id = $1 AND id = $2
    RETURNING *
  `;

  const result = await pool.query(updateQuery, [tenantId, handoffId, rejectionReason]);
  const row = result.rows[0];

  return {
    id: row.id,
    tenant_id: row.tenant_id,
    task_id: row.task_id,
    from_agent: row.from_agent,
    to_agent: row.to_agent,
    reason: row.reason,
    context: row.context,
    status: row.status,
    created_at: row.created_at,
    accepted_at: row.accepted_at,
    rejected_at: row.rejected_at,
    rejection_reason: row.rejection_reason,
    metadata: row.metadata,
  };
}

/**
 * List pending handoffs for an agent
 */
export async function listPendingHandoffs(
  pool: Pool,
  tenantId: string,
  agentId: string,
  options: {
    includeFrom?: boolean;  // Include handoffs from this agent
    includeTo?: boolean;    // Include handoffs to this agent
  } = {}
): Promise<TaskHandoff[]> {
  const { includeFrom = false, includeTo = true } = options;

  const conditions: string[] = [];
  const params: unknown[] = [tenantId];

  if (includeTo && includeFrom) {
    conditions.push('(to_agent = $2 OR from_agent = $2)');
    params.push(agentId);
  } else if (includeTo) {
    conditions.push('to_agent = $2');
    params.push(agentId);
  } else if (includeFrom) {
    conditions.push('from_agent = $2');
    params.push(agentId);
  } else {
    // Default to includeTo if both are false
    conditions.push('to_agent = $2');
    params.push(agentId);
  }

  const query = `
    SELECT * FROM task_handoffs
    WHERE tenant_id = $1 AND status = 'pending' AND ${conditions.join(' AND ')}
    ORDER BY created_at DESC
  `;

  const result = await pool.query(query, params);

  return result.rows.map(row => ({
    id: row.id,
    tenant_id: row.tenant_id,
    task_id: row.task_id,
    from_agent: row.from_agent,
    to_agent: row.to_agent,
    reason: row.reason,
    context: row.context,
    status: row.status,
    created_at: row.created_at,
    accepted_at: row.accepted_at,
    rejected_at: row.rejected_at,
    rejection_reason: row.rejection_reason,
    metadata: row.metadata,
  }));
}

/**
 * Get handoff by ID
 */
export async function getHandoff(
  pool: Pool,
  tenantId: string,
  handoffId: string
): Promise<TaskHandoff | null> {
  const query = `
    SELECT * FROM task_handoffs
    WHERE tenant_id = $1 AND id = $2
  `;

  const result = await pool.query(query, [tenantId, handoffId]);

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];

  return {
    id: row.id,
    tenant_id: row.tenant_id,
    task_id: row.task_id,
    from_agent: row.from_agent,
    to_agent: row.to_agent,
    reason: row.reason,
    context: row.context,
    status: row.status,
    created_at: row.created_at,
    accepted_at: row.accepted_at,
    rejected_at: row.rejected_at,
    rejection_reason: row.rejection_reason,
    metadata: row.metadata,
  };
}

/**
 * Get handoff history for a task
 */
export async function getTaskHandoffHistory(
  pool: Pool,
  tenantId: string,
  taskId: string,
  limit = 10
): Promise<TaskHandoff[]> {
  const query = `
    SELECT * FROM task_handoffs
    WHERE tenant_id = $1 AND task_id = $2
    ORDER BY created_at DESC
    LIMIT $3
  `;

  const result = await pool.query(query, [tenantId, taskId, limit]);

  return result.rows.map(row => ({
    id: row.id,
    tenant_id: row.tenant_id,
    task_id: row.task_id,
    from_agent: row.from_agent,
    to_agent: row.to_agent,
    reason: row.reason,
    context: row.context,
    status: row.status,
    created_at: row.created_at,
    accepted_at: row.accepted_at,
    rejected_at: row.rejected_at,
    rejection_reason: row.rejection_reason,
    metadata: row.metadata,
  }));
}
