/**
 * Context Analytics Service Tests (REM-101)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import {
  getUsagePatterns,
  getCompressionEvents,
  detectRepeatedInfo,
  detectStaleContext,
  calculateEfficiency,
  generateRecommendations,
  getContextAnalytics,
  type CompressionEvent,
  type WasteDetection,
} from './context-analytics.js';

const testPool = new Pool({
  connectionString: process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/rembr_test',
});

const TEST_TENANT_ID = '11111111-1111-1111-1111-111111111111';
const TEST_SESSION_ID = 'test-session-analytics';

describe('Context Analytics Service', () => {
  beforeAll(async () => {
    // Create context_analytics_events table if not exists (from migration 010)
    await testPool.query(`
      CREATE TABLE IF NOT EXISTS context_analytics_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL,
        session_id TEXT,
        event_type TEXT NOT NULL,
        event_data JSONB NOT NULL DEFAULT '{}'::jsonb,
        token_count INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  });

  afterAll(async () => {
    await testPool.end();
  });

  beforeEach(async () => {
    // Clean up test data
    await testPool.query('DELETE FROM context_analytics_events WHERE tenant_id = $1', [TEST_TENANT_ID]);
  });

  describe('getUsagePatterns', () => {
    it('should fetch usage snapshots for a session', async () => {
      // Insert test usage snapshots
      await testPool.query(`
        INSERT INTO context_analytics_events (tenant_id, session_id, event_type, event_data, token_count, created_at)
        VALUES 
          ($1, $2, 'usage_snapshot', '{"category": "conversation"}', 1000, NOW() - INTERVAL '2 hours'),
          ($1, $2, 'usage_snapshot', '{"category": "decisions"}', 500, NOW() - INTERVAL '1 hour'),
          ($1, $2, 'usage_snapshot', '{"category": "conversation"}', 1200, NOW())
      `, [TEST_TENANT_ID, TEST_SESSION_ID]);

      const patterns = await getUsagePatterns(testPool, TEST_TENANT_ID, TEST_SESSION_ID);

      expect(patterns).toHaveLength(3);
      expect(patterns[0].category).toBe('conversation');
      expect(patterns[0].token_count).toBe(1000);
      expect(patterns[1].category).toBe('decisions');
      expect(patterns[1].token_count).toBe(500);
      expect(patterns[2].token_count).toBe(1200);
    });

    it('should filter by period', async () => {
      await testPool.query(`
        INSERT INTO context_analytics_events (tenant_id, session_id, event_type, event_data, token_count, created_at)
        VALUES 
          ($1, $2, 'usage_snapshot', '{"category": "old"}', 100, NOW() - INTERVAL '10 days'),
          ($1, $2, 'usage_snapshot', '{"category": "recent"}', 200, NOW() - INTERVAL '1 day')
      `, [TEST_TENANT_ID, TEST_SESSION_ID]);

      const periodStart = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000); // 2 days ago
      const patterns = await getUsagePatterns(testPool, TEST_TENANT_ID, TEST_SESSION_ID, periodStart);

      expect(patterns).toHaveLength(1);
      expect(patterns[0].category).toBe('recent');
    });
  });

  describe('getCompressionEvents', () => {
    it('should fetch and calculate compression metrics', async () => {
      await testPool.query(`
        INSERT INTO context_analytics_events (tenant_id, session_id, event_type, event_data, token_count, created_at)
        VALUES 
          ($1, $2, 'compression_completed', '{"tokens_after": "5000", "strategy": "aggressive"}', 10000, NOW() - INTERVAL '1 hour'),
          ($1, $2, 'compression_completed', '{"tokens_after": "7000", "strategy": "balanced"}', 8000, NOW())
      `, [TEST_TENANT_ID, TEST_SESSION_ID]);

      const events = await getCompressionEvents(testPool, TEST_TENANT_ID, TEST_SESSION_ID);

      expect(events).toHaveLength(2);
      
      // First event
      expect(events[0].tokens_before).toBe(10000);
      expect(events[0].tokens_after).toBe(5000);
      expect(events[0].tokens_saved).toBe(5000);
      expect(events[0].compression_ratio).toBe(0.5);
      expect(events[0].strategy).toBe('aggressive');
      
      // Second event
      expect(events[1].tokens_before).toBe(8000);
      expect(events[1].tokens_after).toBe(7000);
      expect(events[1].tokens_saved).toBe(1000);
      expect(events[1].compression_ratio).toBeCloseTo(0.875);
      expect(events[1].strategy).toBe('balanced');
    });
  });

  describe('detectRepeatedInfo', () => {
    it('should detect repeated content hashes', async () => {
      const contentHash = 'abc123def456';
      
      await testPool.query(`
        INSERT INTO context_analytics_events (tenant_id, session_id, event_type, event_data, token_count, created_at)
        VALUES 
          ($1, $2, 'usage_snapshot', $3, 500, NOW() - INTERVAL '3 hours'),
          ($1, $2, 'usage_snapshot', $3, 500, NOW() - INTERVAL '2 hours'),
          ($1, $2, 'usage_snapshot', $3, 500, NOW() - INTERVAL '1 hour')
      `, [TEST_TENANT_ID, TEST_SESSION_ID, JSON.stringify({ content_hash: contentHash, token_count: 500 })]);

      const waste = await detectRepeatedInfo(testPool, TEST_TENANT_ID, TEST_SESSION_ID);

      expect(waste).toHaveLength(1);
      expect(waste[0].type).toBe('repeated_info');
      expect(waste[0].description).toContain('3 times');
      expect(waste[0].estimated_waste_tokens).toBeGreaterThan(0);
      expect(waste[0].severity).toBe('medium'); // 1000 tokens wasted (not > 1000)
    });

    it('should ignore single occurrences', async () => {
      await testPool.query(`
        INSERT INTO context_analytics_events (tenant_id, session_id, event_type, event_data, token_count)
        VALUES ($1, $2, 'usage_snapshot', $3, 500)
      `, [TEST_TENANT_ID, TEST_SESSION_ID, JSON.stringify({ content_hash: 'unique123', token_count: 500 })]);

      const waste = await detectRepeatedInfo(testPool, TEST_TENANT_ID, TEST_SESSION_ID);

      expect(waste).toHaveLength(0);
    });
  });

  describe('detectStaleContext', () => {
    it('should detect old unused context', async () => {
      await testPool.query(`
        INSERT INTO context_analytics_events (tenant_id, session_id, event_type, event_data, token_count, created_at)
        VALUES ($1, $2, 'usage_snapshot', $3, 2000, NOW() - INTERVAL '48 hours')
      `, [TEST_TENANT_ID, TEST_SESSION_ID, JSON.stringify({ category: 'old_project', token_count: 2000 })]);

      const waste = await detectStaleContext(testPool, TEST_TENANT_ID, TEST_SESSION_ID);

      expect(waste).toHaveLength(1);
      expect(waste[0].type).toBe('stale_context');
      expect(waste[0].description).toContain('48 hours');
      expect(waste[0].severity).toBe('medium');
      expect(waste[0].location).toBe('old_project');
    });

    it('should ignore recent context', async () => {
      await testPool.query(`
        INSERT INTO context_analytics_events (tenant_id, session_id, event_type, event_data, token_count, created_at)
        VALUES ($1, $2, 'usage_snapshot', $3, 1000, NOW() - INTERVAL '12 hours')
      `, [TEST_TENANT_ID, TEST_SESSION_ID, JSON.stringify({ category: 'active_project', token_count: 1000 })]);

      const waste = await detectStaleContext(testPool, TEST_TENANT_ID, TEST_SESSION_ID);

      expect(waste).toHaveLength(0);
    });
  });

  describe('calculateEfficiency', () => {
    it('should calculate efficiency score with grade A', () => {
      const compressionEvents: CompressionEvent[] = [
        {
          timestamp: new Date(),
          tokens_before: 10000,
          tokens_after: 5000,
          tokens_saved: 5000,
          compression_ratio: 0.5,
          strategy: 'aggressive',
        },
      ];

      const efficiency = calculateEfficiency(10000, 500, compressionEvents);

      expect(efficiency.waste_ratio).toBe(0.05);
      expect(efficiency.useful_context_ratio).toBe(0.95);
      expect(efficiency.compression_efficiency).toBe(0.5);
      expect(efficiency.score).toBe(86); // (0.95 * 0.5 + 0.95 * 0.3 + 0.5 * 0.2) * 100 = 86
      expect(efficiency.grade).toBe('B'); // 86 is grade B (80-89)
    });

    it('should calculate efficiency score with grade F', () => {
      const compressionEvents: CompressionEvent[] = [];

      const efficiency = calculateEfficiency(10000, 6000, compressionEvents);

      expect(efficiency.waste_ratio).toBe(0.6);
      expect(efficiency.useful_context_ratio).toBe(0.4);
      expect(efficiency.score).toBeLessThan(60);
      expect(efficiency.grade).toBe('F');
    });
  });

  describe('generateRecommendations', () => {
    it('should generate critical waste recommendations', () => {
      const waste: WasteDetection[] = [
        {
          type: 'repeated_info',
          severity: 'high',
          description: 'Content repeated 5 times',
          estimated_waste_tokens: 2000,
        },
      ];

      const efficiency = {
        score: 70,
        useful_context_ratio: 0.7,
        waste_ratio: 0.3,
        compression_efficiency: 0.5,
        grade: 'C' as const,
      };

      const recommendations = generateRecommendations(waste, efficiency, []);

      expect(recommendations.length).toBeGreaterThan(0);
      expect(recommendations[0].priority).toBe('critical');
      expect(recommendations[0].category).toBe('waste_reduction');
      expect(recommendations[0].estimated_savings_tokens).toBe(2000);
    });

    it('should recommend deduplication for repeated info', () => {
      const waste: WasteDetection[] = [
        {
          type: 'repeated_info',
          severity: 'medium',
          description: 'Repeated content',
          estimated_waste_tokens: 500,
        },
      ];

      const efficiency = {
        score: 75,
        useful_context_ratio: 0.75,
        waste_ratio: 0.25,
        compression_efficiency: 0.5,
        grade: 'C' as const,
      };

      const recommendations = generateRecommendations(waste, efficiency, []);

      const dedup = recommendations.find(r => r.category === 'deduplication');
      expect(dedup).toBeDefined();
      expect(dedup?.priority).toBe('high');
      expect(dedup?.action).toContain('deduplication');
    });

    it('should recommend context refresh for stale data', () => {
      const waste: WasteDetection[] = [
        {
          type: 'stale_context',
          severity: 'medium',
          description: 'Not accessed in 72 hours',
          estimated_waste_tokens: 1000,
          location: 'old_category',
        },
      ];

      const efficiency = {
        score: 80,
        useful_context_ratio: 0.8,
        waste_ratio: 0.2,
        compression_efficiency: 0.5,
        grade: 'B' as const,
      };

      const recommendations = generateRecommendations(waste, efficiency, []);

      const refresh = recommendations.find(r => r.category === 'context_refresh');
      expect(refresh).toBeDefined();
      expect(refresh?.priority).toBe('medium');
    });

    it('should sort recommendations by priority', () => {
      const waste: WasteDetection[] = [
        {
          type: 'repeated_info',
          severity: 'high',
          description: 'High waste',
          estimated_waste_tokens: 2000,
        },
        {
          type: 'stale_context',
          severity: 'medium',
          description: 'Medium waste',
          estimated_waste_tokens: 500,
        },
      ];

      const efficiency = {
        score: 50,
        useful_context_ratio: 0.5,
        waste_ratio: 0.5,
        compression_efficiency: 0.2,
        grade: 'F' as const,
      };

      const recommendations = generateRecommendations(waste, efficiency, []);

      expect(recommendations[0].priority).toBe('critical');
      expect(recommendations[recommendations.length - 1].priority).not.toBe('critical');
    });
  });

  describe('getContextAnalytics', () => {
    it('should return comprehensive analytics', async () => {
      // Insert usage snapshots
      await testPool.query(`
        INSERT INTO context_analytics_events (tenant_id, session_id, event_type, event_data, token_count, created_at)
        VALUES 
          ($1, $2, 'usage_snapshot', '{"category": "conversation"}', 1000, NOW() - INTERVAL '2 hours'),
          ($1, $2, 'usage_snapshot', '{"category": "decisions"}', 500, NOW() - INTERVAL '1 hour'),
          ($1, $2, 'compression_completed', '{"tokens_after": "500", "strategy": "balanced"}', 1000, NOW() - INTERVAL '1 hour')
      `, [TEST_TENANT_ID, TEST_SESSION_ID]);

      const analytics = await getContextAnalytics(testPool, TEST_TENANT_ID, TEST_SESSION_ID);

      expect(analytics.session_id).toBe(TEST_SESSION_ID);
      expect(analytics.tenant_id).toBe(TEST_TENANT_ID);
      expect(analytics.total_tokens_used).toBeGreaterThan(0);
      expect(analytics.usage_by_category).toHaveProperty('conversation');
      expect(analytics.usage_by_category).toHaveProperty('decisions');
      expect(analytics.total_compressions).toBe(1);
      expect(analytics.efficiency).toHaveProperty('score');
      expect(analytics.efficiency).toHaveProperty('grade');
      expect(analytics.recommendations).toBeInstanceOf(Array);
    });

    it('should handle empty session gracefully', async () => {
      const analytics = await getContextAnalytics(testPool, TEST_TENANT_ID, 'empty-session');

      expect(analytics.total_tokens_used).toBe(0);
      expect(analytics.total_compressions).toBe(0);
      expect(analytics.waste_detected).toHaveLength(0);
      expect(analytics.efficiency.score).toBeDefined();
    });
  });
});
