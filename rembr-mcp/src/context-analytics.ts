/**
 * Context Analytics Service (REM-101)
 * 
 * Provides insights into context usage patterns, waste detection, and efficiency scoring.
 * Leverages context_analytics_events table for historical data analysis.
 */

import type { Pool } from 'pg';

export interface UsageSnapshot {
  timestamp: Date;
  token_count: number;
  category: string;
  session_id: string;
}

export interface WasteDetection {
  type: 'repeated_info' | 'stale_context' | 'redundant_results';
  severity: 'low' | 'medium' | 'high';
  description: string;
  estimated_waste_tokens: number;
  location?: string;
}

export interface CompressionEvent {
  timestamp: Date;
  tokens_before: number;
  tokens_after: number;
  tokens_saved: number;
  compression_ratio: number;
  strategy: string;
}

export interface EfficiencyScore {
  score: number; // 0-100
  useful_context_ratio: number;
  waste_ratio: number;
  compression_efficiency: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
}

export interface Recommendation {
  priority: 'critical' | 'high' | 'medium' | 'low';
  category: string;
  action: string;
  reason: string;
  estimated_savings_tokens?: number;
}

export interface ContextAnalytics {
  session_id: string;
  tenant_id: string;
  period_start: Date;
  period_end: Date;
  
  // Usage patterns
  total_tokens_used: number;
  peak_tokens: number;
  avg_tokens_per_hour: number;
  usage_by_category: Record<string, number>;
  usage_timeline: UsageSnapshot[];
  
  // Compression tracking
  compression_events: CompressionEvent[];
  total_compressions: number;
  total_tokens_saved: number;
  avg_compression_ratio: number;
  
  // Waste detection
  waste_detected: WasteDetection[];
  total_waste_tokens: number;
  waste_percentage: number;
  
  // Efficiency
  efficiency: EfficiencyScore;
  
  // Recommendations
  recommendations: Recommendation[];
}

/**
 * Fetch usage patterns for a session
 */
export async function getUsagePatterns(
  pool: Pool,
  tenantId: string,
  sessionId: string,
  periodStart?: Date,
  periodEnd?: Date
): Promise<UsageSnapshot[]> {
  const query = `
    SELECT 
      created_at as timestamp,
      token_count,
      event_data->>'category' as category,
      session_id
    FROM context_analytics_events
    WHERE tenant_id = $1
      AND session_id = $2
      AND event_type = 'usage_snapshot'
      ${periodStart ? 'AND created_at >= $3' : ''}
      ${periodEnd ? `AND created_at <= $${periodStart ? '4' : '3'}` : ''}
    ORDER BY created_at ASC
  `;
  
  const params: unknown[] = [tenantId, sessionId];
  if (periodStart) params.push(periodStart);
  if (periodEnd) params.push(periodEnd);
  
  const result = await pool.query(query, params);
  
  return result.rows.map(row => ({
    timestamp: row.timestamp,
    token_count: parseInt(row.token_count, 10),
    category: row.category || 'unknown',
    session_id: row.session_id,
  }));
}

/**
 * Fetch compression events for a session
 */
export async function getCompressionEvents(
  pool: Pool,
  tenantId: string,
  sessionId: string,
  periodStart?: Date,
  periodEnd?: Date
): Promise<CompressionEvent[]> {
  const query = `
    SELECT 
      created_at as timestamp,
      token_count as tokens_before,
      event_data->>'tokens_after' as tokens_after,
      event_data->>'strategy' as strategy
    FROM context_analytics_events
    WHERE tenant_id = $1
      AND session_id = $2
      AND event_type = 'compression_completed'
      ${periodStart ? 'AND created_at >= $3' : ''}
      ${periodEnd ? `AND created_at <= $${periodStart ? '4' : '3'}` : ''}
    ORDER BY created_at ASC
  `;
  
  const params: unknown[] = [tenantId, sessionId];
  if (periodStart) params.push(periodStart);
  if (periodEnd) params.push(periodEnd);
  
  const result = await pool.query(query, params);
  
  return result.rows.map(row => {
    const tokensBefore = parseInt(row.tokens_before, 10);
    const tokensAfter = parseInt(row.tokens_after, 10);
    const tokensSaved = tokensBefore - tokensAfter;
    const compressionRatio = tokensBefore > 0 ? tokensAfter / tokensBefore : 0;
    
    return {
      timestamp: row.timestamp,
      tokens_before: tokensBefore,
      tokens_after: tokensAfter,
      tokens_saved: tokensSaved,
      compression_ratio: compressionRatio,
      strategy: row.strategy || 'unknown',
    };
  });
}

/**
 * Detect repeated information waste
 */
