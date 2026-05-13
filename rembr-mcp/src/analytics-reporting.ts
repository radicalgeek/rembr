/**
 * Advanced Analytics & Reporting (REM-42)
 *
 * Provides:
 * - Usage analytics: time-series breakdown of memory/search operations
 * - Performance metrics: latency percentiles, cache rates, tool call stats
 * - Export capabilities: JSON, CSV, Markdown
 * - Custom report builder: configurable metric + time + format reports
 */

import { MemoryDatabase } from './database.js';
import { Pool } from 'pg';

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

export type ReportFormat = 'json' | 'csv' | 'markdown';
export type Granularity = 'hour' | 'day' | 'week' | 'month';

export interface UsageDataPoint {
  period: string;           // ISO date/hour string
  memories_stored: number;
  memories_deleted: number;
  searches_performed: number;
  tool_calls_total: number;
  pii_detected: number;
  unique_categories: number;
}

export interface PerformanceMetrics {
  period: string;
  avg_store_ms: number | null;
  avg_search_ms: number | null;
  p95_store_ms: number | null;
  p95_search_ms: number | null;
  tool_calls: number;
  error_rate: number;
}

export interface MemoryGrowthStats {
  start_count: number;
  end_count: number;
  net_change: number;
  growth_rate_pct: number;
  avg_per_day: number;
  peak_day: string | null;
  peak_count: number;
}

export interface CategoryBreakdown {
  category: string;
  count: number;
  pct: number;
  pii_count: number;
  avg_content_length: number;
  last_used: string | null;
}

export interface CustomReportConfig {
  title?: string;
  metrics: Array<'usage' | 'performance' | 'growth' | 'categories' | 'pii_summary'>;
  granularity: Granularity;
  from: string;   // ISO date
  to: string;     // ISO date
  format: ReportFormat;
}

export interface AnalyticsReport {
  generated_at: string;
  tenant_id: string;
  config: CustomReportConfig;
  sections: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────

export class AnalyticsReportingService {
  private pool: Pool;
  private tenantId: string;

  constructor(pool: Pool, tenantId: string) {
    this.pool = pool;
    this.tenantId = tenantId;
  }

  // ─── Usage Analytics ────────────────────────────────────

  /**
   * Time-series usage breakdown for the given window.
   */
  async getUsageAnalytics(
    from: Date,
    to: Date,
    granularity: Granularity = 'day',
  ): Promise<UsageDataPoint[]> {
    const truncFn = granularity === 'hour'  ? 'hour'
                  : granularity === 'week'  ? 'week'
                  : granularity === 'month' ? 'month'
                  : 'day';

    const result = await this.pool.query<{
      period: Date;
      memories_stored: string;
      memories_deleted: string;
      searches_performed: string;
      tool_calls_total: string;
      pii_detected: string;
      unique_categories: string;
    }>(
      `SELECT
         date_trunc($1, created_at AT TIME ZONE 'UTC') AS period,
         COUNT(*) FILTER (WHERE event_type = 'store')          AS memories_stored,
         COUNT(*) FILTER (WHERE event_type = 'delete')         AS memories_deleted,
         COUNT(*) FILTER (WHERE event_type = 'search')         AS searches_performed,
         COUNT(*)                                               AS tool_calls_total,
         COUNT(*) FILTER (WHERE pii_detected = true)           AS pii_detected,
         COUNT(DISTINCT category)                              AS unique_categories
       FROM memory_events
       WHERE tenant_id = $2
         AND created_at >= $3
         AND created_at <= $4
       GROUP BY 1
       ORDER BY 1`,
      [truncFn, this.tenantId, from, to],
    );

    return result.rows.map(r => ({
      period: r.period.toISOString(),
      memories_stored:  parseInt(r.memories_stored,  10),
      memories_deleted: parseInt(r.memories_deleted, 10),
      searches_performed: parseInt(r.searches_performed, 10),
      tool_calls_total:  parseInt(r.tool_calls_total, 10),
      pii_detected:    parseInt(r.pii_detected,    10),
      unique_categories: parseInt(r.unique_categories, 10),
    }));
  }

