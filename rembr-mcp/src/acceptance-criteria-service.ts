/**
 * Acceptance Criteria Service (RAD-58)
 *
 * Manages per-task acceptance criteria with evidence and memory linking.
 *
 * DB tables:
 *   acceptance_criteria          — one row per criterion
 *   acceptance_criteria_memories — many-to-many link to memories
 *
 * Methods:
 *   addCriterion(taskId, criterion, validationMethod, tenantId)
 *   validateCriterion(criterionId, evidence, tenantId, validatedBy?)
 *   getAcceptanceStatus(taskId, tenantId)
 *   linkEvidence(criterionId, memoryIds, tenantId)
 */

import type { Pool } from 'pg';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ValidationMethod = 'manual' | 'automated' | 'review';
export type CriterionStatus  = 'pending' | 'passed' | 'failed' | 'skipped';

export interface AcceptanceCriterion {
  id:                string;
  task_id:           string;
  criterion:         string;
  validation_method: ValidationMethod;
  status:            CriterionStatus;
  evidence:          Record<string, unknown> | null;
  validated_at:      Date | null;
  validated_by:      string | null;
  tenant_id:         string;
  created_at:        Date;
  updated_at:        Date;
  /** Linked memory IDs (populated on getAcceptanceStatus). */
  memory_ids?:       string[];
}

export interface AcceptanceStatus {
  task_id:      string;
  total:        number;
  passed:       number;
  failed:       number;
  pending:      number;
  skipped:      number;
  /** Overall pass/fail/incomplete */
  overall:      'passed' | 'failed' | 'incomplete';
  criteria:     AcceptanceCriterion[];
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class AcceptanceCriteriaService {
  constructor(private readonly pool: Pool) {}

  /**
   * Add a criterion to a task.
   */
  async addCriterion(
    taskId:           string,
    criterion:        string,
    validationMethod: ValidationMethod = 'manual',
    tenantId:         string,
  ): Promise<AcceptanceCriterion> {
    if (!criterion.trim()) {
      throw new Error('criterion text must not be empty');
    }

    const result = await this.pool.query<AcceptanceCriterion>(
      `INSERT INTO acceptance_criteria
         (task_id, criterion, validation_method, tenant_id)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [taskId, criterion.trim(), validationMethod, tenantId],
    );
    return result.rows[0];
  }

  /**
   * Record evidence for a criterion and update its status.
   *
   * @param evidence  Arbitrary JSON evidence blob (test results, links, notes, etc.)
   * @param status    'passed' | 'failed' | 'skipped'  (default: 'passed')
   */
  async validateCriterion(
    criterionId: string,
    evidence:    Record<string, unknown>,
    tenantId:    string,
    validatedBy: string  = 'system',
    status:      CriterionStatus = 'passed',
  ): Promise<AcceptanceCriterion> {
    const result = await this.pool.query<AcceptanceCriterion>(
      `UPDATE acceptance_criteria
       SET status       = $1,
           evidence     = $2,
           validated_at = NOW(),
           validated_by = $3
       WHERE id = $4 AND tenant_id = $5
       RETURNING *`,
      [status, JSON.stringify(evidence), validatedBy, criterionId, tenantId],
    );

    if (result.rowCount === 0) {
      throw new Error(`Criterion ${criterionId} not found or access denied`);
    }
    return result.rows[0];
  }

  /**
   * Get overall acceptance status for a task including all criteria.
   */
  async getAcceptanceStatus(
    taskId:   string,
    tenantId: string,
  ): Promise<AcceptanceStatus> {
    // Fetch criteria
    const criteriaResult = await this.pool.query<AcceptanceCriterion>(
      `SELECT * FROM acceptance_criteria
       WHERE task_id = $1 AND tenant_id = $2
       ORDER BY created_at ASC`,
      [taskId, tenantId],
    );

    const criteria = criteriaResult.rows;

    // Fetch linked memory IDs in bulk
    if (criteria.length > 0) {
      const ids = criteria.map(c => c.id);
      const memResult = await this.pool.query<{ criterion_id: string; memory_id: string }>(
        `SELECT criterion_id, memory_id
         FROM acceptance_criteria_memories
         WHERE criterion_id = ANY($1)`,
        [ids],
      );

      // Group by criterion
      const memMap: Record<string, string[]> = {};
      for (const row of memResult.rows) {
        (memMap[row.criterion_id] ??= []).push(row.memory_id);
      }
      for (const c of criteria) {
        c.memory_ids = memMap[c.id] ?? [];
      }
    }

    // Aggregate counts
    const counts = { passed: 0, failed: 0, pending: 0, skipped: 0 };
    for (const c of criteria) {
      if (c.status in counts) counts[c.status as keyof typeof counts]++;
    }

    // Overall: passed only if all non-skipped criteria passed and at least one exists
    const nonSkipped = criteria.filter(c => c.status !== 'skipped');
    let overall: AcceptanceStatus['overall'] = 'incomplete';
    if (nonSkipped.length > 0 && nonSkipped.every(c => c.status === 'passed')) {
      overall = 'passed';
    } else if (nonSkipped.some(c => c.status === 'failed')) {
      overall = 'failed';
    }

    return {
      task_id:  taskId,
      total:    criteria.length,
      overall,
      criteria,
      ...counts,
    };
  }

  /**
   * Link memory IDs as supporting evidence for a criterion.
   * Idempotent — re-linking an already-linked memory is a no-op.
   */
  async linkEvidence(
    criterionId: string,
    memoryIds:   string[],
    tenantId:    string,
  ): Promise<{ linked: number }> {
    // Verify ownership
    const ownerCheck = await this.pool.query(
      `SELECT id FROM acceptance_criteria WHERE id = $1 AND tenant_id = $2`,
      [criterionId, tenantId],
    );
    if (ownerCheck.rowCount === 0) {
      throw new Error(`Criterion ${criterionId} not found or access denied`);
    }

    if (memoryIds.length === 0) return { linked: 0 };

    // Batch upsert
    const values = memoryIds
      .map((_, i) => `($1, $${i + 2})`)
      .join(', ');
    const result = await this.pool.query(
      `INSERT INTO acceptance_criteria_memories (criterion_id, memory_id)
       VALUES ${values}
       ON CONFLICT DO NOTHING`,
      [criterionId, ...memoryIds],
    );

    return { linked: result.rowCount ?? 0 };
  }

  /**
   * List all criteria for a task (lightweight — no memory IDs).
   */
  async listCriteria(
    taskId:   string,
    tenantId: string,
  ): Promise<AcceptanceCriterion[]> {
    const result = await this.pool.query<AcceptanceCriterion>(
      `SELECT * FROM acceptance_criteria
       WHERE task_id = $1 AND tenant_id = $2
       ORDER BY created_at ASC`,
      [taskId, tenantId],
    );
    return result.rows;
  }

  /**
   * Delete a criterion (hard delete).
   */
  async deleteCriterion(
    criterionId: string,
    tenantId:    string,
  ): Promise<void> {
    const result = await this.pool.query(
      `DELETE FROM acceptance_criteria WHERE id = $1 AND tenant_id = $2`,
      [criterionId, tenantId],
    );
    if (result.rowCount === 0) {
      throw new Error(`Criterion ${criterionId} not found or access denied`);
    }
  }
}
