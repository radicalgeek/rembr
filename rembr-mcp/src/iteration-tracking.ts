/**
 * Iteration Tracking & Stuck Detection Service (RAD-59)
 *
 * Records task execution attempts in the `task_iterations` table (created by
 * migration 011-plan-regeneration-schema.sql) and provides stuck-detection
 * logic for RLM (Recursive Language Model) workflows.
 *
 * Stuck Detection Algorithm:
 *   1. Same state for >3 iterations (plateau detection)
 *   2. No progress on acceptance criteria
 *   3. Error patterns repeating
 *   4. Time since last state change
 */

import type { Pool } from 'pg';
import { randomUUID } from 'crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IterationRecord {
  id: string;
  tenant_id: string;
  task_id: string;
  attempt_number: number;
  approach: string;
  outcome: string;
  error?: string | null;
  started_at: Date;
  completed_at?: Date | null;
  duration_seconds?: number | null;
  metadata: Record<string, unknown>;
}

export interface RecordIterationOptions {
  task_id: string;
  approach: string;
  outcome: string;
  error?: string;
  duration_seconds?: number;
  metadata?: Record<string, unknown>;
}

export interface StuckScore {
  task_id: string;
  score: number;               // 0–100; ≥70 = likely stuck
  is_stuck: boolean;
  reasons: string[];
  iteration_count: number;
  last_updated: Date | null;
}

