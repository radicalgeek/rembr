/**
 * Temporal Query Service
 * 
 * Enables point-in-time queries ("time travel") for debugging RLM decisions.
 * Tracks memory version history and creates snapshots.
 */

import { Pool } from 'pg';

export interface Memory {
  id: string;
  tenant_id: string;
  project_id?: string;
  content: string;
  category?: string;
  embedding?: number[];
  metadata?: any;
  created_at: Date;
  valid_from: Date;
  valid_until?: Date;
}

export interface MemoryVersion {
  content: string;
  category?: string;
  valid_from: Date;
  valid_until?: Date;
  metadata?: any;
  updated_at: Date;
  status: 'current' | 'historical';
}

export interface SnapshotDiff {
  timeA: Date;
  timeB: Date;
  added: number;
  removed: number;
  modified: number;
  details: {
    added: Memory[];
    removed: Memory[];
    modified: Array<{ before: Memory; after: Memory }>;
  };
}

export interface SearchOptions {
  embedding: number[];
  projectId?: string;
  category?: string;
  limit?: number;
}

export class TemporalQueryService {
  constructor(private db: Pool) {}

  /**
   * Search memories as they existed at a specific point in time
   */
  async searchAtTime(
    tenantId: string,
    query: string,
    asOfTime: Date,
    options: SearchOptions
  ): Promise<Memory[]> {
    const asOfTimeISO = asOfTime.toISOString();
    const params: any[] = [tenantId];
    let paramIndex = 2;

    let whereClause = `
      WHERE m.tenant_id = $1
        AND m.valid_from <= $${paramIndex}
        AND (m.valid_until IS NULL OR m.valid_until > $${paramIndex})
    `;
    params.push(asOfTimeISO);
    paramIndex++;

    if (options.projectId) {
      whereClause += ` AND m.project_id = $${paramIndex}`;
      params.push(options.projectId);
      paramIndex++;
    }

    if (options.category) {
      whereClause += ` AND m.category = $${paramIndex}`;
      params.push(options.category);
      paramIndex++;
    }

    // Use search_memories_at_time function if we have embedding
    if (options.embedding) {
      const querySQL = `
        SELECT * FROM search_memories_at_time(
          $1::uuid, 
          $2::vector(768), 
          $3::timestamptz,
          $4::uuid,
          $5::varchar(50),
          $6::integer
        )
      `;

      const result = await this.db.query(querySQL, [
        tenantId,
        `[${options.embedding.join(',')}]`,
        asOfTimeISO,
        options.projectId || null,
        options.category || null,
        options.limit || 10
      ]);

      return result.rows;
    }

    // Fall back to simple query without embedding
    const querySQL = `
      SELECT m.*
      FROM memories m
      ${whereClause}
      ORDER BY m.created_at DESC
      LIMIT $${paramIndex}
    `;
    params.push(options.limit || 10);

    const result = await this.db.query(querySQL, params);
    return result.rows;
  }

  /**
   * Get memory state at specific time
   */
  async getMemoryAtTime(
    tenantId: string,
    memoryId: string,
    asOfTime: Date,
    projectId?: string
  ): Promise<Memory | null> {
    const asOfTimeISO = asOfTime.toISOString();
    const query = `
      SELECT * FROM memories
      WHERE id = $1
        AND tenant_id = $2
        AND ($3::uuid IS NULL OR project_id = $3)
        AND valid_from <= $4
        AND (valid_until IS NULL OR valid_until > $4)
      LIMIT 1
    `;

    const result = await this.db.query(query, [memoryId, tenantId, projectId, asOfTimeISO]);
    return result.rows[0] || null;
  }

