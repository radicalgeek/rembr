import { MemoryDatabase, Memory, AuthContext } from '../database.js';
import { OllamaClient } from '../ollama-client.js';

/**
 * Duplicate cluster - group of similar memories
 */
export interface DuplicateCluster {
  clusterId: string;
  memories: Array<{
    id: string;
    content: string;
    similarity: number;
    created_at: Date;
  }>;
  averageSimilarity: number;
}

/**
 * Merge result
 */
export interface MergeResult {
  keptMemoryId: string;
  mergedMemoryIds: string[];
  archivedCount: number;
}

/**
 * DeduplicationService - Detects and merges duplicate memories
 * 
 * Responsibilities:
 * - Find semantically similar memories using vector similarity
 * - Group duplicates into clusters
 * - Merge duplicates into canonical memory
 * - Archive replaced memories
 * 
 * Algorithm:
 * 1. Load all memories for tenant with embeddings
 * 2. Calculate pairwise cosine similarity
 * 3. Cluster memories above threshold (default 0.85)
 * 4. For each cluster, keep oldest memory, merge metadata
 * 5. Archive duplicates with reference to canonical memory
 */
export class DeduplicationService {
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
   * Find duplicate clusters for a tenant
   * @param tenantId Tenant to analyze
   * @param similarityThreshold Minimum similarity (0.0-1.0, default 0.85)
   * @param batchSize Number of memories to process at once
   * @returns Array of duplicate clusters
   */
  async findDuplicateClusters(
    tenantId: string,
    similarityThreshold: number = 0.85,
    batchSize: number = 100
  ): Promise<DuplicateCluster[]> {
    // Set tenant context for RLS
    await this.db.query('SELECT set_config($1, $2, FALSE)', ['app.current_tenant', tenantId]);

    // Load all memories with embeddings
    const result = await this.db.query(`
      SELECT m.id, m.content, m.created_at, m.category, me.embedding
      FROM memories m
      JOIN memory_embeddings me ON m.id = me.memory_id
      WHERE m.tenant_id = $1
      ORDER BY m.created_at ASC
      LIMIT $2
    `, [tenantId, batchSize]);

    const memories = result.rows.map((row: any) => ({
      ...row,
      embedding: this.parseEmbedding(row.embedding)
    }));
    
    if (memories.length < 2) {
      return [];
    }

    // Calculate pairwise similarity and build clusters
    const clusters: Map<string, DuplicateCluster> = new Map();
    const processed = new Set<string>();

    for (let i = 0; i < memories.length; i++) {
      if (processed.has(memories[i].id)) continue;

      const cluster: DuplicateCluster = {
        clusterId: `cluster-${i}`,
        memories: [{
          id: memories[i].id,
          content: memories[i].content,
          similarity: 1.0,
          created_at: memories[i].created_at
        }],
        averageSimilarity: 1.0
      };

      for (let j = i + 1; j < memories.length; j++) {
        if (processed.has(memories[j].id)) continue;

        const similarity = this.cosineSimilarity(
          memories[i].embedding,
          memories[j].embedding
        );

        if (similarity >= similarityThreshold) {
          cluster.memories.push({
            id: memories[j].id,
            content: memories[j].content,
            similarity,
            created_at: memories[j].created_at
          });
          processed.add(memories[j].id);
        }
      }

      // Only include clusters with 2+ memories
      if (cluster.memories.length > 1) {
        cluster.averageSimilarity = cluster.memories.reduce((sum, m) => sum + m.similarity, 0) / cluster.memories.length;
        clusters.set(cluster.clusterId, cluster);
        processed.add(memories[i].id);
      }
    }

    return Array.from(clusters.values());
  }

  /**
   * Merge duplicates in a cluster
   * Keeps oldest memory, archives others
   * @param cluster Duplicate cluster
   * @param tenantId Tenant ID
   * @returns Merge result with kept memory and archived count
   */
  async mergeDuplicates(
    cluster: DuplicateCluster,
    tenantId: string
  ): Promise<MergeResult> {
    if (cluster.memories.length < 2) {
      throw new Error('Cluster must have at least 2 memories to merge');
    }

    // Set tenant context
    await this.db.query('SELECT set_config($1, $2, FALSE)', ['app.current_tenant', tenantId]);

    // Sort by created_at to keep oldest
    const sorted = [...cluster.memories].sort((a, b) => 
      a.created_at.getTime() - b.created_at.getTime()
    );

    const canonical = sorted[0];
    const duplicates = sorted.slice(1);

    // Archive duplicates
    for (const dup of duplicates) {
      await this.archiveMemory(dup.id, canonical.id, tenantId, 'duplicate');
    }

    // Update canonical memory metadata with merge info
    await this.db.query(`
      UPDATE memories
      SET metadata = jsonb_set(
        COALESCE(metadata, '{}'::jsonb),
        '{merged_from}',
        $1::jsonb
      )
      WHERE id = $2
    `, [
      JSON.stringify(duplicates.map(d => d.id)),
      canonical.id
    ]);

    return {
      keptMemoryId: canonical.id,
      mergedMemoryIds: duplicates.map(d => d.id),
      archivedCount: duplicates.length
    };
  }

  /**
   * Archive a memory
   * @param memoryId Memory to archive
   * @param replacedById Canonical memory ID
   * @param tenantId Tenant ID
   * @param reason Archival reason
   */
  private async archiveMemory(
    memoryId: string,
    replacedById: string,
    tenantId: string,
    reason: string
  ): Promise<void> {
    // Copy memory to archived_memories
    await this.db.query(`
      INSERT INTO archived_memories (
        id, tenant_id, project_id, content, category, embedding,
        archived_reason, replaced_by_id, original_created_at, original_updated_at, metadata
      )
      SELECT 
        m.id, m.tenant_id, m.project_id, m.content, m.category, me.embedding,
        $1, $2, m.created_at, m.updated_at, m.metadata
      FROM memories m
      LEFT JOIN memory_embeddings me ON m.id = me.memory_id
      WHERE m.id = $3
    `, [reason, replacedById, memoryId]);

    // Delete from memories
    await this.db.query('DELETE FROM memories WHERE id = $1 AND tenant_id = $2', [memoryId, tenantId]);
  }

  /**
   * Calculate cosine similarity between two vectors
   * @param vecA First vector
   * @param vecB Second vector
   * @returns Similarity score (0.0-1.0)
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

  /**
   * Get deduplication statistics for tenant
   * @param tenantId Tenant ID
   * @returns Stats object
   */
  async getStats(tenantId: string): Promise<{
    totalMemories: number;
    duplicateClusters: number;
    estimatedDuplicates: number;
  }> {
    await this.db.query('SELECT set_config($1, $2, FALSE)', ['app.current_tenant', tenantId]);

    const result = await this.db.query(`
      SELECT COUNT(*) as count FROM memories WHERE tenant_id = $1
    `, [tenantId]);

    const clusters = await this.findDuplicateClusters(tenantId);

    return {
      totalMemories: parseInt(result.rows[0].count),
      duplicateClusters: clusters.length,
      estimatedDuplicates: clusters.reduce((sum, c) => sum + c.memories.length - 1, 0)
    };
  }
}
