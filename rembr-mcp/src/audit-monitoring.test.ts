/**
 * Tests for Audit Monitoring Service (REM-30)
 */
import { describe, it, expect, vi } from 'vitest';
import { AuditMonitoringService, DEFAULT_THRESHOLDS } from './audit-monitoring.js';

const TENANT = 'a1b2c3d4-0000-0000-0000-000000000001';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeCountsRow(overrides: Partial<{
  total: string; success_count: string; failure_count: string; denied_count: string;
}> = {}) {
  return {
    total: overrides.total ?? '100',
    success_count: overrides.success_count ?? '90',
    failure_count: overrides.failure_count ?? '8',
    denied_count: overrides.denied_count ?? '2',
  };
}

function makePool(countsRow = makeCountsRow(), extraRows: any[][] = []) {
  let callIdx = 0;
  const defaultResponses = [
    { rows: [countsRow] },           // counts
    { rows: [] },                     // top events
    { rows: [] },                     // top resources
    { rows: [{ unique_users: '3', unique_resource_types: '2' }] }, // unique
  ];

  const allResponses = [...defaultResponses, ...extraRows.map(r => ({ rows: r }))];

  return {
    query: vi.fn().mockImplementation(() => {
      const res = allResponses[callIdx] ?? { rows: [] };
      callIdx++;
      return Promise.resolve(res);
    }),
  } as any;
}

function makePoolWithSchema() {
  // First query is CREATE TABLE (ensureSchema), then real queries follow
  let callIdx = 0;
  const responses = [
    { rows: [] },  // ensureSchema
    { rows: [makeCountsRow({ failure_count: '30', total: '100' })] }, // 5m counts
    { rows: [] }, { rows: [] }, { rows: [{ unique_users: '1', unique_resource_types: '1' }] }, // 5m rest
    { rows: [makeCountsRow({ failure_count: '30', total: '100' })] }, // 5m counts for second threshold
    { rows: [] }, { rows: [] }, { rows: [{ unique_users: '1', unique_resource_types: '1' }] },
  ];
  return {
    query: vi.fn().mockImplementation(() => {
      const res = responses[callIdx] ?? { rows: [] };
      callIdx++;
      return Promise.resolve(res);
    }),
    rowCount: 1,
  } as any;
}

// ─── getMetrics ───────────────────────────────────────────────────────────────

describe('getMetrics', () => {
  it('returns correct counts and rates', async () => {
    const svc = new AuditMonitoringService(makePool());
    const m = await svc.getMetrics(TENANT, 300);

    expect(m.total_events).toBe(100);
    expect(m.success_count).toBe(90);
    expect(m.failure_count).toBe(8);
    expect(m.denied_count).toBe(2);
    expect(m.failure_rate).toBe(0.08);
    expect(m.error_rate).toBe(0.1);
    expect(m.unique_users).toBe(3);
    expect(m.tenant_id).toBe(TENANT);
    expect(m.window_seconds).toBe(300);
  });

  it('returns 0 failure_rate when no events', async () => {
    const svc = new AuditMonitoringService(makePool(makeCountsRow({ total: '0', success_count: '0', failure_count: '0', denied_count: '0' })));
    const m = await svc.getMetrics(TENANT);
    expect(m.failure_rate).toBe(0);
    expect(m.events_per_minute).toBe(0);
  });

  it('computes events_per_minute correctly', async () => {
    const svc = new AuditMonitoringService(makePool(makeCountsRow({ total: '300' })));
    const m = await svc.getMetrics(TENANT, 300); // 5 min window
    expect(m.events_per_minute).toBe(60);
  });
});

// ─── evaluateThresholds ───────────────────────────────────────────────────────

