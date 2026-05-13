/**
 * Token Budget Utilities Tests (REM-103)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { estimateTokens, estimateMemoryTokens, truncateToTokenBudget, getBudgetLimit } from './token-budget.js';
import { Pool } from 'pg';

describe('Token Budget Utilities', () => {
  describe('estimateTokens', () => {
    it('should estimate tokens for empty string as 0', () => {
      expect(estimateTokens('')).toBe(0);
    });

    it('should estimate tokens using character count / 4', () => {
      expect(estimateTokens('test')).toBe(1); // 4 chars / 4 = 1
      expect(estimateTokens('hello world')).toBe(3); // 11 chars / 4 = 2.75 -> ceil = 3
      expect(estimateTokens('a'.repeat(100))).toBe(25); // 100 / 4 = 25
    });
  });

  describe('estimateMemoryTokens', () => {
    it('should count content tokens', () => {
      const memory = { content: 'test content' };
      expect(estimateMemoryTokens(memory)).toBe(3); // 12 chars / 4 = 3
    });

    it('should count content + tags', () => {
      const memory = {
        content: 'test',
        tags: ['tag1', 'tag2']
      };
      // content: 4/4=1, tags: "tag1, tag2" = 11/4=3, total=4
      expect(estimateMemoryTokens(memory)).toBe(4);
    });

    it('should count content + metadata', () => {
      const memory = {
        content: 'test',
        metadata: { key: 'value' }
      };
      // content: 4/4=1, metadata: '{"key":"value"}' = 15/4=4, total=5
      expect(estimateMemoryTokens(memory)).toBe(5);
    });

    it('should count content + tags + metadata', () => {
      const memory = {
        content: 'a'.repeat(40), // 40/4 = 10
        tags: ['tag'],          // 3/4 = 1
        metadata: { k: 'v' }   // '{"k":"v"}' = 9/4 = 3
      };
      expect(estimateMemoryTokens(memory)).toBe(14);
    });
  });

  describe('truncateToTokenBudget', () => {
    const sampleMemories = [
      { id: '1', content: 'a'.repeat(40) },  // 10 tokens
      { id: '2', content: 'b'.repeat(80) },  // 20 tokens
      { id: '3', content: 'c'.repeat(120) }, // 30 tokens
      { id: '4', content: 'd'.repeat(40) },  // 10 tokens
    ];

    it('should include all results if budget allows', () => {
      const result = truncateToTokenBudget(sampleMemories, 100);
      expect(result.results.length).toBe(4);
      expect(result.total_tokens).toBe(70); // 10+20+30+10
      expect(result.truncated).toBe(false);
      expect(result.original_count).toBe(4);
    });

    it('should truncate results to fit budget', () => {
      const result = truncateToTokenBudget(sampleMemories, 35);
      expect(result.results.length).toBe(2); // First two fit (10+20=30)
      expect(result.total_tokens).toBe(30);
      expect(result.truncated).toBe(true);
      expect(result.original_count).toBe(4);
    });

    it('should annotate each result with token count', () => {
      const result = truncateToTokenBudget(sampleMemories, 100);
      expect(result.results[0]._token_count).toBe(10);
      expect(result.results[1]._token_count).toBe(20);
      expect(result.results[2]._token_count).toBe(30);
      expect(result.results[3]._token_count).toBe(10);
    });

    it('should warn if no results fit', () => {
      const result = truncateToTokenBudget(sampleMemories, 5);
      expect(result.results.length).toBe(0);
      expect(result.total_tokens).toBe(0);
      expect(result.warning).toContain('No results fit within 5 token budget');
      expect(result.warning).toContain('~10 tokens');
    });

    it('should handle empty results array', () => {
      const result = truncateToTokenBudget([], 100);
      expect(result.results.length).toBe(0);
      expect(result.total_tokens).toBe(0);
      expect(result.truncated).toBe(false);
      expect(result.warning).toBeUndefined();
    });
  });

  describe('getBudgetLimit', () => {
    let pool: Pool;
    let testTenantId: string;
    let otherTenantId: string;

    beforeAll(async () => {
      // Use test database
      pool = new Pool({
        connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/rembr_test'
      });
      testTenantId = '550e8400-e29b-41d4-a716-446655440000'; // Valid UUID format
      otherTenantId = '660e8400-e29b-41d4-a716-446655440001'; // Different UUID for negative tests

      // Create context_budgets table if it doesn't exist (from migration 010)
      await pool.query(`
        CREATE TABLE IF NOT EXISTS context_budgets (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL,
          budget_name TEXT NOT NULL,
          total_tokens INTEGER NOT NULL,
          allocations JSONB NOT NULL DEFAULT '{}'::jsonb,
          thresholds JSONB DEFAULT '{}'::jsonb,
          compression_trigger_percent INTEGER DEFAULT 80,
          is_active BOOLEAN NOT NULL DEFAULT TRUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          metadata JSONB DEFAULT '{}'::jsonb,
          CONSTRAINT context_budgets_unique UNIQUE (tenant_id, budget_name)
        );
      `);

      // Create a test budget
      await pool.query(`
        INSERT INTO context_budgets (tenant_id, budget_name, total_tokens, allocations, is_active)
        VALUES ($1, 'test-budget', 10000, $2, TRUE)
        ON CONFLICT (tenant_id, budget_name) DO NOTHING
      `, [testTenantId, JSON.stringify({ search: 5000, conversation: 4000, decisions: 1000 })]);
    });

    afterAll(async () => {
      // Clean up test data
      if (pool) {
        await pool.query('DELETE FROM context_budgets WHERE tenant_id = $1', [testTenantId]);
        await pool.end();
      }
    });

    it('should return budget limit for valid category', async () => {
      const limit = await getBudgetLimit(pool, testTenantId, 'search');
      expect(limit).toBe(5000);
    });

    it('should return null for non-existent category', async () => {
      const limit = await getBudgetLimit(pool, testTenantId, 'nonexistent');
      expect(limit).toBeNull();
    });

    it('should return null for inactive budget', async () => {
      // Create inactive budget
      await pool.query(`
        INSERT INTO context_budgets (tenant_id, budget_name, total_tokens, allocations, is_active)
        VALUES ($1, 'inactive-budget', 10000, $2, FALSE)
      `, [testTenantId, JSON.stringify({ test: 1000 })]);

      const limit = await getBudgetLimit(pool, testTenantId, 'test');
      expect(limit).toBeNull();
    });

    it('should return null for different tenant', async () => {
      const limit = await getBudgetLimit(pool, otherTenantId, 'search');
      expect(limit).toBeNull();
    });
  });
});