  /**
   * Get memory version history
   */
  async getMemoryHistory(
    tenantId: string,
    memoryId: string,
    projectId?: string
  ): Promise<MemoryVersion[]> {
    const query = `
      SELECT 
        content, 
        category, 
        valid_from, 
        valid_until,
        metadata, 
        updated_at,
        CASE 
          WHEN valid_until IS NULL THEN 'current'
          ELSE 'historical'
        END as status
      FROM memories
      WHERE id = $1
        AND tenant_id = $2
        AND ($3::uuid IS NULL OR project_id = $3)
      ORDER BY valid_from DESC
    `;

    const result = await this.db.query(query, [memoryId, tenantId, projectId]);
    return result.rows;
  }

  /**
   * Create named snapshot for fast temporal queries
   */
  async createSnapshot(
    tenantId: string,
    snapshotName: string,
    snapshotTime?: Date,
    projectId?: string,
    userId?: string
  ): Promise<string> {
    const snapTime = snapshotTime || new Date();
    const snapTimeISO = snapTime.toISOString();
    
    // Count memories at snapshot time
    const statsQuery = `
      SELECT 
        COUNT(*) as total,
        category,
        COUNT(*) FILTER (WHERE category IS NOT NULL) as cat_count
      FROM memories
      WHERE tenant_id = $1
        AND ($2::uuid IS NULL OR project_id = $2)
        AND valid_from <= $3
        AND (valid_until IS NULL OR valid_until > $3)
      GROUP BY category
    `;

    const statsResult = await this.db.query(statsQuery, [tenantId, projectId, snapTimeISO]);

    const categoriesSnapshot = statsResult.rows.reduce((acc: any, row: any) => {
      acc[row.category || 'uncategorized'] = parseInt(row.cat_count);
      return acc;
    }, {});

    const totalMemories = statsResult.rows.reduce((sum: number, r: any) => 
      sum + parseInt(r.cat_count), 0
    );

    const insertQuery = `
      INSERT INTO temporal_snapshots 
      (tenant_id, project_id, snapshot_name, snapshot_time, total_memories, categories_snapshot, created_by_user_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id
    `;

    const result = await this.db.query(insertQuery, [
      tenantId, 
      projectId, 
      snapshotName, 
      snapTimeISO,
      totalMemories,
      JSON.stringify(categoriesSnapshot),
      userId || null
    ]);

    return result.rows[0].id;
  }

  /**
   * Get snapshot by name
   */
  async getSnapshot(
    tenantId: string,
    snapshotName: string
  ): Promise<any> {
    const query = `
      SELECT * FROM temporal_snapshots
      WHERE tenant_id = $1 AND snapshot_name = $2
      LIMIT 1
    `;

    const result = await this.db.query(query, [tenantId, snapshotName]);
    return result.rows[0] || null;
  }

  /**
   * List snapshots for tenant
   */
  async listSnapshots(
    tenantId: string,
    projectId?: string,
    limit: number = 50
  ): Promise<any[]> {
    const query = `
      SELECT 
        id,
        snapshot_name,
        snapshot_time,
        total_memories,
        categories_snapshot,
        created_at
      FROM temporal_snapshots
      WHERE tenant_id = $1
        AND ($2::uuid IS NULL OR project_id = $2)
      ORDER BY snapshot_time DESC
      LIMIT $3
    `;

    const result = await this.db.query(query, [tenantId, projectId, limit]);
    return result.rows;
  }

  /**
   * Delete snapshot
   */
  async deleteSnapshot(
    tenantId: string,
    snapshotId: string
  ): Promise<void> {
    const query = `
      DELETE FROM temporal_snapshots
      WHERE id = $1 AND tenant_id = $2
    `;

    await this.db.query(query, [snapshotId, tenantId]);
  }

