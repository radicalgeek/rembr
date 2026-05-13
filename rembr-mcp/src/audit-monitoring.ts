/**
 * Audit Monitoring Service — REM-30
 *
 * Real-time monitoring layer on top of the existing audit-logger:
 *  - Alert threshold evaluation (failure rate, error spikes, unusual access)
 *  - Anomaly scoring per tenant over configurable windows
 *  - Health status dashboard (overall + per-event-type breakdown)
 *  - Prometheus-style metrics snapshot
 *  - Alert history management (persist + query fired alerts)
 */

import type { Pool } from 'pg';

// ─── Types ────────────────────────────────────────────────────────────────────

export type AlertSeverity = 'info' | 'warning' | 'critical';
export type AlertStatus = 'firing' | 'resolved' | 'acknowledged';

export interface AlertThreshold {
  id: string;
  name: string;
  description: string;
  metric: 'failure_rate' | 'error_count' | 'denied_count' | 'event_rate' | 'unique_users';
  window_seconds: number;   // evaluation window
  threshold: number;        // trigger value
  severity: AlertSeverity;
  enabled: boolean;
}

export interface FiredAlert {
  id?: string;
  threshold_id: string;
  threshold_name: string;
  severity: AlertSeverity;
  metric: string;
  observed_value: number;
  threshold_value: number;
  tenant_id: string;
  status: AlertStatus;
  fired_at: string;         // ISO
  resolved_at?: string;     // ISO
  message: string;
}

export interface MetricSnapshot {
  tenant_id: string;
  window_seconds: number;
  captured_at: string;
  total_events: number;
  success_count: number;
  failure_count: number;
  denied_count: number;
  failure_rate: number;     // 0.0–1.0
  error_rate: number;
  events_per_minute: number;
  unique_users: number;
  unique_resource_types: number;
  top_event_types: Array<{ event_type: string; count: number }>;
  top_resource_types: Array<{ resource_type: string; count: number }>;
}

export interface AnomalyResult {
  tenant_id: string;
  anomaly_score: number;       // 0.0–1.0
  risk_level: 'low' | 'medium' | 'high' | 'critical';
  signals: AnomalySignal[];
  evaluated_at: string;
}

export interface AnomalySignal {
  name: string;
  description: string;
  weight: number;
  triggered: boolean;
  value?: number | string;
}

export interface HealthStatus {
  tenant_id: string;
  status: 'healthy' | 'degraded' | 'critical';
  evaluated_at: string;
  metrics: MetricSnapshot;
  active_alerts: FiredAlert[];
  anomaly: AnomalyResult;
  recent_failures: Array<{
    event_type: string;
    resource_type: string;
    error_message: string | null;
    created_at: string;
  }>;
}

// ─── Built-in default thresholds ─────────────────────────────────────────────

export const DEFAULT_THRESHOLDS: AlertThreshold[] = [
  {
    id: 'failure-rate-warning',
    name: 'High Failure Rate (Warning)',
    description: 'Failure rate exceeds 10% in the last 5 minutes',
    metric: 'failure_rate',
    window_seconds: 300,
    threshold: 0.10,
    severity: 'warning',
    enabled: true,
  },
  {
    id: 'failure-rate-critical',
    name: 'Critical Failure Rate',
    description: 'Failure rate exceeds 25% in the last 5 minutes',
    metric: 'failure_rate',
    window_seconds: 300,
    threshold: 0.25,
    severity: 'critical',
    enabled: true,
  },
  {
    id: 'denied-spike',
    name: 'Access Denial Spike',
    description: 'More than 10 denied operations in the last 10 minutes',
    metric: 'denied_count',
    window_seconds: 600,
    threshold: 10,
    severity: 'warning',
    enabled: true,
  },
  {
    id: 'error-burst',
    name: 'Error Burst',
    description: 'More than 50 errors in the last 15 minutes',
    metric: 'error_count',
    window_seconds: 900,
    threshold: 50,
    severity: 'critical',
    enabled: true,
  },
  {
    id: 'event-rate-spike',
    name: 'Unusual Event Rate',
    description: 'More than 1000 events per minute in the last 5 minutes',
    metric: 'event_rate',
    window_seconds: 300,
    threshold: 1000,
    severity: 'warning',
    enabled: true,
  },
];

