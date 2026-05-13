/**
 * Checkpoint Service Tests (REM-98)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import {
  createCheckpoint,
  getLatestCheckpoint,
  getCheckpointHistory,
  getCheckpoint,
  shouldTriggerCheckpoint,
  formatLifeboatAsMarkdown,
  type CheckpointRequest,
  type CheckpointDecision,
  type CheckpointPendingItem,
} from './checkpoint-service.js';

const testPool = new Pool({
  connectionString: process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/rembr_test',
});

const TEST_TENANT_ID = '550e8400-e29b-41d4-a716-446655440000';
const TEST_SESSION_ID = 'test-session-123';

describe('Checkpoint Service', () => {
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
      CREATE TABLE IF NOT EXISTS context_checkpoints (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL,
        session_id TEXT NOT NULL,
        checkpoint_type TEXT NOT NULL DEFAULT 'compression',
        token_count_before INTEGER NOT NULL,
        token_count_after INTEGER,
        decisions_snapshot JSONB DEFAULT '[]'::jsonb,
        pending_snapshot JSONB DEFAULT '[]'::jsonb,
        lifeboat_snapshot JSONB DEFAULT '[]'::jsonb,
        linked_memory_ids UUID[] DEFAULT ARRAY[]::UUID[],
        compression_strategy TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        metadata JSONB DEFAULT '{}'::jsonb
      )
    `);
    
    // Create test session
    await testPool.query(`
      INSERT INTO context_sessions (tenant_id, session_id, agent_name, max_tokens)
      VALUES ($1, $2, 'test-agent', 100000)
      ON CONFLICT (tenant_id, session_id) DO NOTHING
    `, [TEST_TENANT_ID, TEST_SESSION_ID]);
  });

  afterAll(async () => {
    await testPool.query('DELETE FROM context_checkpoints WHERE tenant_id = $1', [TEST_TENANT_ID]);
    await testPool.query('DELETE FROM context_sessions WHERE tenant_id = $1', [TEST_TENANT_ID]);
    await testPool.end();
  });

  beforeEach(async () => {
    // Clean up checkpoints before each test
    await testPool.query('DELETE FROM context_checkpoints WHERE tenant_id = $1', [TEST_TENANT_ID]);
  });

  describe('createCheckpoint', () => {
    it('should create a checkpoint with decisions and pending items', async () => {
      const decisions: CheckpointDecision[] = [
        {
          timestamp: new Date(),
          decision: 'Use Google Drive for shared storage',
          rationale: 'Zero setup, mature API',
          impact: 'Unblocks Strix file automation',
        },
        {
          timestamp: new Date(),
          decision: 'Implement ContextPilot checkpoints',
          rationale: '3.2x cost reduction vs re-deriving',
        },
      ];
      
      const pending: CheckpointPendingItem[] = [
        {
          type: 'task',
          description: 'Complete REM-98 implementation',
          priority: 'critical',
        },
        {
          type: 'file',
          description: 'Update checkpoint-service.ts',
          priority: 'high',
        },
      ];
      
      const request: CheckpointRequest = {
        session_id: TEST_SESSION_ID,
        checkpoint_type: 'manual',
        token_count_before: 70000,
        current_task: 'REM-98 Pre-Compression Checkpoints',
        objective: 'Implement ContextPilot checkpoint system',
        decisions,
        pending_items: pending,
        file_paths: ['/workspace/rembr/src/checkpoint-service.ts'],
        success_signal: 'Tests pass, MR raised, moved to review',
      };
      
      const checkpoint = await createCheckpoint(testPool, TEST_TENANT_ID, request);
      
      expect(checkpoint.id).toBeDefined();
      expect(checkpoint.session_id).toBe(TEST_SESSION_ID);
      expect(checkpoint.checkpoint_type).toBe('manual');
      expect(checkpoint.token_count_before).toBe(70000);
      expect(checkpoint.decisions_snapshot).toHaveLength(2);
      expect(checkpoint.pending_snapshot).toHaveLength(2);
      expect(checkpoint.lifeboat_snapshot.objective).toBe('Implement ContextPilot checkpoint system');
      expect(checkpoint.lifeboat_snapshot.current_task).toBe('REM-98 Pre-Compression Checkpoints');
      expect(checkpoint.lifeboat_snapshot.key_decisions).toHaveLength(2);
      expect(checkpoint.lifeboat_snapshot.pending_critical).toHaveLength(2);
      expect(checkpoint.lifeboat_snapshot.file_paths).toContain('/workspace/rembr/src/checkpoint-service.ts');
      expect(checkpoint.lifeboat_snapshot.success_signal).toBe('Tests pass, MR raised, moved to review');
    });

    it('should create compression-type checkpoint', async () => {
      const request: CheckpointRequest = {
        session_id: TEST_SESSION_ID,
        checkpoint_type: 'compression',
        token_count_before: 85000,
        objective: 'Context compression triggered at 85% threshold',
        decisions: [
          { timestamp: new Date(), decision: 'Keep critical task state' },
        ],
        pending_items: [],
        compression_strategy: 'aggressive',
      };
      
      const checkpoint = await createCheckpoint(testPool, TEST_TENANT_ID, request);
      
      expect(checkpoint.checkpoint_type).toBe('compression');
      expect(checkpoint.compression_strategy).toBe('aggressive');
      expect(checkpoint.token_count_before).toBe(85000);
    });

    it('should limit lifeboat to top 5 decisions and pending items', async () => {
      const decisions: CheckpointDecision[] = Array.from({ length: 10 }, (_, i) => ({
        timestamp: new Date(Date.now() - i * 1000),
        decision: `Decision ${i + 1}`,
      }));
      
      const pending: CheckpointPendingItem[] = Array.from({ length: 10 }, (_, i) => ({
        type: 'task' as const,
        description: `Task ${i + 1}`,
        priority: i < 7 ? 'critical' as const : 'low' as const,
      }));
      
      const request: CheckpointRequest = {
        session_id: TEST_SESSION_ID,
        token_count_before: 70000,
        decisions,
        pending_items: pending,
      };
      
      const checkpoint = await createCheckpoint(testPool, TEST_TENANT_ID, request);
      
      // Lifeboat should limit to top 5
      expect(checkpoint.lifeboat_snapshot.key_decisions).toHaveLength(5);
      expect(checkpoint.lifeboat_snapshot.pending_critical).toHaveLength(5);
      
      // Full snapshots should have all
      expect(checkpoint.decisions_snapshot).toHaveLength(10);
      expect(checkpoint.pending_snapshot).toHaveLength(10);
    });

    it('should throw error if lifeboat exceeds 4000 chars', async () => {
      // Lifeboat takes top 5 decisions, so make each decision 1000 chars
      const longDecisions: CheckpointDecision[] = Array.from({ length: 10 }, (_, i) => ({
        timestamp: new Date(Date.now() - i * 1000),
        decision: 'A'.repeat(2000), // 2000 chars * 5 decisions = 10k+ > 4k limit
      }));
      
      const request: CheckpointRequest = {
        session_id: TEST_SESSION_ID,
        token_count_before: 70000,
        objective: 'Test lifeboat size limit',
        decisions: longDecisions,
        pending_items: [],
      };
      
      await expect(createCheckpoint(testPool, TEST_TENANT_ID, request)).rejects.toThrow('Lifeboat too large');
    });
  });

  describe('getLatestCheckpoint', () => {
    it('should return latest checkpoint for session', async () => {
      // Create two checkpoints
      const request1: CheckpointRequest = {
        session_id: TEST_SESSION_ID,
        token_count_before: 60000,
        decisions: [{ timestamp: new Date(), decision: 'First checkpoint' }],
        pending_items: [],
      };
      
      const request2: CheckpointRequest = {
        session_id: TEST_SESSION_ID,
        token_count_before: 70000,
        decisions: [{ timestamp: new Date(), decision: 'Second checkpoint' }],
        pending_items: [],
      };
      
      await createCheckpoint(testPool, TEST_TENANT_ID, request1);
      await new Promise(resolve => setTimeout(resolve, 10)); // Ensure different timestamps
      const checkpoint2 = await createCheckpoint(testPool, TEST_TENANT_ID, request2);
      
      const latest = await getLatestCheckpoint(testPool, TEST_TENANT_ID, TEST_SESSION_ID);
      
      expect(latest).toBeDefined();
      expect(latest!.id).toBe(checkpoint2.id);
      expect(latest!.token_count_before).toBe(70000);
    });

    it('should return null if no checkpoints exist', async () => {
      const latest = await getLatestCheckpoint(testPool, TEST_TENANT_ID, 'non-existent-session');
      expect(latest).toBeNull();
    });
  });

  describe('getCheckpointHistory', () => {
    it('should return checkpoint history with counts', async () => {
      // Create 3 checkpoints (2 compression, 1 manual)
      await createCheckpoint(testPool, TEST_TENANT_ID, {
        session_id: TEST_SESSION_ID,
        checkpoint_type: 'compression',
        token_count_before: 80000,
        decisions: [],
        pending_items: [],
      });
      
      await createCheckpoint(testPool, TEST_TENANT_ID, {
        session_id: TEST_SESSION_ID,
        checkpoint_type: 'manual',
        token_count_before: 70000,
        decisions: [],
        pending_items: [],
      });
      
      await createCheckpoint(testPool, TEST_TENANT_ID, {
        session_id: TEST_SESSION_ID,
        checkpoint_type: 'compression',
        token_count_before: 90000,
        decisions: [],
        pending_items: [],
      });
      
      const history = await getCheckpointHistory(testPool, TEST_TENANT_ID, TEST_SESSION_ID);
      
      expect(history.total_count).toBe(3);
      expect(history.compression_count).toBe(2);
      expect(history.manual_count).toBe(1);
      expect(history.checkpoints).toHaveLength(3);
      expect(history.latest_checkpoint).toBeDefined();
      expect(history.latest_checkpoint!.token_count_before).toBe(90000);
    });

    it('should respect limit parameter', async () => {
      // Create 5 checkpoints
      for (let i = 0; i < 5; i++) {
        await createCheckpoint(testPool, TEST_TENANT_ID, {
          session_id: TEST_SESSION_ID,
          token_count_before: 60000 + i * 1000,
          decisions: [],
          pending_items: [],
        });
      }
      
      const history = await getCheckpointHistory(testPool, TEST_TENANT_ID, TEST_SESSION_ID, 3);
      
      expect(history.checkpoints).toHaveLength(3);
    });
  });

  describe('getCheckpoint', () => {
    it('should retrieve checkpoint by ID', async () => {
      const checkpoint = await createCheckpoint(testPool, TEST_TENANT_ID, {
        session_id: TEST_SESSION_ID,
        token_count_before: 70000,
        objective: 'Test checkpoint retrieval',
        decisions: [],
        pending_items: [],
      });
      
      const retrieved = await getCheckpoint(testPool, TEST_TENANT_ID, checkpoint.id);
      
      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe(checkpoint.id);
      expect(retrieved!.lifeboat_snapshot.objective).toBe('Test checkpoint retrieval');
    });

    it('should return null for non-existent checkpoint', async () => {
      const retrieved = await getCheckpoint(testPool, TEST_TENANT_ID, '00000000-0000-0000-0000-000000000000');
      expect(retrieved).toBeNull();
    });
  });

  describe('shouldTriggerCheckpoint', () => {
    it('should return true when usage exceeds threshold', () => {
      expect(shouldTriggerCheckpoint(70000, 100000, 0.70)).toBe(true);
      expect(shouldTriggerCheckpoint(71000, 100000, 0.70)).toBe(true);
      expect(shouldTriggerCheckpoint(85000, 100000, 0.70)).toBe(true);
    });

    it('should return false when usage below threshold', () => {
      expect(shouldTriggerCheckpoint(69000, 100000, 0.70)).toBe(false);
      expect(shouldTriggerCheckpoint(50000, 100000, 0.70)).toBe(false);
    });

    it('should use custom threshold', () => {
      expect(shouldTriggerCheckpoint(80000, 100000, 0.80)).toBe(true);
      expect(shouldTriggerCheckpoint(79000, 100000, 0.80)).toBe(false);
    });
  });

  describe('formatLifeboatAsMarkdown', () => {
    it('should format lifeboat as NOW.md-style markdown', () => {
      const lifeboat = {
        objective: 'Complete ContextPilot implementation',
        current_task: 'REM-98 Checkpoints',
        key_decisions: [
          'Use NOW.md-style lifeboat format',
          'Limit to <1k tokens',
        ],
        pending_critical: [
          'task: Write comprehensive tests',
          'file: Update MCP tool schema',
        ],
        file_paths: [
          '/workspace/checkpoint-service.ts',
          '/workspace/checkpoint-service.test.ts',
        ],
        success_signal: 'All tests pass, MR approved',
        timestamp: new Date('2026-02-26T04:00:00Z'),
      };
      
      const markdown = formatLifeboatAsMarkdown(lifeboat);
      
      expect(markdown).toContain('# Context Checkpoint — 2026-02-26');
      expect(markdown).toContain('## Objective');
      expect(markdown).toContain('Complete ContextPilot implementation');
      expect(markdown).toContain('## Current Task');
      expect(markdown).toContain('REM-98 Checkpoints');
      expect(markdown).toContain('## Key Decisions');
      expect(markdown).toContain('1. Use NOW.md-style lifeboat format');
      expect(markdown).toContain('2. Limit to <1k tokens');
      expect(markdown).toContain('## Pending Critical');
      expect(markdown).toContain('1. task: Write comprehensive tests');
      expect(markdown).toContain('## Key Files');
      expect(markdown).toContain('`/workspace/checkpoint-service.ts`');
      expect(markdown).toContain('## Success Signal');
      expect(markdown).toContain('All tests pass, MR approved');
    });
  });
});
