/**
 * Performance Benchmark Script (REM-45)
 *
 * Measures latency for key MCP operations:
 * - store_memory
 * - search_memory (text, phrase)
 * - get_stats
 *
 * Usage: npx tsx tests/performance/benchmark.ts
 *
 * Targets:
 *   store_memory  p50 < 200ms,  p95 < 500ms
 *   search_memory p50 < 300ms,  p95 < 800ms
 *   get_stats     p50 < 100ms,  p95 < 300ms
 */

import { Pool } from 'pg';
import { MemoryDatabase } from '../../src/database.js';
import { MemoryService } from '../../src/memory-service.js';

const TENANT_ID = 'bench-0000-0000-0000-000000000045';
const PROJECT_ID = 'bench-0000-0000-0000-000000000046';
const N = 50; // number of iterations per operation

interface BenchResult {
  name: string;
  n: number;
  p50: number;
  p95: number;
  min: number;
  max: number;
  pass: boolean;
  target_p50: number;
  target_p95: number;
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

async function bench(name: string, fn: () => Promise<void>, targetP50: number, targetP95: number): Promise<BenchResult> {
  const times: number[] = [];
  for (let i = 0; i < N; i++) {
    const start = Date.now();
    await fn();
    times.push(Date.now() - start);
  }
  times.sort((a, b) => a - b);
  const p50 = percentile(times, 50);
  const p95 = percentile(times, 95);
  return {
    name,
    n: N,
    p50,
    p95,
    min: times[0],
    max: times[times.length - 1],
    pass: p50 < targetP50 && p95 < targetP95,
    target_p50: targetP50,
    target_p95: targetP95,
  };
}

function printResult(r: BenchResult) {
  const status = r.pass ? '✅ PASS' : '❌ FAIL';
  console.log(`${status} ${r.name.padEnd(30)} p50=${r.p50}ms (target <${r.target_p50}ms)  p95=${r.p95}ms (target <${r.target_p95}ms)  min=${r.min}ms  max=${r.max}ms  n=${r.n}`);
}

async function main() {
  const dbUrl = process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/rembr_test';
  const pool = new Pool({ connectionString: dbUrl });
  const db = new MemoryDatabase(dbUrl);
  const service = new MemoryService(TENANT_ID, PROJECT_ID, db, undefined, 'bench-user');

  // Ensure tenant exists
  await pool.query(`INSERT INTO tenants (id, name) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [TENANT_ID, 'bench-tenant']);
  await pool.query(`INSERT INTO tenant_plans (tenant_id, plan, memory_limit, search_limit_daily, project_limit) VALUES ($1, 'pro', 100000, 100000, 100) ON CONFLICT DO NOTHING`, [TENANT_ID]);
  await pool.query(`INSERT INTO projects (id, tenant_id, name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [PROJECT_ID, TENANT_ID, 'bench-project']);

  // Seed data for search benchmarks
  console.log(`\n🔧 Seeding ${N} memories for search benchmarks...`);
  for (let i = 0; i < N; i++) {
    await service.storeMemory({
      content: `Benchmark seed memory ${i}: exploring software engineering and distributed systems`,
      category: 'notes',
      metadata: { bench: true },
    });
  }

  const results: BenchResult[] = [];

  console.log(`\n📊 Running benchmarks (n=${N} each)...\n`);

  results.push(await bench('store_memory', async () => {
    await service.storeMemory({
      content: 'Benchmark memory: software architecture and design patterns in modern systems',
      category: 'notes',
      metadata: { bench: true },
    });
  }, 200, 500));

  results.push(await bench('search_memory (text)', async () => {
    await service.searchMemory({ query: 'software engineering distributed', limit: 10, search_mode: 'text' });
  }, 300, 800));

  results.push(await bench('search_memory (phrase)', async () => {
    await service.searchMemory({ query: 'benchmark seed memory', limit: 10, search_mode: 'phrase' });
  }, 300, 800));

  results.push(await bench('get_stats', async () => {
    await service.getStats();
  }, 100, 300));

  // Print results
  console.log('\n─────────────────────────────────────────────────────────────────────────\n');
  for (const r of results) printResult(r);
  console.log('\n─────────────────────────────────────────────────────────────────────────\n');

  const allPassed = results.every(r => r.pass);
  console.log(allPassed ? '✅ All benchmarks passed!' : '❌ Some benchmarks failed — see above.');

  // Cleanup
  await pool.query(`DELETE FROM memories WHERE tenant_id = $1`, [TENANT_ID]);
  await pool.end();

  process.exit(allPassed ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
