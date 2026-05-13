/**
 * Phase 2: Context Snapshots
 * 
 * Immutable context slicing for sub-agent handoff.
 * Snapshots capture a point-in-time view of memories for RLM decomposition.
 */

import { MemoryDatabase, AuthContext } from './database.js';

export interface SnapshotOptions {
  name?: string;
  description?: string;
  query?: string;
  contextIds?: string[];
  memoryIds?: string[];
  maxTokens?: number;
  ttlHours?: number;
  projectId?: string;
}

export interface Snapshot {
  id: string;
  tenant_id: string;
  project_id: string | null;
  name: string | null;
  description: string | null;
  query: string | null;
  max_tokens: number | null;
  token_count: number;
  memory_count: number;
  created_at: Date;
  expires_at: Date | null;
  metadata: Record<string, any>;
}

export interface SnapshotMemory {
  id: string;
  snapshot_id: string;
  memory_id: string | null;
  content: string;
  category: string | null;
  metadata: Record<string, any> | null;
  relevance_score: number;
  position: number;
}

export class SnapshotService {
  constructor(private db: MemoryDatabase) {}

  /**
   * Check memory limit before creating snapshot
   */
  private async checkMemoryLimit(tenant_id: string, memoryCount: number): Promise<void> {
    const plan = await this.db.getTenantPlan(tenant_id);
    if (!plan) {
      throw new Error('Tenant plan not found');
    }

    const currentCount = await this.db.getMemoryCount(tenant_id);
    // Check if adding snapshot memories would exceed limit
    // Note: snapshots create immutable copies, so they count against storage
    if (currentCount + memoryCount > plan.memory_limit) {
      throw new Error(
        `Creating snapshot would exceed memory limit (${plan.memory_limit}). ` +
        `Current: ${currentCount}, Snapshot size: ${memoryCount}`
      );
    }
  }

  /**
   * Create an immutable snapshot of memories
   */
  async createSnapshot(
    authContext: AuthContext,
    options: SnapshotOptions
  ): Promise<{ snapshot: Snapshot; memories: SnapshotMemory[] }> {
    const { tenant_id } = authContext;
    const project_id = options.projectId || authContext.project_id || null;

    // Calculate expiration time
    const expiresAt = options.ttlHours
      ? new Date(Date.now() + options.ttlHours * 60 * 60 * 1000)
      : null;

    // Fetch memories to snapshot
    let memories: any[] = [];
    
    if (options.memoryIds && options.memoryIds.length > 0) {
      // Snapshot specific memories
      for (const memoryId of options.memoryIds) {
        const memory = await this.db.getMemoryById(memoryId, tenant_id, project_id || undefined);
        if (memory) memories.push(memory);
      }
    } else if (options.contextIds && options.contextIds.length > 0) {
      // Snapshot memories from contexts
      for (const contextId of options.contextIds) {
        const contextMemories = await this.db.getContextMemories(contextId, tenant_id);
        memories.push(...contextMemories);
      }
    } else if (options.query) {
      // Snapshot from search query  
      const searchResults = await this.db.searchMemories(
        tenant_id,
        options.query,
        undefined, // category
        options.maxTokens ? Math.floor(options.maxTokens / 100) : 50 // Rough estimate: 100 tokens per memory
      );
      memories = searchResults;
    } else {
      throw new Error('Must provide memoryIds, contextIds, or query for snapshot');
    }

    // Check memory limit before creating snapshot
    await this.checkMemoryLimit(tenant_id, memories.length);

    // Estimate token count (rough: ~4 chars per token)
    const tokenEstimate = memories.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0);

    // Create snapshot record
    const snapshotResult = await this.db.query(
      `INSERT INTO context_snapshots (
        id, tenant_id, project_id, name, description, query, max_tokens, 
        token_count, memory_count, expires_at, metadata
      ) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *`,
      [
        tenant_id,
        project_id,
        options.name || null,
        options.description || null,
        options.query || null,
        options.maxTokens || null,
        tokenEstimate,
        memories.length,
        expiresAt,
        JSON.stringify(options)
      ],
      tenant_id
    );

    const snapshot = snapshotResult.rows[0];

