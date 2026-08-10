import { describe, expect, it, vi } from 'vitest';
import {
  getCompressionEvents,
  getContextAnalytics,
  getUsagePatterns,
} from './context-analytics.js';

const tenantId = '20000000-0000-4000-8000-000000000001';

describe('context analytics resource boundary', () => {
  it('limits usage and compression event queries and driver output', async () => {
    const rows = Array.from({ length: 1_200 }, (_, index) => ({
      timestamp: new Date(1_700_000_000_000 + index),
      token_count: '100',
      tokens_before: '100',
      tokens_after: '50',
      category: 'facts',
      strategy: 'bounded',
      session_id: 'session-1',
    }));
    const pool = { query: vi.fn().mockResolvedValue({ rows }) } as any;

    const usage = await getUsagePatterns(pool, tenantId, 'session-1');
    const compression = await getCompressionEvents(pool, tenantId, 'session-1');

    expect(usage).toHaveLength(1_000);
    expect(compression).toHaveLength(1_000);
    expect(pool.query.mock.calls[0][0]).toContain('ORDER BY created_at DESC');
    expect(pool.query.mock.calls[0][0]).toContain('LIMIT 1000');
    expect(pool.query.mock.calls[1][0]).toContain('LIMIT 1000');
  });

  it('rejects invalid or excessive periods before issuing a query', async () => {
    const pool = { query: vi.fn() } as any;

    await expect(getContextAnalytics(
      pool,
      tenantId,
      'session-1',
      new Date('2026-01-01T00:00:00Z'),
      new Date('2026-03-01T00:00:00Z'),
    )).rejects.toThrow('cannot exceed 31 days');
    await expect(getContextAnalytics(
      pool,
      tenantId,
      'session-1',
      new Date('2026-02-02T00:00:00Z'),
      new Date('2026-02-01T00:00:00Z'),
    )).rejects.toThrow('Invalid context analytics period');
    expect(pool.query).not.toHaveBeenCalled();
  });
});
