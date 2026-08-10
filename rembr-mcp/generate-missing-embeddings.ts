#!/usr/bin/env tsx
/**
 * Generate embeddings for memories that don't have them
 */

import { MemoryDatabase } from './src/database.js';
import { OllamaEmbeddingProvider } from './src/ollama-provider.js';

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const DB_HOST = process.env.DB_HOST || 'localhost';
const DB_PORT = parseInt(process.env.DB_PORT || '5432');
const DB_NAME = process.env.DB_NAME || 'rembr';
const DB_USER = process.env.DB_USER || 'rembr';
const DB_PASSWORD = process.env.DB_PASSWORD || '';

async function main() {
  console.log('🚀 Generating missing embeddings...\n');

  const database = new MemoryDatabase();
  console.log('✅ Connected to database\n');

  const embeddingProvider = new OllamaEmbeddingProvider(OLLAMA_URL);

  // Find memories without embeddings
  const result = await database.query(`
    SELECT m.id, m.content, m.tenant_id
    FROM memories m
    LEFT JOIN memory_embeddings me ON m.id = me.memory_id
    WHERE me.memory_id IS NULL
    ORDER BY m.created_at DESC
  `);

  const memoriesWithoutEmbeddings = result.rows;
  console.log(`📊 Found ${memoriesWithoutEmbeddings.length} memories without embeddings\n`);

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < memoriesWithoutEmbeddings.length; i++) {
    const memory = memoriesWithoutEmbeddings[i];
    
    if ((i + 1) % 10 === 0) {
      console.log(`   Progress: ${i + 1}/${memoriesWithoutEmbeddings.length}...`);
    }

    try {
      // Generate embedding
      const embedding = await embeddingProvider.generateEmbedding(memory.content);
      
      // Store embedding
      await database.query(`
        INSERT INTO memory_embeddings (memory_id, tenant_id, embedding, provider, model, created_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
        ON CONFLICT (memory_id) DO NOTHING
      `, [
        memory.id,
        memory.tenant_id,
        `[${embedding.join(',')}]`,
        embeddingProvider.name,
        embeddingProvider.model
      ]);

      successCount++;
    } catch (error) {
      console.error(`   ❌ Failed for memory ${memory.id}:`, error instanceof Error ? error.message : error);
      failCount++;
    }

    // Small delay to avoid overwhelming Ollama
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  console.log(`\n✅ Complete!`);
  console.log(`   Success: ${successCount}`);
  console.log(`   Failed: ${failCount}\n`);

  // Verify
  const verifyResult = await database.query(`
    SELECT 
      COUNT(*) as total_memories,
      COUNT(me.embedding) as memories_with_embeddings
    FROM memories m
    LEFT JOIN memory_embeddings me ON m.id = me.memory_id
  `);

  const stats = verifyResult.rows[0];
  console.log(`📊 Final stats:`);
  console.log(`   Total memories: ${stats.total_memories}`);
  console.log(`   With embeddings: ${stats.memories_with_embeddings}`);
  console.log(`   Coverage: ${((stats.memories_with_embeddings / stats.total_memories) * 100).toFixed(1)}%\n`);
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
