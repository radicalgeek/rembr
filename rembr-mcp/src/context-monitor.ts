/**
 * Context Monitor Service (REM-97)
 * 
 * Tracks context window usage, provides breakdowns by category, and generates alerts.
 * Addresses #1 pain point from 50+ agents surveyed: no visibility into context allocation.
 */

import type { Pool } from 'pg';
import { randomUUID } from 'crypto';

export interface CategoryBreakdown {
  category: string;
  tokens: number;
  percentage: number;
  rank: number;
}

export interface UsageTrend {
  timestamp: Date;
  total_tokens: number;
  utilization_percent: number;
}

export interface ContextAlert {
  severity: 'warning' | 'critical' | 'urgent';
  threshold_percent: number;
  current_percent: number;
  message: string;
  recommendation?: string;
}

export interface ContextMonitorResult {
  session_id: string;
  tenant_id: string;
  timestamp: Date;
  
  // Usage summary
  total_tokens_used: number;
  max_tokens: number;
  utilization_percent: number;
  tokens_remaining: number;
  
  // Category breakdown
  breakdown_by_category: CategoryBreakdown[];
  top_consumers: CategoryBreakdown[];
  
  // Alerts
  alerts: ContextAlert[];
  
  // Trends
  usage_trend: UsageTrend[];
  peak_usage: number;
  peak_usage_time?: Date;
  
  // Recommendations
  should_checkpoint: boolean;
  should_compress: boolean;
  estimated_time_to_full?: number; // minutes
}

export interface MonitorRequest {
  session_id: string;
  current_usage: Record<string, number>; // category -> token count
  max_tokens?: number;
  thresholds?: number[]; // default: [70, 85, 95]
  top_n?: number; // default: 5
  trend_window_hours?: number; // default: 24
}

/**
 * Monitor context usage and generate report
 */
export async function monitorContext(
  pool: Pool,
  tenantId: string,
  request: MonitorRequest
): Promise<ContextMonitorResult> {
  const maxTokens = request.max_tokens || 200000;
  const thresholds = request.thresholds || [70, 85, 95];
  const topN = request.top_n || 5;
  const trendWindowHours = request.trend_window_hours || 24;
  
  // Calculate total usage
  const totalTokensUsed = Object.values(request.current_usage).reduce((sum, val) => sum + val, 0);
  const utilizationPercent = (totalTokensUsed / maxTokens) * 100;
  const tokensRemaining = maxTokens - totalTokensUsed;
  
  // Create or update session
  await upsertSession(pool, tenantId, request.session_id, maxTokens, totalTokensUsed);
  
  // Log usage snapshot
  await logUsageSnapshot(pool, tenantId, request.session_id, totalTokensUsed, request.current_usage);
  
  // Build category breakdown
  const breakdownByCategory = buildCategoryBreakdown(request.current_usage, totalTokensUsed);
  const topConsumers = breakdownByCategory.slice(0, topN);
  
  // Generate alerts
  const alerts = generateAlerts(utilizationPercent, thresholds, tokensRemaining);
  
  // Fetch usage trend
  const usageTrend = await getUsageTrend(pool, tenantId, request.session_id, trendWindowHours);
  
  // Calculate peak usage
  const { peakUsage, peakUsageTime } = calculatePeakUsage(usageTrend, totalTokensUsed);
  
  // Determine recommendations
  const shouldCheckpoint = utilizationPercent >= 70;
  const shouldCompress = utilizationPercent >= 85;
  const estimatedTimeToFull = estimateTimeToFull(usageTrend, totalTokensUsed, maxTokens);
  
  return {
    session_id: request.session_id,
    tenant_id: tenantId,
    timestamp: new Date(),
    total_tokens_used: totalTokensUsed,
    max_tokens: maxTokens,
    utilization_percent: Math.round(utilizationPercent * 10) / 10,
    tokens_remaining: tokensRemaining,
    breakdown_by_category: breakdownByCategory,
    top_consumers: topConsumers,
    alerts,
    usage_trend: usageTrend,
    peak_usage: peakUsage,
    peak_usage_time: peakUsageTime,
    should_checkpoint: shouldCheckpoint,
    should_compress: shouldCompress,
    estimated_time_to_full: estimatedTimeToFull,
  };
}

