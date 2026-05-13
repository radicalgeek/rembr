/**
 * Tests for GDPR Compliance Service (REM-29)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GDPRComplianceService } from './gdpr-compliance.js';

const TENANT = 'a1b2c3d4-0000-0000-0000-000000000001';
const USER   = 'bbbbbbbb-0000-0000-0000-000000000002';
const MEM_ID = 'cccccccc-0000-0000-0000-000000000003';
const REQ_ID = 'dddddddd-0000-0000-0000-000000000004';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makePool(responses: any[]) {
  let idx = 0;
  return {
    query: vi.fn().mockImplementation(() => {
      const res = responses[idx] ?? { rows: [], rowCount: 0 };
      idx++;
      return Promise.resolve(res);
    }),
    connect: vi.fn().mockImplementation(() => {
      const client = {
        query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
        release: vi.fn(),
      };
      return Promise.resolve(client);
    }),
  } as any;
}

function makeRequest(overrides: Partial<Record<string, any>> = {}) {
  return {
    id: REQ_ID,
    tenant_id: TENANT,
    user_id: USER,
    request_type: 'full',
    status: 'pending',
    memories_deleted: 0,
    contexts_deleted: 0,
    snapshots_deleted: 0,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function makeEvent(overrides: Partial<Record<string, any>> = {}) {
  return {
    id: 'eeeeeeee-0000-0000-0000-000000000005',
    tenant_id: TENANT,
    event_type: 'data_deleted',
    created_at: new Date(),
    ...overrides,
  };
}

// ─── requestForgetMe ──────────────────────────────────────────────────────────

describe('requestForgetMe', () => {
  it('creates a deletion request and consent event', async () => {
    const req = makeRequest();
    // schema, insert request, insert consent event
    const pool = makePool([{ rows: [] }, { rows: [req] }, { rows: [makeEvent()] }]);
    const svc = new GDPRComplianceService(pool);
    const result = await svc.requestForgetMe(TENANT, { user_id: USER });
    expect(result.id).toBe(REQ_ID);
    expect(result.status).toBe('pending');
    expect(pool.query).toHaveBeenCalledTimes(3);
  });

  it('uses full request type by default', async () => {
    const req = makeRequest();
    const pool = makePool([{ rows: [] }, { rows: [req] }, { rows: [makeEvent()] }]);
    const svc = new GDPRComplianceService(pool);
    await svc.requestForgetMe(TENANT);
    const insertCall = pool.query.mock.calls.find((c: any[]) =>
      c[0].includes('INSERT INTO gdpr_deletion_requests')
    );
    expect(insertCall).toBeDefined();
    expect(insertCall[1]).toContain('full');
  });

  it('accepts selective request type', async () => {
    const req = makeRequest({ request_type: 'selective' });
    const pool = makePool([{ rows: [] }, { rows: [req] }, { rows: [makeEvent()] }]);
    const svc = new GDPRComplianceService(pool);
    const result = await svc.requestForgetMe(TENANT, { request_type: 'selective' });
    expect(result.request_type).toBe('selective');
  });
});

// ─── getDeletionRequest ───────────────────────────────────────────────────────

describe('getDeletionRequest', () => {
  it('returns request when found', async () => {
    const req = makeRequest({ status: 'completed' });
    const pool = makePool([{ rows: [] }, { rows: [req] }]);
    const svc = new GDPRComplianceService(pool);
    const result = await svc.getDeletionRequest(REQ_ID, TENANT);
    expect(result).not.toBeNull();
    expect(result!.status).toBe('completed');
  });

  it('returns null when not found', async () => {
    const pool = makePool([{ rows: [] }, { rows: [] }]);
    const svc = new GDPRComplianceService(pool);
    const result = await svc.getDeletionRequest('missing', TENANT);
    expect(result).toBeNull();
  });
});

// ─── listDeletionRequests ─────────────────────────────────────────────────────

describe('listDeletionRequests', () => {
  it('returns list of requests', async () => {
    const pool = makePool([{ rows: [] }, { rows: [makeRequest(), makeRequest({ id: 'req-002' })] }]);
    const svc = new GDPRComplianceService(pool);
    const results = await svc.listDeletionRequests(TENANT);
    expect(results).toHaveLength(2);
  });
});

// ─── setRetentionPolicy ───────────────────────────────────────────────────────

describe('setRetentionPolicy', () => {
  it('updates retention policy and logs consent event', async () => {
    // schema, SELECT prev, UPDATE, INSERT consent event
    const pool = makePool([
      { rows: [] },
      { rows: [{ retention_policy: 'standard' }] },
      { rows: [], rowCount: 1 },
      { rows: [makeEvent({ event_type: 'retention_policy_changed' })] },
    ]);
    const svc = new GDPRComplianceService(pool);
    await svc.setRetentionPolicy(TENANT, MEM_ID, 'minimal');
    const updateCall = pool.query.mock.calls.find((c: any[]) =>
      c[0].includes('UPDATE memories') && c[0].includes('retention_policy')
    );
    expect(updateCall).toBeDefined();
    expect(updateCall[1][0]).toBe('minimal'); // first param is policy
  });

  it('sets expires_at for minimal policy (30 days)', async () => {
    const pool = makePool([
      { rows: [] },
      { rows: [{ retention_policy: 'standard' }] },
      { rows: [], rowCount: 1 },
      { rows: [makeEvent()] },
    ]);
    const svc = new GDPRComplianceService(pool);
    await svc.setRetentionPolicy(TENANT, MEM_ID, 'minimal');
    const updateCall = pool.query.mock.calls.find((c: any[]) =>
      c[0].includes('UPDATE memories') && c[0].includes('retention_policy')
    );
    const expiresAt = updateCall[1][1] as string;
    expect(expiresAt).toBeDefined();
    const expiry = new Date(expiresAt);
    const now = new Date();
    const diffDays = (expiry.getTime() - now.getTime()) / (1000 * 86400);
    expect(diffDays).toBeGreaterThan(29);
    expect(diffDays).toBeLessThan(31);
  });

  it('sets null expires_at for gdpr_deleted policy', async () => {
    const pool = makePool([
      { rows: [] },
      { rows: [{ retention_policy: 'standard' }] },
      { rows: [], rowCount: 1 },
      { rows: [makeEvent()] },
    ]);
    const svc = new GDPRComplianceService(pool);
    await svc.setRetentionPolicy(TENANT, MEM_ID, 'gdpr_deleted');
    const updateCall = pool.query.mock.calls.find((c: any[]) =>
      c[0].includes('UPDATE memories') && c[0].includes('retention_policy')
    );
    expect(updateCall[1][1]).toBeNull();
  });
});

// ─── purgeExpiredMemories ─────────────────────────────────────────────────────

describe('purgeExpiredMemories', () => {
  it('returns count of deleted memories', async () => {
    const pool = makePool([{ rows: [] }, { rows: [], rowCount: 5 }]);
    const svc = new GDPRComplianceService(pool);
    const count = await svc.purgeExpiredMemories(TENANT);
    expect(count).toBe(5);
  });

  it('always includes tenant_id in DELETE (no cross-tenant purge)', async () => {
    const pool = makePool([{ rows: [] }, { rows: [], rowCount: 3 }]);
    const svc = new GDPRComplianceService(pool);
    const count = await svc.purgeExpiredMemories(TENANT);
    expect(count).toBe(3);
    const deleteCall = pool.query.mock.calls.find((c: any[]) =>
      c[0].includes('DELETE FROM memories')
    );
    // tenant_id must always be param $1
    expect(deleteCall[1][0]).toBe(TENANT);
    expect(deleteCall[0]).toContain('tenant_id = $1');
  });
});

// ─── getRetentionStats ────────────────────────────────────────────────────────

describe('getRetentionStats', () => {
  it('returns parsed stats', async () => {
    const statsRow = {
      total: '500', pii: '23', expired: '8',
      standard: '400', extended: '50', minimal: '30', gdpr_deleted: '20',
    };
    const pool = makePool([{ rows: [] }, { rows: [statsRow] }]);
    const svc = new GDPRComplianceService(pool);
    const stats = await svc.getRetentionStats(TENANT);
    expect(stats.total_memories).toBe(500);
    expect(stats.pii_detected).toBe(23);
    expect(stats.expired).toBe(8);
    expect(stats.by_policy.standard).toBe(400);
    expect(stats.by_policy.gdpr_deleted).toBe(20);
  });
});

// ─── logConsentEvent ──────────────────────────────────────────────────────────

describe('logConsentEvent', () => {
  it('inserts and returns consent event', async () => {
    const event = makeEvent({ event_type: 'consent_given' });
    const pool = makePool([{ rows: [event] }]);
    const svc = new GDPRComplianceService(pool);
    const result = await svc.logConsentEvent(TENANT, { event_type: 'consent_given' });
    expect(result.event_type).toBe('consent_given');
  });
});

// ─── getConsentAuditTrail ─────────────────────────────────────────────────────

describe('getConsentAuditTrail', () => {
  it('returns events and total', async () => {
    const events = [makeEvent(), makeEvent({ id: 'ev-002' })];
    const pool = makePool([{ rows: [] }, { rows: events }, { rows: [{ count: '2' }] }]);
    const svc = new GDPRComplianceService(pool);
    const result = await svc.getConsentAuditTrail(TENANT, {});
    expect(result.events).toHaveLength(2);
    expect(result.total).toBe(2);
  });

  it('filters by event type', async () => {
    const pool = makePool([{ rows: [] }, { rows: [makeEvent({ event_type: 'data_deleted' })] }, { rows: [{ count: '1' }] }]);
    const svc = new GDPRComplianceService(pool);
    const result = await svc.getConsentAuditTrail(TENANT, { event_type: 'data_deleted' });
    expect(result.events[0].event_type).toBe('data_deleted');
  });
});

// ─── exportData ───────────────────────────────────────────────────────────────

describe('exportData', () => {
  it('returns export with memories and consent events', async () => {
    const memories = [
      { id: MEM_ID, content: 'test memory', pii_detected: true },
      { id: 'mem-002', content: 'safe memory', pii_detected: false },
    ];
    const pool = makePool([
      { rows: [] },           // schema
      { rows: memories },     // memories query
      { rows: [] },           // contexts query
      { rows: [] },           // consent events query
      { rows: [makeEvent({ event_type: 'data_exported' })] }, // log export event
    ]);
    const svc = new GDPRComplianceService(pool);
    const result = await svc.exportData(TENANT);
    expect(result.total_memories).toBe(2);
    expect(result.pii_detected_count).toBe(1);
    expect(result.memories).toHaveLength(2);
    expect(result.tenant_id).toBe(TENANT);
    expect(result.exported_at).toBeDefined();
  });
});
