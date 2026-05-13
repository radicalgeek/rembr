import { MemoryDatabase } from '../database.js';
import { OllamaClient } from '../ollama-client.js';

/**
 * Inferred relationship between memories
 */
export interface InferredRelationship {
  sourceMemoryId: string;
  targetMemoryId: string;
  relationshipType: string;
  confidence: number; // 0.0-1.0
  evidence?: string;
}

/**
 * Relationship update result
 */
export interface RelationshipUpdateResult {
  added: number;
  removed: number;
  updated: number;
}

/**
 * RelationshipMaintainerService - Infers and maintains semantic relationships
 * 
 * Responsibilities:
 * - Infer new semantic relationships between memories
 * - Update relationship weights based on co-access patterns
 * - Remove weak relationships
 * - Maintain relationship graph health
 * 
 * Relationship Types:
 * - similar: Semantically similar content (>0.75 similarity)
 * - related: Related topics or concepts (0.60-0.75 similarity)
 * - prerequisite: One memory builds on another
 * - contradicts: Conflicting information
 * - updates: Newer info supersedes older
 */
export class RelationshipMaintainerService {
  private readonly SIMILARITY_THRESHOLD = 0.70;
  private readonly WEAK_RELATIONSHIP_THRESHOLD = 0.30;

  constructor(
    private db: MemoryDatabase,
    private ollamaClient: OllamaClient
  ) {}

  /**
   * Parse pgvector embedding string to number array
   * @param embeddingStr Embedding as string from pgvector (e.g., "[0.1,0.2,0.3]")
   * @returns Number array
   */
  private parseEmbedding(embeddingStr: string | number[]): number[] {
    if (Array.isArray(embeddingStr)) {
      return embeddingStr;
    }
    // pgvector returns embeddings as strings like "[0.1,0.2,0.3,...]"
    const str = embeddingStr.toString().trim();
    if (str.startsWith('[') && str.endsWith(']')) {
      return JSON.parse(str);
    }
    throw new Error(`Invalid embedding format: ${str.substring(0, 50)}...`);
  }

  /**
   * Infer relationships for unconnected or under-connected memories
   * @param tenantId Tenant to analyze
   * @param minScore Minimum similarity score for relationships
   * @param batchSize Number of memories to process
   * @returns Array of inferred relationships
   */
  async inferRelationships(
    tenantId: string,
    minScore: number = this.SIMILARITY_THRESHOLD,
    batchSize: number = 50
  ): Promise<InferredRelationship[]> {
    await this.db.query('SELECT set_config($1, $2, FALSE)', ['app.current_tenant', tenantId]);

    // Get memories with low relationship counts
    const result = await this.db.query(`
      SELECT 
        m.id,
        m.content,
        m.category,
        me.embedding,
        COUNT(mr.id) as relationship_count
      FROM memories m
      LEFT JOIN memory_embeddings me ON m.id = me.memory_id
      LEFT JOIN memory_relationships mr ON m.id = mr.source_memory_id OR m.id = mr.target_memory_id
      WHERE m.tenant_id = $1 AND me.embedding IS NOT NULL
      GROUP BY m.id, m.content, m.category, me.embedding
      HAVING COUNT(mr.id) < 3
      ORDER BY COUNT(mr.id) ASC, m.created_at DESC
      LIMIT $2
    `, [tenantId, batchSize]);

    const memories = result.rows.map((row: any) => ({
      ...row,
      embedding: this.parseEmbedding(row.embedding)
    }));
    
    if (memories.length < 2) {
      return [];
    }

    const relationships: InferredRelationship[] = [];

    // Compare each memory with others to find relationships
    for (let i = 0; i < memories.length; i++) {
      const source = memories[i];

      for (let j = i + 1; j < memories.length; j++) {
        const target = memories[j];

        // Skip if already related
        const existing = await this.hasRelationship(source.id, target.id);
        if (existing) continue;

        // Calculate similarity
        const similarity = this.cosineSimilarity(source.embedding, target.embedding);

        if (similarity >= minScore) {
          const relType = this.determineRelationshipType(similarity, source.category, target.category);
          
          relationships.push({
            sourceMemoryId: source.id,
            targetMemoryId: target.id,
            relationshipType: relType,
            confidence: similarity,
            evidence: `Vector similarity: ${similarity.toFixed(3)}`
          });
        }
      }
    }

    return relationships;
  }