    // Create immutable memory copies
    const snapshotMemories: SnapshotMemory[] = [];
    for (let i = 0; i < memories.length; i++) {
      const memory = memories[i];
      const result = await this.db.query(
        `INSERT INTO snapshot_memories (
          id, snapshot_id, memory_id, content, category, metadata, relevance_score, position
        ) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7)
        RETURNING *`,
        [
          snapshot.id,
          memory.id,
          memory.content,
          memory.category || null,
          memory.metadata ? JSON.stringify(memory.metadata) : null,
          memory.relevance_score || 1.0,
          i
        ],
        tenant_id
      );
      snapshotMemories.push(result.rows[0]);
    }

    // Link contexts if provided
    if (options.contextIds && options.contextIds.length > 0) {
      for (const contextId of options.contextIds) {
        await this.db.query(
          `INSERT INTO snapshot_contexts (snapshot_id, context_id)
          VALUES ($1, $2)
          ON CONFLICT DO NOTHING`,
          [snapshot.id, contextId],
          tenant_id
        );
      }
    }

    return { snapshot, memories: snapshotMemories };
  }

  /**
   * Get a snapshot by ID
   */
  async getSnapshot(
    snapshotId: string,
    authContext: AuthContext
  ): Promise<{ snapshot: Snapshot; memories: SnapshotMemory[] } | null> {
    const { tenant_id } = authContext;

    // Get snapshot
    const snapshotResult = await this.db.query(
      `SELECT * FROM context_snapshots WHERE id = $1`,
      [snapshotId],
      tenant_id
    );

    if (snapshotResult.rows.length === 0) {
      return null;
    }

    const snapshot = snapshotResult.rows[0];

    // Check if expired
    if (snapshot.expires_at && new Date(snapshot.expires_at) < new Date()) {
      await this.deleteSnapshot(snapshotId, authContext);
      return null;
    }

    // Get memories
    const memoriesResult = await this.db.query(
      `SELECT * FROM snapshot_memories WHERE snapshot_id = $1 ORDER BY position`,
      [snapshotId],
      tenant_id
    );

    return {
      snapshot,
      memories: memoriesResult.rows
    };
  }

  /**
   * Search snapshots
   */
  async searchSnapshots(
    authContext: AuthContext,
    query?: string,
    projectId?: string,
    limit: number = 10
  ): Promise<Snapshot[]> {
    const { tenant_id } = authContext;
    const project_id = projectId || authContext.project_id || null;
    

    let sql = `SELECT * FROM context_snapshots WHERE tenant_id = $1`;
    const params: any[] = [tenant_id];

    if (project_id) {
      sql += ` AND project_id = $${params.length + 1}`;
      params.push(project_id);
    }

    if (query) {
      sql += ` AND (name ILIKE $${params.length + 1} OR description ILIKE $${params.length + 1})`;
      params.push(`%${query}%`);
    }

    // Exclude expired snapshots
    sql += ` AND (expires_at IS NULL OR expires_at > NOW())`;

    sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    const result = await this.db.query(sql, params, tenant_id);
    return result.rows;
  }

  /**
   * Delete a snapshot
   */
  async deleteSnapshot(snapshotId: string, authContext: AuthContext): Promise<boolean> {
    const { tenant_id } = authContext;
    

    const result = await this.db.query(
      `DELETE FROM context_snapshots WHERE id = $1`,
      [snapshotId],
      tenant_id
    );

    return result.rowCount! > 0;
  }

  /**
   * Clean up expired snapshots
   */
  async cleanExpiredSnapshots(authContext: AuthContext): Promise<number> {
    const { tenant_id } = authContext;
    

    const result = await this.db.query(
      `DELETE FROM context_snapshots 
       WHERE expires_at IS NOT NULL AND expires_at < NOW()`,
      [],
      tenant_id
    );

    return result.rowCount || 0;
  }

  /**
   * List all snapshots
   */
  async listSnapshots(
    authContext: AuthContext,
    projectId?: string,
    limit: number = 10
  ): Promise<Snapshot[]> {
    const { tenant_id } = authContext;
    const project_id = projectId || authContext.project_id || null;
    

    let sql = `SELECT * FROM context_snapshots WHERE tenant_id = $1`;
    const params: any[] = [tenant_id];

    if (project_id) {
      sql += ` AND project_id = $${params.length + 1}`;
      params.push(project_id);
    }

    // Exclude expired
    sql += ` AND (expires_at IS NULL OR expires_at > NOW())`;

    sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    const result = await this.db.query(sql, params, tenant_id);
    return result.rows;
  }
}
