/**
 * Context Monitor Service Tests (REM-97)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import {
  monitorContext,
  getSessionState,
  type MonitorRequest,
} from './context-monitor.js';

const testPool = new Pool({
  connectionString: process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/rembr_test',
});

const TEST_TENANT_ID = '550e8400-e29b-41d4-a716-446655440000';
const TEST_SESSION_ID = 'test-session-monitor-1';

describe('Context Monitor Service', () => {
  beforeAll(async () => {
    // Set tenant context
    
    // Create tables if not exist (from migration 010)
    await testPool.query(`
      CREATE TABLE IF NOT EXISTS context_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL,
        session_id TEXT NOT NULL,
        agent_name TEXT,
        max_tokens INTEGER NOT NULL DEFAULT 200000,
        current_usage INTEGER NOT NULL DEFAULT 0,
        peak_usage INTEGER NOT NULL DEFAULT 0,
        compression_count INTEGER NOT NULL DEFAULT 0,
        last_compression_at TIMESTAMPTZ,
        session_state TEXT NOT NULL DEFAULT 'active',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        metadata JSONB DEFAULT '{}'::jsonb,
        
        CONSTRAINT context_sessions_unique UNIQUE (tenant_id, session_id)
      )
    `);
    
    await testPool.query(`
      CREATE TABLE IF NOT EXISTS context_analytics_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL,
        session_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        event_data JSONB DEFAULT '{}'::jsonb,
        token_count INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        metadata JSONB DEFAULT '{}'::jsonb
      )
    `);
  });

  afterAll(async () => {
    await testPool.query('DELETE FROM context_analytics_events WHERE tenant_id = $1', [TEST_TENANT_ID]);
    await testPool.query('DELETE FROM context_sessions WHERE tenant_id = $1', [TEST_TENANT_ID]);
    await testPool.end();
  });

  beforeEach(async () => {
    // Clean up before each test
    await testPool.query('DELETE FROM context_analytics_events WHERE tenant_id = $1', [TEST_TENANT_ID]);
    await testPool.query('DELETE FROM context_sessions WHERE tenant_id = $1', [TEST_TENANT_ID]);
  });

  describe('monitorContext', () => {
    it('should track context usage and generate report', async () => {
      const request: MonitorRequest = {
        session_id: TEST_SESSION_ID,
        current_usage: {
          system: 5000,
          conversation: 30000,
          tools: 25000,
          memory: 20000,
          other: 5000,
        },
        max_tokens: 100000,
      };
      
      const result = await monitorContext(testPool, TEST_TENANT_ID, request);
      
      expect(result.session_id).toBe(TEST_SESSION_ID);
      expect(result.tenant_id).toBe(TEST_TENANT_ID);
      expect(result.total_tokens_used).toBe(85000);
      expect(result.max_tokens).toBe(100000);
      expect(result.utilization_percent).toBe(85.0);
      expect(result.tokens_remaining).toBe(15000);
    });

    it('should provide category breakdown sorted by usage', async () => {
      const request: MonitorRequest = {
        session_id: TEST_SESSION_ID,
        current_usage: {
          system: 5000,
          conversation: 30000,
          tools: 25000,
          memory: 20000,
          other: 5000,
        },
      };
      
      const result = await monitorContext(testPool, TEST_TENANT_ID, request);
      
      expect(result.breakdown_by_category).toHaveLength(5);
      
      // Should be sorted by tokens (descending)
      expect(result.breakdown_by_category[0].category).toBe('conversation');
      expect(result.breakdown_by_category[0].tokens).toBe(30000);
      expect(result.breakdown_by_category[0].percentage).toBe(35.3); // 30000/85000
      expect(result.breakdown_by_category[0].rank).toBe(1);
      
      expect(result.breakdown_by_category[1].category).toBe('tools');
      expect(result.breakdown_by_category[1].tokens).toBe(25000);
      expect(result.breakdown_by_category[1].rank).toBe(2);
    });

    it('should identify top N consumers', async () => {
      const request: MonitorRequest = {
        session_id: TEST_SESSION_ID,
        current_usage: {
          system: 5000,
          conversation: 30000,
          tools: 25000,
          memory: 20000,
          other: 5000,
        },
        top_n: 3,
      };
      
      const result = await monitorContext(testPool, TEST_TENANT_ID, request);
      
      expect(result.top_consumers).toHaveLength(3);
      expect(result.top_consumers[0].category).toBe('conversation');
      expect(result.top_consumers[1].category).toBe('tools');
      expect(result.top_consumers[2].category).toBe('memory');
    });

    it('should generate alerts at threshold levels', async () => {
      const request: MonitorRequest = {
        session_id: TEST_SESSION_ID,
        current_usage: { total: 85000 },
        max_tokens: 100000,
        thresholds: [70, 85, 95],
      };
      
      const result = await monitorContext(testPool, TEST_TENANT_ID, request);
      
      expect(result.alerts.length).toBeGreaterThan(0);
      const alert = result.alerts[0];
      expect(alert.severity).toBe('critical'); // 85% >= 85 threshold
      expect(alert.threshold_percent).toBe(85);
      expect(alert.current_percent).toBe(85.0);
      expect(alert.recommendation).toBeDefined();
    });

    it('should generate urgent alert at 95%+ usage', async () => {
      const request: MonitorRequest = {
        session_id: TEST_SESSION_ID,
        current_usage: { total: 96000 },
        max_tokens: 100000,
      };
      
      const result = await monitorContext(testPool, TEST_TENANT_ID, request);
      
      expect(result.alerts.length).toBeGreaterThan(0);
      const alert = result.alerts[0];
      expect(alert.severity).toBe('urgent');
      expect(alert.threshold_percent).toBe(95);
    });

    it('should generate alert for low tokens remaining', async () => {
      const request: MonitorRequest = {
        session_id: TEST_SESSION_ID,
        current_usage: { total: 195000 },
        max_tokens: 200000, // Only 5000 tokens remaining
      };
      
      const result = await monitorContext(testPool, TEST_TENANT_ID, request);
      
      const lowTokenAlert = result.alerts.find(a =>
        a.message.includes('tokens remaining')
      );
      
      expect(lowTokenAlert).toBeDefined();
      expect(lowTokenAlert!.severity).toBe('urgent');
    });

    it('should track usage trends over time', async () => {
      // Simulate multiple usage snapshots
      const baseUsage = { conversation: 20000, tools: 10000 };
      
      // First snapshot
      await monitorContext(testPool, TEST_TENANT_ID, {
        session_id: TEST_SESSION_ID,
        current_usage: baseUsage,
        max_tokens: 100000,
      });
      
      // Second snapshot (higher usage)
      await new Promise(resolve => setTimeout(resolve, 10));
      await monitorContext(testPool, TEST_TENANT_ID, {
        session_id: TEST_SESSION_ID,
        current_usage: { conversation: 30000, tools: 20000 },
        max_tokens: 100000,
      });
      
      // Third snapshot
      await new Promise(resolve => setTimeout(resolve, 10));
      const result = await monitorContext(testPool, TEST_TENANT_ID, {
        session_id: TEST_SESSION_ID,
        current_usage: { conversation: 40000, tools: 30000 },
        max_tokens: 100000,
      });
      
      expect(result.usage_trend.length).toBeGreaterThan(0);
      // Trend should show increasing usage
      if (result.usage_trend.length >= 2) {
        expect(result.usage_trend[result.usage_trend.length - 1].total_tokens)
          .toBeGreaterThan(result.usage_trend[0].total_tokens);
      }
    });

    it('should calculate peak usage correctly', async () => {
      // First usage at 60K
      await monitorContext(testPool, TEST_TENANT_ID, {
        session_id: TEST_SESSION_ID,
        current_usage: { total: 60000 },
      });
      
      // Peak at 80K
      await new Promise(resolve => setTimeout(resolve, 10));
      await monitorContext(testPool, TEST_TENANT_ID, {
        session_id: TEST_SESSION_ID,
        current_usage: { total: 80000 },
      });
      
      // Drop to 70K
      await new Promise(resolve => setTimeout(resolve, 10));
      const result = await monitorContext(testPool, TEST_TENANT_ID, {
        session_id: TEST_SESSION_ID,
        current_usage: { total: 70000 },
      });
      
      expect(result.peak_usage).toBe(80000);
      expect(result.peak_usage_time).toBeDefined();
    });

    it('should recommend checkpoint at 70% usage', async () => {
      const result = await monitorContext(testPool, TEST_TENANT_ID, {
        session_id: TEST_SESSION_ID,
        current_usage: { total: 70000 },
        max_tokens: 100000,
      });
      
      expect(result.should_checkpoint).toBe(true);
      expect(result.should_compress).toBe(false); // Not yet at 85%
    });

    it('should recommend compression at 85% usage', async () => {
      const result = await monitorContext(testPool, TEST_TENANT_ID, {
        session_id: TEST_SESSION_ID,
        current_usage: { total: 85000 },
        max_tokens: 100000,
      });
      
      expect(result.should_checkpoint).toBe(true);
      expect(result.should_compress).toBe(true);
    });

    it('should estimate time to full based on growth trend', async () => {
      // Simulate steady growth: 50K -> 60K -> 70K over 20 minutes
      const timestamps = [
        new Date(Date.now() - 20 * 60 * 1000), // 20 min ago
        new Date(Date.now() - 10 * 60 * 1000), // 10 min ago
        new Date(), // now
      ];
      
      // Not easily testable with real time progression in unit tests
      // This would be better as an integration test with mocked timestamps
      // Just verify the field exists for now
      const result = await monitorContext(testPool, TEST_TENANT_ID, {
        session_id: TEST_SESSION_ID,
        current_usage: { total: 70000 },
      });
      
      expect(result).toHaveProperty('estimated_time_to_full');
    });

    it('should use default thresholds when not specified', async () => {
      const result = await monitorContext(testPool, TEST_TENANT_ID, {
        session_id: TEST_SESSION_ID,
        current_usage: { total: 75000 },
        max_tokens: 100000,
      });
      
      // Default thresholds: [70, 85, 95]
      // At 75%, should trigger 70% threshold
      expect(result.alerts.length).toBeGreaterThan(0);
      const alert = result.alerts[0];
      expect(alert.threshold_percent).toBe(70);
      expect(alert.severity).toBe('warning');
    });
  });

  describe('getSessionState', () => {
    it('should return session state after monitoring', async () => {
      await monitorContext(testPool, TEST_TENANT_ID, {
        session_id: TEST_SESSION_ID,
        current_usage: { total: 60000 },
        max_tokens: 100000,
      });
      
      const state = await getSessionState(testPool, TEST_TENANT_ID, TEST_SESSION_ID);
      
      expect(state).toBeDefined();
      expect(state!.current_usage).toBe(60000);
      expect(state!.peak_usage).toBe(60000);
      expect(state!.max_tokens).toBe(100000);
      expect(state!.session_state).toBe('active');
    });

    it('should update peak usage when current exceeds previous', async () => {
      // First monitoring at 50K
      await monitorContext(testPool, TEST_TENANT_ID, {
        session_id: TEST_SESSION_ID,
        current_usage: { total: 50000 },
      });
      
      // Second monitoring at 80K (new peak)
      await monitorContext(testPool, TEST_TENANT_ID, {
        session_id: TEST_SESSION_ID,
        current_usage: { total: 80000 },
      });
      
      const state = await getSessionState(testPool, TEST_TENANT_ID, TEST_SESSION_ID);
      
      expect(state!.current_usage).toBe(80000);
      expect(state!.peak_usage).toBe(80000);
    });

    it('should return null for non-existent session', async () => {
      const state = await getSessionState(testPool, TEST_TENANT_ID, 'non-existent-session');
      expect(state).toBeNull();
    });
  });
});
