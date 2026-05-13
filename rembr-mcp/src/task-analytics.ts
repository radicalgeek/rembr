/**
 * Task Analytics Service (REM-56)
 * 
 * Provides analytics for task management:
 * - Velocity: tasks completed per time period with trend analysis
 * - Burndown: remaining work vs time with projection to completion
 * - Bottlenecks: identify blocked tasks, overloaded agents, slow transitions
 * 
 * Supports Ralph-RLM stuck detection and team productivity insights.
 */

import type { Pool } from 'pg';

/**
 * Time period for velocity calculations
 */
export type TimePeriod = 'day' | 'week' | 'month';

/**
 * Velocity data point
 */
export interface VelocityDataPoint {
  period_start: Date;
  period_end: Date;
  tasks_completed: number;
  tasks_started: number;
  avg_cycle_time_hours: number;
}

/**
 * Velocity analysis result
 */
export interface VelocityAnalysis {
  period: TimePeriod;
  data_points: VelocityDataPoint[];
  avg_velocity: number;
  trend: 'increasing' | 'decreasing' | 'stable';
  trend_percentage: number;
}

/**
 * Burndown data point
 */
export interface BurndownDataPoint {
  date: Date;
  total_tasks: number;
  completed_tasks: number;
  remaining_tasks: number;
  ideal_remaining: number;
}

/**
 * Burndown analysis result
 */
export interface BurndownAnalysis {
  project_id?: string;
  start_date: Date;
  target_date?: Date;
  current_date: Date;
  data_points: BurndownDataPoint[];
  projected_completion_date?: Date;
  on_track: boolean;
  completion_percentage: number;
}

/**
 * Bottleneck type
 */
export type BottleneckType = 'blocked_task' | 'slow_transition' | 'overloaded_agent' | 'long_cycle_time';

/**
 * Bottleneck detection result
 */
export interface Bottleneck {
  type: BottleneckType;
  severity: 'low' | 'medium' | 'high' | 'critical';
  task_id?: string;
  agent_id?: string;
  state?: string;
  description: string;
  duration_hours?: number;
  task_count?: number;
  suggested_action: string;
}

/**
 * Bottleneck analysis result
 */
export interface BottleneckAnalysis {
  project_id?: string;
  bottlenecks: Bottleneck[];
  total_blocked_tasks: number;
  total_overloaded_agents: number;
  avg_cycle_time_hours: number;
  recommendations: string[];
}

/**
 * Task Analytics Service
 */
export class TaskAnalyticsService {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * Calculate velocity (tasks completed per time period)
   */
  async calculateVelocity(
    tenantId: string,
    period: TimePeriod = 'week',
    projectId?: string,
    periods: number = 8
  ): Promise<VelocityAnalysis> {
    // Determine period length in days
    const periodDays = period === 'day' ? 1 : period === 'week' ? 7 : 30;
    
    // Query to get completed tasks per period
    const query = `
      WITH period_bounds AS (
        SELECT 
          generate_series(
            CURRENT_DATE - INTERVAL '${periodDays * periods} days',
            CURRENT_DATE,
            INTERVAL '${periodDays} days'
          )::date AS period_start
      ),
      task_completions AS (
        SELECT 
          DATE_TRUNC('${period === 'day' ? 'day' : period === 'week' ? 'week' : 'month'}', completed_at) AS completion_period,
          COUNT(*) AS completed_count,
          AVG(EXTRACT(EPOCH FROM (completed_at - created_at)) / 3600) AS avg_cycle_hours
        FROM tasks
        WHERE tenant_id = $1
          AND ($2::uuid IS NULL OR project_id = $2)
          AND completed_at IS NOT NULL
          AND completed_at >= CURRENT_DATE - INTERVAL '${periodDays * periods} days'
        GROUP BY DATE_TRUNC('${period === 'day' ? 'day' : period === 'week' ? 'week' : period === 'month'}', completed_at)
      ),
      task_starts AS (
        SELECT 
          DATE_TRUNC('${period === 'day' ? 'day' : period === 'week' ? 'week' : 'month'}', 
            (SELECT MIN(transitioned_at) 
             FROM task_state_transitions 
             WHERE task_id = t.id AND to_state = 'in_progress')
          ) AS start_period,
          COUNT(*) AS started_count
        FROM tasks t
        WHERE tenant_id = $1
          AND ($2::uuid IS NULL OR project_id = $2)
          AND EXISTS (
            SELECT 1 FROM task_state_transitions 
            WHERE task_id = t.id 
              AND to_state = 'in_progress'
              AND transitioned_at >= CURRENT_DATE - INTERVAL '${periodDays * periods} days'
          )
        GROUP BY start_period
      )
      SELECT 
        pb.period_start,
        pb.period_start + INTERVAL '${periodDays} days' AS period_end,
        COALESCE(tc.completed_count, 0)::integer AS tasks_completed,
        COALESCE(ts.started_count, 0)::integer AS tasks_started,
        COALESCE(tc.avg_cycle_hours, 0)::numeric AS avg_cycle_time_hours
      FROM period_bounds pb
      LEFT JOIN task_completions tc ON DATE_TRUNC('${period === 'day' ? 'day' : period === 'week' ? 'week' : 'month'}', pb.period_start) = tc.completion_period
      LEFT JOIN task_starts ts ON DATE_TRUNC('${period === 'day' ? 'day' : period === 'week' ? 'week' : 'month'}', pb.period_start) = ts.start_period
      ORDER BY pb.period_start DESC
      LIMIT $3
    `;

    const result = await this.pool.query(query, [tenantId, projectId, periods]);
    const dataPoints: VelocityDataPoint[] = result.rows.map(row => ({
      period_start: row.period_start,
      period_end: row.period_end,
      tasks_completed: row.tasks_completed,
      tasks_started: row.tasks_started,
      avg_cycle_time_hours: parseFloat(row.avg_cycle_time_hours)
    }));

    // Calculate average velocity
    const avgVelocity = dataPoints.reduce((sum, dp) => sum + dp.tasks_completed, 0) / dataPoints.length;

    // Calculate trend (compare recent half vs older half)
    const midpoint = Math.floor(dataPoints.length / 2);
    const recentAvg = dataPoints.slice(0, midpoint).reduce((sum, dp) => sum + dp.tasks_completed, 0) / midpoint;
    const olderAvg = dataPoints.slice(midpoint).reduce((sum, dp) => sum + dp.tasks_completed, 0) / (dataPoints.length - midpoint);
    
    const trendPercentage = olderAvg > 0 ? ((recentAvg - olderAvg) / olderAvg) * 100 : 0;
    const trend = trendPercentage > 10 ? 'increasing' : trendPercentage < -10 ? 'decreasing' : 'stable';

    return {
      period,
      data_points: dataPoints,
      avg_velocity: avgVelocity,
      trend,
      trend_percentage: trendPercentage
    };
  }