  /**
   * Fallback usage analytics derived from the memories table when
   * memory_events is unavailable (e.g. older deployments).
   */
  async getUsageAnalyticsFallback(
    from: Date,
    to: Date,
    granularity: Granularity = 'day',
  ): Promise<UsageDataPoint[]> {
    const truncFn = granularity === 'hour' ? 'hour' : granularity === 'week' ? 'week' : granularity === 'month' ? 'month' : 'day';

    const result = await this.pool.query<{
      period: Date;
      memories_stored: string;
      pii_detected: string;
      unique_categories: string;
    }>(
      `SELECT
         date_trunc($1, created_at AT TIME ZONE 'UTC') AS period,
         COUNT(*)                                         AS memories_stored,
         COUNT(*) FILTER (WHERE pii_detected = true)    AS pii_detected,
         COUNT(DISTINCT category)                        AS unique_categories
       FROM memories
       WHERE tenant_id = $2
         AND created_at >= $3
         AND created_at <= $4
       GROUP BY 1
       ORDER BY 1`,
      [truncFn, this.tenantId, from, to],
    );

    return result.rows.map(r => ({
      period: r.period.toISOString(),
      memories_stored:   parseInt(r.memories_stored,   10),
      memories_deleted:  0,
      searches_performed: 0,
      tool_calls_total:  parseInt(r.memories_stored, 10),
      pii_detected:    parseInt(r.pii_detected, 10),
      unique_categories: parseInt(r.unique_categories, 10),
    }));
  }

  // ─── Performance Metrics ─────────────────────────────────

  /**
   * Performance metrics from mcp_tool_calls if available.
   */
  async getPerformanceMetrics(
    from: Date,
    to: Date,
    granularity: Granularity = 'day',
  ): Promise<PerformanceMetrics[]> {
    const truncFn = granularity === 'hour' ? 'hour' : granularity === 'week' ? 'week' : granularity === 'month' ? 'month' : 'day';

    try {
      const result = await this.pool.query<{
        period: Date;
        avg_store_ms: string | null;
        avg_search_ms: string | null;
        p95_store_ms: string | null;
        p95_search_ms: string | null;
        tool_calls: string;
        error_count: string;
      }>(
        `SELECT
           date_trunc($1, called_at AT TIME ZONE 'UTC') AS period,
           AVG(duration_ms) FILTER (WHERE tool_name = 'store_memory')                          AS avg_store_ms,
           AVG(duration_ms) FILTER (WHERE tool_name = 'search_memory')                         AS avg_search_ms,
           PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms)
             FILTER (WHERE tool_name = 'store_memory')                                         AS p95_store_ms,
           PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms)
             FILTER (WHERE tool_name = 'search_memory')                                        AS p95_search_ms,
           COUNT(*)                                                                            AS tool_calls,
           COUNT(*) FILTER (WHERE success = false)                                             AS error_count
         FROM mcp_tool_calls
         WHERE tenant_id = $2
           AND called_at >= $3
           AND called_at <= $4
         GROUP BY 1
         ORDER BY 1`,
        [truncFn, this.tenantId, from, to],
      );

      return result.rows.map(r => {
        const total = parseInt(r.tool_calls, 10);
        const errors = parseInt(r.error_count, 10);
        return {
          period: r.period.toISOString(),
          avg_store_ms:  r.avg_store_ms  ? parseFloat(r.avg_store_ms)  : null,
          avg_search_ms: r.avg_search_ms ? parseFloat(r.avg_search_ms) : null,
          p95_store_ms:  r.p95_store_ms  ? parseFloat(r.p95_store_ms)  : null,
          p95_search_ms: r.p95_search_ms ? parseFloat(r.p95_search_ms) : null,
          tool_calls: total,
          error_rate: total > 0 ? errors / total : 0,
        };
      });
    } catch {
      // Table may not exist — return empty
      return [];
    }
  }

  // ─── Memory Growth Stats ─────────────────────────────────

