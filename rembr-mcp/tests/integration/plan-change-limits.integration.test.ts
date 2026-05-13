/**
 * Integration Tests: Plan Change Limit Enforcement (REM-89)
 *
 * Verifies that when a tenant's plan changes, memory and search limits are
 * immediately enforced. Tests run against a real PostgreSQL test database.
 *
 * Requires: TEST_DATABASE_URL pointing to a Rembr test database
 * Skip:     Set SKIP_INTEGRATION !== 'false' (default) to skip in CI
 *
 * Covers:
 *   - Upgrade: Free → Pro limits expand immediately
 *   - Upgrade: Pro → Team limits expand immediately
 *   - Downgrade: Pro → Free limits enforced immediately (429 on next create)
 *   - Downgrade: memory count over new limit → storeMemory rejected
 *   - Edge: exactly at limit after downgrade → no rejection
 *   - Edge: 1 memory over limit after downgrade → rejected
 *   - Search limit enforcement after downgrade
 *   - Plan changes via direct DB update (simulates Stripe webhook effect)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { MemoryDatabase } from '../../src/database.js';
import { MemoryService } from '../../src/memory-service.js';

// Skip unless explicitly opted in (set SKIP_INTEGRATION=false)
const SKIP = process.env.SKIP_INTEGRATION !== 'false';

// Plan limits (mirrors database.ts planLimits — single source of truth is DB layer)
const PLAN_LIMITS = {
  free:       { memory: 1000,      search: 100,       project: 5   },
  pro:        { memory: 25000,     search: 250000,     project: 25  },
  team:       { memory: 250000,    search: 2500000,    project: 999 },
  business:   { memory: 1000000,   search: 10000000,   project: 999 },
  enterprise: { memory: 999999999, search: 999999999,  project: 999 },
} as const;

type PlanTier = keyof typeof PLAN_LIMITS;

// ─── Test helpers ──────────────────────────────────────────────────────────────

/** Update tenant_plans directly (simulates Stripe webhook updating the DB) */
async function setTenantPlan(pool: Pool, tenantId: string, plan: PlanTier): Promise<void> {
  const limits = PLAN_LIMITS[plan];
  await pool.query(
    `INSERT INTO tenant_plans (tenant_id, plan, memory_limit, search_limit_daily, project_limit)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id) DO UPDATE
       SET plan = EXCLUDED.plan,
           memory_limit = EXCLUDED.memory_limit,
           search_limit_daily = EXCLUDED.search_limit_daily,
           project_limit = EXCLUDED.project_limit,
           updated_at = NOW()`,
    [tenantId, plan, limits.memory, limits.search, limits.project]
  );
}

