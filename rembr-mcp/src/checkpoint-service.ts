/**
 * Checkpoint Service (REM-98)
 * 
 * Provides pre-compression checkpoint functionality for ContextPilot.
 * Auto-saves critical agent state before context compression occurs.
 */

import type { Pool } from 'pg';
import { randomUUID } from 'crypto';

export interface CheckpointDecision {
  timestamp: Date;
  decision: string;
  rationale?: string;
  impact?: string;
}

export interface CheckpointPendingItem {
  type: 'task' | 'action' | 'question' | 'file';
  description: string;
  priority?: 'critical' | 'high' | 'medium' | 'low';
  due_by?: Date;
}

export interface CheckpointLifeboat {
  objective: string;
  current_task?: string;
  key_decisions: string[];
  pending_critical: string[];
  file_paths: string[];
  success_signal?: string;
  timestamp: Date;
}

export interface CheckpointRequest {
  session_id: string;
  checkpoint_type?: 'compression' | 'manual' | 'scheduled';
  token_count_before: number;
  current_task?: string;
  objective?: string;
  decisions: CheckpointDecision[];
  pending_items: CheckpointPendingItem[];
  file_paths?: string[];
  success_signal?: string;
  compression_strategy?: string;
  metadata?: Record<string, unknown>;
}

export interface Checkpoint {
  id: string;
  tenant_id: string;
  session_id: string;
  checkpoint_type: string;
  token_count_before: number;
  token_count_after: number | null;
  decisions_snapshot: CheckpointDecision[];
  pending_snapshot: CheckpointPendingItem[];
  lifeboat_snapshot: CheckpointLifeboat;
  linked_memory_ids: string[];
  compression_strategy: string | null;
  created_at: Date;
  metadata: Record<string, unknown>;
}

export interface CheckpointHistory {
  checkpoints: Checkpoint[];
  total_count: number;
  compression_count: number;
  manual_count: number;
  latest_checkpoint: Checkpoint | null;
}

/**
 * Create a checkpoint
 */
export async function createCheckpoint(
  pool: Pool,
  tenantId: string,
  request: CheckpointRequest
): Promise<Checkpoint> {
  // Generate lifeboat snapshot (NOW.md-style compact summary)
  const lifeboat = generateLifeboat(request);
  
  // Ensure lifeboat is under 1k tokens (~4k chars)
  const lifeboatText = JSON.stringify(lifeboat);
  if (lifeboatText.length > 4000) {
    throw new Error(`Lifeboat too large: ${lifeboatText.length} chars (max 4000)`);
  }
  
  const query = `
    INSERT INTO context_checkpoints (
      id,
      tenant_id,
      session_id,
      checkpoint_type,
      token_count_before,
      decisions_snapshot,
      pending_snapshot,
      lifeboat_snapshot,
      compression_strategy,
      metadata
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    RETURNING *
  `;
  
  const result = await pool.query(query, [
    randomUUID(),
    tenantId,
    request.session_id,
    request.checkpoint_type || 'manual',
    request.token_count_before,
    JSON.stringify(request.decisions),
    JSON.stringify(request.pending_items),
    JSON.stringify(lifeboat),
    request.compression_strategy || null,
    JSON.stringify(request.metadata || {}),
  ]);
  
  const row = result.rows[0];
  
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    session_id: row.session_id,
    checkpoint_type: row.checkpoint_type,
    token_count_before: row.token_count_before,
    token_count_after: row.token_count_after,
    decisions_snapshot: row.decisions_snapshot,
    pending_snapshot: row.pending_snapshot,
    lifeboat_snapshot: row.lifeboat_snapshot,
    linked_memory_ids: row.linked_memory_ids || [],
    compression_strategy: row.compression_strategy,
    created_at: row.created_at,
    metadata: row.metadata || {},
  };
}

/**
 * Generate NOW.md-style lifeboat (<1k tokens)
 */
function generateLifeboat(request: CheckpointRequest): CheckpointLifeboat {
  // Extract critical info only
  const keyDecisions = request.decisions
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
    .slice(0, 5) // Top 5 most recent decisions
    .map(d => d.decision);
  
  const pendingCritical = request.pending_items
    .filter(p => p.priority === 'critical' || p.priority === 'high')
    .slice(0, 5) // Top 5 critical pending items
    .map(p => `${p.type}: ${p.description}`);
  
  const filePaths = (request.file_paths || []).slice(0, 10); // Top 10 file paths
  
  return {
    objective: request.objective || 'No objective specified',
    current_task: request.current_task,
    key_decisions: keyDecisions,
    pending_critical: pendingCritical,
    file_paths: filePaths,
    success_signal: request.success_signal,
    timestamp: new Date(),
  };
}

/**
 * Get latest checkpoint for a session
 */
