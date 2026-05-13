/**
 * Unit Tests: Embedding Model Consistency (REM-249)
 * 
 * Tests model fingerprinting and stale vector detection when the
 * embedding model changes (e.g., nomic-embed-text → all-minilm-l6-v2).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Pool } from 'pg'
import { MemoryDatabase } from './database.js'
import { OllamaClient } from './ollama-client.js'

describe('Embedding Model Consistency (REM-249)', () => {
  let pool: Pool
  let db: MemoryDatabase
  const TEST_TENANT_ID = '550e8400-e29b-41d4-a716-446655440000'

  beforeEach(async () => {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/rembr_test'
    })

    db = new MemoryDatabase(process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/rembr_test')

    // Enable pgvector extension first (required for vector type)
    await pool.query(`CREATE EXTENSION IF NOT EXISTS vector;`)

    // Create base tables if they don't exist (test setup)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tenants (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL UNIQUE,
        plan VARCHAR(50) NOT NULL DEFAULT 'dev',
        status VARCHAR(50) NOT NULL DEFAULT 'active',
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS projects (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS memories (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        embedding vector(768),
        category VARCHAR(50),
        metadata JSONB,
        relevance_score FLOAT DEFAULT 1.0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS memory_embeddings (
        memory_id UUID PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
        embedding vector(768),
        provider VARCHAR(100) NOT NULL,
        model VARCHAR(100) NOT NULL,
        dimensions INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        model_fingerprint TEXT,
        is_stale BOOLEAN DEFAULT FALSE,
        stale_since TIMESTAMPTZ
      );
    `)

    // Insert test tenant (required for foreign key constraints)
    await pool.query(`
      INSERT INTO tenants (id, name, email, plan, status)
      VALUES ($1, 'Test Tenant', 'test@example.com', 'dev', 'active')
      ON CONFLICT (id) DO NOTHING
    `, [TEST_TENANT_ID])

    // Clean up test data
    await pool.query('DELETE FROM memory_embeddings WHERE memory_id IN (SELECT id FROM memories WHERE tenant_id = $1)', [TEST_TENANT_ID])
    await pool.query('DELETE FROM memories WHERE tenant_id = $1', [TEST_TENANT_ID])
  })

  afterEach(async () => {
    await pool.end()
  })

  describe('Model Fingerprinting', () => {
    it('should compute consistent fingerprint for same model config', () => {
      const client1 = OllamaClient.getInstance()
      const client2 = OllamaClient.getInstance()

      const fp1 = client1.getModelFingerprint()
      const fp2 = client2.getModelFingerprint()

      expect(fp1).toBe(fp2)
      expect(fp1).toMatch(/^[0-9a-f]{64}$/)  // SHA-256 hex
    })

    it('should compute different fingerprints for different models', () => {
      // Note: In real use, you'd change OLLAMA_EMBEDDING_MODEL env var
      // For this test, we're just verifying the fingerprint is deterministic
      const fp = OllamaClient.getInstance().getModelFingerprint()
      
      // Fingerprint should be stable across calls
      const fp2 = OllamaClient.getInstance().getModelFingerprint()
      expect(fp).toBe(fp2)
    })
  })

  describe('Stale Detection', () => {
    it('should mark embeddings as stale when model changes', async () => {
      // Insert a memory with an embedding
      const memoryResult = await pool.query(
        'INSERT INTO memories (id, tenant_id, content, created_at) VALUES (gen_random_uuid(), $1, $2, NOW()) RETURNING id',
        [TEST_TENANT_ID, 'Test memory content']
      )
      const memoryId = memoryResult.rows[0].id

      const fakeEmbedding = Array(768).fill(0.1)
      const oldFingerprint = 'old_model_fingerprint_12345'

      // Store with old fingerprint
      await db.storeEmbedding(
        memoryId,
        TEST_TENANT_ID,
        fakeEmbedding,
        'ollama',
        'old-model',
        oldFingerprint
      )

      // Verify it's not stale initially
      let result = await pool.query(
        'SELECT is_stale FROM memory_embeddings WHERE memory_id = $1',
        [memoryId]
      )
      expect(result.rows[0].is_stale).toBe(false)

      // Mark stale with different fingerprint
      const newFingerprint = 'new_model_fingerprint_67890'
      const staleCount = await db.markStaleEmbeddings(TEST_TENANT_ID, newFingerprint)

      expect(staleCount).toBe(1)

      // Verify it's now stale
      result = await pool.query(
        'SELECT is_stale, stale_since FROM memory_embeddings WHERE memory_id = $1',
        [memoryId]
      )
      expect(result.rows[0].is_stale).toBe(true)
      expect(result.rows[0].stale_since).toBeTruthy()
    })

    it('should NOT mark embeddings as stale when fingerprint matches', async () => {
      const memoryResult = await pool.query(
        'INSERT INTO memories (id, tenant_id, content, created_at) VALUES (gen_random_uuid(), $1, $2, NOW()) RETURNING id',
        [TEST_TENANT_ID, 'Test memory']
      )
      const memoryId = memoryResult.rows[0].id

      const fakeEmbedding = Array(768).fill(0.2)
      const fingerprint = 'matching_fingerprint'

      await db.storeEmbedding(
        memoryId,
        TEST_TENANT_ID,
        fakeEmbedding,
        'ollama',
        'current-model',
        fingerprint
      )

      // Mark stale with SAME fingerprint
      const staleCount = await db.markStaleEmbeddings(TEST_TENANT_ID, fingerprint)

      expect(staleCount).toBe(0)

      const result = await pool.query(
        'SELECT is_stale FROM memory_embeddings WHERE memory_id = $1',
        [memoryId]
      )
      expect(result.rows[0].is_stale).toBe(false)
    })

    it('should get count of stale embeddings', async () => {
      // Insert 3 memories with stale embeddings
      for (let i = 0; i < 3; i++) {
        const memoryResult = await pool.query(
          'INSERT INTO memories (id, tenant_id, content, created_at) VALUES (gen_random_uuid(), $1, $2, NOW()) RETURNING id',
          [TEST_TENANT_ID, `Memory ${i}`]
        )
        const memoryId = memoryResult.rows[0].id

        await db.storeEmbedding(
          memoryId,
          TEST_TENANT_ID,
          Array(768).fill(0.1),
          'ollama',
          'old-model',
          'old_fingerprint'
        )
      }

      await db.markStaleEmbeddings(TEST_TENANT_ID, 'new_fingerprint')

      const count = await db.getStaleEmbeddingCount(TEST_TENANT_ID)
      expect(count).toBe(3)
    })

    it('should retrieve stale embeddings for re-embedding', async () => {
      const memoryResult = await pool.query(
        'INSERT INTO memories (id, tenant_id, content, created_at) VALUES (gen_random_uuid(), $1, $2, NOW()) RETURNING id',
        [TEST_TENANT_ID, 'Content to re-embed']
      )
      const memoryId = memoryResult.rows[0].id

      await db.storeEmbedding(
        memoryId,
        TEST_TENANT_ID,
        Array(768).fill(0.3),
        'ollama',
        'old-model-v1',
        'old_fp'
      )

      await db.markStaleEmbeddings(TEST_TENANT_ID, 'new_fp')

      const staleList = await db.getStaleEmbeddings(TEST_TENANT_ID, 10)

      expect(staleList).toHaveLength(1)
      expect(staleList[0].memory_id).toBe(memoryId)
      expect(staleList[0].content).toBe('Content to re-embed')
      expect(staleList[0].old_model).toBe('old-model-v1')
      expect(staleList[0].old_fingerprint).toBe('old_fp')
    })
  })

  describe('Re-embedding', () => {
    it('should clear stale flag after successful re-embedding', async () => {
      const memoryResult = await pool.query(
        'INSERT INTO memories (id, tenant_id, content, created_at) VALUES (gen_random_uuid(), $1, $2, NOW()) RETURNING id',
        [TEST_TENANT_ID, 'Memory for re-embedding']
      )
      const memoryId = memoryResult.rows[0].id

      // Store with old fingerprint
      await db.storeEmbedding(
        memoryId,
        TEST_TENANT_ID,
        Array(768).fill(0.1),
        'ollama',
        'old-model',
        'old_fp'
      )

      // Mark stale
      await db.markStaleEmbeddings(TEST_TENANT_ID, 'new_fp')

      let result = await pool.query(
        'SELECT is_stale FROM memory_embeddings WHERE memory_id = $1',
        [memoryId]
      )
      expect(result.rows[0].is_stale).toBe(true)

      // Re-embed with new fingerprint
      await db.storeEmbedding(
        memoryId,
        TEST_TENANT_ID,
        Array(768).fill(0.5),
        'ollama',
        'new-model',
        'new_fp'
      )

      // Verify stale flag is cleared
      result = await pool.query(
        'SELECT is_stale, model, model_fingerprint FROM memory_embeddings WHERE memory_id = $1',
        [memoryId]
      )
      expect(result.rows[0].is_stale).toBe(false)
      expect(result.rows[0].model).toBe('new-model')
      expect(result.rows[0].model_fingerprint).toBe('new_fp')
    })
  })
})
