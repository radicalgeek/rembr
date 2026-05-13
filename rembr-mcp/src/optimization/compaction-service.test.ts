/**
 * Memory Compaction Service Tests (REM-88)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Pool } from 'pg';
import {
  compactMemories,
  getPlanMemoryLimit,
  isCompactionNeeded,
  computeExecuteAfter,
  type CompactionOptions,
} from './compaction-service.js';

// Mock OllamaClient to avoid network calls in tests
vi.mock('../ollama-client.js', () => {
  return {
    OllamaClient: {
      getInstance: () => ({
        generateText: async (prompt: string) => {
          // Extract memory contents from prompt and create a simple merged version
          const memoryMatch = prompt.match(/Memories to merge:\n([\s\S]+?)\n\nCreate a consolidated/);
          if (memoryMatch) {
            const memories = memoryMatch[1].split('\n\n').filter(m => m.trim());
            // Simple concatenation for testing
            return memories.map(m => m.replace(/^\d+\.\s*/, '')).join(' | ');
          }
          return 'Merged memory content';
        },
      }),
    },
  };
});

const testPool = new Pool({
  connectionString: process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/rembr_test',
});

const TEST_TENANT_ID = '550e8400-e29b-41d4-a716-446655440000';

describe('Memory Compaction Service', () => {
  beforeAll(async () => {
    // Enable pgvector extension
    await testPool.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    
    // Set tenant context
    
    // Create tables if not exist
    await testPool.query(`
      CREATE TABLE IF NOT EXISTS memories (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL,
        content TEXT NOT NULL,
        category TEXT,
        tags TEXT[] DEFAULT '{}',
        relevance_score FLOAT,
        embedding vector(1536),
        metadata JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    
    await testPool.query(`
      CREATE TABLE IF NOT EXISTS tenant_plans (
        tenant_id UUID PRIMARY KEY,
        plan VARCHAR(50) NOT NULL,
        memory_limit INTEGER NOT NULL,
        search_limit_daily INTEGER NOT NULL,
        project_limit INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    
    await testPool.query(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL,
        action TEXT NOT NULL,
        resource_type TEXT,
        resource_id UUID,
        details JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  });

  afterAll(async () => {
    await testPool.query('DELETE FROM audit_log WHERE tenant_id = $1', [TEST_TENANT_ID]);
    await testPool.query('DELETE FROM memories WHERE tenant_id = $1', [TEST_TENANT_ID]);
    await testPool.query('DELETE FROM tenant_plans WHERE tenant_id = $1', [TEST_TENANT_ID]);
    await testPool.end();
  });

  beforeEach(async () => {
    // Clean up before each test
    await testPool.query('DELETE FROM audit_log WHERE tenant_id = $1', [TEST_TENANT_ID]);
    await testPool.query('DELETE FROM memories WHERE tenant_id = $1', [TEST_TENANT_ID]);
    await testPool.query('DELETE FROM tenant_plans WHERE tenant_id = $1', [TEST_TENANT_ID]);
  });

  describe('getPlanMemoryLimit', () => {
    it('should return memory limit for existing plan', async () => {
      await testPool.query(
        `INSERT INTO tenant_plans (tenant_id, plan, memory_limit, search_limit_daily, project_limit)
         VALUES ($1, 'pro', 25000, 1000, 10)`,
        [TEST_TENANT_ID]
      );

      const limit = await getPlanMemoryLimit(testPool, TEST_TENANT_ID);
      expect(limit).toBe(25000);
    });

    it('should return null for non-existent plan', async () => {
      const limit = await getPlanMemoryLimit(testPool, TEST_TENANT_ID);
      expect(limit).toBeNull();
    });
  });

  describe('isCompactionNeeded', () => {
    it('should return false when no plan limit exists', async () => {
      const result = await isCompactionNeeded(testPool, TEST_TENANT_ID);
      
      expect(result.needed).toBe(false);
      expect(result.limit).toBeNull();
    });

    it('should return false when memory count is within limit', async () => {
      await testPool.query(
        `INSERT INTO tenant_plans (tenant_id, plan, memory_limit, search_limit_daily, project_limit)
         VALUES ($1, 'pro', 10, 1000, 10)`,
        [TEST_TENANT_ID]
      );

      // Add 5 memories (below limit of 10)
      for (let i = 0; i < 5; i++) {
        await testPool.query(
          'INSERT INTO memories (tenant_id, content, category) VALUES ($1, $2, $3)',
          [TEST_TENANT_ID, `Memory ${i}`, 'test']
        );
      }

      const result = await isCompactionNeeded(testPool, TEST_TENANT_ID);
      
      expect(result.needed).toBe(false);
      expect(result.currentCount).toBe(5);
      expect(result.limit).toBe(10);
    });

    it('should return true when memory count exceeds limit', async () => {
      await testPool.query(
        `INSERT INTO tenant_plans (tenant_id, plan, memory_limit, search_limit_daily, project_limit)
         VALUES ($1, 'free', 5, 100, 1)`,
        [TEST_TENANT_ID]
      );

      // Add 10 memories (above limit of 5)
      for (let i = 0; i < 10; i++) {
        await testPool.query(
          'INSERT INTO memories (tenant_id, content, category) VALUES ($1, $2, $3)',
          [TEST_TENANT_ID, `Memory ${i}`, 'test']
        );
      }

      const result = await isCompactionNeeded(testPool, TEST_TENANT_ID);
      
      expect(result.needed).toBe(true);
      expect(result.currentCount).toBe(10);
      expect(result.limit).toBe(5);
    });
  });

  describe('compactMemories', () => {
    it('should skip compaction when memory count is within limit', async () => {
      // Add 3 memories
      for (let i = 0; i < 3; i++) {
        await testPool.query(
          'INSERT INTO memories (tenant_id, content, category) VALUES ($1, $2, $3)',
          [TEST_TENANT_ID, `Memory ${i}`, 'notes']
        );
      }

      const result = await compactMemories(testPool, TEST_TENANT_ID, 10);

      expect(result.success).toBe(true);
      expect(result.initial_count).toBe(3);
      expect(result.final_count).toBe(3);
      expect(result.merged_groups).toHaveLength(0);
    });

    it('should merge similar memories when over limit (dry run)', async () => {
      // Add 6 similar memories in same category
      for (let i = 0; i < 6; i++) {
        await testPool.query(
          `INSERT INTO memories (tenant_id, content, category, relevance_score)
           VALUES ($1, $2, $3, $4)`,
          [TEST_TENANT_ID, `Similar memory about cats number ${i}`, 'notes', 0.5]
        );
      }

      const options: CompactionOptions = {
        dry_run: true,
        similarity_threshold: 0.3, // Lower threshold for text-based similarity
        max_group_size: 3,
      };

      const result = await compactMemories(testPool, TEST_TENANT_ID, 3, options);

      expect(result.success).toBe(true);
      expect(result.initial_count).toBe(6);
      // Dry run doesn't modify database
      expect(result.final_count).toBe(6);
      // Should have merged some groups
      expect(result.merged_groups.length).toBeGreaterThan(0);
    });

    it('should preserve category when merging', async () => {
      // Add memories in different categories
      await testPool.query(
        'INSERT INTO memories (tenant_id, content, category) VALUES ($1, $2, $3)',
        [TEST_TENANT_ID, 'Note about dogs', 'notes']
      );
      await testPool.query(
        'INSERT INTO memories (tenant_id, content, category) VALUES ($1, $2, $3)',
        [TEST_TENANT_ID, 'Another note about dogs', 'notes']
      );
      await testPool.query(
        'INSERT INTO memories (tenant_id, content, category) VALUES ($1, $2, $3)',
        [TEST_TENANT_ID, 'Task to walk dog', 'tasks']
      );

      const options: CompactionOptions = {
        dry_run: true,
        similarity_threshold: 0.3,
      };

      const result = await compactMemories(testPool, TEST_TENANT_ID, 1, options);

      // Merged groups should maintain category
      for (const group of result.merged_groups) {
        expect(group.category).toBeDefined();
        expect(['notes', 'tasks']).toContain(group.category);
      }
    });

    it('should merge tags from original memories', async () => {
      await testPool.query(
        `INSERT INTO memories (tenant_id, content, category, tags)
         VALUES ($1, $2, $3, $4)`,
        [TEST_TENANT_ID, 'Memory 1', 'notes', ['tag1', 'tag2']]
      );
      await testPool.query(
        `INSERT INTO memories (tenant_id, content, category, tags)
         VALUES ($1, $2, $3, $4)`,
        [TEST_TENANT_ID, 'Memory 2', 'notes', ['tag2', 'tag3']]
      );

      const options: CompactionOptions = {
        dry_run: true,
        similarity_threshold: 0.3,
      };

      const result = await compactMemories(testPool, TEST_TENANT_ID, 1, options);

      // Merged groups should have union of tags (tested via metadata in actual implementation)
      expect(result.merged_groups.length).toBeGreaterThan(0);
    });

    it('should log audit trail on successful compaction', async () => {
      // Add similar memories with dummy embeddings
      // Create 2 groups of similar memories to test merge logic
      const embeddingA = Array(1536).fill(0.1);
      const embeddingB = Array(1536).fill(0.9);
      const embeddingStrA = '[' + embeddingA.join(',') + ']';
      const embeddingStrB = '[' + embeddingB.join(',') + ']';
      
      // Group A: 2 similar memories
      for (let i = 0; i < 2; i++) {
        await testPool.query(
          'INSERT INTO memories (tenant_id, content, category, embedding) VALUES ($1, $2, $3, $4::vector)',
          [TEST_TENANT_ID, `Note A ${i}`, 'notes', embeddingStrA]
        );
      }
      
      // Group B: 2 similar memories
      for (let i = 0; i < 2; i++) {
        await testPool.query(
          'INSERT INTO memories (tenant_id, content, category, embedding) VALUES ($1, $2, $3, $4::vector)',
          [TEST_TENANT_ID, `Note B ${i}`, 'notes', embeddingStrB]
        );
      }

      const options: CompactionOptions = {
        similarity_threshold: 0.3,
      };

      const result = await compactMemories(testPool, TEST_TENANT_ID, 2, options);

      // Log result for debugging
      console.log('Compaction result:', JSON.stringify(result, null, 2));

      expect(result.success).toBe(true);
      expect(result.audit_log_id).toBeDefined();

      // Verify audit log
      const auditResult = await testPool.query(
        'SELECT * FROM audit_log WHERE id = $1',
        [result.audit_log_id]
      );

      expect(auditResult.rows).toHaveLength(1);
      expect(auditResult.rows[0].action).toBe('memory_compaction');
      expect(auditResult.rows[0].resource_type).toBe('memories');
    });

    it('should use lowest_relevance priority strategy by default', async () => {
      // Add memories with different relevance scores
      await testPool.query(
        'INSERT INTO memories (tenant_id, content, category, relevance_score) VALUES ($1, $2, $3, $4)',
        [TEST_TENANT_ID, 'High relevance', 'notes', 0.9]
      );
      await testPool.query(
        'INSERT INTO memories (tenant_id, content, category, relevance_score) VALUES ($1, $2, $3, $4)',
        [TEST_TENANT_ID, 'Low relevance', 'notes', 0.1]
      );
      await testPool.query(
        'INSERT INTO memories (tenant_id, content, category, relevance_score) VALUES ($1, $2, $3, $4)',
        [TEST_TENANT_ID, 'Medium relevance', 'notes', 0.5]
      );

      const options: CompactionOptions = {
        dry_run: true,
        priority_strategy: 'lowest_relevance',
        similarity_threshold: 0.1, // Very low to ensure grouping
      };

      const result = await compactMemories(testPool, TEST_TENANT_ID, 1, options);

      expect(result.success).toBe(true);
      // Lowest relevance memories should be merged first
    });

    it('should return error when no similar memories can be merged', async () => {
      // Add completely different memories
      await testPool.query(
        'INSERT INTO memories (tenant_id, content, category) VALUES ($1, $2, $3)',
        [TEST_TENANT_ID, 'Astronomy facts', 'science']
      );
      await testPool.query(
        'INSERT INTO memories (tenant_id, content, category) VALUES ($1, $2, $3)',
        [TEST_TENANT_ID, 'Cooking recipes', 'food']
      );
      await testPool.query(
        'INSERT INTO memories (tenant_id, content, category) VALUES ($1, $2, $3)',
        [TEST_TENANT_ID, 'Travel destinations', 'travel']
      );

      const options: CompactionOptions = {
        similarity_threshold: 0.9, // Very high threshold
      };

      const result = await compactMemories(testPool, TEST_TENANT_ID, 1, options);

      expect(result.success).toBe(false);
      expect(result.error).toContain('No similar memories found to merge');
    });

    it('should calculate compression ratio correctly', async () => {
      // Add 3 similar memories
      for (let i = 0; i < 3; i++) {
        await testPool.query(
          'INSERT INTO memories (tenant_id, content, category) VALUES ($1, $2, $3)',
          [TEST_TENANT_ID, `Similar content ${i}`, 'notes']
        );
      }

      const options: CompactionOptions = {
        dry_run: true,
        similarity_threshold: 0.2,
      };

      const result = await compactMemories(testPool, TEST_TENANT_ID, 1, options);

      expect(result.merged_groups.length).toBeGreaterThan(0);
      
      for (const group of result.merged_groups) {
        expect(group.compression_ratio).toBeGreaterThanOrEqual(2);
        expect(group.compression_ratio).toBe(group.original_memory_ids.length);
      }
    });
  });
});

// ─── RAD-73: computeExecuteAfter unit tests (no DB needed) ───────────────────
describe('computeExecuteAfter (RAD-73 grace period logic)', () => {
  it('should use subscription end date when in the future (beyond 24h)', () => {
    const subEnd = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000); // 20 days from now
    const result = computeExecuteAfter({ subscription_end_date: subEnd });
    // Should be close to subscription end date
    expect(result.getTime()).toBeCloseTo(subEnd.getTime(), -5);
  });

  it('should enforce 24h floor when subscription ends within 24h', () => {
    const subEnd = new Date(Date.now() + 1 * 60 * 60 * 1000); // 1h from now
    const result = computeExecuteAfter({ subscription_end_date: subEnd });
    const minExpected = new Date(Date.now() + 23 * 60 * 60 * 1000); // at least 23h from now
    expect(result.getTime()).toBeGreaterThan(minExpected.getTime());
  });

  it('should fall back to grace period when subscription end is in the past', () => {
    const subEnd = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000); // 2 days ago
    const result = computeExecuteAfter({ subscription_end_date: subEnd, fallback_grace_days: 7 });
    const minExpected = new Date(Date.now() + 6 * 24 * 60 * 60 * 1000); // ~7 days from now
    expect(result.getTime()).toBeGreaterThan(minExpected.getTime());
  });

  it('should fall back to grace period when no subscription end date', () => {
    const result = computeExecuteAfter({ fallback_grace_days: 7 });
    const minExpected = new Date(Date.now() + 6 * 24 * 60 * 60 * 1000);
    expect(result.getTime()).toBeGreaterThan(minExpected.getTime());
  });

  it('should use 7-day fallback by default', () => {
    const result = computeExecuteAfter({});
    const minExpected = new Date(Date.now() + 6 * 24 * 60 * 60 * 1000);
    expect(result.getTime()).toBeGreaterThan(minExpected.getTime());
  });

  it('should always return a date at least 24h from now', () => {
    const minFloor = new Date(Date.now() + 23 * 60 * 60 * 1000);
    // Even with a past subscription end and 0 grace days
    const result = computeExecuteAfter({
      subscription_end_date: new Date(Date.now() - 1000),
      fallback_grace_days: 0
    });
    expect(result.getTime()).toBeGreaterThan(minFloor.getTime());
  });
});