export async function getLatestCheckpoint(
  pool: Pool,
  tenantId: string,
  sessionId: string
): Promise<Checkpoint | null> {
  const query = `
    SELECT * FROM context_checkpoints
    WHERE tenant_id = $1 AND session_id = $2
    ORDER BY created_at DESC
    LIMIT 1
  `;
  
  const result = await pool.query(query, [tenantId, sessionId]);
  
  if (result.rows.length === 0) {
    return null;
  }
  
  const row = result.rows[0];
  
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    session_id: row.session_id,
    checkpoint_type: row.checkpoint_type,
    token_count_before: row.token_count_before,
    token_count_after: row.token_count_after,
    decisions_snapshot: row.decisions_snapshot,
    pending_snapshot: row.pending_snapshot,
    lifeboat_snapshot: row.lifeboat_snapshot,
    linked_memory_ids: row.linked_memory_ids || [],
    compression_strategy: row.compression_strategy,
    created_at: row.created_at,
    metadata: row.metadata || {},
  };
}

/**
 * Get checkpoint history for a session
 */
export async function getCheckpointHistory(
  pool: Pool,
  tenantId: string,
  sessionId: string,
  limit = 10
): Promise<CheckpointHistory> {
  const query = `
    SELECT * FROM context_checkpoints
    WHERE tenant_id = $1 AND session_id = $2
    ORDER BY created_at DESC
    LIMIT $3
  `;
  
  const result = await pool.query(query, [tenantId, sessionId, limit]);
  
  const checkpoints: Checkpoint[] = result.rows.map(row => ({
    id: row.id,
    tenant_id: row.tenant_id,
    session_id: row.session_id,
    checkpoint_type: row.checkpoint_type,
    token_count_before: row.token_count_before,
    token_count_after: row.token_count_after,
    decisions_snapshot: row.decisions_snapshot,
    pending_snapshot: row.pending_snapshot,
    lifeboat_snapshot: row.lifeboat_snapshot,
    linked_memory_ids: row.linked_memory_ids || [],
    compression_strategy: row.compression_strategy,
    created_at: row.created_at,
    metadata: row.metadata || {},
  }));
  
  const total_count = checkpoints.length;
  const compression_count = checkpoints.filter(c => c.checkpoint_type === 'compression').length;
  const manual_count = checkpoints.filter(c => c.checkpoint_type === 'manual').length;
  const latest_checkpoint = checkpoints[0] || null;
  
  return {
    checkpoints,
    total_count,
    compression_count,
    manual_count,
    latest_checkpoint,
  };
}

/**
 * Check if checkpoint should be triggered based on token usage
 */
export function shouldTriggerCheckpoint(
  currentTokens: number,
  maxTokens: number,
  threshold = 0.70
): boolean {
  const usage = currentTokens / maxTokens;
  return usage >= threshold;
}

/**
 * Get checkpoint by ID
 */
export async function getCheckpoint(
  pool: Pool,
  tenantId: string,
  checkpointId: string
): Promise<Checkpoint | null> {
  const query = `
    SELECT * FROM context_checkpoints
    WHERE tenant_id = $1 AND id = $2
  `;
  
  const result = await pool.query(query, [tenantId, checkpointId]);
  
  if (result.rows.length === 0) {
    return null;
  }
  
  const row = result.rows[0];
  
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    session_id: row.session_id,
    checkpoint_type: row.checkpoint_type,
    token_count_before: row.token_count_before,
    token_count_after: row.token_count_after,
    decisions_snapshot: row.decisions_snapshot,
    pending_snapshot: row.pending_snapshot,
    lifeboat_snapshot: row.lifeboat_snapshot,
    linked_memory_ids: row.linked_memory_ids || [],
    compression_strategy: row.compression_strategy,
    created_at: row.created_at,
    metadata: row.metadata || {},
  };
}

/**
 * Format lifeboat as NOW.md-style markdown
 */
export function formatLifeboatAsMarkdown(lifeboat: CheckpointLifeboat): string {
  const lines: string[] = [];
  
  lines.push(`# Context Checkpoint — ${lifeboat.timestamp.toISOString()}`);
  lines.push('');
  
  lines.push(`## Objective`);
  lines.push(lifeboat.objective);
  lines.push('');
  
  if (lifeboat.current_task) {
    lines.push(`## Current Task`);
    lines.push(lifeboat.current_task);
    lines.push('');
  }
  
  if (lifeboat.key_decisions.length > 0) {
    lines.push(`## Key Decisions`);
    lifeboat.key_decisions.forEach((d, i) => {
      lines.push(`${i + 1}. ${d}`);
    });
    lines.push('');
  }
  
  if (lifeboat.pending_critical.length > 0) {
    lines.push(`## Pending Critical`);
    lifeboat.pending_critical.forEach((p, i) => {
      lines.push(`${i + 1}. ${p}`);
    });
    lines.push('');
  }
  
  if (lifeboat.file_paths.length > 0) {
    lines.push(`## Key Files`);
    lifeboat.file_paths.forEach(f => {
      lines.push(`- \`${f}\``);
    });
    lines.push('');
  }
  
  if (lifeboat.success_signal) {
    lines.push(`## Success Signal`);
    lines.push(lifeboat.success_signal);
    lines.push('');
  }
  
  return lines.join('\n');
}