// ─── Schema ───────────────────────────────────────────────────────────────────

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS audit_alerts (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL,
    threshold_id TEXT NOT NULL,
    threshold_name TEXT NOT NULL,
    severity    TEXT NOT NULL CHECK (severity IN ('info','warning','critical')),
    metric      TEXT NOT NULL,
    observed_value FLOAT NOT NULL,
    threshold_value FLOAT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'firing' CHECK (status IN ('firing','resolved','acknowledged')),
    message     TEXT NOT NULL,
    fired_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ,
    metadata    JSONB
  );
  CREATE INDEX IF NOT EXISTS idx_audit_alerts_tenant ON audit_alerts (tenant_id, fired_at DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_alerts_status ON audit_alerts (tenant_id, status);
`;

// ─── Service ──────────────────────────────────────────────────────────────────

export class AuditMonitoringService {
  private schemaEnsured = false;

  constructor(private readonly pool: Pool) {}

  private async ensureSchema(): Promise<void> {
    if (this.schemaEnsured) return;
    await this.pool.query(SCHEMA_SQL);
    this.schemaEnsured = true;
  }

  // ── Metrics snapshot ───────────────────────────────────────────────────────

  async getMetrics(tenantId: string, windowSeconds = 300): Promise<MetricSnapshot> {
    const since = new Date(Date.now() - windowSeconds * 1000);

    const [countsResult, topEventsResult, topResourcesResult, uniqueResult] = await Promise.all([
      this.pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE action_result = 'success') AS success_count,
          COUNT(*) FILTER (WHERE action_result = 'failure') AS failure_count,
          COUNT(*) FILTER (WHERE action_result = 'denied')  AS denied_count,
          COUNT(*) AS total
        FROM audit_logs
        WHERE tenant_id = $1 AND created_at >= $2
      `, [tenantId, since]),

      this.pool.query(`
        SELECT event_type, COUNT(*) AS count
        FROM audit_logs
        WHERE tenant_id = $1 AND created_at >= $2
        GROUP BY event_type ORDER BY count DESC LIMIT 10
      `, [tenantId, since]),

      this.pool.query(`
        SELECT resource_type, COUNT(*) AS count
        FROM audit_logs
        WHERE tenant_id = $1 AND created_at >= $2
        GROUP BY resource_type ORDER BY count DESC LIMIT 10
      `, [tenantId, since]),

      this.pool.query(`
        SELECT COUNT(DISTINCT user_id) AS unique_users,
               COUNT(DISTINCT resource_type) AS unique_resource_types
        FROM audit_logs
        WHERE tenant_id = $1 AND created_at >= $2
      `, [tenantId, since]),
    ]);

    const c = countsResult.rows[0] || {};
    const total = parseInt(c.total || '0', 10);
    const failures = parseInt(c.failure_count || '0', 10);
    const denied = parseInt(c.denied_count || '0', 10);
    const success = parseInt(c.success_count || '0', 10);
    const windowMinutes = windowSeconds / 60;

    return {
      tenant_id: tenantId,
      window_seconds: windowSeconds,
      captured_at: new Date().toISOString(),
      total_events: total,
      success_count: success,
      failure_count: failures,
      denied_count: denied,
      failure_rate: total > 0 ? Math.round((failures / total) * 1000) / 1000 : 0,
      error_rate: total > 0 ? Math.round(((failures + denied) / total) * 1000) / 1000 : 0,
      events_per_minute: Math.round((total / windowMinutes) * 10) / 10,
      unique_users: parseInt(uniqueResult.rows[0]?.unique_users || '0', 10),
      unique_resource_types: parseInt(uniqueResult.rows[0]?.unique_resource_types || '0', 10),
      top_event_types: topEventsResult.rows.map(r => ({ event_type: r.event_type, count: parseInt(r.count, 10) })),
      top_resource_types: topResourcesResult.rows.map(r => ({ resource_type: r.resource_type, count: parseInt(r.count, 10) })),
    };
  }

  // ── Threshold evaluation ───────────────────────────────────────────────────

  async evaluateThresholds(
    tenantId: string,
    thresholds: AlertThreshold[] = DEFAULT_THRESHOLDS,
  ): Promise<FiredAlert[]> {
    await this.ensureSchema();

    const firedAlerts: FiredAlert[] = [];

    // Group thresholds by window to batch metric fetches
    const windows = [...new Set(thresholds.filter(t => t.enabled).map(t => t.window_seconds))];

    const metricsByWindow: Map<number, MetricSnapshot> = new Map();
    await Promise.all(windows.map(async w => {
      metricsByWindow.set(w, await this.getMetrics(tenantId, w));
    }));

    for (const threshold of thresholds) {
      if (!threshold.enabled) continue;
      const metrics = metricsByWindow.get(threshold.window_seconds)!;

      let observed: number;
      switch (threshold.metric) {
        case 'failure_rate':    observed = metrics.failure_rate; break;
        case 'error_count':     observed = metrics.failure_count; break;
        case 'denied_count':    observed = metrics.denied_count; break;
        case 'event_rate':      observed = metrics.events_per_minute; break;
        case 'unique_users':    observed = metrics.unique_users; break;
        default:                continue;
      }

      if (observed >= threshold.threshold) {
        const alert: FiredAlert = {
          threshold_id: threshold.id,
          threshold_name: threshold.name,
          severity: threshold.severity,
          metric: threshold.metric,
          observed_value: observed,
          threshold_value: threshold.threshold,
          tenant_id: tenantId,
          status: 'firing',
          fired_at: new Date().toISOString(),
          message: `${threshold.name}: ${threshold.metric} = ${observed} (threshold: ${threshold.threshold}) over ${threshold.window_seconds}s window`,
        };

        // Persist
        try {
          const res = await this.pool.query(`
            INSERT INTO audit_alerts
              (tenant_id, threshold_id, threshold_name, severity, metric, observed_value, threshold_value, status, message)
            VALUES ($1,$2,$3,$4,$5,$6,$7,'firing',$8)
            RETURNING id
          `, [tenantId, threshold.id, threshold.name, threshold.severity, threshold.metric,
              observed, threshold.threshold, alert.message]);
          alert.id = res.rows[0]?.id;
        } catch { /* non-fatal */ }

        firedAlerts.push(alert);
      }
    }

    return firedAlerts;
  }

  // ── Alert history ──────────────────────────────────────────────────────────

  async getActiveAlerts(tenantId: string): Promise<FiredAlert[]> {
    await this.ensureSchema();
    const result = await this.pool.query(`
      SELECT id, threshold_id, threshold_name, severity, metric,
             observed_value, threshold_value, status, message,
             fired_at, resolved_at, tenant_id
      FROM audit_alerts
      WHERE tenant_id = $1 AND status = 'firing'
      ORDER BY fired_at DESC
    `, [tenantId]);
    return result.rows.map(this.rowToAlert);
  }

  async getAlertHistory(tenantId: string, limit = 50): Promise<FiredAlert[]> {
    await this.ensureSchema();
    const result = await this.pool.query(`
      SELECT id, threshold_id, threshold_name, severity, metric,
             observed_value, threshold_value, status, message,
             fired_at, resolved_at, tenant_id
      FROM audit_alerts
      WHERE tenant_id = $1
      ORDER BY fired_at DESC
      LIMIT $2
    `, [tenantId, limit]);
    return result.rows.map(this.rowToAlert);
  }

  async acknowledgeAlert(tenantId: string, alertId: string): Promise<boolean> {
    await this.ensureSchema();
    const result = await this.pool.query(`
      UPDATE audit_alerts SET status = 'acknowledged'
      WHERE id = $1 AND tenant_id = $2 AND status = 'firing'
      RETURNING id
    `, [alertId, tenantId]);
    return result.rowCount! > 0;
  }

  async resolveAlert(tenantId: string, alertId: string): Promise<boolean> {
    await this.ensureSchema();
    const result = await this.pool.query(`
      UPDATE audit_alerts SET status = 'resolved', resolved_at = NOW()
      WHERE id = $1 AND tenant_id = $2 AND status IN ('firing','acknowledged')
      RETURNING id
    `, [alertId, tenantId]);
    return result.rowCount! > 0;
  }

  private rowToAlert(row: any): FiredAlert {
    return {
      id: row.id,
      threshold_id: row.threshold_id,
      threshold_name: row.threshold_name,
      severity: row.severity,
      metric: row.metric,
      observed_value: parseFloat(row.observed_value),
      threshold_value: parseFloat(row.threshold_value),
      tenant_id: row.tenant_id,
      status: row.status,
      fired_at: row.fired_at instanceof Date ? row.fired_at.toISOString() : String(row.fired_at),
      resolved_at: row.resolved_at
        ? (row.resolved_at instanceof Date ? row.resolved_at.toISOString() : String(row.resolved_at))
        : undefined,
      message: row.message,
    };
  }

  // ── Anomaly detection ──────────────────────────────────────────────────────

  async detectAnomalies(tenantId: string): Promise<AnomalyResult> {
    const [m5, m60] = await Promise.all([
      this.getMetrics(tenantId, 300),   // 5 min
      this.getMetrics(tenantId, 3600),  // 1 hour baseline
    ]);

    const signals: AnomalySignal[] = [
      {
        name: 'high_failure_rate',
        description: 'Failure rate > 20% in last 5 minutes',
        weight: 0.30,
        triggered: m5.failure_rate > 0.20,
        value: m5.failure_rate,
      },
      {
        name: 'access_denials',
        description: 'More than 5 denied operations in last 5 minutes',
        weight: 0.25,
        triggered: m5.denied_count > 5,
        value: m5.denied_count,
      },
      {
        name: 'event_rate_spike',
        description: 'Event rate > 3x the hourly average',
        weight: 0.20,
        triggered: m60.events_per_minute > 0 && m5.events_per_minute > m60.events_per_minute * 3,
        value: m5.events_per_minute,
      },
      {
        name: 'zero_success',
        description: 'No successful operations in last 5 minutes (but events exist)',
        weight: 0.25,
        triggered: m5.total_events > 0 && m5.success_count === 0,
        value: m5.success_count,
      },
    ];

    const score = signals.reduce((s, sig) => s + (sig.triggered ? sig.weight : 0), 0);
    const risk: AnomalyResult['risk_level'] =
      score >= 0.7 ? 'critical' : score >= 0.45 ? 'high' : score >= 0.2 ? 'medium' : 'low';

    return {
      tenant_id: tenantId,
      anomaly_score: Math.round(score * 100) / 100,
      risk_level: risk,
      signals,
      evaluated_at: new Date().toISOString(),
    };
  }

  // ── Health dashboard ───────────────────────────────────────────────────────

  async getHealthStatus(tenantId: string): Promise<HealthStatus> {
    const [metrics, activeAlerts, anomaly, recentFailures] = await Promise.all([
      this.getMetrics(tenantId, 300),
      this.getActiveAlerts(tenantId),
      this.detectAnomalies(tenantId),
      this.pool.query(`
        SELECT event_type, resource_type, error_message, created_at
        FROM audit_logs
        WHERE tenant_id = $1 AND action_result = 'failure'
        ORDER BY created_at DESC LIMIT 10
      `, [tenantId]).then(r => r.rows.map(row => ({
        event_type: row.event_type,
        resource_type: row.resource_type,
        error_message: row.error_message ?? null,
        created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      }))).catch(() => []),
    ]);

    const hasCritical = activeAlerts.some(a => a.severity === 'critical') || anomaly.risk_level === 'critical';
    const hasDegraded = activeAlerts.some(a => a.severity === 'warning') || anomaly.risk_level === 'high';
    const status: HealthStatus['status'] = hasCritical ? 'critical' : hasDegraded ? 'degraded' : 'healthy';

    return {
      tenant_id: tenantId,
      status,
      evaluated_at: new Date().toISOString(),
      metrics,
      active_alerts: activeAlerts,
      anomaly,
      recent_failures: recentFailures,
    };
  }

  // ── Prometheus-style metrics export ───────────────────────────────────────

  async exportPrometheusMetrics(tenantId: string): Promise<string> {
    const m = await this.getMetrics(tenantId, 300);
    const labeledTenant = `tenant_id="${tenantId}"`;
    const lines: string[] = [
      `# HELP rembr_audit_total_events Total audit events in last 5m`,
      `# TYPE rembr_audit_total_events gauge`,
      `rembr_audit_total_events{${labeledTenant}} ${m.total_events}`,
      `# HELP rembr_audit_failure_rate Failure rate (0–1) in last 5m`,
      `# TYPE rembr_audit_failure_rate gauge`,
      `rembr_audit_failure_rate{${labeledTenant}} ${m.failure_rate}`,
      `# HELP rembr_audit_denied_count Denied operations in last 5m`,
      `# TYPE rembr_audit_denied_count gauge`,
      `rembr_audit_denied_count{${labeledTenant}} ${m.denied_count}`,
      `# HELP rembr_audit_events_per_minute Events per minute in last 5m`,
      `# TYPE rembr_audit_events_per_minute gauge`,
      `rembr_audit_events_per_minute{${labeledTenant}} ${m.events_per_minute}`,
      `# HELP rembr_audit_unique_users Unique users in last 5m`,
      `# TYPE rembr_audit_unique_users gauge`,
      `rembr_audit_unique_users{${labeledTenant}} ${m.unique_users}`,
    ];
    for (const et of m.top_event_types) {
      lines.push(`rembr_audit_event_type_count{${labeledTenant},event_type="${et.event_type}"} ${et.count}`);
    }
    return lines.join('\n');
  }
}