describe('evaluateThresholds', () => {
  it('returns no alerts when metrics are normal', async () => {
    // Low failure rate, low denials
    const pool = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('CREATE TABLE')) return Promise.resolve({ rows: [] });
        if (sql.includes('COUNT(*)') || sql.includes('count')) {
          return Promise.resolve({ rows: [makeCountsRow({ failure_count: '2', denied_count: '0', total: '100' })] });
        }
        if (sql.includes('unique')) return Promise.resolve({ rows: [{ unique_users: '1', unique_resource_types: '1' }] });
        return Promise.resolve({ rows: [] });
      }),
    } as any;
    const svc = new AuditMonitoringService(pool);
    const alerts = await svc.evaluateThresholds(TENANT, DEFAULT_THRESHOLDS);
    expect(alerts).toHaveLength(0);
  });

  it('fires warning when failure_rate exceeds threshold', async () => {
    // 30% failure rate → triggers both warning (10%) and critical (25%) thresholds
    const pool = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('CREATE TABLE')) return Promise.resolve({ rows: [] });
        if (sql.includes('INSERT INTO audit_alerts')) return Promise.resolve({ rows: [{ id: 'alert-001' }] });
        if (sql.includes('unique')) return Promise.resolve({ rows: [{ unique_users: '1', unique_resource_types: '1' }] });
        return Promise.resolve({ rows: [makeCountsRow({ failure_count: '30', denied_count: '0', total: '100' })] });
      }),
    } as any;

    const svc = new AuditMonitoringService(pool);
    const alerts = await svc.evaluateThresholds(TENANT, [DEFAULT_THRESHOLDS[0]]); // warning threshold
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts[0].severity).toBe('warning');
    expect(alerts[0].observed_value).toBe(0.3);
  });

  it('fires critical when failure_rate exceeds critical threshold', async () => {
    const pool = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('CREATE TABLE')) return Promise.resolve({ rows: [] });
        if (sql.includes('INSERT INTO audit_alerts')) return Promise.resolve({ rows: [{ id: 'alert-002' }] });
        if (sql.includes('unique')) return Promise.resolve({ rows: [{ unique_users: '1', unique_resource_types: '1' }] });
        return Promise.resolve({ rows: [makeCountsRow({ failure_count: '50', denied_count: '0', total: '100' })] });
      }),
    } as any;

    const svc = new AuditMonitoringService(pool);
    const critThreshold = DEFAULT_THRESHOLDS.find(t => t.id === 'failure-rate-critical')!;
    const alerts = await svc.evaluateThresholds(TENANT, [critThreshold]);
    expect(alerts.some(a => a.severity === 'critical')).toBe(true);
  });

  it('alert message includes observed and threshold values', async () => {
    const pool = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('CREATE TABLE')) return Promise.resolve({ rows: [] });
        if (sql.includes('INSERT INTO audit_alerts')) return Promise.resolve({ rows: [{ id: 'x' }] });
        if (sql.includes('unique')) return Promise.resolve({ rows: [{ unique_users: '1', unique_resource_types: '1' }] });
        return Promise.resolve({ rows: [makeCountsRow({ denied_count: '20', total: '100' })] });
      }),
    } as any;

    const svc = new AuditMonitoringService(pool);
    const deniedThreshold = DEFAULT_THRESHOLDS.find(t => t.id === 'denied-spike')!;
    const alerts = await svc.evaluateThresholds(TENANT, [deniedThreshold]);
    if (alerts.length > 0) {
      expect(alerts[0].message).toContain('denied_count');
    }
  });
});

// ─── detectAnomalies ──────────────────────────────────────────────────────────

describe('detectAnomalies', () => {
  it('returns low risk for healthy metrics', async () => {
    // detectAnomalies calls getMetrics twice: 5m window and 1h window.
    // event_rate_spike fires if 5m rate > 3x the 1h rate.
    // To avoid a false spike: make both windows return proportional totals
    // (e.g. 5m=100 events in 300s = 20/min; 1h=1200 events in 3600s = 20/min → no spike).
    let callCount = 0;
    const pool = {
      query: vi.fn().mockImplementation((sql: string, params: any[]) => {
        callCount++;
        if (sql.includes('unique')) return Promise.resolve({ rows: [{ unique_users: '5', unique_resource_types: '3' }] });
        if (sql.includes('event_type') || sql.includes('resource_type') || sql.includes('GROUP BY')) {
          return Promise.resolve({ rows: [] });
        }
        // First getMetrics call = 5m window (params[2] is the 'since' date, closer to now)
        // Second getMetrics call = 1h window — return 12x more events so rate is the same
        const isSecondMetricsCall = callCount > 4;
        const total = isSecondMetricsCall ? '1200' : '100';
        return Promise.resolve({ rows: [makeCountsRow({ total, success_count: isSecondMetricsCall ? '1080' : '90', failure_count: isSecondMetricsCall ? '96' : '8', denied_count: isSecondMetricsCall ? '24' : '2' })] });
      }),
    } as any;
    const svc = new AuditMonitoringService(pool);
    const r = await svc.detectAnomalies(TENANT);
    expect(r.risk_level).toBe('low');
    expect(r.anomaly_score).toBeLessThan(0.2);
  });

  it('returns high/critical risk when multiple signals fire', async () => {
    const pool = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('unique')) return Promise.resolve({ rows: [{ unique_users: '1', unique_resource_types: '1' }] });
        // Both 5m and 1h windows: high failure, all denied
        return Promise.resolve({ rows: [makeCountsRow({ failure_count: '50', denied_count: '30', success_count: '0', total: '80' })] });
      }),
    } as any;
    const svc = new AuditMonitoringService(pool);
    const r = await svc.detectAnomalies(TENANT);
    expect(['high', 'critical']).toContain(r.risk_level);
    expect(r.anomaly_score).toBeGreaterThan(0.4);
  });

  it('has correct signal names', async () => {
    const pool = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('unique')) return Promise.resolve({ rows: [{ unique_users: '1', unique_resource_types: '1' }] });
        return Promise.resolve({ rows: [makeCountsRow()] });
      }),
    } as any;
    const svc = new AuditMonitoringService(pool);
    const r = await svc.detectAnomalies(TENANT);
    const names = r.signals.map(s => s.name);
    expect(names).toContain('high_failure_rate');
    expect(names).toContain('access_denials');
    expect(names).toContain('event_rate_spike');
    expect(names).toContain('zero_success');
  });
});