export async function detectRepeatedInfo(
  pool: Pool,
  tenantId: string,
  sessionId: string
): Promise<WasteDetection[]> {
  // Look for identical or nearly-identical content in usage snapshots
  const query = `
    SELECT 
      event_data->>'content_hash' as content_hash,
      COUNT(*) as occurrences,
      SUM((event_data->>'token_count')::int) as total_tokens,
      array_agg(created_at ORDER BY created_at) as timestamps
    FROM context_analytics_events
    WHERE tenant_id = $1
      AND session_id = $2
      AND event_type = 'usage_snapshot'
      AND event_data ? 'content_hash'
    GROUP BY content_hash
    HAVING COUNT(*) > 1
    ORDER BY total_tokens DESC
    LIMIT 10
  `;
  
  const result = await pool.query(query, [tenantId, sessionId]);
  
  return result.rows.map(row => {
    const occurrences = parseInt(row.occurrences, 10);
    const totalTokens = parseInt(row.total_tokens, 10);
    const wasteTokens = totalTokens * (occurrences - 1) / occurrences;
    
    return {
      type: 'repeated_info' as const,
      severity: wasteTokens > 1000 ? 'high' : wasteTokens > 500 ? 'medium' : 'low',
      description: `Content repeated ${occurrences} times`,
      estimated_waste_tokens: Math.round(wasteTokens),
      location: row.content_hash?.substring(0, 8),
    };
  });
}

/**
 * Detect stale context waste
 */
export async function detectStaleContext(
  pool: Pool,
  tenantId: string,
  sessionId: string
): Promise<WasteDetection[]> {
  // Look for old context that hasn't been referenced recently
  const query = `
    SELECT 
      event_data->>'category' as category,
      MAX(created_at) as last_access,
      SUM((event_data->>'token_count')::int) as total_tokens
    FROM context_analytics_events
    WHERE tenant_id = $1
      AND session_id = $2
      AND event_type = 'usage_snapshot'
      AND event_data ? 'category'
    GROUP BY category
    HAVING MAX(created_at) < NOW() - INTERVAL '24 hours'
    ORDER BY total_tokens DESC
    LIMIT 10
  `;
  
  const result = await pool.query(query, [tenantId, sessionId]);
  
  return result.rows.map(row => {
    const totalTokens = parseInt(row.total_tokens, 10);
    const lastAccess = new Date(row.last_access);
    const ageHours = (Date.now() - lastAccess.getTime()) / (1000 * 60 * 60);
    
    return {
      type: 'stale_context' as const,
      severity: ageHours > 72 ? 'high' : ageHours > 48 ? 'medium' : 'low',
      description: `Context not accessed in ${Math.round(ageHours)} hours`,
      estimated_waste_tokens: Math.round(totalTokens * 0.5), // Assume 50% waste
      location: row.category,
    };
  });
}

/**
 * Calculate efficiency score
 */
export function calculateEfficiency(
  totalTokens: number,
  wasteTokens: number,
  compressionEvents: CompressionEvent[]
): EfficiencyScore {
  const wasteRatio = totalTokens > 0 ? wasteTokens / totalTokens : 0;
  const usefulContextRatio = 1 - wasteRatio;
  
  const avgCompressionRatio = compressionEvents.length > 0
    ? compressionEvents.reduce((sum, e) => sum + e.compression_ratio, 0) / compressionEvents.length
    : 1;
  
  const compressionEfficiency = 1 - avgCompressionRatio;
  
  // Weighted score: 50% useful context, 30% waste avoidance, 20% compression
  const score = Math.round(
    (usefulContextRatio * 0.5 + (1 - wasteRatio) * 0.3 + compressionEfficiency * 0.2) * 100
  );
  
  let grade: 'A' | 'B' | 'C' | 'D' | 'F';
  if (score >= 90) grade = 'A';
  else if (score >= 80) grade = 'B';
  else if (score >= 70) grade = 'C';
  else if (score >= 60) grade = 'D';
  else grade = 'F';
  
  return {
    score,
    useful_context_ratio: usefulContextRatio,
    waste_ratio: wasteRatio,
    compression_efficiency: compressionEfficiency,
    grade,
  };
}

/**
 * Generate recommendations
 */
