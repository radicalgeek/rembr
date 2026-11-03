import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { OptimizationScheduler } from '../../src/optimization/scheduler.js';
import { createRuntimeDatabase } from '../../src/test-utils/runtime-db.js';

/** Scheduling queries use the real OSS schema; model work is deterministic. */
describe('OptimizationScheduler integration', () => {
  let runtime: Awaited<ReturnType<typeof createRuntimeDatabase>>;
  let scheduler: OptimizationScheduler;
  const tenantId = randomUUID();
  const dedup = { findDuplicateClusters: vi.fn().mockResolvedValue([]), mergeDuplicates: vi.fn() };
  const temporal = { analyzeMemoryFreshness: vi.fn().mockResolvedValue([]), markOutdated: vi.fn() };
  const relationships = { maintainRelationships: vi.fn().mockResolvedValue({}) };
  const quality = { scoreAllMemories: vi.fn().mockResolvedValue([]) };

  beforeAll(async () => {
    runtime = await createRuntimeDatabase('rembr_test_scheduler');
    await runtime.pool.query(`INSERT INTO tenants (id, name, email, plan) VALUES ($1, 'Scheduler test', $2, 'pro')`, [tenantId, `${tenantId}@test.invalid`]);
    await runtime.pool.query(`INSERT INTO optimization_config (tenant_id, enabled, schedule_frequency, last_run_at) VALUES ($1, true, 'hourly', NOW() - INTERVAL '6 hours')`, [tenantId]);
    scheduler = new OptimizationScheduler(runtime.db, dedup as any, temporal as any, relationships as any, quality as any);
  });
  beforeEach(async () => {
    await runtime.pool.query(`UPDATE optimization_config SET enabled = true, last_run_at = NOW() - INTERVAL '6 hours' WHERE tenant_id = $1`, [tenantId]);
  });
  afterAll(async () => {
    await scheduler?.stop();
    if (runtime) {
      await runtime.pool.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
      await runtime.db.close();
      await runtime.pool.end();
    }
  });
  it('selects an active tenant whose configured interval has elapsed', async () => {
    const tenants = await (scheduler as any).getTenantsNeedingOptimization();
    expect(tenants).toContainEqual(expect.objectContaining({ tenantId, planName: 'pro', optimizationInterval: 1 }));
  });
  it('reports the current scheduler configuration', () => {
    expect(scheduler.getStatus()).toEqual({ running: false, checkIntervalMs: 300000, maxTenantsPerCycle: 10 });
  });
  it('excludes a tenant optimised within its interval', async () => {
    await runtime.pool.query('UPDATE optimization_config SET last_run_at = NOW() WHERE tenant_id = $1', [tenantId]);
    expect(await (scheduler as any).getTenantsNeedingOptimization()).not.toContainEqual(expect.objectContaining({ tenantId }));
  });
  it('excludes tenants with optimisation disabled', async () => {
    await runtime.pool.query('UPDATE optimization_config SET enabled = false WHERE tenant_id = $1', [tenantId]);
    expect(await (scheduler as any).getTenantsNeedingOptimization()).not.toContainEqual(expect.objectContaining({ tenantId }));
  });
});
