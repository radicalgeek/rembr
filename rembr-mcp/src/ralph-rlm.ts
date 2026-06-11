/**
 * Ralph-RLM Integration (REM-37)
 *
 * Provides native support for Ralph patterns and Recursive Language Model workflows:
 *
 * 1. Acceptance Criteria Framework — define, track, and evaluate AC for RLM tasks
 * 2. Iteration Tracking — record iteration cycles with outcome evidence
 * 3. Plan Regeneration — request new plan when stuck, store regeneration history
 * 4. RLM State Persistence — save and restore full RLM session state across sessions
 *
 * Ralph pattern: Plan → Execute → Evaluate → [Done | Iterate → Regenerate → Repeat]
 */

import { Pool } from 'pg';
import { randomUUID } from 'crypto';

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

export type ACStatus = 'pending' | 'met' | 'failed' | 'skipped';
export type IterationOutcome = 'success' | 'partial' | 'failed' | 'blocked';
export type RLMSessionStatus = 'active' | 'complete' | 'abandoned' | 'regenerating';

export interface AcceptanceCriterion {
  id: string;
  description: string;
  status: ACStatus;
  evidence?: string;
  evaluated_at?: string;
  iteration_id?: string;
}

export interface RLMIteration {
  id: string;
  session_id: string;
  iteration_number: number;
  plan_summary: string;
  approach: string;
  outcome: IterationOutcome;
  evidence: string[];
  error?: string;
  ac_met: string[];          // AC IDs that were met this iteration
  ac_failed: string[];       // AC IDs that failed
  duration_ms?: number;
  started_at: string;
  completed_at?: string;
  metadata: Record<string, unknown>;
}

export interface RLMSession {
  id: string;
  tenant_id: string;
  task_id: string;
  task_title: string;
  status: RLMSessionStatus;
  acceptance_criteria: AcceptanceCriterion[];
  iterations: RLMIteration[];
  current_plan?: string;
  regeneration_count: number;
  created_at: string;
  updated_at: string;
  completed_at?: string;
  metadata: Record<string, unknown>;
}

export interface RegenerationRequest {
  session_id: string;
  reason: string;
  stuck_evidence: string[];
  failed_approaches: string[];
  constraints: string[];
}

export interface RegenerationResult {
  regeneration_id: string;
  session_id: string;
  prompt_for_agent: string;
  context_summary: string;
  what_failed: string[];
  suggested_alternatives: string[];
  triggered_at: string;
}

// ─────────────────────────────────────────────────────────
// Schema bootstrap
// ─────────────────────────────────────────────────────────

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS rlm_sessions (
    id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          TEXT         NOT NULL,
    task_id            TEXT         NOT NULL,
    task_title         TEXT         NOT NULL DEFAULT '',
    status             TEXT         NOT NULL DEFAULT 'active',
    acceptance_criteria JSONB       NOT NULL DEFAULT '[]',
    current_plan       TEXT,
    regeneration_count INTEGER      NOT NULL DEFAULT 0,
    metadata           JSONB        NOT NULL DEFAULT '{}',
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    completed_at       TIMESTAMPTZ
  );

  CREATE TABLE IF NOT EXISTS rlm_iterations (
    id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id       UUID         NOT NULL REFERENCES rlm_sessions(id) ON DELETE CASCADE,
    tenant_id        TEXT         NOT NULL,
    iteration_number INTEGER      NOT NULL,
    plan_summary     TEXT         NOT NULL DEFAULT '',
    approach         TEXT         NOT NULL DEFAULT '',
    outcome          TEXT         NOT NULL DEFAULT 'failed',
    evidence         JSONB        NOT NULL DEFAULT '[]',
    error            TEXT,
    ac_met           JSONB        NOT NULL DEFAULT '[]',
    ac_failed        JSONB        NOT NULL DEFAULT '[]',
    duration_ms      INTEGER,
    started_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    completed_at     TIMESTAMPTZ,
    metadata         JSONB        NOT NULL DEFAULT '{}'
  );
