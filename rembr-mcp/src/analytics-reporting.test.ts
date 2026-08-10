/**
 * Unit tests for AnalyticsReportingService (REM-42)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AnalyticsReportingService, CustomReportConfig } from './analytics-reporting.js';

// ─── Mock pool ────────────────────────────────────────────
function transactionalPool(dataQuery: ReturnType<typeof vi.fn>) {
  const client = {
    query: vi.fn((sql: string, params?: unknown[]) => {
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql) || sql.includes('set_config')) {
        return Promise.resolve({ rows: [] });
      }
      return dataQuery(sql, params);
    }),
    release: vi.fn(),
  };
  return {
    query: dataQuery,
    connect: vi.fn().mockResolvedValue(client),
  } as any;
}

function makePool(rows: Record<string, unknown>[] = []) {
  return transactionalPool(vi.fn().mockResolvedValue({ rows }));
}

const TENANT = 'aaaaaaaa-0000-0000-0000-000000000042';
const FROM   = new Date('2026-02-01T00:00:00Z');
const TO     = new Date('2026-02-28T23:59:59Z');

// ─── Export Formatters ────────────────────────────────────
describe('AnalyticsReportingService — exportAsJSON', () => {
  it('returns valid JSON string', () => {
    const svc = new AnalyticsReportingService(makePool(), TENANT);
    const report = {
      generated_at: '2026-02-27T04:00:00Z',
      tenant_id: TENANT,
      config: { metrics: ['growth'], granularity: 'day', from: '2026-02-01', to: '2026-02-28', format: 'json' } as CustomReportConfig,
      sections: { growth: { start_count: 10, end_count: 50, net_change: 40 } },
    };
    const json = svc.exportAsJSON(report);
    const parsed = JSON.parse(json);
    expect(parsed.tenant_id).toBe(TENANT);
    expect(parsed.sections.growth.net_change).toBe(40);
  });
});

describe('AnalyticsReportingService — exportAsCSV', () => {
  it('produces CSV header row for array sections', () => {
    const svc = new AnalyticsReportingService(makePool(), TENANT);
    const report = {
      generated_at: '2026-02-27T04:00:00Z',
      tenant_id: TENANT,
      config: { metrics: ['categories'], granularity: 'day', from: '2026-02-01', to: '2026-02-28', format: 'csv' } as CustomReportConfig,
      sections: {
        categories: [
          { category: 'notes', count: 50, pct: 80, pii_count: 2, avg_content_length: 120, last_used: null },
          { category: 'contacts', count: 10, pct: 20, pii_count: 5, avg_content_length: 80, last_used: null },
        ]
      },
    };
    const csv = svc.exportAsCSV(report);
    expect(csv).toContain('"category","count","pct"');
    expect(csv).toContain('"notes","50"');
    expect(csv).toContain('"contacts","10"');
  });

  it('handles object (non-array) sections', () => {
    const svc = new AnalyticsReportingService(makePool(), TENANT);
    const report = {
      generated_at: '2026-02-27T04:00:00Z',
      tenant_id: TENANT,
      config: { metrics: ['growth'], granularity: 'day', from: '2026-02-01', to: '2026-02-28', format: 'csv' } as CustomReportConfig,
      sections: { growth: { start_count: 10, end_count: 50, net_change: 40, growth_rate_pct: 400 } },
    };
    const csv = svc.exportAsCSV(report);
    expect(csv).toContain('key,value');
    expect(csv).toContain('"start_count","10"');
  });

  it('neutralises formula-shaped report cells', () => {
    const svc = new AnalyticsReportingService(makePool(), TENANT);
    const report = {
      generated_at: '2026-02-27T04:00:00Z',
      tenant_id: TENANT,
      config: {} as CustomReportConfig,
      sections: { categories: [{ category: '@SUM(1,1)', count: 1 }] },
    };
    expect(svc.exportAsCSV(report)).toContain('"\'@SUM(1,1)"');
  });
});

describe('AnalyticsReportingService — exportAsMarkdown', () => {
  it('generates markdown with title and table', () => {
    const svc = new AnalyticsReportingService(makePool(), TENANT);
    const report = {
      generated_at: '2026-02-27T04:00:00Z',
      tenant_id: TENANT,
      config: { title: 'Monthly', metrics: ['usage'], granularity: 'day', from: '2026-02-01', to: '2026-02-28', format: 'markdown' } as CustomReportConfig,
      sections: {
        usage: [
          { period: '2026-02-01T00:00:00Z', memories_stored: 10, memories_deleted: 0, searches_performed: 5, tool_calls_total: 15, pii_detected: 1, unique_categories: 3 },
        ]
      },
    };
    const md = svc.exportAsMarkdown(report);
    expect(md).toContain('# Rembr Analytics Report');
    expect(md).toContain('Monthly');
    expect(md).toContain('| period |');
    expect(md).toContain('2026-02-01T00:00:00Z');
  });

  it('handles empty array sections with _No data_', () => {
    const svc = new AnalyticsReportingService(makePool(), TENANT);
    const report = {
      generated_at: '2026-02-27T04:00:00Z',
      tenant_id: TENANT,
      config: { metrics: ['performance'], granularity: 'day', from: '2026-02-01', to: '2026-02-28', format: 'markdown' } as CustomReportConfig,
      sections: { performance: [] },
    };
    const md = svc.exportAsMarkdown(report);
    expect(md).toContain('_No data_');
  });
});

describe('AnalyticsReportingService — export dispatcher', () => {
  it('routes to JSON by default', () => {
    const svc = new AnalyticsReportingService(makePool(), TENANT);
    const report = { generated_at: '', tenant_id: TENANT, config: {} as any, sections: {} };
    const out = svc.export(report, 'json');
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it('routes to CSV', () => {
    const svc = new AnalyticsReportingService(makePool(), TENANT);
    const report = { generated_at: '2026-02-27T04:00:00Z', tenant_id: TENANT, config: {} as any, sections: {} };
    const out = svc.export(report, 'csv');
    expect(out).toContain('Rembr Analytics Report');
  });

  it('routes to Markdown', () => {
    const svc = new AnalyticsReportingService(makePool(), TENANT);
    const report = { generated_at: '2026-02-27T04:00:00Z', tenant_id: TENANT, config: {} as any, sections: {} };
    const out = svc.export(report, 'markdown');
    expect(out).toContain('# Rembr Analytics Report');
  });
});

// ─── Category Breakdown ───────────────────────────────────
describe('AnalyticsReportingService — getCategoryBreakdown', () => {
  it('maps rows to CategoryBreakdown with pct', async () => {
    const rows = [
      { category: 'notes',    count: '80', pii_count: '5',  avg_len: '150', last_used: new Date('2026-02-20') },
      { category: 'contacts', count: '20', pii_count: '15', avg_len: '80',  last_used: new Date('2026-02-25') },
    ];
    const svc = new AnalyticsReportingService(makePool(rows), TENANT);
    const result = await svc.getCategoryBreakdown();
    expect(result).toHaveLength(2);
    expect(result[0].category).toBe('notes');
    expect(result[0].count).toBe(80);
    expect(result[0].pct).toBe(80);
    expect(result[1].pct).toBe(20);
  });

  it('handles zero total gracefully', async () => {
    const svc = new AnalyticsReportingService(makePool([]), TENANT);
    const result = await svc.getCategoryBreakdown();
    expect(result).toHaveLength(0);
  });
});

// ─── Memory Growth Stats ──────────────────────────────────
describe('AnalyticsReportingService — getMemoryGrowthStats', () => {
  it('calculates growth rate correctly', async () => {
    const pool = transactionalPool(
      vi.fn()
        .mockResolvedValueOnce({ rows: [{ count: '100' }] })   // start
        .mockResolvedValueOnce({ rows: [{ count: '150' }] })   // end
        .mockResolvedValueOnce({ rows: [{ day: new Date('2026-02-15'), count: '10' }] }) // peak
    );

    const svc = new AnalyticsReportingService(pool, TENANT);
    const result = await svc.getMemoryGrowthStats(FROM, TO);

    expect(result.start_count).toBe(100);
    expect(result.end_count).toBe(150);
    expect(result.net_change).toBe(50);
    expect(result.growth_rate_pct).toBe(50);
    expect(result.peak_day).toBe('2026-02-15');
  });

  it('handles zero start_count without division error', async () => {
    const pool = transactionalPool(
      vi.fn()
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [{ count: '20' }] })
        .mockResolvedValueOnce({ rows: [] })
    );
    const svc = new AnalyticsReportingService(pool, TENANT);
    const result = await svc.getMemoryGrowthStats(FROM, TO);
    expect(result.growth_rate_pct).toBe(0);
    expect(result.peak_day).toBeNull();
  });
});

// ─── PII Summary ──────────────────────────────────────────
describe('AnalyticsReportingService — getPIISummary', () => {
  it('aggregates bounded PII types in SQL with the canonical audience predicate', async () => {
    const dataQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [{ total: '100', pii: '30' }] })
      .mockResolvedValueOnce({ rows: [{ type: 'email', count: '2' }, { type: 'phone', count: '1' }] })
      .mockResolvedValueOnce({ rows: [{ category: 'contacts', pii_count: '20' }, { category: 'notes', pii_count: '10' }] });
    const pool = transactionalPool(
      dataQuery
    );
    const svc = new AnalyticsReportingService(pool, TENANT);
    const result = await svc.getPIISummary();
    expect(result.total_memories).toBe(100);
    expect(result.pii_count).toBe(30);
    expect(result.pii_pct).toBe(30);
    expect(result.by_type.email).toBe(2);
    expect(result.by_type.phone).toBe(1);
    expect(result.by_category[0].category).toBe('contacts');
    const typeSql = dataQuery.mock.calls[1][0] as string;
    expect(typeSql).toContain('CROSS JOIN LATERAL unnest(m.pii_types)');
    expect(typeSql).toContain('p.id IS NOT NULL');
    expect(typeSql).toContain('LIMIT 100');
  });
});

describe('AnalyticsReportingService — query boundaries', () => {
  it('caps usage time-series rows and applies audience predicates to the memory fallback', async () => {
    const dataQuery = vi.fn().mockResolvedValue({ rows: [] });
    const svc = new AnalyticsReportingService(transactionalPool(dataQuery), TENANT, 'project-1', 'user-1');

    await svc.getUsageAnalytics(FROM, TO, 'hour');
    await svc.getUsageAnalyticsFallback(FROM, TO, 'hour');

    expect(dataQuery.mock.calls[0][0]).toContain('LIMIT 10000');
    const fallbackSql = dataQuery.mock.calls[1][0] as string;
    expect(fallbackSql).toContain('LIMIT 10000');
    expect(fallbackSql).toContain("COALESCE(m.visibility, 'shared') = 'shared' AND m.project_id IS NULL");
    expect(fallbackSql).toContain('p.id IS NOT NULL');
    expect(dataQuery.mock.calls[1][1].slice(-2)).toEqual(['project-1', 'user-1']);
  });
});

// ─── buildReport ─────────────────────────────────────────
describe('AnalyticsReportingService — buildReport', () => {
  it('assembles sections for requested metrics', async () => {
    // Use a spy that returns sensible rows for every query type
    const pool = transactionalPool(
      vi.fn().mockImplementation((sql: string) => {
        // Growth stats: 3 parallel queries — all need count or day rows
        if (sql.includes('created_at <') || sql.includes('created_at <=')) {
          return Promise.resolve({ rows: [{ count: '10' }] });
        }
        // Growth peak day query
        if (sql.includes('DATE(created_at')) {
          return Promise.resolve({ rows: [] }); // no peak
        }
        // Category breakdown
        if (sql.includes('COALESCE(category')) {
          return Promise.resolve({ rows: [{ category: 'notes', count: '10', pii_count: '1', avg_len: '120', last_used: null }] });
        }
        // Default: empty
        return Promise.resolve({ rows: [] });
      })
    );

    const svc = new AnalyticsReportingService(pool, TENANT);
    const config: CustomReportConfig = {
      title: 'Full test',
      metrics: ['growth', 'categories'],
      granularity: 'day',
      from: '2026-02-01',
      to: '2026-02-28',
      format: 'json',
    };

    const report = await svc.buildReport(config);
    expect(report.tenant_id).toBe(TENANT);
    expect(report.config.title).toBe('Full test');
    expect(report.sections).toHaveProperty('growth');
    expect(report.sections).toHaveProperty('categories');
    // Growth should have numeric fields
    const growth = report.sections.growth as Record<string, unknown>;
    expect(typeof growth.start_count).toBe('number');
    expect(typeof growth.net_change).toBe('number');
    // Categories should be an array
    expect(Array.isArray(report.sections.categories)).toBe(true);
  });
});