  async getMemoryGrowthStats(from: Date, to: Date): Promise<MemoryGrowthStats> {
    const [startResult, endResult, dailyResult] = await Promise.all([
      this.pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM memories WHERE tenant_id=$1 AND created_at < $2`,
        [this.tenantId, from],
      ),
      this.pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM memories WHERE tenant_id=$1 AND created_at <= $2`,
        [this.tenantId, to],
      ),
      this.pool.query<{ day: Date; count: string }>(
        `SELECT DATE(created_at AT TIME ZONE 'UTC') AS day, COUNT(*) AS count
         FROM memories
         WHERE tenant_id=$1 AND created_at >= $2 AND created_at <= $3
         GROUP BY 1 ORDER BY 2 DESC LIMIT 1`,
        [this.tenantId, from, to],
      ),
    ]);

    const startCount = parseInt(startResult.rows[0]?.count ?? '0', 10);
    const endCount   = parseInt(endResult.rows[0]?.count ?? '0', 10);
    const netChange  = endCount - startCount;
    const days       = Math.max(1, Math.round((to.getTime() - from.getTime()) / 86400000));
    const peakRow    = dailyResult.rows[0];

    return {
      start_count: startCount,
      end_count:   endCount,
      net_change:  netChange,
      growth_rate_pct: startCount > 0 ? Math.round((netChange / startCount) * 100 * 10) / 10 : 0,
      avg_per_day: Math.round((netChange / days) * 10) / 10,
      peak_day:    peakRow ? (peakRow.day instanceof Date ? peakRow.day.toISOString().slice(0, 10) : String(peakRow.day).slice(0, 10)) : null,
      peak_count:  peakRow ? parseInt(peakRow.count, 10) : 0,
    };
  }

  // ─── Category Breakdown ──────────────────────────────────

  async getCategoryBreakdown(): Promise<CategoryBreakdown[]> {
    const result = await this.pool.query<{
      category: string;
      count: string;
      pii_count: string;
      avg_len: string;
      last_used: Date | null;
    }>(
      `SELECT
         COALESCE(category, 'uncategorized') AS category,
         COUNT(*)                             AS count,
         COUNT(*) FILTER (WHERE pii_detected = true) AS pii_count,
         AVG(LENGTH(content))                AS avg_len,
         MAX(created_at)                     AS last_used
       FROM memories
       WHERE tenant_id = $1
       GROUP BY 1
       ORDER BY 2 DESC`,
      [this.tenantId],
    );

    const total = result.rows.reduce((s, r) => s + parseInt(r.count, 10), 0);

    return result.rows.map(r => ({
      category:           r.category,
      count:              parseInt(r.count,     10),
      pct:                total > 0 ? Math.round((parseInt(r.count, 10) / total) * 100 * 10) / 10 : 0,
      pii_count:          parseInt(r.pii_count, 10),
      avg_content_length: Math.round(parseFloat(r.avg_len ?? '0')),
      last_used:          r.last_used ? r.last_used.toISOString() : null,
    }));
  }

  // ─── PII Summary ─────────────────────────────────────────

  async getPIISummary(): Promise<{
    total_memories: number;
    pii_count: number;
    pii_pct: number;
    by_type: Record<string, number>;
    by_category: Array<{ category: string; pii_count: number }>;
  }> {
    const [countResult, typeResult, catResult] = await Promise.all([
      this.pool.query<{ total: string; pii: string }>(
        `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE pii_detected = true) AS pii
         FROM memories WHERE tenant_id = $1`,
        [this.tenantId],
      ),
      this.pool.query<{ types: string[] }>(
        `SELECT pii_types AS types FROM memories
         WHERE tenant_id = $1 AND pii_detected = true AND pii_types IS NOT NULL`,
        [this.tenantId],
      ),
      this.pool.query<{ category: string; pii_count: string }>(
        `SELECT COALESCE(category,'uncategorized') AS category, COUNT(*) AS pii_count
         FROM memories
         WHERE tenant_id = $1 AND pii_detected = true
         GROUP BY 1 ORDER BY 2 DESC`,
        [this.tenantId],
      ),
    ]);

    const total = parseInt(countResult.rows[0]?.total ?? '0', 10);
    const pii   = parseInt(countResult.rows[0]?.pii   ?? '0', 10);

    // Tally PII type occurrences
    const byType: Record<string, number> = {};
    for (const row of typeResult.rows) {
      for (const type of (row.types ?? [])) {
        byType[type] = (byType[type] ?? 0) + 1;
      }
    }

    return {
      total_memories: total,
      pii_count:      pii,
      pii_pct:        total > 0 ? Math.round((pii / total) * 100 * 10) / 10 : 0,
      by_type:        byType,
      by_category:    catResult.rows.map(r => ({
        category:  r.category,
        pii_count: parseInt(r.pii_count, 10),
      })),
    };
  }