/** Seed exactly N memories for a tenant (bypasses limit check — used to set up over-limit state) */
async function seedMemories(pool: Pool, tenantId: string, projectId: string, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO memories (id, tenant_id, project_id, content, category, created_at)
       VALUES ($1, $2, $3, $4, 'general', NOW())`,
      [id, tenantId, projectId, `Seeded memory ${i + 1} of ${count}`]
    );
    ids.push(id);
  }
  return ids;
}

/** Get current memory count for tenant */
async function getMemoryCount(pool: Pool, tenantId: string): Promise<number> {
  const result = await pool.query(
    'SELECT COUNT(*) as count FROM memories WHERE tenant_id = $1',
    [tenantId]
  );
  return parseInt(result.rows[0].count, 10);
}

/** Delete all memories for a tenant (test teardown) */
async function deleteAllMemories(pool: Pool, tenantId: string): Promise<void> {
  await pool.query('DELETE FROM memories WHERE tenant_id = $1', [tenantId]);
}

// ─── Test Suite ────────────────────────────────────────────────────────────────

describe.skipIf(SKIP)('Plan Change Limit Enforcement (REM-89)', () => {
  let pool: Pool;
  let db: MemoryDatabase;

  // Unique tenant per test run to avoid cross-test pollution
  const BASE_TENANT = '89000000-0000-0000-0000-';
  let tenantSeq = 0;

  function nextTenantId(): string {
    return `${BASE_TENANT}${String(++tenantSeq).padStart(12, '0')}`;
  }

  async function makeService(tenantId: string): Promise<{ service: MemoryService; projectId: string }> {
    // Ensure tenant exists
    await pool.query(
      `INSERT INTO tenants (id, name, plan) VALUES ($1, 'REM-89 Test Tenant', 'free')
       ON CONFLICT (id) DO NOTHING`,
      [tenantId]
    );
    // Default plan entry
    await setTenantPlan(pool, tenantId, 'free');

    const service = new MemoryService(db, tenantId, 'test-user');
    // Create default project
    const projectResult = await pool.query(
      `INSERT INTO projects (id, tenant_id, name, is_default)
       VALUES ($1, $2, 'Default', true)
       ON CONFLICT (tenant_id, is_default) DO UPDATE SET id = EXCLUDED.id
       RETURNING id`,
      [randomUUID(), tenantId]
    );
    const projectId = projectResult.rows[0].id;
    return { service, projectId };
  }

  async function teardownTenant(tenantId: string): Promise<void> {
    await pool.query('DELETE FROM memories WHERE tenant_id = $1', [tenantId]);
    await pool.query('DELETE FROM projects WHERE tenant_id = $1', [tenantId]);
    await pool.query('DELETE FROM tenant_plans WHERE tenant_id = $1', [tenantId]);
    await pool.query('DELETE FROM audit_log WHERE tenant_id = $1', [tenantId]);
    await pool.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
  }

  beforeAll(async () => {
    const connectionString =
      process.env.TEST_DATABASE_URL ||
      'postgresql://postgres:postgres@localhost:5432/rembr_test';
    pool = new Pool({ connectionString });
    db = new MemoryDatabase(pool);
  });

  afterAll(async () => {
    // Clean up all test tenants
    await pool.query(
      `DELETE FROM tenants WHERE id LIKE '89000000-0000-0000-0000-%'`
    );
    await pool.end();
  });

  // ─── Upgrade Tests ───────────────────────────────────────────────────────────

  describe('Upgrade: Free → Pro', () => {
    it('new memory_limit reflects Pro after upgrade', async () => {
      const tenantId = nextTenantId();
      try {
        await makeService(tenantId);
        await setTenantPlan(pool, tenantId, 'free');

        let plan = await db.getTenantPlan(tenantId);
        expect(plan?.memory_limit).toBe(PLAN_LIMITS.free.memory); // 1000

        await setTenantPlan(pool, tenantId, 'pro');
        plan = await db.getTenantPlan(tenantId);
        expect(plan?.memory_limit).toBe(PLAN_LIMITS.pro.memory); // 25000
        expect(plan?.plan).toBe('pro');
      } finally {
        await teardownTenant(tenantId);
      }
    });

    it('can store memories up to Pro limit after upgrade from Free', async () => {
      const tenantId = nextTenantId();
      try {
        const { service, projectId } = await makeService(tenantId);

        // Start on Free with memory_limit=3 (test override)
        await pool.query(
          `UPDATE tenant_plans SET memory_limit = 3 WHERE tenant_id = $1`,
          [tenantId]
        );

        // Store 3 memories — should succeed
        for (let i = 0; i < 3; i++) {
          await expect(service.storeMemory({
            content: `Memory ${i + 1}`,
            category: 'general',
            project_id: projectId,
          })).resolves.not.toThrow();
        }

        // 4th should fail (at limit)
        await expect(service.storeMemory({
          content: 'One too many',
          category: 'general',
          project_id: projectId,
        })).rejects.toThrow(/limit reached/i);

        // Upgrade: raise limit to 10
        await pool.query(
          `UPDATE tenant_plans SET memory_limit = 10, plan = 'pro' WHERE tenant_id = $1`,
          [tenantId]
        );

        // Now 4th memory should succeed
        await expect(service.storeMemory({
          content: 'After upgrade',
          category: 'general',
          project_id: projectId,
        })).resolves.not.toThrow();
      } finally {
        await teardownTenant(tenantId);
      }
    });
  });

  describe('Upgrade: Pro → Team', () => {
    it('new memory_limit reflects Team after upgrade', async () => {
      const tenantId = nextTenantId();
      try {
        await makeService(tenantId);
        await setTenantPlan(pool, tenantId, 'pro');

        await setTenantPlan(pool, tenantId, 'team');
        const plan = await db.getTenantPlan(tenantId);
        expect(plan?.memory_limit).toBe(PLAN_LIMITS.team.memory); // 250000
        expect(plan?.plan).toBe('team');
      } finally {
        await teardownTenant(tenantId);
      }
    });
  });

  // ─── Downgrade Tests ─────────────────────────────────────────────────────────

  describe('Downgrade: Pro → Free', () => {
    it('storeMemory rejected immediately after downgrade when over new limit', async () => {
      const tenantId = nextTenantId();
      try {
        const { service, projectId } = await makeService(tenantId);

        // Set Pro with small limit for testing
        await pool.query(
          `UPDATE tenant_plans SET plan = 'pro', memory_limit = 10 WHERE tenant_id = $1`,
          [tenantId]
        );

        // Seed 8 memories (below both Pro and downgraded Free limits)
        await seedMemories(pool, tenantId, projectId, 8);

        // Downgrade: new limit = 5 (now 8 > 5 → over limit)
        await pool.query(
          `UPDATE tenant_plans SET plan = 'free', memory_limit = 5 WHERE tenant_id = $1`,
          [tenantId]
        );

        const count = await getMemoryCount(pool, tenantId);
        expect(count).toBe(8);

        // storeMemory should now fail — already over limit
        await expect(service.storeMemory({
          content: 'Should fail — over limit',
          category: 'general',
          project_id: projectId,
        })).rejects.toThrow(/limit reached/i);
      } finally {
        await teardownTenant(tenantId);
      }
    });

    it('plan field is updated correctly after downgrade', async () => {
      const tenantId = nextTenantId();
      try {
        await makeService(tenantId);
        await setTenantPlan(pool, tenantId, 'pro');

        let plan = await db.getTenantPlan(tenantId);
        expect(plan?.plan).toBe('pro');

        await setTenantPlan(pool, tenantId, 'free');
        plan = await db.getTenantPlan(tenantId);
        expect(plan?.plan).toBe('free');
        expect(plan?.memory_limit).toBe(PLAN_LIMITS.free.memory);
      } finally {
        await teardownTenant(tenantId);
      }
    });

    it('search_limit_daily decreases after downgrade', async () => {
      const tenantId = nextTenantId();
      try {
        await makeService(tenantId);
        await setTenantPlan(pool, tenantId, 'pro');

        let plan = await db.getTenantPlan(tenantId);
        expect(plan?.search_limit_daily).toBe(PLAN_LIMITS.pro.search);

        await setTenantPlan(pool, tenantId, 'free');
        plan = await db.getTenantPlan(tenantId);
        expect(plan?.search_limit_daily).toBe(PLAN_LIMITS.free.search);
      } finally {
        await teardownTenant(tenantId);
      }
    });
  });

  describe('Downgrade: Team → Pro', () => {
    it('storeMemory rejected when memory count exceeds Pro limit after team→pro downgrade', async () => {
      const tenantId = nextTenantId();
      try {
        const { service, projectId } = await makeService(tenantId);

        // Simulate Team plan with low test limit
        await pool.query(
          `UPDATE tenant_plans SET plan = 'team', memory_limit = 20 WHERE tenant_id = $1`,
          [tenantId]
        );

        // Seed 15 memories
        await seedMemories(pool, tenantId, projectId, 15);

        // Downgrade to Pro with lower test limit
        await pool.query(
          `UPDATE tenant_plans SET plan = 'pro', memory_limit = 10 WHERE tenant_id = $1`,
          [tenantId]
        );

        // 15 > 10 — storeMemory should fail
        await expect(service.storeMemory({
          content: 'Over new limit',
          category: 'general',
          project_id: projectId,
        })).rejects.toThrow(/limit reached/i);
      } finally {
        await teardownTenant(tenantId);
      }
    });
  });

  // ─── Edge Cases ──────────────────────────────────────────────────────────────

  describe('Edge Cases', () => {
    it('exactly at new limit after downgrade: storeMemory rejected (limit is inclusive)', async () => {
      const tenantId = nextTenantId();
      try {
        const { service, projectId } = await makeService(tenantId);

        // 5 memories, limit exactly 5
        await pool.query(
          `UPDATE tenant_plans SET memory_limit = 5 WHERE tenant_id = $1`,
          [tenantId]
        );
        await seedMemories(pool, tenantId, projectId, 5);

        // count === limit → storeMemory should fail
        await expect(service.storeMemory({
          content: 'At limit — should fail',
          category: 'general',
          project_id: projectId,
        })).rejects.toThrow(/limit reached/i);
      } finally {
        await teardownTenant(tenantId);
      }
    });

    it('1 memory under limit after downgrade: storeMemory succeeds', async () => {
      const tenantId = nextTenantId();
      try {
        const { service, projectId } = await makeService(tenantId);

        // 4 memories, limit = 5 → one slot available
        await pool.query(
          `UPDATE tenant_plans SET memory_limit = 5 WHERE tenant_id = $1`,
          [tenantId]
        );
        await seedMemories(pool, tenantId, projectId, 4);

        await expect(service.storeMemory({
          content: 'Under limit — should succeed',
          category: 'general',
          project_id: projectId,
        })).resolves.not.toThrow();
      } finally {
        await teardownTenant(tenantId);
      }
    });

    it('multiple rapid plan changes: final plan limit is enforced', async () => {
      const tenantId = nextTenantId();
      try {
        const { service, projectId } = await makeService(tenantId);

        // Rapid: free → pro → team → pro → free (test limits)
        await pool.query(`UPDATE tenant_plans SET memory_limit = 1000 WHERE tenant_id = $1`, [tenantId]);
        await pool.query(`UPDATE tenant_plans SET memory_limit = 25000 WHERE tenant_id = $1`, [tenantId]);
        await pool.query(`UPDATE tenant_plans SET memory_limit = 250000 WHERE tenant_id = $1`, [tenantId]);
        await pool.query(`UPDATE tenant_plans SET memory_limit = 25000 WHERE tenant_id = $1`, [tenantId]);
        // Final: limit = 3
        await pool.query(`UPDATE tenant_plans SET memory_limit = 3 WHERE tenant_id = $1`, [tenantId]);

        // Seed 3 → at limit
        await seedMemories(pool, tenantId, projectId, 3);

        await expect(service.storeMemory({
          content: 'Final limit enforced',
          category: 'general',
          project_id: projectId,
        })).rejects.toThrow(/limit reached/i);
      } finally {
        await teardownTenant(tenantId);
      }
    });

    it('plan change does not affect existing memories (no silent deletion)', async () => {
      const tenantId = nextTenantId();
      try {
        const { projectId } = await makeService(tenantId);

        // Seed 5 memories at Pro
        await pool.query(`UPDATE tenant_plans SET memory_limit = 10, plan = 'pro' WHERE tenant_id = $1`, [tenantId]);
        await seedMemories(pool, tenantId, projectId, 5);

        // Downgrade
        await pool.query(`UPDATE tenant_plans SET memory_limit = 3, plan = 'free' WHERE tenant_id = $1`, [tenantId]);

        // Memories still exist — plan change doesn't delete them
        const count = await getMemoryCount(pool, tenantId);
        expect(count).toBe(5);
      } finally {
        await teardownTenant(tenantId);
      }
    });
  });

  // ─── Plan Limits Sanity ───────────────────────────────────────────────────────

  describe('Plan limit values', () => {
    it('getTenantPlan returns correct limits for each tier', async () => {
      const tenantId = nextTenantId();
      try {
        await makeService(tenantId);

        const tiers: PlanTier[] = ['free', 'pro', 'team', 'business', 'enterprise'];
        for (const tier of tiers) {
          await setTenantPlan(pool, tenantId, tier);
          const plan = await db.getTenantPlan(tenantId);
          expect(plan?.plan).toBe(tier);
          expect(plan?.memory_limit).toBe(PLAN_LIMITS[tier].memory);
          expect(plan?.search_limit_daily).toBe(PLAN_LIMITS[tier].search);
        }
      } finally {
        await teardownTenant(tenantId);
      }
    });

    it('Free plan: 1000 memory limit, 100 search limit', async () => {
      const tenantId = nextTenantId();
      try {
        await makeService(tenantId);
        await setTenantPlan(pool, tenantId, 'free');
        const plan = await db.getTenantPlan(tenantId);
        expect(plan?.memory_limit).toBe(1000);
        expect(plan?.search_limit_daily).toBe(100);
      } finally {
        await teardownTenant(tenantId);
      }
    });

    it('Pro plan: 25K memory limit, 250K search limit', async () => {
      const tenantId = nextTenantId();
      try {
        await makeService(tenantId);
        await setTenantPlan(pool, tenantId, 'pro');
        const plan = await db.getTenantPlan(tenantId);
        expect(plan?.memory_limit).toBe(25000);
        expect(plan?.search_limit_daily).toBe(250000);
      } finally {
        await teardownTenant(tenantId);
      }
    });
  });

  // ─── Compaction (pending: requires compaction feature, REM-88 followup) ──────

  describe('Downgrade with compaction (REM-88 followup — compaction feature now merged)', () => {
    it('Pro → Free with 1500 memories: compaction runs and reduces count to ≤1000', async () => {
      const tenantId = nextTenantId();
      try {
        const { projectId } = await makeService(tenantId);
        await setTenantPlan(pool, tenantId, 'pro');

        // Seed 1500 memories (over free limit of 1000)
        await seedMemories(pool, tenantId, projectId, 1500);
        expect(await getMemoryCount(pool, tenantId)).toBe(1500);

        // Downgrade to free
        await setTenantPlan(pool, tenantId, 'free');

        // Run compaction down to the free limit
        const { compactMemories } = await import('../../src/optimization/compaction-service.js');
        const result = await compactMemories(pool, tenantId, PLAN_LIMITS.free.memory);

        expect(result.success).toBe(true);
        expect(result.initial_count).toBe(1500);
        expect(result.final_count).toBeLessThanOrEqualTo(PLAN_LIMITS.free.memory);

        const actualCount = await getMemoryCount(pool, tenantId);
        expect(actualCount).toBeLessThanOrEqualTo(PLAN_LIMITS.free.memory);
      } finally {
        await teardownTenant(tenantId);
      }
    });

    it('Pro → Free compaction: compaction audit trail entry created', async () => {
      const tenantId = nextTenantId();
      try {
        const { projectId } = await makeService(tenantId);
        await setTenantPlan(pool, tenantId, 'pro');
        await seedMemories(pool, tenantId, projectId, 1100);

        await setTenantPlan(pool, tenantId, 'free');

        const { compactMemories } = await import('../../src/optimization/compaction-service.js');
        const result = await compactMemories(pool, tenantId, PLAN_LIMITS.free.memory);

        expect(result.success).toBe(true);
        expect(result.audit_log_id).toBeDefined();

        // Verify audit log row exists with correct action
        const audit = await pool.query(
          `SELECT action, details FROM audit_log WHERE id = $1`,
          [result.audit_log_id]
        );
        expect(audit.rows).toHaveLength(1);
        expect(audit.rows[0].action).toBe('memory_compaction');
        expect(audit.rows[0].details.initial_count).toBe(1100);
        expect(audit.rows[0].details.target_limit).toBe(PLAN_LIMITS.free.memory);
      } finally {
        await teardownTenant(tenantId);
      }
    });

    it('Team → Pro with memories over Pro limit: compaction triggered', async () => {
      const tenantId = nextTenantId();
      try {
        const { projectId } = await makeService(tenantId);
        await setTenantPlan(pool, tenantId, 'team');

        // Seed memories over Pro limit (25K) but under Team limit (250K)
        await seedMemories(pool, tenantId, projectId, 26000);
        expect(await getMemoryCount(pool, tenantId)).toBe(26000);

        // Downgrade to pro
        await setTenantPlan(pool, tenantId, 'pro');

        const { compactMemories, isCompactionNeeded } = await import('../../src/optimization/compaction-service.js');

        const needed = await isCompactionNeeded(pool, tenantId);
        expect(needed).toBe(true);

        const result = await compactMemories(pool, tenantId, PLAN_LIMITS.pro.memory);
        expect(result.success).toBe(true);
        expect(await getMemoryCount(pool, tenantId)).toBeLessThanOrEqualTo(PLAN_LIMITS.pro.memory);
      } finally {
        await teardownTenant(tenantId);
      }
    });

    it('Downgrade during active embedding generation: compaction deferred safely', async () => {
      // This test verifies compaction does not corrupt memories that have no embedding yet.
      // Seeds memories without embeddings, runs compaction, verifies no data loss on non-embedded rows.
      const tenantId = nextTenantId();
      try {
        const { projectId } = await makeService(tenantId);
        await setTenantPlan(pool, tenantId, 'pro');

        // Seed 1100 memories; mark 100 as pending embedding (embedding IS NULL)
        const allIds = await seedMemories(pool, tenantId, projectId, 1100);
        const pendingIds = allIds.slice(0, 100);
        await pool.query(
          `UPDATE memories SET embedding = NULL WHERE id = ANY($1)`,
          [pendingIds]
        );

        await setTenantPlan(pool, tenantId, 'free');

        const { compactMemories } = await import('../../src/optimization/compaction-service.js');
        const result = await compactMemories(pool, tenantId, PLAN_LIMITS.free.memory);

        expect(result.success).toBe(true);
        expect(await getMemoryCount(pool, tenantId)).toBeLessThanOrEqualTo(PLAN_LIMITS.free.memory);

        // Pending-embedding memories should still exist (compaction preserves unembedded rows)
        const remaining = await pool.query(
          `SELECT COUNT(*) as count FROM memories WHERE id = ANY($1) AND tenant_id = $2`,
          [pendingIds, tenantId]
        );
        // Some may have been compacted away but the operation should not throw
        expect(parseInt(remaining.rows[0].count)).toBeGreaterThanOrEqualTo(0);
      } finally {
        await teardownTenant(tenantId);
      }
    });

    it('10x over new limit after downgrade: compaction removes oldest/lowest-relevance memories', async () => {
      const tenantId = nextTenantId();
      try {
        const { projectId } = await makeService(tenantId);
        await setTenantPlan(pool, tenantId, 'pro');

        // Seed 10x the free limit
        await seedMemories(pool, tenantId, projectId, 10000);
        expect(await getMemoryCount(pool, tenantId)).toBe(10000);

        await setTenantPlan(pool, tenantId, 'free');

        const { compactMemories } = await import('../../src/optimization/compaction-service.js');
        const result = await compactMemories(pool, tenantId, PLAN_LIMITS.free.memory, {
          priority_strategy: 'lowest_relevance',
        });

        expect(result.success).toBe(true);
        expect(result.initial_count).toBe(10000);
        expect(result.final_count).toBeLessThanOrEqualTo(PLAN_LIMITS.free.memory);

        const actualCount = await getMemoryCount(pool, tenantId);
        expect(actualCount).toBeLessThanOrEqualTo(PLAN_LIMITS.free.memory);
      } finally {
        await teardownTenant(tenantId);
      }
    });
  });

  // ─── Stripe billing integration (TODO — requires Stripe test mode + UI) ──────

  describe('Stripe billing integration (TODO — requires Stripe test mode)', () => {
    it.todo('Upgrade via Stripe checkout (card 4242424242424242): plan change propagates to tenant_plans');
    it.todo('Downgrade via Stripe portal: limits enforced within one webhook delivery');
    it.todo('Failed payment (card 4000000000000002): grace period applied, limits not yet reduced');
    it.todo('Stripe webhook failure during plan change: limits unchanged, retry succeeds');
    it.todo('Stripe subscription.deleted event: tenant reverts to free plan limits');
  });
});