/**
 * Upsert context session
 */
async function upsertSession(
  pool: Pool,
  tenantId: string,
  sessionId: string,
  maxTokens: number,
  currentUsage: number
): Promise<void> {
  const query = `
    INSERT INTO context_sessions (
      id, tenant_id, session_id, max_tokens, current_usage, peak_usage, updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $5, NOW())
    ON CONFLICT (tenant_id, session_id)
    DO UPDATE SET
      current_usage = $5,
      peak_usage = GREATEST(context_sessions.peak_usage, $5),
      updated_at = NOW()
  `;
  
  await pool.query(query, [randomUUID(), tenantId, sessionId, maxTokens, currentUsage]);
}

/**
 * Log usage snapshot to analytics events
 */
async function logUsageSnapshot(
  pool: Pool,
  tenantId: string,
  sessionId: string,
  totalTokens: number,
  categoryBreakdown: Record<string, number>
): Promise<void> {
  const query = `
    INSERT INTO context_analytics_events (
      id, tenant_id, session_id, event_type, event_data, token_count
    )
    VALUES ($1, $2, $3, 'usage_snapshot', $4, $5)
  `;
  
  const eventData = {
    categories: categoryBreakdown,
    timestamp: new Date().toISOString(),
  };
  
  await pool.query(query, [
    randomUUID(),
    tenantId,
    sessionId,
    JSON.stringify(eventData),
    totalTokens,
  ]);
}

/**
 * Build category breakdown
 */
function buildCategoryBreakdown(
  usage: Record<string, number>,
  totalTokens: number
): CategoryBreakdown[] {
  const breakdown = Object.entries(usage)
    .map(([category, tokens]) => ({
      category,
      tokens,
      percentage: totalTokens > 0 ? Math.round((tokens / totalTokens) * 1000) / 10 : 0,
      rank: 0,
    }))
    .sort((a, b) => b.tokens - a.tokens);
  
  // Assign ranks
  breakdown.forEach((item, index) => {
    item.rank = index + 1;
  });
  
  return breakdown;
}

/**
 * Generate alerts based on thresholds
 */
function generateAlerts(
  utilizationPercent: number,
  thresholds: number[],
  tokensRemaining: number
): ContextAlert[] {
  const alerts: ContextAlert[] = [];
  
  const sortedThresholds = [...thresholds].sort((a, b) => b - a);
  
  for (const threshold of sortedThresholds) {
    if (utilizationPercent >= threshold) {
      let severity: 'warning' | 'critical' | 'urgent';
      let recommendation: string | undefined;
      
      if (threshold >= 95) {
        severity = 'urgent';
        recommendation = 'Immediate action required: Compress context or archive old data now';
      } else if (threshold >= 85) {
        severity = 'critical';
        recommendation = 'Create checkpoint and prepare for compression';
      } else {
        severity = 'warning';
        recommendation = 'Consider creating a checkpoint soon';
      }
      
      alerts.push({
        severity,
        threshold_percent: threshold,
        current_percent: Math.round(utilizationPercent * 10) / 10,
        message: `Context usage at ${Math.round(utilizationPercent)}% (threshold: ${threshold}%)`,
        recommendation,
      });
      
      break; // Only show highest threshold alert
    }
  }
  
  // Add low-token warning
  if (tokensRemaining < 10000 && tokensRemaining > 0) {
    alerts.push({
      severity: 'urgent',
      threshold_percent: 95,
      current_percent: Math.round(utilizationPercent * 10) / 10,
      message: `Only ${tokensRemaining.toLocaleString()} tokens remaining`,
      recommendation: 'Context compression required immediately',
    });
  }
  
  return alerts;
}