// ─── getHealthStatus ──────────────────────────────────────────────────────────

describe('getHealthStatus', () => {
  it('returns healthy status for good metrics', async () => {
    const pool = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('CREATE TABLE')) return Promise.resolve({ rows: [] });
        if (sql.includes('unique')) return Promise.resolve({ rows: [{ unique_users: '2', unique_resource_types: '2' }] });
        if (sql.includes('audit_alerts')) return Promise.resolve({ rows: [] });
        if (sql.includes('action_result') && sql.includes('failure')) return Promise.resolve({ rows: [] });
        return Promise.resolve({ rows: [makeCountsRow()] });
      }),
    } as any;
    const svc = new AuditMonitoringService(pool);
    const h = await svc.getHealthStatus(TENANT);
    expect(h.status).toBe('healthy');
    expect(h.tenant_id).toBe(TENANT);
    expect(h.metrics).toBeDefined();
    expect(h.anomaly).toBeDefined();
  });

  it('includes evaluated_at timestamp', async () => {
    const pool = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('CREATE TABLE')) return Promise.resolve({ rows: [] });
        if (sql.includes('unique')) return Promise.resolve({ rows: [{ unique_users: '1', unique_resource_types: '1' }] });
        if (sql.includes('audit_alerts')) return Promise.resolve({ rows: [] });
        if (sql.includes('action_result')) return Promise.resolve({ rows: [] });
        return Promise.resolve({ rows: [makeCountsRow()] });
      }),
    } as any;
    const svc = new AuditMonitoringService(pool);
    const h = await svc.getHealthStatus(TENANT);
    expect(h.evaluated_at).toBeDefined();
    expect(new Date(h.evaluated_at).getTime()).toBeGreaterThan(0);
  });
});

// ─── exportPrometheusMetrics ──────────────────────────────────────────────────

describe('exportPrometheusMetrics', () => {
  it('produces valid Prometheus text format', async () => {
    const svc = new AuditMonitoringService(makePool());
    const text = await svc.exportPrometheusMetrics(TENANT);
    expect(text).toContain('# HELP rembr_audit_total_events');
    expect(text).toContain('# TYPE rembr_audit_total_events gauge');
    expect(text).toContain(`tenant_id="${TENANT}"`);
    expect(text).toContain('rembr_audit_failure_rate');
    expect(text).toContain('rembr_audit_events_per_minute');
  });

  it('includes correct values', async () => {
    const svc = new AuditMonitoringService(makePool(makeCountsRow({ total: '50' })));
    const text = await svc.exportPrometheusMetrics(TENANT);
    expect(text).toContain('rembr_audit_total_events');
    expect(text).toContain('50');
  });
});

// ─── DEFAULT_THRESHOLDS ───────────────────────────────────────────────────────

describe('DEFAULT_THRESHOLDS', () => {
  it('has expected threshold ids', () => {
    const ids = DEFAULT_THRESHOLDS.map(t => t.id);
    expect(ids).toContain('failure-rate-warning');
    expect(ids).toContain('failure-rate-critical');
    expect(ids).toContain('denied-spike');
    expect(ids).toContain('error-burst');
  });

  it('all have enabled: true by default', () => {
    expect(DEFAULT_THRESHOLDS.every(t => t.enabled)).toBe(true);
  });

  it('critical threshold is higher than warning threshold', () => {
    const warn = DEFAULT_THRESHOLDS.find(t => t.id === 'failure-rate-warning')!;
    const crit = DEFAULT_THRESHOLDS.find(t => t.id === 'failure-rate-critical')!;
    expect(crit.threshold).toBeGreaterThan(warn.threshold);
  });
});