  /**
   * Compare knowledge graph between two timestamps
   */
  async compareSnapshots(
    tenantId: string,
    timeA: Date,
    timeB: Date,
    projectId?: string
  ): Promise<SnapshotDiff> {
    const [memoriesA, memoriesB] = await Promise.all([
      this.getMemoriesAtTime(tenantId, timeA, projectId),
      this.getMemoriesAtTime(tenantId, timeB, projectId)
    ]);

    // Create maps for efficient lookup
    const mapA = new Map(memoriesA.map(m => [m.id, m]));
    const mapB = new Map(memoriesB.map(m => [m.id, m]));

    const added = memoriesB.filter(m => !mapA.has(m.id));
    const removed = memoriesA.filter(m => !mapB.has(m.id));
    
    const modified: Array<{ before: Memory; after: Memory }> = [];
    for (const [id, memB] of mapB.entries()) {
      const memA = mapA.get(id);
      if (memA && memA.content !== memB.content) {
        modified.push({ before: memA, after: memB });
      }
    }

    return {
      timeA,
      timeB,
      added: added.length,
      removed: removed.length,
      modified: modified.length,
      details: { added, removed, modified }
    };
  }

  private async getMemoriesAtTime(
    tenantId: string,
    asOfTime: Date,
    projectId?: string
  ): Promise<Memory[]> {
    const asOfTimeISO = asOfTime.toISOString();
    const query = `
      SELECT * FROM memories
      WHERE tenant_id = $1
        AND ($2::uuid IS NULL OR project_id = $2)
        AND valid_from <= $3
        AND (valid_until IS NULL OR valid_until > $3)
      ORDER BY created_at DESC
    `;

    const result = await this.db.query(query, [tenantId, projectId, asOfTimeISO]);
    return result.rows;
  }

  /**
   * Get temporal statistics
   */
  async getTemporalStats(
    tenantId: string,
    projectId?: string
  ): Promise<any> {
    const query = `
      SELECT 
        COUNT(DISTINCT id) as total_unique_memories,
        COUNT(*) as total_versions,
        AVG(EXTRACT(EPOCH FROM (COALESCE(valid_until, NOW()) - valid_from))) as avg_version_lifetime_seconds,
        COUNT(*) FILTER (WHERE valid_until IS NULL) as current_versions,
        COUNT(*) FILTER (WHERE valid_until IS NOT NULL) as historical_versions
      FROM memories
      WHERE tenant_id = $1
        AND ($2::uuid IS NULL OR project_id = $2)
    `;

    const result = await this.db.query(query, [tenantId, projectId]);
    
    const stats = result.rows[0];
    return {
      unique_memories: parseInt(stats.total_unique_memories),
      total_versions: parseInt(stats.total_versions),
      current_versions: parseInt(stats.current_versions),
      historical_versions: parseInt(stats.historical_versions),
      avg_version_lifetime_hours: parseFloat(stats.avg_version_lifetime_seconds) / 3600
    };
  }

  /**
   * Rollback memory to specific time (creates new version)
   */
  async rollbackMemory(
    tenantId: string,
    memoryId: string,
    rollbackToTime: Date,
    projectId?: string
  ): Promise<Memory | null> {
    // Get the memory version at the rollback time
    const historicalVersion = await this.getMemoryAtTime(tenantId, memoryId, rollbackToTime, projectId);
    
    if (!historicalVersion) {
      return null;
    }

    // Close current version
    const closeQuery = `
      UPDATE memories
      SET valid_until = NOW()
      WHERE id = $1 
        AND tenant_id = $2
        AND valid_until IS NULL
    `;
    
    await this.db.query(closeQuery, [memoryId, tenantId]);

    // Insert new version with historical content
    const insertQuery = `
      INSERT INTO memories (
        id, tenant_id, project_id, user_id, content, category, 
        embedding, metadata, valid_from, created_at
      ) 
      SELECT 
        id, tenant_id, project_id, user_id, content, category,
        embedding, metadata, NOW(), created_at
      FROM memories
      WHERE id = $1 
        AND tenant_id = $2
        AND valid_from = $3
      RETURNING *
    `;

    const result = await this.db.query(insertQuery, [
      memoryId, 
      tenantId, 
      historicalVersion.valid_from
    ]);

    return result.rows[0] || null;
  }
}