  // ─── Custom Report Builder ───────────────────────────────

  async buildReport(config: CustomReportConfig): Promise<AnalyticsReport> {
    const from = new Date(config.from);
    const to   = new Date(config.to);
    const sections: Record<string, unknown> = {};

    for (const metric of config.metrics) {
      switch (metric) {
        case 'usage': {
          let data: UsageDataPoint[] = [];
          try {
            data = await this.getUsageAnalytics(from, to, config.granularity);
          } catch {
            data = await this.getUsageAnalyticsFallback(from, to, config.granularity);
          }
          sections.usage = data;
          break;
        }
        case 'performance':
          sections.performance = await this.getPerformanceMetrics(from, to, config.granularity);
          break;
        case 'growth':
          sections.growth = await this.getMemoryGrowthStats(from, to);
          break;
        case 'categories':
          sections.categories = await this.getCategoryBreakdown();
          break;
        case 'pii_summary':
          sections.pii_summary = await this.getPIISummary();
          break;
      }
    }

    return {
      generated_at: new Date().toISOString(),
      tenant_id:    this.tenantId,
      config,
      sections,
    };
  }

  // ─── Export Formatters ───────────────────────────────────

  exportAsJSON(report: AnalyticsReport): string {
    return JSON.stringify(report, null, 2);
  }

  exportAsCSV(report: AnalyticsReport): string {
    const lines: string[] = [`# Rembr Analytics Report — ${report.generated_at}`];

    for (const [section, data] of Object.entries(report.sections)) {
      lines.push('');
      lines.push(`## ${section.toUpperCase()}`);

      if (Array.isArray(data) && data.length > 0) {
        const headers = Object.keys(data[0]);
        lines.push(headers.join(','));
        for (const row of data as Record<string, unknown>[]) {
          lines.push(headers.map(h => {
            const v = row[h];
            const s = v == null ? '' : String(v);
            return s.includes(',') ? `"${s}"` : s;
          }).join(','));
        }
      } else if (data && typeof data === 'object' && !Array.isArray(data)) {
        lines.push('key,value');
        for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
          if (typeof v !== 'object') {
            lines.push(`${k},${v}`);
          }
        }
      }
    }

    return lines.join('\n');
  }

  exportAsMarkdown(report: AnalyticsReport): string {
    const lines: string[] = [
      `# Rembr Analytics Report`,
      ``,
      `**Generated:** ${report.generated_at}`,
      `**Period:** ${report.config.from} → ${report.config.to}`,
      `**Granularity:** ${report.config.granularity}`,
      `**Title:** ${report.config.title ?? 'Custom Report'}`,
      ``,
    ];

    for (const [section, data] of Object.entries(report.sections)) {
      lines.push(`## ${section.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}`);
      lines.push('');

      if (Array.isArray(data)) {
        if (data.length === 0) {
          lines.push('_No data_');
        } else {
          const headers = Object.keys(data[0]);
          lines.push('| ' + headers.join(' | ') + ' |');
          lines.push('| ' + headers.map(() => '---').join(' | ') + ' |');
          for (const row of data as Record<string, unknown>[]) {
            lines.push('| ' + headers.map(h => {
              const v = row[h];
              return v == null ? '' : String(v);
            }).join(' | ') + ' |');
          }
        }
      } else if (data && typeof data === 'object') {
        const entries = Object.entries(data as Record<string, unknown>).filter(([, v]) => typeof v !== 'object');
        if (entries.length === 0) {
          lines.push('_No data_');
        } else {
          for (const [k, v] of entries) {
            lines.push(`- **${k}:** ${v}`);
          }
        }
      } else {
        lines.push('_No data_');
      }

      lines.push('');
    }

    return lines.join('\n');
  }

  export(report: AnalyticsReport, format: ReportFormat): string {
    switch (format) {
      case 'csv':      return this.exportAsCSV(report);
      case 'markdown': return this.exportAsMarkdown(report);
      default:         return this.exportAsJSON(report);
    }
  }
}
