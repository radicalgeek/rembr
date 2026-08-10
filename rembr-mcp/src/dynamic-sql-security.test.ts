import { describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AuditLogger } from './audit-logger.js';
import { monitorContext } from './context-monitor.js';
import { TaskAnalyticsService } from './task-analytics.js';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('dynamic interval SQL hardening', () => {
  it('forbids session-scoped tenant GUCs in pooled runtime code', () => {
    const violations: string[] = [];
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'migrations') walk(path);
        } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
          if (/set_config\([^)]*,\s*FALSE\s*\)/i.test(readFileSync(path, 'utf8'))) violations.push(path);
        }
      }
    };
    walk(join(process.cwd(), 'src'));
    expect(violations).toEqual([]);
  });

  it.each([
    Number.NaN,
    -1,
    0,
    721,
    "1' hour); SELECT pg_sleep(10); --" as unknown as number,
  ])('rejects unsafe context trend windows before writes: %s', async trendWindow => {
    const query = vi.fn();
    const connect = vi.fn();
    await expect(monitorContext({ connect, query } as any, TENANT, {
      session_id: 'session',
      current_usage: { memory: 1 },
      trend_window_hours: trendWindow,
    })).rejects.toThrow(/trend_window_hours/);
    expect(connect).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('binds a valid context trend window as an integer parameter', async () => {
    const query = vi.fn().mockImplementation((sql: string) => Promise.resolve({
      rows: sql.includes('FROM context_analytics_events') ? [] : [],
      rowCount: 0,
    }));
    const client = { query, release: vi.fn() };
    await monitorContext({ connect: vi.fn().mockResolvedValue(client) } as any, TENANT, {
      session_id: 'session',
      current_usage: { memory: 1 },
      trend_window_hours: 48,
    });
    const trendCall = query.mock.calls.find(call => String(call[0]).includes('FROM context_analytics_events'))!;
    expect(trendCall[0]).toContain("$3::int * INTERVAL '1 hour'");
    expect(trendCall[1]).toEqual([TENANT, 'session', 48]);
  });

  it.each([Number.NaN, -1, 0, 8_761, "1' hour); --" as unknown as number])(
    'rejects unsafe audit lookback windows before SQL: %s',
    async lookback => {
      const query = vi.fn();
      const logger = new AuditLogger({ query } as any);
      await expect(logger.detectSuspiciousActivity(TENANT, lookback)).rejects.toThrow(/lookbackHours/);
      expect(query).not.toHaveBeenCalled();
    },
  );

  it('binds a valid audit lookback window', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const logger = new AuditLogger({ query } as any);
    await logger.detectSuspiciousActivity(TENANT, 24);
    expect(query.mock.calls[0][0]).toContain("$2::int * INTERVAL '1 hour'");
    expect(query.mock.calls[0][1]).toEqual([TENANT, 24]);
  });

  it.each([
    ['hour); SELECT pg_sleep(10); --', 8],
    ['week', Number.NaN],
    ['week', -1],
    ['week', 105],
  ])('rejects unsafe task analytics period inputs before SQL', async (period, periods) => {
    const query = vi.fn();
    const service = new TaskAnalyticsService({ query } as any);
    await expect(service.calculateVelocity(TENANT, period as any, undefined, periods as number))
      .rejects.toThrow(/period/);
    expect(query).not.toHaveBeenCalled();
  });

  it('binds task analytics interval and date-part values', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const service = new TaskAnalyticsService({ query } as any);
    await service.calculateVelocity(TENANT, 'week', undefined, 8);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("$4::int * INTERVAL '1 day'");
    expect(sql).toContain('DATE_TRUNC($3::text');
    expect(params).toEqual([TENANT, undefined, 'week', 56, 7, 8]);
  });
});
