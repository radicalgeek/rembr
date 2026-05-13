/**
 * Integration test for OptimizationScheduler
 * Tests against real database in TEST environment
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pkg from 'pg';
const { Pool } = pkg;
import { OllamaClient } from '../../src/ollama-client.js';
import { OptimizationScheduler } from '../../src/optimization/scheduler.js';

// These tests should only run when explicitly requested
const SKIP_INTEGRATION = process.env.SKIP_INTEGRATION !== 'false';

describe.skipIf(SKIP_INTEGRATION)('OptimizationScheduler Integration Tests', () => {
  let pool: pkg.Pool;
  let scheduler: OptimizationScheduler;
  let testTenantId: string;

  beforeAll(async () => {
    // Connect to TEST database
    const databaseUrl = process.env.DATABASE_URL || 'postgresql://rembr_test:password@localhost:5432/rembr_test';
    pool = new Pool({ connectionString: databaseUrl });

    // Create test tenant
    const result = await pool.query(
      `INSERT INTO tenants (name, created_at, updated_at) 
       VALUES ($1, NOW(), NOW()) 
       RETURNING id`,
      ['integration-test-tenant']
    );
    testTenantId = result.rows[0].id;

    // Insert tenant plan
    await pool.query(
      `INSERT INTO tenant_plans (tenant_id, plan, memories_limit, searches_per_day_limit, created_at, updated_at)
       VALUES ($1, 'pro', 10000, 100000, NOW(), NOW())`,
      [testTenantId]
    );

    // Insert optimization config
    await pool.query(
      `INSERT INTO optimization_config (tenant_id, auto_optimization_enabled, last_run_at, created_at, updated_at)
       VALUES ($1, true, NOW() - INTERVAL '6 hours', NOW(), NOW())`,
      [testTenantId]
    );

    // Initialize scheduler
    const ollamaClient = OllamaClient.getInstance();
    scheduler = new OptimizationScheduler(pool, ollamaClient, { checkIntervalMs: 1000 });
  });

  afterAll(async () => {
    // Cleanup
    await pool.query('DELETE FROM optimization_config WHERE tenant_id = $1', [testTenantId]);
    await pool.query('DELETE FROM tenant_plans WHERE tenant_id = $1', [testTenantId]);
    await pool.query('DELETE FROM tenants WHERE id = $1', [testTenantId]);
    await pool.end();
  });

  it('should find tenants needing optimization', async () => {
    const tenants = await (scheduler as any).getTenantsNeedingOptimization();
    
    expect(tenants).toBeDefined();
    expect(Array.isArray(tenants)).toBe(true);
    
    // Should include our test tenant (last_run > 1 hour ago)
    const testTenant = tenants.find((t: any) => t.tenant_id === testTenantId);
    expect(testTenant).toBeDefined();
    expect(testTenant.plan).toBe('pro');
  });

  it('should get scheduler status', async () => {
    const status = scheduler.getStatus();
    
    expect(status).toBeDefined();
    expect(status.isRunning).toBe(false); // Not started yet
    expect(status.checkIntervalMs).toBe(1000);
    expect(status.totalCycles).toBe(0);
  });

  it('should record optimization run', async () => {
    // Update last_run_at for our tenant
    await (scheduler as any).updateLastRun(testTenantId);

    // Verify update
    const result = await pool.query(
      'SELECT last_run_at FROM optimization_config WHERE tenant_id = $1',
      [testTenantId]
    );

    expect(result.rows.length).toBe(1);
    expect(result.rows[0].last_run_at).toBeDefined();
    
    // Should be recent (within last minute)
    const lastRun = new Date(result.rows[0].last_run_at);
    const now = new Date();
    const diffMs = now.getTime() - lastRun.getTime();
    expect(diffMs).toBeLessThan(60000); // Less than 1 minute
  });

  it('should track optimization in history table', async () => {
    const startTime = new Date();
    
    // Insert test history record
    await pool.query(
      `INSERT INTO optimization_history 
       (tenant_id, started_at, completed_at, duration_seconds, memories_processed, duplicates_found, 
        duplicates_merged, relationships_created, relationships_updated, quality_score, status, error_message)
       VALUES ($1, $2, $3, 10, 100, 5, 5, 20, 10, 0.85, 'completed', NULL)`,
      [testTenantId, startTime, new Date()]
    );

    // Verify insertion
    const result = await pool.query(
      'SELECT * FROM optimization_history WHERE tenant_id = $1 ORDER BY started_at DESC LIMIT 1',
      [testTenantId]
    );

    expect(result.rows.length).toBe(1);
    expect(result.rows[0].status).toBe('completed');
    expect(result.rows[0].memories_processed).toBe(100);
    expect(result.rows[0].duplicates_merged).toBe(5);

    // Cleanup
    await pool.query('DELETE FROM optimization_history WHERE tenant_id = $1', [testTenantId]);
  });
});
