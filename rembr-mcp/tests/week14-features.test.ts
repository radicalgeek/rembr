/** Causal, temporal and operational audit workflows against the OSS database. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createRuntimeDatabase } from '../src/test-utils/runtime-db.js';
import { CausalReasoningService } from '../src/causal-reasoning-service.js';
import { TemporalQueryService } from '../src/temporal-query-service.js';
import { AuditLogger } from '../src/audit-logger.js';
import type { OllamaClient } from '../src/ollama-client.js';

describe('Causal, temporal and audit integration', () => {
  let runtime: Awaited<ReturnType<typeof createRuntimeDatabase>>;
  let causal: CausalReasoningService;
  let temporal: TemporalQueryService;
  let audit: AuditLogger;
  const tenantId = randomUUID();
  const causeId = randomUUID();
  const effectId = randomUUID();
  let linkId: string;
  let snapshotId: string;
  beforeAll(async () => {
    runtime = await createRuntimeDatabase('rembr_test_agentic');
    await runtime.pool.query(`INSERT INTO tenants (id, name, email) VALUES ($1, 'Agentic test', $2)`, [tenantId, `${tenantId}@test.invalid`]);
    // Fixed model response makes the database workflow repeatable without a paid provider.
    causal = new CausalReasoningService(runtime.pool, { generateText: async () => JSON.stringify({ has_causality: true, causal_type: 'enables', strength: 0.9, explanation: 'Login enables access to the dashboard.' }) } as unknown as OllamaClient);
    temporal = new TemporalQueryService(runtime.pool);
    audit = new AuditLogger(runtime.pool);
  });
  afterAll(async () => {
    if (!runtime) return;
    await runtime.pool.query('DELETE FROM temporal_snapshots WHERE tenant_id = $1', [tenantId]);
    await runtime.pool.query('DELETE FROM memories WHERE tenant_id = $1', [tenantId]);
    await runtime.pool.query('DELETE FROM audit_logs WHERE tenant_id = $1', [tenantId]);
    await runtime.pool.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
    await runtime.db.close();
    await runtime.pool.end();
  });
  it('stores a cause memory', async () => {
    const row = await runtime.pool.query(`INSERT INTO memories (id, tenant_id, content, category, created_at, valid_from) VALUES ($1, $2, 'User logged in successfully', 'facts', NOW() - INTERVAL '1 minute', NOW() - INTERVAL '1 minute') RETURNING content`, [causeId, tenantId]);
    expect(row.rows[0].content).toContain('logged in');
  });
  it('stores the subsequent effect memory', async () => {
    await runtime.pool.query(`INSERT INTO memories (id, tenant_id, content, category) VALUES ($1, $2, 'User viewed dashboard after login', 'facts')`, [effectId, tenantId]);
    expect((await runtime.pool.query('SELECT id FROM memories WHERE tenant_id = $1', [tenantId])).rows).toHaveLength(2);
  });
  it('infers and persists a causal relationship', async () => {
    const link = await causal.inferCausality(tenantId, causeId, effectId);
    expect(link).toEqual(expect.objectContaining({ cause_memory_id: causeId, effect_memory_id: effectId, causal_type: 'enables' }));
    linkId = link!.id;
  });
  it('retrieves causal links', async () => {
    expect(await causal.getCausalLinks(tenantId, causeId)).toContainEqual(expect.objectContaining({ id: linkId }));
  });
  it('traces the causal chain', async () => {
    expect(await causal.traceCausalChain(tenantId, causeId)).toEqual(expect.objectContaining({ root: causeId, total_links: 1 }));
  });
  it('validates an existing link', async () => {
    await causal.validateCausalLink(tenantId, linkId, true);
    expect((await causal.getCausalLinks(tenantId, causeId))[0].validated_by_user).toBe(true);
  });
  it('returns memory history', async () => {
    expect(await temporal.getMemoryHistory(tenantId, causeId)).toContainEqual(expect.objectContaining({ content: 'User logged in successfully' }));
  });
  it('searches at a specific time', async () => {
    expect(await temporal.searchAtTime(tenantId, 'logged', new Date(), {})).toContainEqual(expect.objectContaining({ id: causeId }));
  });
  it('creates a named temporal snapshot', async () => {
    snapshotId = await temporal.createSnapshot(tenantId, 'Integration snapshot');
    expect(await temporal.getSnapshot(tenantId, 'Integration snapshot')).toEqual(expect.objectContaining({ snapshot_name: 'Integration snapshot', total_memories: 2 }));
  });
  it('compares earlier and current snapshots', async () => {
    const diff = await temporal.compareSnapshots(tenantId, new Date(Date.now() - 86400000), new Date());
    expect(diff.added).toBe(2);
    expect(diff.removed).toBe(0);
  });
  it('records and queries operational audit events', async () => {
    expect(await audit.log({ tenantId, eventType: 'memory.create', resourceType: 'memory', resourceId: causeId, actionResult: 'success' }, 'required')).toBe(true);
    expect(await audit.query(tenantId, {})).toContainEqual(expect.objectContaining({ event_type: 'memory.create', resource_id: causeId }));
  });
  it('returns audit statistics', async () => {
    expect(Number((await audit.getAuditStats(tenantId)).total_events)).toBe(1);
  });
  it('builds an internal event summary for the recorded period', async () => {
    const report = await audit.generateComplianceReport(tenantId, new Date(Date.now() - 86400000), new Date());
    expect(report.totalEvents).toBe(1);
    expect(report.failureRate).toBe(0);
  });
});