export interface StuckDetectionCriteria {
  min_iterations?: number;     // Minimum iterations before checking (default 3)
  plateau_threshold?: number;  // Consecutive same-outcome iterations (default 3)
  error_repeat_threshold?: number; // Repeated identical errors (default 2)
  idle_minutes?: number;       // Minutes without new iteration (default 60)
  score_threshold?: number;    // Score at which task is considered stuck (default 70)
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class IterationTrackingService {
  constructor(private readonly pool: Pool) {}

  // -------------------------------------------------------------------------
  // recordIteration
  // -------------------------------------------------------------------------

  /**
   * Record a task execution attempt.
   * attempt_number is auto-incremented per (tenant_id, task_id) pair.
   */
  async recordIteration(
    tenantId: string,
    options: RecordIterationOptions,
  ): Promise<IterationRecord> {
    // Determine next attempt_number atomically
    const result = await this.pool.query(
      `INSERT INTO task_iterations
         (id, tenant_id, task_id, attempt_number, approach, outcome, error,
          started_at, completed_at, duration_seconds, metadata)
       VALUES (
         $1, $2, $3,
         (SELECT COALESCE(MAX(attempt_number), 0) + 1
          FROM task_iterations
          WHERE tenant_id = $2 AND task_id = $3),
         $4, $5, $6,
         NOW(),
         CASE WHEN $7::integer IS NOT NULL THEN NOW() - ($7 || ' seconds')::INTERVAL ELSE NULL END,
         $7,
         $8
       )
       ON CONFLICT (tenant_id, task_id, attempt_number)
         DO UPDATE SET
           approach         = EXCLUDED.approach,
           outcome          = EXCLUDED.outcome,
           error            = EXCLUDED.error,
           completed_at     = EXCLUDED.completed_at,
           duration_seconds = EXCLUDED.duration_seconds,
           metadata         = EXCLUDED.metadata
       RETURNING *`,
      [
        randomUUID(),
        tenantId,
        options.task_id,
        options.approach,
        options.outcome,
        options.error ?? null,
        options.duration_seconds ?? null,
        JSON.stringify(options.metadata ?? {}),
      ],
    );
    return rowToRecord(result.rows[0]);
  }

  // -------------------------------------------------------------------------
  // getIterationHistory
  // -------------------------------------------------------------------------

  /**
   * Return all iterations for a task in chronological order.
   */
  async getIterationHistory(
    tenantId: string,
    taskId: string,
    limit = 50,
  ): Promise<IterationRecord[]> {
    const result = await this.pool.query(
      `SELECT * FROM task_iterations
       WHERE tenant_id = $1 AND task_id = $2
       ORDER BY attempt_number ASC
       LIMIT $3`,
      [tenantId, taskId, limit],
    );
    return result.rows.map(rowToRecord);
  }

  // -------------------------------------------------------------------------
  // calculateStuckScore
  // -------------------------------------------------------------------------

  /**
   * Compute a stuck score (0–100) for a single task.
   *
   * Scoring breakdown:
   *   - Plateau (same outcome ≥3 consecutive): +35
   *   - Repeating errors (same error ≥2×):    +25
   *   - High iteration count (≥5):             +20
   *   - Idle time (no new iteration ≥60 min):  +20
   */
  async calculateStuckScore(
    tenantId: string,
    taskId: string,
    criteria: StuckDetectionCriteria = {},
  ): Promise<StuckScore> {
    const {
      plateau_threshold    = 3,
      error_repeat_threshold = 2,
      idle_minutes         = 60,
      score_threshold      = 70,
    } = criteria;

    const iterations = await this.getIterationHistory(tenantId, taskId, 100);

    if (iterations.length === 0) {
      return {
        task_id: taskId,
        score: 0,
        is_stuck: false,
        reasons: [],
        iteration_count: 0,
        last_updated: null,
      };
    }

    let score = 0;
    const reasons: string[] = [];

    // 1. Plateau: same outcome for ≥ N consecutive iterations
    const recentOutcomes = iterations.slice(-plateau_threshold).map(i => i.outcome);
    if (
      recentOutcomes.length >= plateau_threshold &&
      recentOutcomes.every(o => o === recentOutcomes[0])
    ) {
      score += 35;
      reasons.push(`Same outcome "${recentOutcomes[0]}" for last ${plateau_threshold} iterations`);
    }

    // 2. Repeating errors
    const errors = iterations.filter(i => i.error).map(i => i.error as string);
    const errorCounts: Record<string, number> = {};
    for (const e of errors) {
      // Normalise: trim + lowercase for comparison
      const key = e.trim().toLowerCase();
      errorCounts[key] = (errorCounts[key] ?? 0) + 1;
    }
    const repeatedErrors = Object.entries(errorCounts).filter(([, c]) => c >= error_repeat_threshold);
    if (repeatedErrors.length > 0) {
      score += 25;
      reasons.push(`Error repeated ${repeatedErrors[0][1]}× across iterations`);
    }

    // 3. High iteration count
    if (iterations.length >= 5) {
      score += 20;
      reasons.push(`High iteration count: ${iterations.length} attempts`);
    } else if (iterations.length >= 3) {
      score += 10;
      reasons.push(`Moderate iteration count: ${iterations.length} attempts`);
    }

    // 4. Idle time
    const lastIteration = iterations[iterations.length - 1];
    const lastTime = lastIteration.completed_at ?? lastIteration.started_at;
    const idleMs = Date.now() - lastTime.getTime();
    const idleMinutes = idleMs / 60_000;
    if (idleMinutes >= idle_minutes) {
      score += 20;
      reasons.push(`No new iteration for ${Math.round(idleMinutes)} minutes`);
    }

    score = Math.min(score, 100);

    return {
      task_id: taskId,
      score,
      is_stuck: score >= score_threshold,
      reasons,
      iteration_count: iterations.length,
      last_updated: lastTime,
    };
  }

  // -------------------------------------------------------------------------
  // detectStuckTasks
  // -------------------------------------------------------------------------

  /**
   * Identify all tasks (for a tenant) that exceed the stuck threshold.
   * Returns tasks ordered by stuck score descending.
   */
  async detectStuckTasks(
    tenantId: string,
    criteria: StuckDetectionCriteria = {},
  ): Promise<StuckScore[]> {
    const { min_iterations = 3, score_threshold = 70 } = criteria;

    // Get all task_ids with enough iterations
    const taskRows = await this.pool.query(
      `SELECT task_id, COUNT(*) AS cnt, MAX(started_at) AS last_seen
       FROM task_iterations
       WHERE tenant_id = $1
       GROUP BY task_id
       HAVING COUNT(*) >= $2
       ORDER BY MAX(started_at) DESC`,
      [tenantId, min_iterations],
    );

    const results: StuckScore[] = [];

    for (const row of taskRows.rows) {
      const stuckScore = await this.calculateStuckScore(tenantId, row.task_id, criteria);
      if (stuckScore.score >= score_threshold) {
        results.push(stuckScore);
      }
    }

    return results.sort((a, b) => b.score - a.score);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToRecord(row: Record<string, unknown>): IterationRecord {
  return {
    id:               row.id as string,
    tenant_id:        row.tenant_id as string,
    task_id:          row.task_id as string,
    attempt_number:   parseInt(String(row.attempt_number), 10),
    approach:         row.approach as string,
    outcome:          row.outcome as string,
    error:            (row.error as string | null) ?? null,
    started_at:       new Date(row.started_at as string),
    completed_at:     row.completed_at ? new Date(row.completed_at as string) : null,
    duration_seconds: row.duration_seconds ? parseInt(String(row.duration_seconds), 10) : null,
    metadata:         typeof row.metadata === 'object' && row.metadata !== null
      ? row.metadata as Record<string, unknown>
      : {},
  };
}