export function generateRecommendations(
  wasteDetections: WasteDetection[],
  efficiency: EfficiencyScore,
  compressionEvents: CompressionEvent[]
): Recommendation[] {
  const recommendations: Recommendation[] = [];
  
  // Critical waste
  const highWaste = wasteDetections.filter(w => w.severity === 'high');
  if (highWaste.length > 0) {
    recommendations.push({
      priority: 'critical',
      category: 'waste_reduction',
      action: `Address ${highWaste.length} high-severity waste sources`,
      reason: `Estimated ${highWaste.reduce((sum, w) => sum + w.estimated_waste_tokens, 0)} tokens wasted`,
      estimated_savings_tokens: highWaste.reduce((sum, w) => sum + w.estimated_waste_tokens, 0),
    });
  }
  
  // Repeated info
  const repeatedInfo = wasteDetections.filter(w => w.type === 'repeated_info');
  if (repeatedInfo.length > 0) {
    recommendations.push({
      priority: 'high',
      category: 'deduplication',
      action: 'Enable automatic deduplication for repeated content',
      reason: `Found ${repeatedInfo.length} instances of repeated information`,
      estimated_savings_tokens: repeatedInfo.reduce((sum, w) => sum + w.estimated_waste_tokens, 0),
    });
  }
  
  // Stale context
  const staleContext = wasteDetections.filter(w => w.type === 'stale_context');
  if (staleContext.length > 0) {
    recommendations.push({
      priority: 'medium',
      category: 'context_refresh',
      action: 'Review and prune stale context categories',
      reason: `${staleContext.length} categories not accessed recently`,
      estimated_savings_tokens: staleContext.reduce((sum, w) => sum + w.estimated_waste_tokens, 0),
    });
  }
  
  // Poor compression
  if (compressionEvents.length > 0 && efficiency.compression_efficiency < 0.3) {
    recommendations.push({
      priority: 'medium',
      category: 'compression',
      action: 'Review compression strategy',
      reason: `Average compression efficiency only ${Math.round(efficiency.compression_efficiency * 100)}%`,
    });
  }
  
  // Overall low efficiency
  if (efficiency.score < 70) {
    recommendations.push({
      priority: 'high',
      category: 'optimization',
      action: 'Comprehensive context optimization needed',
      reason: `Overall efficiency score: ${efficiency.score}/100 (grade ${efficiency.grade})`,
    });
  }
  
  return recommendations.sort((a, b) => {
    const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    return priorityOrder[a.priority] - priorityOrder[b.priority];
  });
}

/**
 * Get comprehensive context analytics for a session
 */
export async function getContextAnalytics(
  pool: Pool,
  tenantId: string,
  sessionId: string,
  periodStart?: Date,
  periodEnd?: Date
): Promise<ContextAnalytics> {
  const start = periodStart || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // Default: last 7 days
  const end = periodEnd || new Date();
  
  // Fetch usage patterns
  const usageTimeline = await getUsagePatterns(pool, tenantId, sessionId, start, end);
  
  // Aggregate usage by category
  const usageByCategory: Record<string, number> = {};
  let totalTokensUsed = 0;
  let peakTokens = 0;
  
  for (const snapshot of usageTimeline) {
    usageByCategory[snapshot.category] = (usageByCategory[snapshot.category] || 0) + snapshot.token_count;
    totalTokensUsed += snapshot.token_count;
    peakTokens = Math.max(peakTokens, snapshot.token_count);
  }
  
  const periodHours = (end.getTime() - start.getTime()) / (1000 * 60 * 60);
  const avgTokensPerHour = periodHours > 0 ? Math.round(totalTokensUsed / periodHours) : 0;
  
  // Fetch compression events
  const compressionEvents = await getCompressionEvents(pool, tenantId, sessionId, start, end);
  const totalCompressions = compressionEvents.length;
  const totalTokensSaved = compressionEvents.reduce((sum, e) => sum + e.tokens_saved, 0);
  const avgCompressionRatio = totalCompressions > 0
    ? compressionEvents.reduce((sum, e) => sum + e.compression_ratio, 0) / totalCompressions
    : 0;
  
  // Detect waste
  const repeatedInfo = await detectRepeatedInfo(pool, tenantId, sessionId);
  const staleContext = await detectStaleContext(pool, tenantId, sessionId);
  const wasteDetected = [...repeatedInfo, ...staleContext];
  const totalWasteTokens = wasteDetected.reduce((sum, w) => sum + w.estimated_waste_tokens, 0);
  const wastePercentage = totalTokensUsed > 0 ? (totalWasteTokens / totalTokensUsed) * 100 : 0;
  
  // Calculate efficiency
  const efficiency = calculateEfficiency(totalTokensUsed, totalWasteTokens, compressionEvents);
  
  // Generate recommendations
  const recommendations = generateRecommendations(wasteDetected, efficiency, compressionEvents);
  
  return {
    session_id: sessionId,
    tenant_id: tenantId,
    period_start: start,
    period_end: end,
    
    total_tokens_used: totalTokensUsed,
    peak_tokens: peakTokens,
    avg_tokens_per_hour: avgTokensPerHour,
    usage_by_category: usageByCategory,
    usage_timeline: usageTimeline,
    
    compression_events: compressionEvents,
    total_compressions: totalCompressions,
    total_tokens_saved: totalTokensSaved,
    avg_compression_ratio: avgCompressionRatio,
    
    waste_detected: wasteDetected,
    total_waste_tokens: totalWasteTokens,
    waste_percentage: wastePercentage,
    
    efficiency,
    
    recommendations,
  };
}
