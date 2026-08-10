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
    const pool = makePool([{ rows: [req] }, { rows: [makeEvent()] }]);
    const svc = new GDPRComplianceService(pool);
    const result = await svc.requestForgetMe(TENANT, { user_id: USER });
    expect(result.id).toBe(REQ_ID);
    expect(result.status).toBe('pending');
    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  it('uses full request type by default', async () => {
    const req = makeRequest();
    const pool = makePool([{ rows: [req] }, { rows: [makeEvent()] }]);
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
    const pool = makePool([{ rows: [req] }, { rows: [makeEvent()] }]);
    const svc = new GDPRComplianceService(pool);
    const result = await svc.requestForgetMe(TENANT, { request_type: 'selective' });
    expect(result.request_type).toBe('selective');
  });
});

// ─── getDeletionRequest ───────────────────────────────────────────────────────

describe('getDeletionRequest', () => {
  it('returns request when found', async () => {
    const req = makeRequest({ status: 'completed' });
    const pool = makePool([{ rows: [req] }]);
    const svc = new GDPRComplianceService(pool);
    const result = await svc.getDeletionRequest(REQ_ID, TENANT);
    expect(result).not.toBeNull();
    expect(result!.status).toBe('completed');
  });

  it('returns null when not found', async () => {
    const pool = makePool([{ rows: [] }]);
    const svc = new GDPRComplianceService(pool);
    const result = await svc.getDeletionRequest('missing', TENANT);
    expect(result).toBeNull();
  });
});

// ─── listDeletionRequests ─────────────────────────────────────────────────────

describe('listDeletionRequests', () => {
  it('returns list of requests', async () => {
    const pool = makePool([{ rows: [makeRequest(), makeRequest({ id: 'req-002' })] }]);
    const svc = new GDPRComplianceService(pool);
    const results = await svc.listDeletionRequests(TENANT);
    expect(results).toHaveLength(2);
  });
});

// ─── setRetentionPolicy ───────────────────────────────────────────────────────

describe('setRetentionPolicy', () => {
  it('fails closed until caller and audience-safe retention authorisation exists', async () => {
    const pool = makePool([]);
    const svc = new GDPRComplianceService(pool);
    await expect(svc.setRetentionPolicy(TENANT, MEM_ID, 'minimal'))
      .rejects.toThrow(/unavailable pending audience-safe authorisation/);
    expect(pool.query).not.toHaveBeenCalled();
  });
});

// ─── purgeExpiredMemories ─────────────────────────────────────────────────────

describe('purgeExpiredMemories', () => {
  it('fails closed without an audience-safe maintenance identity', async () => {
    const pool = makePool([]);
    const svc = new GDPRComplianceService(pool);
    await expect(svc.purgeExpiredMemories(TENANT))
      .rejects.toThrow(/unavailable pending audience-safe scheduled execution/);
    expect(pool.query).not.toHaveBeenCalled();
  });
});

// ─── getRetentionStats ────────────────────────────────────────────────────────

describe('getRetentionStats', () => {
  it('returns parsed stats', async () => {
    const statsRow = {
      total: '500', pii: '23', expired: '8',
      standard: '400', extended: '50', minimal: '30', gdpr_deleted: '20',
    };
    const pool = makePool([{ rows: [statsRow] }]);
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
    const pool = makePool([{ rows: events }, { rows: [{ count: '2' }] }]);
    const svc = new GDPRComplianceService(pool);
    const result = await svc.getConsentAuditTrail(TENANT, {});
    expect(result.events).toHaveLength(2);
    expect(result.total).toBe(2);
  });

  it('filters by event type', async () => {
    const pool = makePool([{ rows: [makeEvent({ event_type: 'data_deleted' })] }, { rows: [{ count: '1' }] }]);
    const svc = new GDPRComplianceService(pool);
    const result = await svc.getConsentAuditTrail(TENANT, { event_type: 'data_deleted' });
    expect(result.events[0].event_type).toBe('data_deleted');
  });
});

// ─── exportData ───────────────────────────────────────────────────────────────

describe('exportData', () => {
  it('fails closed until subject-scoped context ownership is enforced', async () => {
    const pool = makePool([]);
    const svc = new GDPRComplianceService(pool);
    await expect(svc.exportData(TENANT, USER))
      .rejects.toThrow(/unavailable pending subject-scoped/);
    expect(pool.query).not.toHaveBeenCalled();
  });
});
