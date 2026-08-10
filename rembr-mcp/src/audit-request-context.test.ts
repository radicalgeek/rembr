import { describe, expect, it, vi } from 'vitest';
import { AuditLogger } from './audit-logger.js';

describe('AuditLogger request-scoped attribution', () => {
  it('does not cross-attribute interleaved principals', async () => {
    const inserts: unknown[][] = [];
    const query = vi.fn(async (_sql: string, params: unknown[]) => {
      await new Promise(resolve => setTimeout(resolve, params[1] === 'user-a' ? 5 : 0));
      inserts.push(params);
      return { rows: [], rowCount: 1 };
    });
    const base = new AuditLogger({ query } as any);
    const principalA = base.withContext({ tenantId: 'tenant-a', userId: 'user-a', apiKeyId: 'key-a', ipAddress: '10.0.0.1' });
    const principalB = base.withContext({ tenantId: 'tenant-b', userId: 'user-b', apiKeyId: 'key-b', ipAddress: '10.0.0.2' });

    await Promise.all([
      principalA.log({ tenantId: 'spoofed-tenant', userId: 'spoofed-user', eventType: 'memory.search', resourceType: 'memory', actionResult: 'success' }),
      principalB.log({ eventType: 'memory.create', resourceType: 'memory', actionResult: 'success' }),
    ]);

    const byTenant = new Map(inserts.map(params => [params[0], params]));
    expect(byTenant.get('tenant-a')?.slice(1, 6)).toEqual(['user-a', 'key-a', null, '10.0.0.1', null]);
    expect(byTenant.get('tenant-b')?.slice(1, 6)).toEqual(['user-b', 'key-b', null, '10.0.0.2', null]);
  });

  it('redacts database error detail from fallback logging', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logger = new AuditLogger({ query: vi.fn().mockRejectedValue(new Error('private database detail')) } as any);
    await expect(logger.log({ eventType: 'test', resourceType: 'test', actionResult: 'failure' })).resolves.toBe(false);
    await expect(logger.log({ eventType: 'test', resourceType: 'test', actionResult: 'failure' }, 'required'))
      .rejects.toThrow('Required audit persistence failed');
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('private database detail');
    consoleError.mockRestore();
  });

  it('bounds and redacts audit JSON instead of duplicating memory/query/secret material', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    const logger = new AuditLogger({ query } as any);
    await expect(logger.log({
      eventType: 'memory.create',
      resourceType: 'memory',
      actionResult: 'failure',
      errorMessage: 'private SQL detail',
      payloadAfter: {
        content: 'private durable memory',
        authorization: 'Bearer private',
        nested: { safe: 'value', queryText: 'private query' },
      },
      metadata: { giant: 'x'.repeat(20_000) },
    })).resolves.toBe(true);
    const params = query.mock.calls[0][1] as unknown[];
    expect(params[10]).toBe('operation_failed');
    expect(params[12]).toContain('[redacted]');
    expect(params[12]).not.toContain('private durable memory');
    expect(params[12]).not.toContain('Bearer private');
    expect(Buffer.byteLength(String(params[16]), 'utf8')).toBeLessThanOrEqual(16 * 1024);
  });

  it('verifies recent windows in ascending chain order with one predecessor anchor', async () => {
    const logger = new AuditLogger({ query: vi.fn() } as any);
    const rows = [1, 2, 3].map(seq => ({
      seq_num: String(seq),
      id: `id-${seq}`,
      tenant_id: 'tenant',
      user_id: '', api_key_id: '', agent_id: '', ip_address: '', user_agent: '',
      event_type: 'memory.read', resource_type: 'memory', resource_id: '',
      action_result: 'success', error_message: '', payload_before_canonical: '',
      payload_after_canonical: '', query_parameters_canonical: '', session_id: '',
      request_id: '', metadata_canonical: '', type: '', user_identifier: '', provider: '',
      success: true, created_at_epoch: '1.000000', prev_hash: null as string | null,
      is_anchor: seq === 1,
    }));
    for (let index = 0; index < rows.length; index++) {
      rows[index].prev_hash = index === 0 ? null : (rows[index - 1] as any).entry_hash;
      (rows[index] as any).entry_hash = (logger as any).recomputeHash(rows[index]);
    }
    const query = vi.fn().mockResolvedValue({ rows });
    (logger as any).db = { query };
    await expect(logger.verifyIntegrity('tenant', 2)).resolves.toEqual([]);
    expect(query.mock.calls[0][0]).toContain('ORDER BY a.tenant_seq_num ASC');
    expect(query.mock.calls[0][1]).toEqual(['tenant', 2]);

    rows[2].prev_hash = 'tampered';
    const violations = await logger.verifyIntegrity('tenant', 2);
    expect(violations.some(item => item.violation_type === 'chain_break')).toBe(true);
    expect(violations.some(item => item.violation_type === 'hash_mismatch')).toBe(true);
  });

  it('anchors bounded gap detection and still reports a real in-window deletion', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [
        { seq_num: '98', prev_seq_num: null, is_anchor: true },
        { seq_num: '99', prev_seq_num: '98', is_anchor: false },
        { seq_num: '100', prev_seq_num: '99', is_anchor: false },
      ] })
      .mockResolvedValueOnce({ rows: [
        { seq_num: '98', prev_seq_num: null, is_anchor: true },
        { seq_num: '100', prev_seq_num: '98', is_anchor: false },
      ] });
    const logger = new AuditLogger({ query } as any);

    await expect(logger.detectGaps('tenant', 2)).resolves.toEqual([]);
    await expect(logger.detectGaps('tenant', 2)).resolves.toEqual([
      { start_seq: 98, end_seq: 100, gap_size: 1 },
    ]);
    expect(query.mock.calls[0][0]).toContain('a.tenant_seq_num BETWEEN bounds.min_seq - 1');
    expect(query.mock.calls[0][1]).toEqual(['tenant', 2]);
  });
});
