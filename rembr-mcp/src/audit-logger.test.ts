/**
 * Unit Tests: Audit Logger Tamper-Resistance (REM-251)
 * 
 * Tests the integrity verification methods added to AuditLogger:
 *   - verifyIntegrity() — detects hash mismatches, chain breaks, sequence gaps
 *   - detectGaps() — identifies deleted records via seq_num gaps
 *   - recomputeHash() — validates hash computation
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Pool } from 'pg'
import { AuditLogger } from './audit-logger.js'

describe('AuditLogger Tamper-Resistance (REM-251)', () => {
  let pool: Pool
  let auditLogger: AuditLogger
  const TEST_TENANT_ID = '550e8400-e29b-41d4-a716-446655440000'

  beforeEach(async () => {
    // Use test database
    pool = new Pool({
      connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/rembr_test'
    })

    auditLogger = new AuditLogger(pool)

    // Create audit_logs table if it doesn't exist (full schema matching audit-logger.ts)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL,
        user_id TEXT,
        api_key_id TEXT,
        agent_id TEXT,
        ip_address TEXT,
        user_agent TEXT,
        event_type TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT,
        action_result TEXT NOT NULL,
        error_message TEXT,
        payload_before JSONB,
        payload_after JSONB,
        query_parameters JSONB,
        session_id TEXT,
        request_id TEXT,
        metadata JSONB,
        type TEXT,
        user_identifier TEXT,
        provider TEXT,
        success BOOLEAN,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `)

    // Apply REM-251 migration (audit tamper-resistance)
    // Add columns + triggers if they don't exist
    await pool.query(`
      -- Enable pgcrypto
      CREATE EXTENSION IF NOT EXISTS pgcrypto;

      -- Add columns
      ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS seq_num BIGSERIAL;
      ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS entry_hash TEXT;
      ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS prev_hash TEXT;

      -- Drop triggers if they exist (idempotent)
      DROP TRIGGER IF EXISTS audit_set_hash ON audit_logs;
      DROP TRIGGER IF EXISTS audit_immutable ON audit_logs;
      DROP FUNCTION IF EXISTS set_audit_entry_hash() CASCADE;
      DROP FUNCTION IF EXISTS prevent_audit_modification() CASCADE;

      -- Create hash chaining trigger function
      CREATE OR REPLACE FUNCTION set_audit_entry_hash()
      RETURNS TRIGGER AS $$
      DECLARE
        v_prev_hash TEXT;
        v_entry_hash TEXT;
      BEGIN
        -- Get prev_hash from the most recent entry for this tenant
        SELECT entry_hash INTO v_prev_hash
          FROM audit_logs
         WHERE tenant_id = NEW.tenant_id
         ORDER BY seq_num DESC
         LIMIT 1;

        NEW.prev_hash := v_prev_hash;

        -- Compute entry_hash (canonical field order matching migration)
        v_entry_hash := encode(
          digest(
            COALESCE(NEW.id::TEXT, '') || '|' ||
            COALESCE(NEW.tenant_id::TEXT, '') || '|' ||
            COALESCE(NEW.user_id, '') || '|' ||
            COALESCE(NEW.agent_id, '') || '|' ||
            COALESCE(NEW.event_type, '') || '|' ||
            COALESCE(NEW.resource_type, '') || '|' ||
            COALESCE(NEW.resource_id, '') || '|' ||
            COALESCE(NEW.action_result, '') || '|' ||
            EXTRACT(EPOCH FROM NEW.created_at)::TEXT || '|' ||
            COALESCE(v_prev_hash, 'GENESIS'),
            'sha256'
          ),
          'hex'
        );

        NEW.entry_hash := v_entry_hash;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      -- Create immutability trigger function
      CREATE OR REPLACE FUNCTION prevent_audit_modification()
      RETURNS TRIGGER AS $$
      BEGIN
        IF TG_OP = 'UPDATE' THEN
          RAISE EXCEPTION
            'Audit logs are immutable. UPDATE is not permitted on audit_logs (record id: %).',
            OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        ELSIF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION
            'Audit logs are immutable. DELETE is not permitted on audit_logs (record id: %).',
            OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql;

      -- Attach triggers (matching migration 006 trigger names)
      CREATE TRIGGER audit_set_hash
        BEFORE INSERT ON audit_logs
        FOR EACH ROW
        EXECUTE FUNCTION set_audit_entry_hash();

      CREATE TRIGGER audit_immutable
        BEFORE UPDATE OR DELETE ON audit_logs
        FOR EACH ROW
        EXECUTE FUNCTION prevent_audit_modification();
    `)

    // Clean up test tenant data
    // NOTE: This will fail due to immutability trigger, so truncate instead
    await pool.query('TRUNCATE TABLE audit_logs RESTART IDENTITY CASCADE')
  })

  afterEach(async () => {
    await pool.end()
  })

  describe('Hash Chain Integrity', () => {
    it('should verify clean audit log chain with no violations', async () => {
      // Insert 3 sequential audit log entries
      await auditLogger.log({
        tenantId: TEST_TENANT_ID,
        userId: 'user1',
        eventType: 'memory.create',
        resourceType: 'memory',
        resourceId: '111',
        actionResult: 'success'
      })

      await auditLogger.log({
        tenantId: TEST_TENANT_ID,
        userId: 'user1',
        eventType: 'memory.read',
        resourceType: 'memory',
        resourceId: '111',
        actionResult: 'success'
      })

      await auditLogger.log({
        tenantId: TEST_TENANT_ID,
        userId: 'user1',
        eventType: 'memory.update',
        resourceType: 'memory',
        resourceId: '111',
        actionResult: 'success'
      })

      // Verify integrity
      const violations = await auditLogger.verifyIntegrity(TEST_TENANT_ID, 100)
      expect(violations).toHaveLength(0)
    })

    it('should detect hash mismatch when entry_hash is tampered', async () => {
      // Insert a log entry
      await auditLogger.log({
        tenantId: TEST_TENANT_ID,
        userId: 'user1',
        eventType: 'memory.create',
        resourceType: 'memory',
        resourceId: '222',
        actionResult: 'success'
      })

      // Simulate tampering: disable trigger, update entry_hash
      await pool.query('ALTER TABLE audit_logs DISABLE TRIGGER audit_immutable')
      await pool.query(
        `UPDATE audit_logs 
         SET entry_hash = 'fake_hash_12345' 
         WHERE tenant_id = $1`,
        [TEST_TENANT_ID]
      )
      await pool.query('ALTER TABLE audit_logs ENABLE TRIGGER audit_immutable')

      // Verify should detect mismatch
      const violations = await auditLogger.verifyIntegrity(TEST_TENANT_ID, 100)
      expect(violations.length).toBeGreaterThan(0)
      expect(violations[0].violation_type).toBe('hash_mismatch')
    })

    it('should detect chain break when prev_hash is tampered', async () => {
      // Insert 2 entries
      await auditLogger.log({
        tenantId: TEST_TENANT_ID,
        userId: 'user1',
        eventType: 'memory.create',
        resourceType: 'memory',
        actionResult: 'success'
      })

      await auditLogger.log({
        tenantId: TEST_TENANT_ID,
        userId: 'user1',
        eventType: 'memory.update',
        resourceType: 'memory',
        actionResult: 'success'
      })

      // Tamper with prev_hash of second record
      await pool.query('ALTER TABLE audit_logs DISABLE TRIGGER audit_immutable')
      const rows = await pool.query(
        'SELECT id FROM audit_logs WHERE tenant_id = $1 ORDER BY seq_num DESC LIMIT 1',
        [TEST_TENANT_ID]
      )
      await pool.query(
        'UPDATE audit_logs SET prev_hash = $1 WHERE id = $2',
        ['tampered_prev_hash', rows.rows[0].id]
      )
      await pool.query('ALTER TABLE audit_logs ENABLE TRIGGER audit_immutable')

      // Verify should detect chain break
      const violations = await auditLogger.verifyIntegrity(TEST_TENANT_ID, 100)
      expect(violations.some(v => v.violation_type === 'chain_break')).toBe(true)
    })
  })

  describe('Sequence Gap Detection', () => {
    it('should detect no gaps in continuous sequence', async () => {
      await auditLogger.log({
        tenantId: TEST_TENANT_ID,
        eventType: 'test.event1',
        resourceType: 'test',
        actionResult: 'success'
      })

      await auditLogger.log({
        tenantId: TEST_TENANT_ID,
        eventType: 'test.event2',
        resourceType: 'test',
        actionResult: 'success'
      })

      const gaps = await auditLogger.detectGaps(TEST_TENANT_ID)
      expect(gaps).toHaveLength(0)
    })

    it('should detect sequence gap when a record is deleted', async () => {
      // Insert 3 entries
      await auditLogger.log({
        tenantId: TEST_TENANT_ID,
        eventType: 'test.event1',
        resourceType: 'test',
        actionResult: 'success'
      })

      await auditLogger.log({
        tenantId: TEST_TENANT_ID,
        eventType: 'test.event2',
        resourceType: 'test',
        actionResult: 'success'
      })

      await auditLogger.log({
        tenantId: TEST_TENANT_ID,
        eventType: 'test.event3',
        resourceType: 'test',
        actionResult: 'success'
      })

      // Get middle record's ID
      const rows = await pool.query(
        `SELECT id FROM audit_logs 
         WHERE tenant_id = $1 
         ORDER BY seq_num ASC 
         LIMIT 1 OFFSET 1`,
        [TEST_TENANT_ID]
      )

      // Delete it (requires disabling immutability trigger)
      await pool.query('ALTER TABLE audit_logs DISABLE TRIGGER audit_immutable')
      await pool.query('DELETE FROM audit_logs WHERE id = $1', [rows.rows[0].id])
      await pool.query('ALTER TABLE audit_logs ENABLE TRIGGER audit_immutable')

      // Detect gap
      const gaps = await auditLogger.detectGaps(TEST_TENANT_ID)
      expect(gaps.length).toBeGreaterThan(0)
      expect(gaps[0].gap_size).toBe(1)
    })

    it('should detect multiple gaps', async () => {
      // Insert 6 entries
      for (let i = 0; i < 6; i++) {
        await auditLogger.log({
          tenantId: TEST_TENANT_ID,
          eventType: `test.event${i}`,
          resourceType: 'test',
          actionResult: 'success'
        })
      }

      // Delete records 2 and 5 (creating 2 gaps)
      const rows = await pool.query(
        'SELECT id FROM audit_logs WHERE tenant_id = $1 ORDER BY seq_num ASC',
        [TEST_TENANT_ID]
      )

      await pool.query('ALTER TABLE audit_logs DISABLE TRIGGER audit_immutable')
      await pool.query('DELETE FROM audit_logs WHERE id IN ($1, $2)', [
        rows.rows[1].id,
        rows.rows[4].id
      ])
      await pool.query('ALTER TABLE audit_logs ENABLE TRIGGER audit_immutable')

      const gaps = await auditLogger.detectGaps(TEST_TENANT_ID)
      expect(gaps).toHaveLength(2)
    })
  })

  describe('Immutability Trigger', () => {
    it('should block UPDATE attempts on audit_logs', async () => {
      await auditLogger.log({
        tenantId: TEST_TENANT_ID,
        eventType: 'test.event',
        resourceType: 'test',
        actionResult: 'success'
      })

      const rows = await pool.query(
        'SELECT id FROM audit_logs WHERE tenant_id = $1',
        [TEST_TENANT_ID]
      )

      // Attempt to update should raise exception
      await expect(
        pool.query('UPDATE audit_logs SET action_result = $1 WHERE id = $2', [
          'failure',
          rows.rows[0].id
        ])
      ).rejects.toThrow(/immutable/i)
    })

    it('should block DELETE attempts on audit_logs', async () => {
      await auditLogger.log({
        tenantId: TEST_TENANT_ID,
        eventType: 'test.event',
        resourceType: 'test',
        actionResult: 'success'
      })

      const rows = await pool.query(
        'SELECT id FROM audit_logs WHERE tenant_id = $1',
        [TEST_TENANT_ID]
      )

      // Attempt to delete should raise exception
      await expect(
        pool.query('DELETE FROM audit_logs WHERE id = $1', [rows.rows[0].id])
      ).rejects.toThrow(/immutable/i)
    })
  })

  describe('Hash Computation', () => {
    it('should produce consistent hashes for identical inputs', async () => {
      // Insert a log entry
      await auditLogger.log({
        tenantId: TEST_TENANT_ID,
        userId: 'user1',
        agentId: 'agent1',
        eventType: 'memory.create',
        resourceType: 'memory',
        resourceId: '333',
        actionResult: 'success'
      })

      const rows = await pool.query(
        `SELECT *, EXTRACT(EPOCH FROM created_at) AS created_at_epoch 
         FROM audit_logs 
         WHERE tenant_id = $1`,
        [TEST_TENANT_ID]
      )

      // Recompute hash using private method (via reflection for testing)
      const recomputed = (auditLogger as any).recomputeHash(rows.rows[0])
      expect(recomputed).toBe(rows.rows[0].entry_hash)
    })

    it('should produce different hashes when any field changes', async () => {
      await auditLogger.log({
        tenantId: TEST_TENANT_ID,
        eventType: 'test.event',
        resourceType: 'test',
        actionResult: 'success'
      })

      const row1 = await pool.query(
        'SELECT * FROM audit_logs WHERE tenant_id = $1 LIMIT 1',
        [TEST_TENANT_ID]
      )

      // Insert another with different action_result
      await auditLogger.log({
        tenantId: TEST_TENANT_ID,
        eventType: 'test.event',
        resourceType: 'test',
        actionResult: 'failure'
      })

      const row2 = await pool.query(
        'SELECT * FROM audit_logs WHERE tenant_id = $1 ORDER BY seq_num DESC LIMIT 1',
        [TEST_TENANT_ID]
      )

      // Hashes should differ
      expect(row1.rows[0].entry_hash).not.toBe(row2.rows[0].entry_hash)
    })
  })
})