  /**
   * Calculate burndown (remaining work vs time)
   */
  async calculateBurndown(
    tenantId: string,
    projectId?: string,
    startDate?: Date,
    targetDate?: Date
  ): Promise<BurndownAnalysis> {
    const effectiveStartDate = startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days ago
    const effectiveTargetDate = targetDate;

    // Get total tasks at start
    const totalTasksQuery = `
      SELECT COUNT(*) as total
      FROM tasks
      WHERE tenant_id = $1
        AND ($2::uuid IS NULL OR project_id = $2)
        AND created_at <= $3
        AND state NOT IN ('cancelled')
    `;
    const totalTasksResult = await this.pool.query(totalTasksQuery, [tenantId, projectId, effectiveStartDate]);
    const totalTasks = parseInt(totalTasksResult.rows[0]?.total || '0');

    // Get completed tasks over time
    const burndownQuery = `
      WITH date_series AS (
        SELECT generate_series(
          $3::date,
          CURRENT_DATE,
          '1 day'::interval
        )::date AS date
      ),
      daily_completions AS (
        SELECT 
          DATE(completed_at) AS completion_date,
          COUNT(*) AS completed_count
        FROM tasks
        WHERE tenant_id = $1
          AND ($2::uuid IS NULL OR project_id = $2)
          AND completed_at >= $3
          AND state = 'done'
        GROUP BY DATE(completed_at)
      )
      SELECT 
        ds.date,
        COALESCE(SUM(dc.completed_count) OVER (ORDER BY ds.date ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW), 0)::integer AS cumulative_completed
      FROM date_series ds
      LEFT JOIN daily_completions dc ON ds.date = dc.completion_date
      ORDER BY ds.date
    `;

    const burndownResult = await this.pool.query(burndownQuery, [tenantId, projectId, effectiveStartDate]);
    
    const dataPoints: BurndownDataPoint[] = burndownResult.rows.map((row, index) => {
      const completedTasks = row.cumulative_completed;
      const remainingTasks = totalTasks - completedTasks;
      
      // Calculate ideal remaining (linear burndown)
      const daysSinceStart = index;
      const totalDays = effectiveTargetDate 
        ? Math.ceil((effectiveTargetDate.getTime() - effectiveStartDate.getTime()) / (24 * 60 * 60 * 1000))
        : burndownResult.rows.length;
      const idealRemaining = totalDays > 0 
        ? Math.max(0, totalTasks - (totalTasks * daysSinceStart / totalDays))
        : totalTasks;

      return {
        date: row.date,
        total_tasks: totalTasks,
        completed_tasks: completedTasks,
        remaining_tasks: remainingTasks,
        ideal_remaining: Math.round(idealRemaining)
      };
    });

    // Project completion date based on recent velocity
    const recentDataPoints = dataPoints.slice(-7); // Last 7 days
    const recentVelocity = recentDataPoints.length > 1
      ? (recentDataPoints[recentDataPoints.length - 1].completed_tasks - recentDataPoints[0].completed_tasks) / recentDataPoints.length
      : 0;

    const currentRemaining = dataPoints[dataPoints.length - 1]?.remaining_tasks || 0;
    const projectedDaysToCompletion = recentVelocity > 0 ? Math.ceil(currentRemaining / recentVelocity) : null;
    const projectedCompletionDate = projectedDaysToCompletion
      ? new Date(Date.now() + projectedDaysToCompletion * 24 * 60 * 60 * 1000)
      : undefined;

    // Check if on track
    const onTrack = !effectiveTargetDate || !projectedCompletionDate || projectedCompletionDate <= effectiveTargetDate;
    const completionPercentage = totalTasks > 0 ? ((totalTasks - currentRemaining) / totalTasks) * 100 : 0;

    return {
      project_id: projectId,
      start_date: effectiveStartDate,
      target_date: effectiveTargetDate,
      current_date: new Date(),
      data_points: dataPoints,
      projected_completion_date: projectedCompletionDate,
      on_track: onTrack,
      completion_percentage: completionPercentage
    };
  }