/**
 * Get usage trend over time window
 */
async function getUsageTrend(
  pool: Pool,
  tenantId: string,
  sessionId: string,
  windowHours: number
): Promise<UsageTrend[]> {
  const query = `
    SELECT 
      created_at as timestamp,
      token_count as total_tokens,
      (SELECT max_tokens FROM context_sessions WHERE tenant_id = $1 AND session_id = $2 LIMIT 1) as max_tokens
    FROM context_analytics_events
    WHERE tenant_id = $1
      AND session_id = $2
      AND event_type = 'usage_snapshot'
      AND created_at >= NOW() - INTERVAL '${windowHours} hours'
    ORDER BY created_at ASC
    LIMIT 100
  `;
  
  const result = await pool.query(query, [tenantId, sessionId]);
  
  return result.rows.map(row => ({
    timestamp: row.timestamp,
    total_tokens: parseInt(row.total_tokens, 10),
    utilization_percent: row.max_tokens > 0
      ? Math.round((parseInt(row.total_tokens, 10) / parseInt(row.max_tokens, 10)) * 1000) / 10
      : 0,
  }));
}

/**
 * Calculate peak usage
 */
function calculatePeakUsage(
  trend: UsageTrend[],
  currentUsage: number
): { peakUsage: number; peakUsageTime?: Date } {
  if (trend.length === 0) {
    return { peakUsage: currentUsage };
  }
  
  const peak = trend.reduce((max, item) =>
    item.total_tokens > max.total_tokens ? item : max
  , trend[0]);
  
  const peakUsage = Math.max(peak.total_tokens, currentUsage);
  const peakUsageTime = peak.total_tokens >= currentUsage ? peak.timestamp : undefined;
  
  return { peakUsage, peakUsageTime };
}

/**
 * Estimate time to full (in minutes)
 */
function estimateTimeToFull(
  trend: UsageTrend[],
  currentUsage: number,
  maxTokens: number
): number | undefined {
  if (trend.length < 2) {
    return undefined;
  }
  
  // Calculate average growth rate (tokens per minute)
  const oldestPoint = trend[0];
  const latestPoint = trend[trend.length - 1];
  
  const timeDiffMinutes = (latestPoint.timestamp.getTime() - oldestPoint.timestamp.getTime()) / (1000 * 60);
  const tokenGrowth = latestPoint.total_tokens - oldestPoint.total_tokens;
  
  if (timeDiffMinutes <= 0 || tokenGrowth <= 0) {
    return undefined;
  }
  
  const growthRatePerMinute = tokenGrowth / timeDiffMinutes;
  const tokensRemaining = maxTokens - currentUsage;
  
  if (tokensRemaining <= 0) {
    return 0;
  }
  
  const estimatedMinutes = Math.round(tokensRemaining / growthRatePerMinute);
  
  return estimatedMinutes > 0 ? estimatedMinutes : undefined;
}

/**
 * Get current session state
 */
export async function getSessionState(
  pool: Pool,
  tenantId: string,
  sessionId: string
): Promise<{
  current_usage: number;
  peak_usage: number;
  max_tokens: number;
  session_state: string;
  created_at: Date;
  updated_at: Date;
} | null> {
  const query = `
    SELECT 
      current_usage,
      peak_usage,
      max_tokens,
      session_state,
      created_at,
      updated_at
    FROM context_sessions
    WHERE tenant_id = $1 AND session_id = $2
  `;
  
  const result = await pool.query(query, [tenantId, sessionId]);
  
  if (result.rows.length === 0) {
    return null;
  }
  
  const row = result.rows[0];
  
  return {
    current_usage: row.current_usage,
    peak_usage: row.peak_usage,
    max_tokens: row.max_tokens,
    session_state: row.session_state,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
