/**
 * Tests for Work Queue & Agent Handoff (REM-36)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkQueueService } from './work-queue.js';
import type { QueueItem } from './work-queue.js';

const TENANT = 'a1b2c3d4-0000-0000-0000-000000000001';
const AGENT  = 'agent-iris-001';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeItemRow(overrides: Partial<Record<string, any>> = {}): Record<string, any> {
  return {
    id: 'item-001',
    tenant_id: TENANT,
    queue_name: 'default',
    task_type: 'process_memory',
    priority: 'normal',
    status: 'pending',
    payload: { key: 'value' },
    handoff: null,
    attempt_count: '0',
    max_attempts: '3',
    claimed_by: null,
    claimed_at: null,
    lease_expires_at: null,
    completed_at: null,
    failed_at: null,
    failure_reason: null,
    scheduled_after: null,
    idempotency_key: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function makePool(responses: any[]) {
  let idx = 0;
  return {
    query: vi.fn().mockImplementation(() => {
      const res = responses[idx] ?? { rows: [], rowCount: 0 };
      idx++;
      return Promise.resolve(res);
    }),
  } as any;
}

// ─── enqueue ──────────────────────────────────────────────────────────────────

describe('enqueue', () => {
  it('inserts a new item and returns it', async () => {
    const row = makeItemRow();
    const pool = makePool([{ rows: [] }, { rows: [row] }]); // schema + insert
    const svc = new WorkQueueService(pool);
    const item = await svc.enqueue(TENANT, {
      queue_name: 'default',
      task_type: 'process_memory',
      payload: { key: 'value' },
    });
    expect(item.id).toBe('item-001');
    expect(item.status).toBe('pending');
    expect(item.attempt_count).toBe(0);
  });

  it('uses default priority normal', async () => {
    const pool = makePool([{ rows: [] }, { rows: [makeItemRow()] }]);
    const svc = new WorkQueueService(pool);
    await svc.enqueue(TENANT, { queue_name: 'q', task_type: 'x', payload: {} });
    const insertCall = pool.query.mock.calls.find((c: any[]) => c[0].includes('INSERT INTO work_queue'));
    const params = insertCall[1];
    expect(params[3]).toBe('normal'); // priority param
  });

  it('stores handoff payload', async () => {
    const row = makeItemRow({ handoff: { summary: 'Do next', context: { foo: 1 }, instructions: 'Continue' } });
    const pool = makePool([{ rows: [] }, { rows: [row] }]);
    const svc = new WorkQueueService(pool);
    const item = await svc.enqueue(TENANT, {
      queue_name: 'q',
      task_type: 'x',
      payload: {},
      handoff: { summary: 'Do next', context: { foo: 1 }, instructions: 'Continue' },
    });
    expect(item.handoff?.summary).toBe('Do next');
    expect(item.handoff?.instructions).toBe('Continue');
  });
});

// ─── claim ────────────────────────────────────────────────────────────────────

describe('claim', () => {
  it('returns null when queue is empty', async () => {
    const pool = makePool([{ rows: [] }, { rows: [] }, { rows: [] }]); // schema + expire + claim
    const svc = new WorkQueueService(pool);
    const result = await svc.claim(TENANT, 'default', AGENT);
    expect(result).toBeNull();
  });

  it('returns claimed item with lease', async () => {
    const claimed = makeItemRow({
      status: 'claimed',
      claimed_by: AGENT,
      attempt_count: '1',
      lease_expires_at: new Date('2026-01-01T00:05:00Z'),
    });
    const pool = makePool([{ rows: [] }, { rows: [] }, { rows: [claimed] }]);
    const svc = new WorkQueueService(pool);
    const result = await svc.claim(TENANT, 'default', AGENT);
    expect(result).not.toBeNull();
    expect(result!.item.status).toBe('claimed');
    expect(result!.item.claimed_by).toBe(AGENT);
    expect(result!.item.attempt_count).toBe(1);
    expect(result!.lease_expires_at).toBeDefined();
  });
});

// ─── complete ─────────────────────────────────────────────────────────────────

describe('complete', () => {
  it('marks item completed', async () => {
    const completed = makeItemRow({ status: 'completed', completed_at: new Date() });
    const pool = makePool([{ rows: [] }, { rows: [completed] }]);
    const svc = new WorkQueueService(pool);
    const item = await svc.complete(TENANT, 'item-001', AGENT);
    expect(item.status).toBe('completed');
  });

  it('throws when item not found or not claimed by this agent', async () => {
    const pool = makePool([{ rows: [] }, { rows: [] }]); // empty result
    const svc = new WorkQueueService(pool);
    await expect(svc.complete(TENANT, 'item-001', AGENT)).rejects.toThrow('not found');
  });

  it('attaches result handoff to completed item', async () => {
    const completed = makeItemRow({
      status: 'completed',
      handoff: { summary: 'Phase 2 ready', context: { result: 'ok' } },
    });
    const pool = makePool([{ rows: [] }, { rows: [completed] }]);
    const svc = new WorkQueueService(pool);
    const item = await svc.complete(TENANT, 'item-001', AGENT, {
      summary: 'Phase 2 ready',
      context: { result: 'ok' },
    });
    expect(item.handoff?.summary).toBe('Phase 2 ready');
  });
});

// ─── fail ─────────────────────────────────────────────────────────────────────

describe('fail', () => {
  it('marks item failed', async () => {
    const failed = makeItemRow({ status: 'failed', failure_reason: 'timeout', attempt_count: '1' });
    const pool = makePool([{ rows: [] }, { rows: [failed] }]);
    const svc = new WorkQueueService(pool);
    const item = await svc.fail(TENANT, 'item-001', AGENT, 'timeout');
    expect(item.status).toBe('failed');
    expect(item.failure_reason).toBe('timeout');
  });

  it('marks item dead_letter when max_attempts reached', async () => {
    const dl = makeItemRow({ status: 'dead_letter', attempt_count: '3', max_attempts: '3' });
    const pool = makePool([{ rows: [] }, { rows: [dl] }]);
    const svc = new WorkQueueService(pool);
    const item = await svc.fail(TENANT, 'item-001', AGENT, 'exhausted');
    expect(item.status).toBe('dead_letter');
  });

  it('throws when item not claimed by this agent', async () => {
    const pool = makePool([{ rows: [] }, { rows: [] }]);
    const svc = new WorkQueueService(pool);
    await expect(svc.fail(TENANT, 'item-001', AGENT, 'err')).rejects.toThrow('not found');
  });
});

// ─── retry ────────────────────────────────────────────────────────────────────

describe('retry', () => {
  it('resets failed item to pending', async () => {
    const pending = makeItemRow({ status: 'pending', failure_reason: null });
    const pool = makePool([{ rows: [] }, { rows: [pending] }]);
    const svc = new WorkQueueService(pool);
    const item = await svc.retry(TENANT, 'item-001');
    expect(item.status).toBe('pending');
    expect(item.failure_reason).toBeNull();
  });

  it('throws when item not in retriable state', async () => {
    const pool = makePool([{ rows: [] }, { rows: [] }]);
    const svc = new WorkQueueService(pool);
    await expect(svc.retry(TENANT, 'item-001')).rejects.toThrow('not found');
  });
});

// ─── renewLease ───────────────────────────────────────────────────────────────

describe('renewLease', () => {
  it('updates lease expiry', async () => {
    const updated = makeItemRow({ status: 'claimed', lease_expires_at: new Date(Date.now() + 300000) });
    const pool = makePool([{ rows: [] }, { rows: [updated] }]);
    const svc = new WorkQueueService(pool);
    const item = await svc.renewLease(TENANT, 'item-001', AGENT, 300);
    expect(item.lease_expires_at).toBeDefined();
    expect(item.status).toBe('claimed');
  });
});

// ─── list ─────────────────────────────────────────────────────────────────────

describe('list', () => {
  it('returns items and total count', async () => {
    const rows = [makeItemRow({ id: 'item-001' }), makeItemRow({ id: 'item-002' })];
    const pool = makePool([{ rows: [] }, { rows }, { rows: [{ count: '2' }] }]);
    const svc = new WorkQueueService(pool);
    const result = await svc.list(TENANT, { queue_name: 'default' });
    expect(result.items).toHaveLength(2);
    expect(result.total).toBe(2);
  });

  it('filters by status array', async () => {
    const pool = makePool([{ rows: [] }, { rows: [makeItemRow()] }, { rows: [{ count: '1' }] }]);
    const svc = new WorkQueueService(pool);
    await svc.list(TENANT, { status: ['pending', 'claimed'] });
    const listCall = pool.query.mock.calls.find((c: any[]) => c[0].includes('SELECT * FROM work_queue') && !c[0].includes('COUNT'));
    expect(listCall).toBeDefined();
  });
});

// ─── getStats ─────────────────────────────────────────────────────────────────

describe('getStats', () => {
  it('returns per-queue stats', async () => {
    const statsRow = {
      queue_name: 'default',
      pending: '5', claimed: '2', completed: '100', failed: '3', dead_letter: '1',
      total: '111',
      oldest_pending_age_seconds: '120.5',
      avg_completion_seconds: '45.2',
    };
    const pool = makePool([{ rows: [] }, { rows: [statsRow] }]);
    const svc = new WorkQueueService(pool);
    const stats = await svc.getStats(TENANT);
    expect(stats).toHaveLength(1);
    expect(stats[0].queue_name).toBe('default');
    expect(stats[0].pending).toBe(5);
    expect(stats[0].completed).toBe(100);
    expect(stats[0].oldest_pending_age_seconds).toBe(120.5);
    expect(stats[0].avg_completion_seconds).toBe(45.2);
  });

  it('returns null for oldest_pending when no pending items', async () => {
    const statsRow = {
      queue_name: 'empty', pending: '0', claimed: '0', completed: '0', failed: '0', dead_letter: '0',
      total: '0', oldest_pending_age_seconds: null, avg_completion_seconds: null,
    };
    const pool = makePool([{ rows: [] }, { rows: [statsRow] }]);
    const svc = new WorkQueueService(pool);
    const stats = await svc.getStats(TENANT);
    expect(stats[0].oldest_pending_age_seconds).toBeNull();
    expect(stats[0].avg_completion_seconds).toBeNull();
  });
});

// ─── get ──────────────────────────────────────────────────────────────────────

describe('get', () => {
  it('returns item by id', async () => {
    const pool = makePool([{ rows: [] }, { rows: [makeItemRow()] }]);
    const svc = new WorkQueueService(pool);
    const item = await svc.get(TENANT, 'item-001');
    expect(item).not.toBeNull();
    expect(item!.id).toBe('item-001');
  });

  it('returns null when not found', async () => {
    const pool = makePool([{ rows: [] }, { rows: [] }]);
    const svc = new WorkQueueService(pool);
    const item = await svc.get(TENANT, 'missing');
    expect(item).toBeNull();
  });
});

// ─── purge ────────────────────────────────────────────────────────────────────

describe('purge', () => {
  it('returns count of deleted rows', async () => {
    const pool = makePool([{ rows: [] }, { rows: [], rowCount: 7 }]);
    const svc = new WorkQueueService(pool);
    const count = await svc.purge(TENANT, 'default', 7);
    expect(count).toBe(7);
  });
});
