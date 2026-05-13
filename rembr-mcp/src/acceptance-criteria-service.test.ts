/**
 * Tests for AcceptanceCriteriaService (RAD-58)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AcceptanceCriteriaService } from './acceptance-criteria-service.js';
import type { Pool } from 'pg';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePool(queryFn: (...args: any[]) => any): Pool {
  return { query: queryFn } as unknown as Pool;
}

const TENANT = 'tenant-123';
const TASK   = 'task-abc';
const CRIT   = 'crit-xyz';

// ---------------------------------------------------------------------------
// addCriterion
// ---------------------------------------------------------------------------

describe('AcceptanceCriteriaService.addCriterion', () => {
  it('inserts a criterion and returns it', async () => {
    const row = { id: CRIT, task_id: TASK, criterion: 'It works', validation_method: 'manual', status: 'pending', tenant_id: TENANT, created_at: new Date(), updated_at: new Date(), evidence: null, validated_at: null, validated_by: null };
    const pool = makePool(vi.fn().mockResolvedValue({ rows: [row], rowCount: 1 }));
    const svc = new AcceptanceCriteriaService(pool);
    const result = await svc.addCriterion(TASK, 'It works', 'manual', TENANT);
    expect(result.id).toBe(CRIT);
    expect(result.status).toBe('pending');
  });

  it('rejects empty criterion text', async () => {
    const pool = makePool(vi.fn());
    const svc = new AcceptanceCriteriaService(pool);
    await expect(svc.addCriterion(TASK, '   ', 'manual', TENANT)).rejects.toThrow('empty');
  });

  it('defaults validation_method to manual', async () => {
    const queryFn = vi.fn().mockResolvedValue({ rows: [{ id: CRIT, status: 'pending', validation_method: 'manual' }], rowCount: 1 });
    const pool = makePool(queryFn);
    const svc = new AcceptanceCriteriaService(pool);
    await svc.addCriterion(TASK, 'criterion', undefined, TENANT);
    const [sql, params] = queryFn.mock.calls[0];
    expect(params[2]).toBe('manual');
  });
});

// ---------------------------------------------------------------------------
// validateCriterion
// ---------------------------------------------------------------------------

describe('AcceptanceCriteriaService.validateCriterion', () => {
  it('updates status, evidence, validated_at, validated_by', async () => {
    const updated = { id: CRIT, status: 'passed', evidence: { note: 'CI green' }, validated_by: 'agent-1', validated_at: new Date() };
    const pool = makePool(vi.fn().mockResolvedValue({ rows: [updated], rowCount: 1 }));
    const svc = new AcceptanceCriteriaService(pool);
    const result = await svc.validateCriterion(CRIT, { note: 'CI green' }, TENANT, 'agent-1', 'passed');
    expect(result.status).toBe('passed');
    expect(result.evidence).toEqual({ note: 'CI green' });
  });

  it('throws when criterion not found', async () => {
    const pool = makePool(vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }));
    const svc = new AcceptanceCriteriaService(pool);
    await expect(svc.validateCriterion(CRIT, {}, TENANT)).rejects.toThrow('not found');
  });

  it('defaults status to passed', async () => {
    const queryFn = vi.fn().mockResolvedValue({ rows: [{ id: CRIT, status: 'passed' }], rowCount: 1 });
    const pool = makePool(queryFn);
    const svc = new AcceptanceCriteriaService(pool);
    await svc.validateCriterion(CRIT, {}, TENANT);
    const [, params] = queryFn.mock.calls[0];
    expect(params[0]).toBe('passed');
  });
});

// ---------------------------------------------------------------------------
// getAcceptanceStatus
// ---------------------------------------------------------------------------

describe('AcceptanceCriteriaService.getAcceptanceStatus', () => {
  function makeRow(status: string) {
    return { id: `${status}-id`, task_id: TASK, criterion: `c-${status}`, validation_method: 'manual', status, evidence: null, validated_at: null, validated_by: null, tenant_id: TENANT, created_at: new Date(), updated_at: new Date() };
  }

  it('overall=passed when all non-skipped pass', async () => {
    const rows = [makeRow('passed'), makeRow('skipped')];
    const pool = makePool(vi.fn()
      .mockResolvedValueOnce({ rows, rowCount: rows.length })   // criteria
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })          // memories
    );
    const svc = new AcceptanceCriteriaService(pool);
    const status = await svc.getAcceptanceStatus(TASK, TENANT);
    expect(status.overall).toBe('passed');
    expect(status.passed).toBe(1);
    expect(status.skipped).toBe(1);
  });

  it('overall=failed when any criterion failed', async () => {
    const rows = [makeRow('passed'), makeRow('failed')];
    const pool = makePool(vi.fn()
      .mockResolvedValueOnce({ rows, rowCount: rows.length })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
    );
    const svc = new AcceptanceCriteriaService(pool);
    const status = await svc.getAcceptanceStatus(TASK, TENANT);
    expect(status.overall).toBe('failed');
  });

  it('overall=incomplete when pending criteria exist', async () => {
    const rows = [makeRow('passed'), makeRow('pending')];
    const pool = makePool(vi.fn()
      .mockResolvedValueOnce({ rows, rowCount: rows.length })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
    );
    const svc = new AcceptanceCriteriaService(pool);
    const status = await svc.getAcceptanceStatus(TASK, TENANT);
    expect(status.overall).toBe('incomplete');
  });

  it('overall=incomplete when no criteria', async () => {
    const pool = makePool(vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }));
    const svc = new AcceptanceCriteriaService(pool);
    const status = await svc.getAcceptanceStatus(TASK, TENANT);
    expect(status.overall).toBe('incomplete');
    expect(status.total).toBe(0);
  });

  it('populates memory_ids from join table', async () => {
    const row = makeRow('passed');
    const pool = makePool(vi.fn()
      .mockResolvedValueOnce({ rows: [row], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ criterion_id: row.id, memory_id: 'mem-1' }, { criterion_id: row.id, memory_id: 'mem-2' }], rowCount: 2 })
    );
    const svc = new AcceptanceCriteriaService(pool);
    const status = await svc.getAcceptanceStatus(TASK, TENANT);
    expect(status.criteria[0].memory_ids).toEqual(['mem-1', 'mem-2']);
  });
});

// ---------------------------------------------------------------------------
// linkEvidence
// ---------------------------------------------------------------------------

describe('AcceptanceCriteriaService.linkEvidence', () => {
  it('inserts memory links and returns count', async () => {
    const pool = makePool(vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: CRIT }], rowCount: 1 })  // ownership check
      .mockResolvedValueOnce({ rowCount: 2 })                          // insert
    );
    const svc = new AcceptanceCriteriaService(pool);
    const result = await svc.linkEvidence(CRIT, ['mem-1', 'mem-2'], TENANT);
    expect(result.linked).toBe(2);
  });

  it('returns 0 when memoryIds is empty (no DB call for insert)', async () => {
    const queryFn = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: CRIT }], rowCount: 1 });
    const pool = makePool(queryFn);
    const svc = new AcceptanceCriteriaService(pool);
    const result = await svc.linkEvidence(CRIT, [], TENANT);
    expect(result.linked).toBe(0);
    expect(queryFn).toHaveBeenCalledTimes(1); // only ownership check
  });

  it('throws when criterion not owned by tenant', async () => {
    const pool = makePool(vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }));
    const svc = new AcceptanceCriteriaService(pool);
    await expect(svc.linkEvidence(CRIT, ['mem-1'], TENANT)).rejects.toThrow('not found');
  });
});

// ---------------------------------------------------------------------------
// listCriteria / deleteCriterion
// ---------------------------------------------------------------------------

describe('AcceptanceCriteriaService.listCriteria', () => {
  it('returns criteria in creation order', async () => {
    const rows = [{ id: 'a' }, { id: 'b' }];
    const pool = makePool(vi.fn().mockResolvedValue({ rows, rowCount: rows.length }));
    const svc = new AcceptanceCriteriaService(pool);
    const result = await svc.listCriteria(TASK, TENANT);
    expect(result).toHaveLength(2);
  });
});

describe('AcceptanceCriteriaService.deleteCriterion', () => {
  it('hard-deletes by id + tenant', async () => {
    const pool = makePool(vi.fn().mockResolvedValue({ rowCount: 1 }));
    const svc = new AcceptanceCriteriaService(pool);
    await expect(svc.deleteCriterion(CRIT, TENANT)).resolves.toBeUndefined();
  });

  it('throws when not found', async () => {
    const pool = makePool(vi.fn().mockResolvedValue({ rowCount: 0 }));
    const svc = new AcceptanceCriteriaService(pool);
    await expect(svc.deleteCriterion(CRIT, TENANT)).rejects.toThrow('not found');
  });
});
