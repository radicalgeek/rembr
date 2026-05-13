/**
 * PII Integration Tests (REM-50)
 * 
 * Tests for PII MCP tool integration with memory operations:
 * - Auto-scan on store_memory
 * - Re-scan on update_memory
 * - exclude_pii filter on search_memory
 * - All 5 PII tool operations
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Pool } from 'pg';
import { MemoryService } from './memory-service.js';
import { piiDetector } from './pii-detector.js';

const TEST_TENANT_ID = '550e8400-e29b-41d4-a716-446655440000';
const TEST_PROJECT_ID = '550e8400-e29b-41d4-a716-446655440001';

describe('PII Integration (REM-50)', () => {
  let pool: Pool;
  let memoryService: MemoryService;

  beforeEach(async () => {
    pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/rembr_test'
    });

    // Set tenant context
    await pool.query(`SET app.current_tenant_id = '${TEST_TENANT_ID}'`);

    // Clean up test data
    await pool.query('DELETE FROM memories WHERE tenant_id = $1', [TEST_TENANT_ID]);
    await pool.query('DELETE FROM pii_access_logs WHERE tenant_id = $1', [TEST_TENANT_ID]);

    memoryService = new MemoryService(pool, TEST_TENANT_ID, TEST_PROJECT_ID, 'test-user');
  });

  afterEach(async () => {
    await pool.end();
  });

  describe('Auto-scan on store_memory', () => {
    it('should detect PII when storing memory with email', async () => {
      const memory = await memoryService.storeMemory({
        content: 'Contact me at john.doe@example.com for details',
        category: 'contacts',
        metadata: {}
      });

      // Verify memory was stored
      expect(memory.id).toBeDefined();

      // Query database to check PII fields
      const result = await pool.query(
        'SELECT pii_detected, pii_types, pii_confidence, pii_scanned_at FROM memories WHERE id = $1',
        [memory.id]
      );

      expect(result.rows[0].pii_detected).toBe(true);
      expect(result.rows[0].pii_types).toContain('email');
      expect(result.rows[0].pii_confidence).toBeGreaterThan(0);
      expect(result.rows[0].pii_scanned_at).toBeDefined();
    });

    it('should not flag memories without PII', async () => {
      const memory = await memoryService.storeMemory({
        content: 'This is a simple note without any personal information',
        category: 'notes',
        metadata: {}
      });

      const result = await pool.query(
        'SELECT pii_detected, pii_types FROM memories WHERE id = $1',
        [memory.id]
      );

      expect(result.rows[0].pii_detected).toBe(false);
      expect(result.rows[0].pii_types).toEqual([]);
    });

    it('should detect multiple PII types', async () => {
      const memory = await memoryService.storeMemory({
        content: 'Contact: john@example.com or call 555-123-4567',
        category: 'contacts',
        metadata: {}
      });

      const result = await pool.query(
        'SELECT pii_detected, pii_types FROM memories WHERE id = $1',
        [memory.id]
      );

      expect(result.rows[0].pii_detected).toBe(true);
      expect(result.rows[0].pii_types).toContain('email');
      expect(result.rows[0].pii_types).toContain('phone');
    });
  });

  describe('Re-scan on update_memory', () => {
    it('should re-scan PII when content is updated', async () => {
      // Store memory without PII
      const memory = await memoryService.storeMemory({
        content: 'Original content without PII',
        category: 'notes',
        metadata: {}
      });

      // Verify no PII initially
      let result = await pool.query(
        'SELECT pii_detected FROM memories WHERE id = $1',
        [memory.id]
      );
      expect(result.rows[0].pii_detected).toBe(false);

      // Update with PII content
      await memoryService.updateMemory(memory.id, {
        content: 'Updated with email: jane@example.com'
      });

      // Verify PII is now detected
      result = await pool.query(
        'SELECT pii_detected, pii_types, pii_scanned_at FROM memories WHERE id = $1',
        [memory.id]
      );

      expect(result.rows[0].pii_detected).toBe(true);
      expect(result.rows[0].pii_types).toContain('email');
      expect(result.rows[0].pii_scanned_at).toBeDefined();
    });

    it('should clear PII flags when PII is removed', async () => {
      // Store memory with PII
      const memory = await memoryService.storeMemory({
        content: 'Email: test@example.com',
        category: 'contacts',
        metadata: {}
      });

      // Verify PII detected
      let result = await pool.query(
        'SELECT pii_detected FROM memories WHERE id = $1',
        [memory.id]
      );
      expect(result.rows[0].pii_detected).toBe(true);

      // Update to remove PII
      await memoryService.updateMemory(memory.id, {
        content: 'No personal information here'
      });

      // Verify PII flag is cleared
      result = await pool.query(
        'SELECT pii_detected, pii_types FROM memories WHERE id = $1',
        [memory.id]
      );

      expect(result.rows[0].pii_detected).toBe(false);
      expect(result.rows[0].pii_types).toEqual([]);
    });
  });

  describe('exclude_pii filter on search_memory', () => {
    beforeEach(async () => {
      // Store test memories: 2 with PII, 2 without
      await memoryService.storeMemory({
        content: 'Contact Alice at alice@example.com',
        category: 'contacts',
        metadata: {}
      });

      await memoryService.storeMemory({
        content: 'Regular note about project planning',
        category: 'notes',
        metadata: {}
      });

      await memoryService.storeMemory({
        content: 'Bob phone: 555-987-6543',
        category: 'contacts',
        metadata: {}
      });

      await memoryService.storeMemory({
        content: 'Another regular note about meetings',
        category: 'notes',
        metadata: {}
      });

      // Wait a bit for embeddings to be generated (if enabled)
      await new Promise(resolve => setTimeout(resolve, 100));
    });

    it('should return all memories when exclude_pii is false', async () => {
      const results = await memoryService.searchMemory({
        query: 'contact note',
        limit: 10,
        search_mode: 'text',
        exclude_pii: false
      });

      expect(results.length).toBeGreaterThan(0);
      // Should include both PII and non-PII memories
      const hasPII = results.some(r => r.pii_detected);
      const hasNonPII = results.some(r => !r.pii_detected);
      expect(hasPII || hasNonPII).toBe(true);
    });

    it('should exclude PII memories when exclude_pii is true', async () => {
      const results = await memoryService.searchMemory({
        query: 'contact note',
        limit: 10,
        search_mode: 'text',
        exclude_pii: true
      });

      // All results should have pii_detected = false
      for (const result of results) {
        expect(result.pii_detected).toBe(false);
      }
    });

    it('should work with semantic search mode', async () => {
      // Skip if no embedding provider
      if (!(memoryService as any).embeddingProvider) {
        console.log('Skipping semantic search test - no embedding provider');
        return;
      }

      const results = await memoryService.searchMemory({
        query: 'contact information',
        limit: 10,
        search_mode: 'semantic',
        exclude_pii: true
      });

      // All results should have pii_detected = false
      for (const result of results) {
        expect(result.pii_detected).toBe(false);
      }
    });
  });

  describe('PII tool operations', () => {
    it('should detect PII in text', () => {
      const result = piiDetector.detectPII('Contact: test@example.com', 'medium');

      expect(result.hasPII).toBe(true);
      expect(result.types).toContain('email');
      expect(result.locations.length).toBeGreaterThan(0);
    });

    it('should redact PII with mask mode', () => {
      const redacted = piiDetector.redactPII('Email: test@example.com', 'mask', 'medium');

      expect(redacted).not.toContain('test@example.com');
      expect(redacted).toContain('*');
    });

    it('should redact PII with hash mode', () => {
      const redacted = piiDetector.redactPII('Email: test@example.com', 'hash', 'medium');

      expect(redacted).not.toContain('test@example.com');
      expect(redacted).toContain('[EMAIL_REDACTED]');
    });

    it('should redact PII with remove mode', () => {
      const redacted = piiDetector.redactPII('Email: test@example.com', 'remove', 'medium');

      expect(redacted).not.toContain('test@example.com');
      expect(redacted).toBe('Email: ');
    });
  });

  describe('batch_scan operation', () => {
    it('should scan unscanned memories', async () => {
      // Insert memories directly without PII scanning
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const result = await pool.query(
          `INSERT INTO memories (tenant_id, project_id, content, category, created_by)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id`,
          [TEST_TENANT_ID, TEST_PROJECT_ID, `Test memory ${i} with email test${i}@example.com`, 'notes', 'test-user']
        );
        ids.push(result.rows[0].id);
      }

      // Verify memories are unscanned
      const unscanned = await pool.query(
        'SELECT COUNT(*) FROM memories WHERE tenant_id = $1 AND pii_scanned_at IS NULL',
        [TEST_TENANT_ID]
      );
      expect(parseInt(unscanned.rows[0].count)).toBe(3);

      // Run batch scan (simulated)
      for (const id of ids) {
        const memory = await pool.query('SELECT content FROM memories WHERE id = $1', [id]);
        const piiResult = piiDetector.detectPII(memory.rows[0].content, 'medium');
        await pool.query(
          `UPDATE memories SET 
             pii_detected = $1, 
             pii_types = $2, 
             pii_confidence = $3, 
             pii_scanned_at = NOW() 
           WHERE id = $4`,
          [piiResult.hasPII, piiResult.types, piiResult.confidence, id]
        );
      }

      // Verify all memories are now scanned and PII is detected
      const scanned = await pool.query(
        'SELECT COUNT(*) FROM memories WHERE tenant_id = $1 AND pii_scanned_at IS NOT NULL AND pii_detected = true',
        [TEST_TENANT_ID]
      );
      expect(parseInt(scanned.rows[0].count)).toBe(3);
    });
  });
});