  /**
   * Create inferred relationships in database
   * @param relationships Relationships to create
   * @param tenantId Tenant ID
   * @returns Number of relationships created
   */
  async createRelationships(
    relationships: InferredRelationship[],
    tenantId: string
  ): Promise<number> {
    if (relationships.length === 0) return 0;

    await this.db.query('SELECT set_config($1, $2, FALSE)', ['app.current_tenant', tenantId]);

    let created = 0;
    for (const rel of relationships) {
      try {
        await this.db.query(`
          INSERT INTO memory_relationships (
            source_memory_id,
            target_memory_id,
            relationship_type,
            confidence,
            evidence
          ) VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (source_memory_id, target_memory_id) DO NOTHING
        `, [
          rel.sourceMemoryId,
          rel.targetMemoryId,
          rel.relationshipType,
          rel.confidence,
          rel.evidence
        ]);
        created++;
      } catch (error) {
        console.error(`Failed to create relationship: ${error}`);
      }
    }

    return created;
  }

  /**
   * Update relationship weights based on co-access patterns
   * @param tenantId Tenant ID
   * @returns Update result
   */
  async updateWeights(tenantId: string): Promise<RelationshipUpdateResult> {
    await this.db.query('SELECT set_config($1, $2, FALSE)', ['app.current_tenant', tenantId]);

    // This would ideally track co-access in a separate table
    // For now, we'll boost confidence for frequently co-occurring relationships
    
    const result = await this.db.query(`
      UPDATE memory_relationships mr
      SET confidence = LEAST(1.0, confidence * 1.1)
      FROM (
        SELECT id
        FROM memory_relationships
        WHERE created_at < NOW() - INTERVAL '7 days'
        AND confidence < 0.95
      ) old
      WHERE mr.id = old.id
    `);

    return {
      added: 0,
      removed: 0,
      updated: result.rowCount || 0
    };
  }

  /**
   * Remove weak relationships
   * @param tenantId Tenant ID
   * @param threshold Confidence threshold below which to remove
   * @returns Number of relationships removed
   */
  async pruneWeak(
    tenantId: string,
    threshold: number = this.WEAK_RELATIONSHIP_THRESHOLD
  ): Promise<number> {
    await this.db.query('SELECT set_config($1, $2, FALSE)', ['app.current_tenant', tenantId]);

    const result = await this.db.query(`
      DELETE FROM memory_relationships
      WHERE confidence < $1
      AND created_at < NOW() - INTERVAL '30 days'
    `, [threshold]);

    return result.rowCount || 0;
  }

  /**
   * Get relationship statistics for tenant
   * @param tenantId Tenant ID
   * @returns Stats object
   */
  async getStats(tenantId: string): Promise<{
    totalRelationships: number;
    avgRelationshipsPerMemory: number;
    orphanedMemories: number;
    highlyConnected: number;
  }> {
    await this.db.query('SELECT set_config($1, $2, FALSE)', ['app.current_tenant', tenantId]);

    const result = await this.db.query(`
      WITH memory_stats AS (
        SELECT 
          m.id,
          COUNT(DISTINCT mr.id) as rel_count
        FROM memories m
        LEFT JOIN memory_relationships mr 
          ON m.id = mr.source_memory_id OR m.id = mr.target_memory_id
        WHERE m.tenant_id = $1
        GROUP BY m.id
      )
      SELECT 
        (SELECT COUNT(*) FROM memory_relationships) as total_relationships,
        COUNT(*) as total_memories,
        SUM(CASE WHEN rel_count = 0 THEN 1 ELSE 0 END)::int as orphaned,
        SUM(CASE WHEN rel_count > 10 THEN 1 ELSE 0 END)::int as highly_connected
      FROM memory_stats
    `, [tenantId]);

    const stats = result.rows[0];
    const avgRel = stats.total_memories > 0 
      ? stats.total_relationships / stats.total_memories 
      : 0;

    return {
      totalRelationships: Number(stats.total_relationships),
      avgRelationshipsPerMemory: Number(avgRel.toFixed(2)),
      orphanedMemories: Number(stats.orphaned),
      highlyConnected: Number(stats.highly_connected)
    };
  }

  /**
   * Check if relationship exists between two memories
   */
  private async hasRelationship(memoryId1: string, memoryId2: string): Promise<boolean> {
    const result = await this.db.query(`
      SELECT COUNT(*) as count
      FROM memory_relationships
      WHERE (source_memory_id = $1 AND target_memory_id = $2)
         OR (source_memory_id = $2 AND target_memory_id = $1)
    `, [memoryId1, memoryId2]);

    return parseInt(result.rows[0].count) > 0;
  }

  /**
   * Determine relationship type based on similarity and categories
   */
  private determineRelationshipType(
    similarity: number,
    sourceCategory: string,
    targetCategory: string
  ): string {
    if (similarity >= 0.85) {
      return 'similar';
    } else if (similarity >= 0.75) {
      return 'related';
    } else if (sourceCategory === targetCategory) {
      return 'related';
    } else {
      return 'associated';
    }
  }

  /**
   * Calculate cosine similarity
   */
  private cosineSimilarity(vecA: number[], vecB: number[]): number {
    if (vecA.length !== vecB.length) {
      throw new Error('Vectors must have same dimensions');
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    if (denominator === 0) return 0;

    return dotProduct / denominator;
  }
}
