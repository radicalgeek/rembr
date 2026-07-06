#!/usr/bin/env tsx
/**
 * One-time script to infer relationships for ALL existing memories
 * Run this to populate memory_relationships table from existing memories
 */

import { MemoryDatabase } from './src/database.js';
import { OllamaEmbeddingProvider } from './src/ollama-provider.js';
import { MemoryRelationshipService } from './src/memory-relationship-service.js';

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const DB_HOST = process.env.DB_HOST || 'localhost';
const DB_PORT = parseInt(process.env.DB_PORT || '5432');
const DB_NAME = process.env.DB_NAME || 'rembr_production';
const DB_USER = process.env.DB_USER || 'rembr';
const DB_PASSWORD = process.env.DB_PASSWORD || '';

async function main() {
  console.log('🚀 Starting relationship inference for all existing memories...\n');

  // Initialize services
  const database = new MemoryDatabase();

  console.log('✅ Connected to database\n');

  const embeddingProvider = new OllamaEmbeddingProvider(OLLAMA_URL);
  const relationshipService = new MemoryRelationshipService(database, embeddingProvider);

  // Get all tenants
  const tenantsResult = await database.query('SELECT DISTINCT tenant_id FROM memories');
  const tenants = tenantsResult.rows;

  console.log(`📊 Found ${tenants.length} tenant(s)\n`);

  for (const { tenant_id } of tenants) {
    console.log(`\n👤 Processing tenant: ${tenant_id}`);
    
    // Get all memories for this tenant
    const memoriesResult = await database.query(
      `SELECT id, content, project_id FROM memories WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [tenant_id]
    );
    
    const memories = memoriesResult.rows;
    console.log(`   Found ${memories.length} memories`);

    let totalRelationships = 0;
    let processedCount = 0;

    // Process each memory
    for (const memory of memories) {
      processedCount++;
      if (processedCount % 10 === 0) {
        console.log(`   Progress: ${processedCount}/${memories.length} memories processed...`);
      }

      try {
        // Infer relationships for this memory
        const relationships = await relationshipService.inferRelationshipsForMemory(
          memory.id,
          tenant_id,
          memory.project_id
        );

        // Store high-confidence relationships
        const highConfidenceRelationships = relationships.filter(r => r.confidence >= 0.6);
        
        if (highConfidenceRelationships.length > 0) {
          await relationshipService.storeRelationships(highConfidenceRelationships, tenant_id);
          totalRelationships += highConfidenceRelationships.length;
          console.log(`   ✅ Memory ${processedCount}: Found ${highConfidenceRelationships.length} relationships`);
        }
      } catch (error) {
        console.error(`   ❌ Error processing memory ${memory.id}:`, error);
      }

      // Add small delay to avoid overwhelming the system
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    console.log(`\n   ✨ Tenant complete: Stored ${totalRelationships} relationships`);
  }

  // Show final stats
  const statsResult = await database.query(`
    SELECT 
      mr.relationship_type, 
      COUNT(*) as count
    FROM memory_relationships mr
    GROUP BY mr.relationship_type
    ORDER BY count DESC
  `);

  console.log('\n📊 Final relationship counts:');
  for (const { relationship_type, count } of statsResult.rows) {
    console.log(`   ${relationship_type}: ${count}`);
  }

  console.log('\n✅ Complete!\n');
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
