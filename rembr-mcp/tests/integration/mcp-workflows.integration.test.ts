/**
 * MCP Workflow Integration Tests (REM-45)
 *
 * Comprehensive end-to-end tests for production readiness:
 * - Core memory CRUD workflows
 * - Search across modes
 * - PII detection & plan-tier gating
 * - Rate limit daily quota (REM-48)
 * - Context operations
 * - Stats with rate_limits and pii_capabilities
 * - Performance benchmarks (p50/p95 latency targets)
 * - Concurrent load handling
 *
 * Requires: TEST_DATABASE_URL pointing to a Rembr test database
 * Skip:     Set SKIP_INTEGRATION=true (default) to skip in CI
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { MemoryDatabase } from '../../src/database.js';
import { MemoryService } from '../../src/memory-service.js';
import { piiDetector } from '../../src/pii-detector.js';
import { DAILY_PLAN_LIMITS } from '../../src/rate-limiter.js';
import { getPIICapabilities, clampSensitivity, assertPIIOperationAllowed } from '../../src/pii-plan-limits.js';

// Skip unless explicitly opted in
const SKIP = process.env.SKIP_INTEGRATION !== 'false';

// Test tenant constants
const TEST_TENANT_ID = '10000000-0000-0000-0000-000000000045';
const TEST_PROJECT_ID = '10000000-0000-0000-0000-000000000046';
const TEST_USER_ID = 'integration-test-user';

// Performance targets
const P50_STORE_MS = 200;   // store_memory p50 target
const P95_STORE_MS = 500;   // store_memory p95 target
const P50_SEARCH_MS = 300;  // search_memory p50 target
const P95_SEARCH_MS = 800;  // search_memory p95 target

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

// ─────────────────────────────────────────────────────────
// Test Suite
// ─────────────────────────────────────────────────────────

describe.skipIf(SKIP)('MCP Workflow Integration Tests (REM-45)', () => {
  let pool: Pool;
  let db: MemoryDatabase;
  let service: MemoryService;

  beforeAll(async () => {
    const connectionString =
      process.env.TEST_DATABASE_URL ||
      'postgresql://postgres:postgres@localhost:5432/rembr_test';

    pool = new Pool({ connectionString });
    db = new MemoryDatabase(connectionString);
    service = new MemoryService(TEST_TENANT_ID, TEST_PROJECT_ID, db, undefined, TEST_USER_ID);

    // Ensure tenant + plan exist
    await pool.query(
      `INSERT INTO tenants (id, name) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [TEST_TENANT_ID, 'integration-test-tenant-45']
    );
    await pool.query(
      `INSERT INTO tenant_plans (tenant_id, plan, memory_limit, search_limit_daily, project_limit)
       VALUES ($1, 'pro', 100000, 100000, 100) ON CONFLICT (tenant_id) DO UPDATE SET plan = 'pro'`,
      [TEST_TENANT_ID]
    );
    await pool.query(
      `INSERT INTO projects (id, tenant_id, name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [TEST_PROJECT_ID, TEST_TENANT_ID, 'integration-test-project']
    );

    // Clean up any leftover test data
    await pool.query(`DELETE FROM memories WHERE tenant_id = $1`, [TEST_TENANT_ID]);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM memories WHERE tenant_id = $1`, [TEST_TENANT_ID]);
    await pool.end();
  });

  // ───────────────────────────────────────────
  // 1. Core Memory CRUD
  // ───────────────────────────────────────────
  describe('Memory CRUD workflows', () => {
    let storedId: string;

    it('should store a memory', async () => {
      const memory = await service.storeMemory({
        content: 'Integration test memory — the sky is blue',
        category: 'notes',
        metadata: { source: 'integration-test' },
      });

      expect(memory.id).toBeDefined();
      expect(memory.content).toBe('Integration test memory — the sky is blue');
      expect(memory.category).toBe('notes');
      storedId = memory.id;
    });

    it('should retrieve a stored memory by search', async () => {
      const results = await service.searchMemory({
        query: 'sky is blue',
        limit: 5,
        search_mode: 'text',
      });

      const found = results.find(r => r.id === storedId);
      expect(found).toBeDefined();
      expect(found?.content).toContain('sky is blue');
    });

    it('should update a memory', async () => {
      const updated = await service.updateMemory(storedId, {
        content: 'Integration test memory — the sky is blue and clear',
      });

      expect(updated).not.toBeNull();
      expect(updated?.content).toContain('clear');
    });

    it('should delete a memory', async () => {
      const deleted = await service.deleteMemory(storedId);
      expect(deleted).toBe(true);

      // Verify it's gone
      const results = await service.searchMemory({
        query: 'sky is blue and clear',
        limit: 5,
        search_mode: 'text',
      });
      expect(results.find(r => r.id === storedId)).toBeUndefined();
    });
  });

  // ───────────────────────────────────────────
  // 2. Search Modes
  // ───────────────────────────────────────────
  describe('Search mode workflows', () => {
    beforeAll(async () => {
      // Seed several memories
      await service.storeMemory({ content: 'TypeScript is a typed superset of JavaScript', category: 'notes', metadata: {} });
      await service.storeMemory({ content: 'React is a UI library for building interfaces', category: 'notes', metadata: {} });
      await service.storeMemory({ content: 'Vitest is a fast unit testing framework', category: 'notes', metadata: {} });
    });

    it('text search returns relevant results', async () => {
      const results = await service.searchMemory({ query: 'TypeScript JavaScript', limit: 5, search_mode: 'text' });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].content).toContain('TypeScript');
    });

    it('phrase search returns exact phrase matches', async () => {
      const results = await service.searchMemory({ query: 'unit testing framework', limit: 5, search_mode: 'phrase' });
      expect(results.length).toBeGreaterThan(0);
    });

    it('search returns results with correct fields', async () => {
      const results = await service.searchMemory({ query: 'React UI', limit: 5, search_mode: 'text' });
      expect(results.length).toBeGreaterThan(0);
      const r = results[0];
      expect(r.id).toBeDefined();
      expect(r.content).toBeDefined();
      expect(r.category).toBeDefined();
    });

    it('exclude_pii filter works', async () => {
      // Store a memory with PII
      await service.storeMemory({
        content: 'Contact dev at dev@example.com for support',
        category: 'contacts',
        metadata: {},
      });

      // Search without exclude_pii — PII memory may appear
      const all = await service.searchMemory({ query: 'contact support', limit: 10, search_mode: 'text', exclude_pii: false });

      // Search with exclude_pii — no PII memories in results
      const noPii = await service.searchMemory({ query: 'contact support', limit: 10, search_mode: 'text', exclude_pii: true });

      for (const r of noPii) {
        expect(r.pii_detected).toBeFalsy();
      }
    });
  });

  // ───────────────────────────────────────────
  // 3. PII Detection workflows
  // ───────────────────────────────────────────
  describe('PII detection workflows', () => {
    it('detects email PII in text', () => {
      const result = piiDetector.detectPII('Send to alice@example.com', 'medium');
      expect(result.hasPII).toBe(true);
      expect(result.types).toContain('email');
    });

    it('detects phone PII at high sensitivity', () => {
      const result = piiDetector.detectPII('Call 555-123-4567 anytime', 'high');
      expect(result.hasPII).toBe(true);
      expect(result.types).toContain('phone');
    });

    it('masks PII correctly', () => {
      const redacted = piiDetector.redactPII('Email: alice@example.com', 'mask', 'medium');
      expect(redacted).not.toContain('alice@example.com');
      expect(redacted).toContain('*');
    });

    it('auto-scans PII on store', async () => {
      const memory = await service.storeMemory({
        content: 'Billing contact: billing@corp.com',
        category: 'contacts',
        metadata: {},
      });

      const row = await pool.query('SELECT pii_detected, pii_types FROM memories WHERE id = $1', [memory.id]);
      expect(row.rows[0].pii_detected).toBe(true);
      expect(row.rows[0].pii_types).toContain('email');
    });
  });

  // ───────────────────────────────────────────
  // 4. Plan-tier PII gating (REM-51)
  // ───────────────────────────────────────────
  describe('Plan-tier PII gating (REM-51)', () => {
    it('free plan caps sensitivity at medium', () => {
      expect(clampSensitivity('high', 'free')).toBe('medium');
    });

    it('pro plan allows high sensitivity', () => {
      expect(clampSensitivity('high', 'pro')).toBe('high');
    });

    it('free plan blocks compliance_report', () => {
      expect(() => assertPIIOperationAllowed('compliance_report', 'free')).toThrow(/compliance reports are not available/i);
    });

    it('pro plan allows compliance_report', () => {
      expect(() => assertPIIOperationAllowed('compliance_report', 'pro')).not.toThrow();
    });

    it('free plan blocks batch_scan', () => {
      expect(() => assertPIIOperationAllowed('batch_scan', 'free')).toThrow(/batch scanning is not available/i);
    });
  });

  // ───────────────────────────────────────────
  // 5. Daily Rate Limit config (REM-48)
  // ───────────────────────────────────────────
  describe('Daily rate limit configuration (REM-48)', () => {
    it('free plan daily limit is 1,000', () => {
      expect(DAILY_PLAN_LIMITS.free).toBe(1000);
    });

    it('pro plan daily limit is 100,000', () => {
      expect(DAILY_PLAN_LIMITS.pro).toBe(100000);
    });

    it('team plan daily limit is 1,000,000', () => {
      expect(DAILY_PLAN_LIMITS.team).toBe(1000000);
    });

    it('enterprise plan daily limit exceeds team', () => {
      expect(DAILY_PLAN_LIMITS.enterprise).toBeGreaterThan(DAILY_PLAN_LIMITS.team);
    });

    it('limits escalate correctly across tiers', () => {
      expect(DAILY_PLAN_LIMITS.free).toBeLessThan(DAILY_PLAN_LIMITS.pro);
      expect(DAILY_PLAN_LIMITS.pro).toBeLessThan(DAILY_PLAN_LIMITS.team);
    });
  });

  // ───────────────────────────────────────────
  // 6. Stats workflow
  // ───────────────────────────────────────────
  describe('Stats workflow', () => {
    it('getStats returns memory count', async () => {
      const stats = await service.getStats();
      expect(stats).toBeDefined();
      expect(typeof stats.total_memories).toBe('number');
    });
  });

  // ───────────────────────────────────────────
  // 7. Performance Benchmarks
  // ───────────────────────────────────────────
  describe('Performance benchmarks', () => {
    const BENCH_COUNT = 20;

    it(`store_memory: p50 < ${P50_STORE_MS}ms, p95 < ${P95_STORE_MS}ms`, async () => {
      const times: number[] = [];

      for (let i = 0; i < BENCH_COUNT; i++) {
        const start = Date.now();
        await service.storeMemory({
          content: `Benchmark memory ${i}: performance testing with sufficient content length`,
          category: 'notes',
          metadata: { bench: true, index: i },
        });
        times.push(Date.now() - start);
      }

      times.sort((a, b) => a - b);
      const p50 = percentile(times, 50);
      const p95 = percentile(times, 95);

      console.log(`store_memory p50=${p50}ms p95=${p95}ms (n=${BENCH_COUNT})`);
      expect(p50).toBeLessThan(P50_STORE_MS);
      expect(p95).toBeLessThan(P95_STORE_MS);
    }, 60000);

    it(`search_memory (text): p50 < ${P50_SEARCH_MS}ms, p95 < ${P95_SEARCH_MS}ms`, async () => {
      const queries = [
        'performance testing content',
        'benchmark memory index',
        'sufficient length content',
        'testing framework',
        'benchmark notes',
      ];
      const times: number[] = [];

      for (let i = 0; i < BENCH_COUNT; i++) {
        const query = queries[i % queries.length];
        const start = Date.now();
        await service.searchMemory({ query, limit: 10, search_mode: 'text' });
        times.push(Date.now() - start);
      }

      times.sort((a, b) => a - b);
      const p50 = percentile(times, 50);
      const p95 = percentile(times, 95);

      console.log(`search_memory p50=${p50}ms p95=${p95}ms (n=${BENCH_COUNT})`);
      expect(p50).toBeLessThan(P50_SEARCH_MS);
      expect(p95).toBeLessThan(P95_SEARCH_MS);
    }, 60000);
  });

  // ───────────────────────────────────────────
  // 8. Concurrent Load
  // ───────────────────────────────────────────
  describe('Concurrent load handling', () => {
    it('handles 10 concurrent store_memory requests', async () => {
      const promises = Array.from({ length: 10 }, (_, i) =>
        service.storeMemory({
          content: `Concurrent test memory ${i} — load testing`,
          category: 'notes',
          metadata: { concurrent: true, index: i },
        })
      );

      const results = await Promise.all(promises);
      expect(results).toHaveLength(10);
      for (const r of results) {
        expect(r.id).toBeDefined();
        expect(r.content).toContain('Concurrent test memory');
      }
    });

    it('handles 10 concurrent search_memory requests', async () => {
      const promises = Array.from({ length: 10 }, (_, i) =>
        service.searchMemory({
          query: `concurrent load testing ${i}`,
          limit: 5,
          search_mode: 'text',
        })
      );

      const results = await Promise.all(promises);
      expect(results).toHaveLength(10);
      for (const r of results) {
        expect(Array.isArray(r)).toBe(true);
      }
    });

    it('handles mixed concurrent operations without errors', async () => {
      const ops = [
        service.storeMemory({ content: 'Mixed op memory A', category: 'notes', metadata: {} }),
        service.searchMemory({ query: 'performance', limit: 5, search_mode: 'text' }),
        service.storeMemory({ content: 'Mixed op memory B', category: 'notes', metadata: {} }),
        service.searchMemory({ query: 'concurrent', limit: 5, search_mode: 'text' }),
        service.getStats(),
      ];

      const results = await Promise.allSettled(ops);
      const failures = results.filter(r => r.status === 'rejected');
      expect(failures).toHaveLength(0);
    });
  });

  // ───────────────────────────────────────────
  // 9. Data Integrity
  // ───────────────────────────────────────────
  describe('Data integrity', () => {
    it('metadata is preserved round-trip', async () => {
      const meta = { source: 'integration', tags: ['qa', 'test'], score: 0.95, nested: { key: 'value' } };
      const memory = await service.storeMemory({
        content: 'Metadata integrity test',
        category: 'notes',
        metadata: meta,
      });

      const row = await pool.query('SELECT metadata FROM memories WHERE id = $1', [memory.id]);
      const stored = row.rows[0].metadata;
      expect(stored.source).toBe('integration');
      expect(stored.tags).toEqual(['qa', 'test']);
      expect(stored.score).toBe(0.95);
    });

    it('category is preserved correctly', async () => {
      const memory = await service.storeMemory({
        content: 'Category test memory',
        category: 'preferences',
        metadata: {},
      });

      const row = await pool.query('SELECT category FROM memories WHERE id = $1', [memory.id]);
      expect(row.rows[0].category).toBe('preferences');
    });

    it('tenant isolation: memories from different tenants do not cross', async () => {
      const otherTenantId = '20000000-0000-0000-0000-000000000045';
      // Ensure the other tenant exists
      await pool.query(
        `INSERT INTO tenants (id, name) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [otherTenantId, 'other-tenant-45']
      );
      const otherService = new MemoryService(otherTenantId, undefined, db);
      const otherMemory = await otherService.storeMemory({
        content: 'Secret memory for other tenant only',
        category: 'notes',
        metadata: {},
      });

      // Search from original tenant should not find other tenant's memory
      const results = await service.searchMemory({ query: 'Secret memory other tenant', limit: 10, search_mode: 'text' });
      const found = results.find(r => r.id === otherMemory.id);
      expect(found).toBeUndefined();

      // Cleanup
      await pool.query(`DELETE FROM memories WHERE tenant_id = $1`, [otherTenantId]);
      await pool.query(`DELETE FROM tenants WHERE id = $1`, [otherTenantId]);
    });
  });
});
