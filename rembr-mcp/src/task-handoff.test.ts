/**
 * Task Handoff Service Tests (REM-73)
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { Pool } from 'pg';
import {
  createHandoff,
  acceptHandoff,
  rejectHandoff,
  listPendingHandoffs,
  getHandoff,
  getTaskHandoffHistory,
} from './task-handoff.js';
import { createTestPool, ensureTenantsTable, applyMigrations } from './test-utils/test-db.js';

beforeAll(async () => {
  const bootstrapPool = createTestPool('it_task_handoff');
  await ensureTenantsTable(bootstrapPool);
  await applyMigrations(bootstrapPool, '012-task-handoff-schema.sql');
  await bootstrapPool.end();
});

const TEST_TENANT_ID = '550e8400-e29b-41d4-a716-446655440000';
const TEST_TASK_ID = 'task-123';
const AGENT_ALICE = 'alice';
const AGENT_BOB = 'bob';

let testPool: Pool;

beforeEach(async () => {
  testPool = createTestPool('it_task_handoff');

  // Set tenant context
  await testPool.query(`SET app.current_tenant_id = '${TEST_TENANT_ID}'`);

  // Create test tenant
  await testPool.query(`
    INSERT INTO tenants (id, name, email)
    VALUES ($1, 'Test Tenant', 'test@example.com')
    ON CONFLICT (id) DO NOTHING
  `, [TEST_TENANT_ID]);
});

afterEach(async () => {
  // Cleanup test data
  await testPool.query('DELETE FROM task_handoffs WHERE tenant_id = $1', [TEST_TENANT_ID]);
  await testPool.query('DELETE FROM tenants WHERE id = $1', [TEST_TENANT_ID]);
  await testPool.end();
});

describe('Task Handoff Service (REM-73)', () => {
  describe('createHandoff', () => {
    it('should create a pending handoff', async () => {
      const handoff = await createHandoff(
        testPool,
        TEST_TENANT_ID,
        TEST_TASK_ID,
        AGENT_ALICE,
        AGENT_BOB,
        'Bob has better skills for this task',
        {
          current_state: 'Initial analysis complete',
          progress: '20% done',
          notes: 'Need database expertise',
        }
      );

      expect(handoff.id).toBeDefined();
      expect(handoff.tenant_id).toBe(TEST_TENANT_ID);
      expect(handoff.task_id).toBe(TEST_TASK_ID);
      expect(handoff.from_agent).toBe(AGENT_ALICE);
      expect(handoff.to_agent).toBe(AGENT_BOB);
      expect(handoff.status).toBe('pending');
      expect(handoff.context.current_state).toBe('Initial analysis complete');
      expect(handoff.context.notes).toBe('Need database expertise');
    });

    it('should create handoff with minimal context', async () => {
      const handoff = await createHandoff(
        testPool,
        TEST_TENANT_ID,
        TEST_TASK_ID,
        AGENT_ALICE,
        AGENT_BOB,
        'Alice is overloaded'
      );

      expect(handoff.status).toBe('pending');
      expect(handoff.context).toEqual({});
    });

    it('should set created_at timestamp', async () => {
      const handoff = await createHandoff(
        testPool,
        TEST_TENANT_ID,
        TEST_TASK_ID,
        AGENT_ALICE,
        AGENT_BOB,
        'Handoff for testing'
      );

      expect(handoff.created_at).toBeDefined();
      expect(handoff.created_at).toBeInstanceOf(Date);
    });
  });

  describe('acceptHandoff', () => {
    it('should accept a pending handoff', async () => {
      const handoff = await createHandoff(
        testPool,
        TEST_TENANT_ID,
        TEST_TASK_ID,
        AGENT_ALICE,
        AGENT_BOB,
        'Test handoff'
      );

      const accepted = await acceptHandoff(testPool, TEST_TENANT_ID, handoff.id, AGENT_BOB);

      expect(accepted.status).toBe('accepted');
      expect(accepted.accepted_at).toBeDefined();
      expect(accepted.accepted_at).toBeInstanceOf(Date);
    });

    it('should throw error if handoff not for agent', async () => {
      const handoff = await createHandoff(
        testPool,
        TEST_TENANT_ID,
        TEST_TASK_ID,
        AGENT_ALICE,
        AGENT_BOB,
        'Test handoff'
      );

      await expect(
        acceptHandoff(testPool, TEST_TENANT_ID, handoff.id, 'charlie')
      ).rejects.toThrow('Handoff not found, not for this agent, or already processed');
    });

    it('should throw error if handoff already accepted', async () => {
      const handoff = await createHandoff(
        testPool,
        TEST_TENANT_ID,
        TEST_TASK_ID,
        AGENT_ALICE,
        AGENT_BOB,
        'Test handoff'
      );

      await acceptHandoff(testPool, TEST_TENANT_ID, handoff.id, AGENT_BOB);

      await expect(
        acceptHandoff(testPool, TEST_TENANT_ID, handoff.id, AGENT_BOB)
      ).rejects.toThrow('Handoff not found, not for this agent, or already processed');
    });
  });

  describe('rejectHandoff', () => {
    it('should reject a pending handoff with reason', async () => {
      const handoff = await createHandoff(
        testPool,
        TEST_TENANT_ID,
        TEST_TASK_ID,
        AGENT_ALICE,
        AGENT_BOB,
        'Test handoff'
      );

      const rejected = await rejectHandoff(
        testPool,
        TEST_TENANT_ID,
        handoff.id,
        AGENT_BOB,
        'I am at capacity'
      );

      expect(rejected.status).toBe('rejected');
      expect(rejected.rejected_at).toBeDefined();
      expect(rejected.rejected_at).toBeInstanceOf(Date);
      expect(rejected.rejection_reason).toBe('I am at capacity');
    });

    it('should throw error if handoff not for agent', async () => {
      const handoff = await createHandoff(
        testPool,
        TEST_TENANT_ID,
        TEST_TASK_ID,
        AGENT_ALICE,
        AGENT_BOB,
        'Test handoff'
      );

      await expect(
        rejectHandoff(testPool, TEST_TENANT_ID, handoff.id, 'charlie', 'Not for me')
      ).rejects.toThrow('Handoff not found, not for this agent, or already processed');
    });

    it('should throw error if handoff already rejected', async () => {
      const handoff = await createHandoff(
        testPool,
        TEST_TENANT_ID,
        TEST_TASK_ID,
        AGENT_ALICE,
        AGENT_BOB,
        'Test handoff'
      );

      await rejectHandoff(testPool, TEST_TENANT_ID, handoff.id, AGENT_BOB, 'First rejection');

      await expect(
        rejectHandoff(testPool, TEST_TENANT_ID, handoff.id, AGENT_BOB, 'Second rejection')
      ).rejects.toThrow('Handoff not found, not for this agent, or already processed');
    });
  });

  describe('listPendingHandoffs', () => {
    it('should list pending handoffs to agent (default)', async () => {
      await createHandoff(testPool, TEST_TENANT_ID, TEST_TASK_ID, AGENT_ALICE, AGENT_BOB, 'Handoff 1');
      await createHandoff(testPool, TEST_TENANT_ID, 'task-456', AGENT_ALICE, AGENT_BOB, 'Handoff 2');
      await createHandoff(testPool, TEST_TENANT_ID, 'task-789', AGENT_BOB, AGENT_ALICE, 'Handoff 3');

      const pendingForBob = await listPendingHandoffs(testPool, TEST_TENANT_ID, AGENT_BOB);

      expect(pendingForBob).toHaveLength(2);
      expect(pendingForBob.every(h => h.to_agent === AGENT_BOB)).toBe(true);
      expect(pendingForBob.every(h => h.status === 'pending')).toBe(true);
    });

    it('should list pending handoffs from agent', async () => {
      await createHandoff(testPool, TEST_TENANT_ID, TEST_TASK_ID, AGENT_ALICE, AGENT_BOB, 'Handoff 1');
      await createHandoff(testPool, TEST_TENANT_ID, 'task-456', AGENT_ALICE, AGENT_BOB, 'Handoff 2');
      await createHandoff(testPool, TEST_TENANT_ID, 'task-789', AGENT_BOB, AGENT_ALICE, 'Handoff 3');

      const pendingFromAlice = await listPendingHandoffs(
        testPool,
        TEST_TENANT_ID,
        AGENT_ALICE,
        { includeFrom: true, includeTo: false }
      );

      expect(pendingFromAlice).toHaveLength(2);
      expect(pendingFromAlice.every(h => h.from_agent === AGENT_ALICE)).toBe(true);
    });

    it('should list pending handoffs to or from agent', async () => {
      await createHandoff(testPool, TEST_TENANT_ID, TEST_TASK_ID, AGENT_ALICE, AGENT_BOB, 'Handoff 1');
      await createHandoff(testPool, TEST_TENANT_ID, 'task-456', AGENT_BOB, AGENT_ALICE, 'Handoff 2');
      await createHandoff(testPool, TEST_TENANT_ID, 'task-789', 'charlie', 'dave', 'Handoff 3');

      const pendingForAlice = await listPendingHandoffs(
        testPool,
        TEST_TENANT_ID,
        AGENT_ALICE,
        { includeFrom: true, includeTo: true }
      );

      expect(pendingForAlice).toHaveLength(2);
      expect(
        pendingForAlice.every(h => h.from_agent === AGENT_ALICE || h.to_agent === AGENT_ALICE)
      ).toBe(true);
    });

    it('should not include accepted or rejected handoffs', async () => {
      const handoff1 = await createHandoff(testPool, TEST_TENANT_ID, TEST_TASK_ID, AGENT_ALICE, AGENT_BOB, 'Handoff 1');
      const handoff2 = await createHandoff(testPool, TEST_TENANT_ID, 'task-456', AGENT_ALICE, AGENT_BOB, 'Handoff 2');
      await createHandoff(testPool, TEST_TENANT_ID, 'task-789', AGENT_ALICE, AGENT_BOB, 'Handoff 3');

      await acceptHandoff(testPool, TEST_TENANT_ID, handoff1.id, AGENT_BOB);
      await rejectHandoff(testPool, TEST_TENANT_ID, handoff2.id, AGENT_BOB, 'Rejected');

      const pendingForBob = await listPendingHandoffs(testPool, TEST_TENANT_ID, AGENT_BOB);

      expect(pendingForBob).toHaveLength(1);
      expect(pendingForBob[0].task_id).toBe('task-789');
    });

    it('should return empty array if no pending handoffs', async () => {
      const pendingForBob = await listPendingHandoffs(testPool, TEST_TENANT_ID, AGENT_BOB);

      expect(pendingForBob).toEqual([]);
    });
  });

  describe('getHandoff', () => {
    it('should get handoff by ID', async () => {
      const handoff = await createHandoff(
        testPool,
        TEST_TENANT_ID,
        TEST_TASK_ID,
        AGENT_ALICE,
        AGENT_BOB,
        'Test handoff'
      );

      const retrieved = await getHandoff(testPool, TEST_TENANT_ID, handoff.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(handoff.id);
      expect(retrieved!.task_id).toBe(TEST_TASK_ID);
    });

    it('should return null if handoff not found', async () => {
      const retrieved = await getHandoff(testPool, TEST_TENANT_ID, '00000000-0000-0000-0000-000000000000');

      expect(retrieved).toBeNull();
    });
  });

  describe('getTaskHandoffHistory', () => {
    it('should get handoff history for task ordered by created_at DESC', async () => {
      await createHandoff(testPool, TEST_TENANT_ID, TEST_TASK_ID, AGENT_ALICE, AGENT_BOB, 'First handoff');
      await new Promise(resolve => setTimeout(resolve, 10));
      await createHandoff(testPool, TEST_TENANT_ID, TEST_TASK_ID, AGENT_BOB, 'charlie', 'Second handoff');
      await new Promise(resolve => setTimeout(resolve, 10));
      await createHandoff(testPool, TEST_TENANT_ID, TEST_TASK_ID, 'charlie', 'dave', 'Third handoff');

      const history = await getTaskHandoffHistory(testPool, TEST_TENANT_ID, TEST_TASK_ID);

      expect(history).toHaveLength(3);
      expect(history[0].reason).toBe('Third handoff');
      expect(history[1].reason).toBe('Second handoff');
      expect(history[2].reason).toBe('First handoff');
    });

    it('should limit results based on limit parameter', async () => {
      await createHandoff(testPool, TEST_TENANT_ID, TEST_TASK_ID, AGENT_ALICE, AGENT_BOB, 'Handoff 1');
      await createHandoff(testPool, TEST_TENANT_ID, TEST_TASK_ID, AGENT_BOB, 'charlie', 'Handoff 2');
      await createHandoff(testPool, TEST_TENANT_ID, TEST_TASK_ID, 'charlie', 'dave', 'Handoff 3');

      const history = await getTaskHandoffHistory(testPool, TEST_TENANT_ID, TEST_TASK_ID, 2);

      expect(history).toHaveLength(2);
    });

    it('should return empty array for task with no handoffs', async () => {
      const history = await getTaskHandoffHistory(testPool, TEST_TENANT_ID, 'nonexistent-task');

      expect(history).toEqual([]);
    });

    it('should include all handoff statuses in history', async () => {
      const handoff1 = await createHandoff(testPool, TEST_TENANT_ID, TEST_TASK_ID, AGENT_ALICE, AGENT_BOB, 'Handoff 1');
      const handoff2 = await createHandoff(testPool, TEST_TENANT_ID, TEST_TASK_ID, AGENT_BOB, 'charlie', 'Handoff 2');
      await createHandoff(testPool, TEST_TENANT_ID, TEST_TASK_ID, 'charlie', 'dave', 'Handoff 3');

      await acceptHandoff(testPool, TEST_TENANT_ID, handoff1.id, AGENT_BOB);
      await rejectHandoff(testPool, TEST_TENANT_ID, handoff2.id, 'charlie', 'Rejected');

      const history = await getTaskHandoffHistory(testPool, TEST_TENANT_ID, TEST_TASK_ID);

      expect(history).toHaveLength(3);
      expect(history.find(h => h.id === handoff1.id)!.status).toBe('accepted');
      expect(history.find(h => h.id === handoff2.id)!.status).toBe('rejected');
      expect(history.find(h => h.status === 'pending')).toBeDefined();
    });
  });

  describe('Context Preservation', () => {
    it('should preserve context through handoff workflow', async () => {
      const context = {
        current_state: 'Database schema designed',
        progress: '50% complete',
        blockers: ['Need review from senior dev'],
        notes: 'Schema uses JSONB for flexibility',
        artifacts: ['schema.sql', 'migration-001.sql'],
      };

      const handoff = await createHandoff(
        testPool,
        TEST_TENANT_ID,
        TEST_TASK_ID,
        AGENT_ALICE,
        AGENT_BOB,
        'Handoff for database expertise',
        context
      );

      const accepted = await acceptHandoff(testPool, TEST_TENANT_ID, handoff.id, AGENT_BOB);

      expect(accepted.context).toEqual(context);
      expect(accepted.context.current_state).toBe('Database schema designed');
      expect(accepted.context.blockers).toEqual(['Need review from senior dev']);
      expect(accepted.context.artifacts).toEqual(['schema.sql', 'migration-001.sql']);
    });
  });
});