  /**
   * Identify bottlenecks (blocked tasks, overloaded agents, slow transitions)
   */
  async identifyBottlenecks(
    tenantId: string,
    projectId?: string,
    thresholds?: {
      blockedHours?: number;
      cycleTimeHours?: number;
      agentTaskLimit?: number;
      transitionHours?: number;
    }
  ): Promise<BottleneckAnalysis> {
    const defaultThresholds = {
      blockedHours: thresholds?.blockedHours || 24,
      cycleTimeHours: thresholds?.cycleTimeHours || 168, // 1 week
      agentTaskLimit: thresholds?.agentTaskLimit || 5,
      transitionHours: thresholds?.transitionHours || 48
    };

    const bottlenecks: Bottleneck[] = [];

    // 1. Blocked tasks
    const blockedTasksQuery = `
      SELECT 
        id,
        title,
        state,
        assigned_to,
        EXTRACT(EPOCH FROM (NOW() - updated_at)) / 3600 AS hours_blocked
      FROM tasks
      WHERE tenant_id = $1
        AND ($2::uuid IS NULL OR project_id = $2)
        AND state = 'blocked'
      ORDER BY updated_at ASC
    `;

    const blockedResult = await this.pool.query(blockedTasksQuery, [tenantId, projectId]);
    for (const row of blockedResult.rows) {
      const hoursBlocked = parseFloat(row.hours_blocked);
      const severity = hoursBlocked > 168 ? 'critical' : hoursBlocked > 72 ? 'high' : hoursBlocked > 24 ? 'medium' : 'low';
      
      bottlenecks.push({
        type: 'blocked_task',
        severity,
        task_id: row.id,
        agent_id: row.assigned_to,
        state: row.state,
        description: `Task "${row.title}" blocked for ${Math.round(hoursBlocked)} hours`,
        duration_hours: hoursBlocked,
        suggested_action: 'Review blockers and dependencies, consider reassignment or breaking down task'
      });
    }

    // 2. Slow transitions (tasks stuck in in_progress or review)
    const slowTransitionsQuery = `
      SELECT 
        t.id,
        t.title,
        t.state,
        t.assigned_to,
        EXTRACT(EPOCH FROM (NOW() - tst.transitioned_at)) / 3600 AS hours_in_state
      FROM tasks t
      JOIN task_state_transitions tst ON tst.task_id = t.id
      WHERE t.tenant_id = $1
        AND ($2::uuid IS NULL OR t.project_id = $2)
        AND t.state IN ('in_progress', 'review')
        AND tst.to_state = t.state
        AND NOT EXISTS (
          SELECT 1 FROM task_state_transitions tst2
          WHERE tst2.task_id = t.id 
            AND tst2.transitioned_at > tst.transitioned_at
        )
        AND EXTRACT(EPOCH FROM (NOW() - tst.transitioned_at)) / 3600 > $3
      ORDER BY hours_in_state DESC
    `;

    const slowResult = await this.pool.query(slowTransitionsQuery, [tenantId, projectId, defaultThresholds.transitionHours]);
    for (const row of slowResult.rows) {
      const hoursInState = parseFloat(row.hours_in_state);
      const severity = hoursInState > 168 ? 'high' : hoursInState > 72 ? 'medium' : 'low';
      
      bottlenecks.push({
        type: 'slow_transition',
        severity,
        task_id: row.id,
        agent_id: row.assigned_to,
        state: row.state,
        description: `Task "${row.title}" in ${row.state} for ${Math.round(hoursInState)} hours`,
        duration_hours: hoursInState,
        suggested_action: `Check with ${row.assigned_to ? 'assigned agent' : 'team'} for status update or blockers`
      });
    }

    // 3. Overloaded agents
    const overloadedAgentsQuery = `
      SELECT 
        assigned_to,
        COUNT(*) AS active_task_count
      FROM tasks
      WHERE tenant_id = $1
        AND ($2::uuid IS NULL OR project_id = $2)
        AND assigned_to IS NOT NULL
        AND state IN ('in_progress', 'review', 'ready')
      GROUP BY assigned_to
      HAVING COUNT(*) > $3
      ORDER BY active_task_count DESC
    `;

    const overloadedResult = await this.pool.query(overloadedAgentsQuery, [tenantId, projectId, defaultThresholds.agentTaskLimit]);
    for (const row of overloadedResult.rows) {
      const taskCount = parseInt(row.active_task_count);
      const severity = taskCount > 10 ? 'high' : taskCount > 7 ? 'medium' : 'low';
      
      bottlenecks.push({
        type: 'overloaded_agent',
        severity,
        agent_id: row.assigned_to,
        description: `Agent ${row.assigned_to} has ${taskCount} active tasks`,
        task_count: taskCount,
        suggested_action: 'Consider redistributing tasks or increasing agent capacity'
      });
    }

    // 4. Long cycle time tasks
    const longCycleQuery = `
      SELECT 
        id,
        title,
        state,
        assigned_to,
        EXTRACT(EPOCH FROM (NOW() - created_at)) / 3600 AS cycle_time_hours
      FROM tasks
      WHERE tenant_id = $1
        AND ($2::uuid IS NULL OR project_id = $2)
        AND state NOT IN ('done', 'cancelled')
        AND EXTRACT(EPOCH FROM (NOW() - created_at)) / 3600 > $3
      ORDER BY cycle_time_hours DESC
      LIMIT 10
    `;

    const longCycleResult = await this.pool.query(longCycleQuery, [tenantId, projectId, defaultThresholds.cycleTimeHours]);
    for (const row of longCycleResult.rows) {
      const cycleTimeHours = parseFloat(row.cycle_time_hours);
      const severity = cycleTimeHours > 336 ? 'high' : 'medium'; // > 2 weeks = high
      
      bottlenecks.push({
        type: 'long_cycle_time',
        severity,
        task_id: row.id,
        agent_id: row.assigned_to,
        state: row.state,
        description: `Task "${row.title}" has been open for ${Math.round(cycleTimeHours)} hours`,
        duration_hours: cycleTimeHours,
        suggested_action: 'Review task complexity, consider breaking down or closing if no longer relevant'
      });
    }

    // Calculate summary metrics
    const avgCycleQuery = `
      SELECT AVG(EXTRACT(EPOCH FROM (completed_at - created_at)) / 3600) AS avg_cycle_hours
      FROM tasks
      WHERE tenant_id = $1
        AND ($2::uuid IS NULL OR project_id = $2)
        AND completed_at IS NOT NULL
        AND completed_at >= NOW() - INTERVAL '30 days'
    `;
    const avgCycleResult = await this.pool.query(avgCycleQuery, [tenantId, projectId]);
    const avgCycleTimeHours = parseFloat(avgCycleResult.rows[0]?.avg_cycle_hours || '0');

    // Generate recommendations
    const recommendations: string[] = [];
    const totalBlockedTasks = bottlenecks.filter(b => b.type === 'blocked_task').length;
    const totalOverloadedAgents = bottlenecks.filter(b => b.type === 'overloaded_agent').length;

    if (totalBlockedTasks > 5) {
      recommendations.push('High number of blocked tasks - review dependency management and task breakdown');
    }
    if (totalOverloadedAgents > 0) {
      recommendations.push('Some agents are overloaded - consider load balancing or team expansion');
    }
    if (avgCycleTimeHours > defaultThresholds.cycleTimeHours) {
      recommendations.push('Average cycle time is high - review task scope and process efficiency');
    }
    if (bottlenecks.filter(b => b.type === 'slow_transition').length > 3) {
      recommendations.push('Multiple tasks stuck in transitions - check for process bottlenecks or unclear acceptance criteria');
    }

    return {
      project_id: projectId,
      bottlenecks,
      total_blocked_tasks: totalBlockedTasks,
      total_overloaded_agents: totalOverloadedAgents,
      avg_cycle_time_hours: avgCycleTimeHours,
      recommendations
    };
  }
}