`;

// ─────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────

export class RalphRLMService {
  private schemaEnsured = false;

  constructor(private pool: Pool, private tenantId: string) {}

  private async ensureSchema(): Promise<void> {
    if (this.schemaEnsured) return;
    const existing = await this.pool.query(`
      SELECT
        to_regclass('public.rlm_sessions') AS sessions_table,
        to_regclass('public.rlm_iterations') AS iterations_table
    `);
    if (
      existing.rows.length === 0 ||
      (existing.rows[0]?.sessions_table && existing.rows[0]?.iterations_table)
    ) {
      this.schemaEnsured = true;
      return;
    }

    await this.pool.query(SCHEMA_SQL);
    this.schemaEnsured = true;
  }

  // ─── Session Management ──────────────────────────────────

  async createSession(
    taskId: string,
    taskTitle: string,
    acceptanceCriteria: string[],
    initialPlan?: string,
    metadata: Record<string, unknown> = {},
  ): Promise<RLMSession> {
    await this.ensureSchema();

    const ac: AcceptanceCriterion[] = acceptanceCriteria.map(desc => ({
      id:          randomUUID(),
      description: desc,
      status:      'pending' as ACStatus,
    }));

    const result = await this.pool.query<{
      id: string; tenant_id: string; task_id: string; task_title: string;
      status: string; acceptance_criteria: AcceptanceCriterion[];
      current_plan: string | null; regeneration_count: number;
      metadata: Record<string, unknown>; created_at: Date; updated_at: Date;
    }>(
      `INSERT INTO rlm_sessions
         (tenant_id, task_id, task_title, acceptance_criteria, current_plan, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [this.tenantId, taskId, taskTitle, JSON.stringify(ac), initialPlan ?? null, JSON.stringify(metadata)],
    );

    return this._formatSession(result.rows[0], []);
  }

  async getSession(sessionId: string): Promise<RLMSession | null> {
    await this.ensureSchema();

    const [sessionResult, iterResult] = await Promise.all([
      this.pool.query(
        `SELECT * FROM rlm_sessions WHERE id = $1 AND tenant_id = $2`,
        [sessionId, this.tenantId],
      ),
      this.pool.query(
        `SELECT * FROM rlm_iterations WHERE session_id = $1 ORDER BY iteration_number`,
        [sessionId],
      ),
    ]);

    if (sessionResult.rows.length === 0) return null;
    return this._formatSession(sessionResult.rows[0], iterResult.rows);
  }

  async listSessions(taskId?: string, status?: RLMSessionStatus): Promise<RLMSession[]> {
    await this.ensureSchema();

    const conditions = ['s.tenant_id = $1'];
    const params: unknown[] = [this.tenantId];
    let p = 2;

    if (taskId) { conditions.push(`s.task_id = $${p++}`); params.push(taskId); }
    if (status) { conditions.push(`s.status = $${p++}`); params.push(status); }

    const result = await this.pool.query(
      `SELECT * FROM rlm_sessions s WHERE ${conditions.join(' AND ')} ORDER BY updated_at DESC`,
      params,
    );

    // Load iterations for each session
    const sessions = await Promise.all(
      result.rows.map(async row => {
        const iters = await this.pool.query(
          `SELECT * FROM rlm_iterations WHERE session_id = $1 ORDER BY iteration_number`,
          [row.id],
        );
        return this._formatSession(row, iters.rows);
      })
    );

    return sessions;
  }

  async updateSessionStatus(sessionId: string, status: RLMSessionStatus, plan?: string): Promise<RLMSession | null> {
    const setClauses = ['status = $3', 'updated_at = NOW()'];
    const params: unknown[] = [sessionId, this.tenantId, status];
    if (plan !== undefined) {
      setClauses.push(`current_plan = $${params.length + 1}`);
      params.push(plan);
    }
    if (status === 'complete' || status === 'abandoned') {
      setClauses.push(`completed_at = NOW()`);
    }

    await this.pool.query(
      `UPDATE rlm_sessions SET ${setClauses.join(', ')} WHERE id = $1 AND tenant_id = $2`,
      params,
    );

    return this.getSession(sessionId);
  }

  // ─── Acceptance Criteria ─────────────────────────────────

  async evaluateAC(
    sessionId: string,
    evaluations: Array<{ id: string; status: ACStatus; evidence?: string }>,
  ): Promise<RLMSession | null> {
    await this.ensureSchema();

    const session = await this.getSession(sessionId);
    if (!session) return null;

    const now = new Date().toISOString();
    const updated = session.acceptance_criteria.map(ac => {
      const eval_ = evaluations.find(e => e.id === ac.id);
      if (!eval_) return ac;
      return {
        ...ac,
        status:       eval_.status,
        evidence:     eval_.evidence,
        evaluated_at: now,
      };
    });

    // Check if all required AC are met
    const allMet = updated.every(ac => ac.status === 'met' || ac.status === 'skipped');

    await this.pool.query(
      `UPDATE rlm_sessions SET acceptance_criteria = $3, updated_at = NOW() ${allMet ? ", status = 'complete', completed_at = NOW()" : ''} WHERE id = $1 AND tenant_id = $2`,
      [sessionId, this.tenantId, JSON.stringify(updated)],
    );

    return this.getSession(sessionId);
  }

  // ─── Iteration Tracking ──────────────────────────────────

  async startIteration(
    sessionId: string,
    planSummary: string,
    approach: string,
    metadata: Record<string, unknown> = {},
  ): Promise<RLMIteration> {
    await this.ensureSchema();

    // Get current iteration count
    const countResult = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM rlm_iterations WHERE session_id = $1`,
      [sessionId],
    );
    const nextNumber = parseInt(countResult.rows[0]?.count ?? '0', 10) + 1;

    const result = await this.pool.query(
      `INSERT INTO rlm_iterations
         (session_id, tenant_id, iteration_number, plan_summary, approach, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [sessionId, this.tenantId, nextNumber, planSummary, approach, JSON.stringify(metadata)],
    );

    // Update session updated_at
    await this.pool.query(`UPDATE rlm_sessions SET updated_at = NOW() WHERE id = $1`, [sessionId]);

    return this._formatIteration(result.rows[0]);
  }

  async completeIteration(
    iterationId: string,
    outcome: IterationOutcome,
    evidence: string[],
    acMet: string[] = [],
    acFailed: string[] = [],
    error?: string,
    durationMs?: number,
  ): Promise<RLMIteration> {
    const result = await this.pool.query(
      `UPDATE rlm_iterations
       SET outcome = $2, evidence = $3, ac_met = $4, ac_failed = $5,
           error = $6, duration_ms = $7, completed_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [iterationId, outcome, JSON.stringify(evidence), JSON.stringify(acMet), JSON.stringify(acFailed), error ?? null, durationMs ?? null],
    );

    return this._formatIteration(result.rows[0]);
  }

  // ─── Plan Regeneration ───────────────────────────────────

  async requestRegeneration(req: RegenerationRequest): Promise<RegenerationResult> {
    await this.ensureSchema();

    const session = await this.getSession(req.session_id);
    if (!session) throw new Error(`RLM session not found: ${req.session_id}`);

    // Increment regeneration count
    await this.pool.query(
      `UPDATE rlm_sessions SET regeneration_count = regeneration_count + 1, status = 'regenerating', updated_at = NOW() WHERE id = $1`,
      [req.session_id],
    );

    const pendingAC = session.acceptance_criteria.filter(ac => ac.status !== 'met' && ac.status !== 'skipped');
    const failedAC  = session.acceptance_criteria.filter(ac => ac.status === 'failed');

    // Build structured regeneration prompt
    const contextSummary = [
      `Task: ${session.task_title}`,
      `Iterations attempted: ${session.iterations.length}`,
      `Previous regenerations: ${session.regeneration_count}`,
      `Stuck reason: ${req.reason}`,
    ].join('\n');

    const whatFailed = [
      ...req.failed_approaches.map(a => `Approach tried: ${a}`),
      ...failedAC.map(ac => `AC failed: ${ac.description} — ${ac.evidence ?? 'no evidence'}`),
    ];

    const suggestedAlternatives = [
      pendingAC.length > 0 ? `Focus on pending AC first: ${pendingAC.map(ac => ac.description).join('; ')}` : null,
      req.constraints.length > 0 ? `Constraints to respect: ${req.constraints.join(', ')}` : null,
      session.iterations.length > 2 ? 'Consider a fundamentally different approach — current pattern has failed multiple times' : null,
      'Break the task into smaller sub-tasks',
      'Ask for clarification on the most blocked acceptance criterion',
    ].filter(Boolean) as string[];

    const promptForAgent = [
      `## Plan Regeneration Required`,
      ``,
      `**Task:** ${session.task_title}`,
      `**Reason stuck:** ${req.reason}`,
      ``,
      `**What was tried (${req.failed_approaches.length} approaches):**`,
      ...req.failed_approaches.map(a => `- ${a}`),
      ``,
      `**Stuck evidence:**`,
      ...req.stuck_evidence.map(e => `- ${e}`),
      ``,
      `**Unmet acceptance criteria (${pendingAC.length}):**`,
      ...pendingAC.map(ac => `- [ ] ${ac.description}`),
      ``,
      `**Constraints:**`,
      ...req.constraints.map(c => `- ${c}`),
      ``,
      `Please generate a new plan that addresses the above. Be specific about how this plan differs from previous attempts.`,
    ].join('\n');

    const regenerationId = randomUUID();

    // Persist regeneration event in session metadata
    await this.pool.query(
      `UPDATE rlm_sessions
       SET metadata = jsonb_set(
         metadata,
         '{regenerations}',
         COALESCE(metadata->'regenerations', '[]'::jsonb) || $3::jsonb
       )
       WHERE id = $1 AND tenant_id = $2`,
      [req.session_id, this.tenantId, JSON.stringify([{
        id:              regenerationId,
        reason:          req.reason,
        stuck_evidence:  req.stuck_evidence,
        failed_approaches: req.failed_approaches,
        triggered_at:    new Date().toISOString(),
      }])],
    );

    return {
      regeneration_id:       regenerationId,
      session_id:            req.session_id,
      prompt_for_agent:      promptForAgent,
      context_summary:       contextSummary,
      what_failed:           whatFailed,
      suggested_alternatives: suggestedAlternatives,
      triggered_at:          new Date().toISOString(),
    };
  }

  // ─── State Persistence ───────────────────────────────────

  /**
   * Export full RLM session state for cross-session persistence.
   * Can be stored in memory_service or passed between agents.
   */
  exportState(session: RLMSession): string {
    return JSON.stringify({
      schema_version: '1.0',
      exported_at:    new Date().toISOString(),
      session,
    }, null, 2);
  }

  /**
   * Restore a session from exported state (creates a new DB record).
   * Useful when resuming work in a new session context.
   */
  async importState(stateJson: string): Promise<RLMSession> {
    await this.ensureSchema();

    const { session } = JSON.parse(stateJson) as { session: RLMSession };

    // Re-create session preserving all state
    const result = await this.pool.query(
      `INSERT INTO rlm_sessions
         (id, tenant_id, task_id, task_title, status, acceptance_criteria, current_plan, regeneration_count, metadata, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
       ON CONFLICT (id) DO UPDATE
         SET status = EXCLUDED.status,
             acceptance_criteria = EXCLUDED.acceptance_criteria,
             current_plan = EXCLUDED.current_plan,
             updated_at = NOW()
       RETURNING *`,
      [
        session.id, this.tenantId, session.task_id, session.task_title,
        session.status, JSON.stringify(session.acceptance_criteria),
        session.current_plan ?? null, session.regeneration_count,
        JSON.stringify(session.metadata), session.created_at,
      ],
    );

    // Re-insert iterations
    for (const iter of session.iterations) {
      await this.pool.query(
        `INSERT INTO rlm_iterations
           (id, session_id, tenant_id, iteration_number, plan_summary, approach,
            outcome, evidence, ac_met, ac_failed, error, duration_ms, started_at, completed_at, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (id) DO NOTHING`,
        [
          iter.id, session.id, this.tenantId, iter.iteration_number,
          iter.plan_summary, iter.approach, iter.outcome,
          JSON.stringify(iter.evidence), JSON.stringify(iter.ac_met),
          JSON.stringify(iter.ac_failed), iter.error ?? null,
          iter.duration_ms ?? null, iter.started_at,
          iter.completed_at ?? null, JSON.stringify(iter.metadata),
        ],
      );
    }

    return this._formatSession(result.rows[0], session.iterations as unknown as Record<string, unknown>[]);
  }

  // ─── Helpers ─────────────────────────────────────────────

  private _formatSession(row: Record<string, unknown>, iterRows: Record<string, unknown>[]): RLMSession {
    const ac = typeof row.acceptance_criteria === 'string'
      ? JSON.parse(row.acceptance_criteria)
      : (row.acceptance_criteria ?? []) as AcceptanceCriterion[];

    return {
      id:                   row.id as string,
      tenant_id:            row.tenant_id as string,
      task_id:              row.task_id as string,
      task_title:           row.task_title as string,
      status:               row.status as RLMSessionStatus,
      acceptance_criteria:  ac,
      iterations:           iterRows.map(r => this._formatIteration(r)),
      current_plan:         row.current_plan as string | undefined,
      regeneration_count:   row.regeneration_count as number,
      created_at:           row.created_at instanceof Date ? (row.created_at as Date).toISOString() : row.created_at as string,
      updated_at:           row.updated_at instanceof Date ? (row.updated_at as Date).toISOString() : row.updated_at as string,
      completed_at:         row.completed_at instanceof Date ? (row.completed_at as Date).toISOString() : (row.completed_at as string | undefined),
      metadata:             (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata ?? {}) as Record<string, unknown>,
    };
  }

  private _formatIteration(row: Record<string, unknown>): RLMIteration {
    const parseJson = (v: unknown) => typeof v === 'string' ? JSON.parse(v) : (v ?? []);
    return {
      id:               row.id as string,
      session_id:       row.session_id as string,
      iteration_number: row.iteration_number as number,
      plan_summary:     row.plan_summary as string,
      approach:         row.approach as string,
      outcome:          row.outcome as IterationOutcome,
      evidence:         parseJson(row.evidence) as string[],
      error:            row.error as string | undefined,
      ac_met:           parseJson(row.ac_met) as string[],
      ac_failed:        parseJson(row.ac_failed) as string[],
      duration_ms:      row.duration_ms as number | undefined,
      started_at:       row.started_at instanceof Date ? (row.started_at as Date).toISOString() : row.started_at as string,
      completed_at:     row.completed_at instanceof Date ? (row.completed_at as Date).toISOString() : (row.completed_at as string | undefined),
      metadata:         parseJson(row.metadata) as Record<string, unknown>,
    };
  }
}
