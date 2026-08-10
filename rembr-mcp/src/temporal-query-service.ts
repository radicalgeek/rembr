/**
 * Temporal Query Service
 * 
 * Enables point-in-time queries ("time travel") for debugging RLM decisions.
 * Tracks memory version history and creates snapshots.
 */

import { Pool, PoolClient } from 'pg';

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
  embedding?: number[];
  projectId?: string;
  userId?: string;
  category?: string;
  limit?: number;
}

export class TemporalQueryService {
  constructor(private db: Pool) {}

  private async withTenantContext<T>(
    tenantId: string,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [tenantId]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

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
    const params: any[] = [tenantId, asOfTimeISO, options.projectId || null, options.userId || null];
    let paramIndex = 5;

    let whereClause = `
      WHERE m.tenant_id = $1
        AND m.valid_from <= $2
        AND (m.valid_until IS NULL OR m.valid_until > $2)
        AND ($3::uuid IS NULL OR m.project_id = $3::uuid)
        AND (
          (COALESCE(m.visibility, 'shared') = 'personal' AND m.user_id = $4::uuid)
          OR (COALESCE(m.visibility, 'shared') IN ('shared', 'project') AND (
            p.id IS NULL OR p.is_personal = false OR p.owner_id = $4::uuid
            OR EXISTS (SELECT 1 FROM project_members pm
                       WHERE pm.project_id = p.id AND pm.user_id = $4::uuid)
          ))
        )
    `;

    if (options.category) {
      whereClause += ` AND m.category = $${paramIndex}`;
      params.push(options.category);
      paramIndex++;
    }

    const hasEmbedding = Array.isArray(options.embedding) && options.embedding.length > 0;
    const embeddingParam = hasEmbedding ? paramIndex++ : null;
    if (hasEmbedding) {
      params.push(`[${options.embedding!.join(',')}]`);
      whereClause += ` AND m.embedding IS NOT NULL`;
    }
    const limitParam = paramIndex;
    params.push(options.limit || 10);

    // Direct querying keeps the user/project audience in the same statement
    // as the point-in-time and vector predicates.
    const querySQL = `
      SELECT m.*${hasEmbedding ? `, (m.embedding <=> $${embeddingParam}::vector) AS distance` : ''}
      FROM memories m
      LEFT JOIN projects p ON p.id = m.project_id AND p.tenant_id = m.tenant_id
      ${whereClause}
      ORDER BY ${hasEmbedding ? `m.embedding <=> $${embeddingParam}::vector` : 'm.created_at DESC'}
      LIMIT $${limitParam}
    `;

    const result = await this.withTenantContext(tenantId, client => client.query(querySQL, params));
    return result.rows;
  }

  /**
   * Get memory state at specific time
   */
  async getMemoryAtTime(
    tenantId: string,
    memoryId: string,
    asOfTime: Date,
    projectId?: string,
    userId?: string,
  ): Promise<Memory | null> {
    const asOfTimeISO = asOfTime.toISOString();
    const query = `
      SELECT m.* FROM memories m
      LEFT JOIN projects p ON p.id = m.project_id AND p.tenant_id = m.tenant_id
      WHERE m.id = $1
        AND m.tenant_id = $2
        AND ($3::uuid IS NULL OR m.project_id = $3::uuid)
        AND m.valid_from <= $4
        AND (m.valid_until IS NULL OR m.valid_until > $4)
        AND (
          (COALESCE(m.visibility, 'shared') = 'personal' AND m.user_id = $5::uuid)
          OR (COALESCE(m.visibility, 'shared') IN ('shared', 'project') AND (
            p.id IS NULL OR p.is_personal = false OR p.owner_id = $5::uuid
            OR EXISTS (SELECT 1 FROM project_members pm
                       WHERE pm.project_id = p.id AND pm.user_id = $5::uuid)
          ))
        )
      LIMIT 1
    `;

    const result = await this.withTenantContext(tenantId, client => client.query(
      query,
      [memoryId, tenantId, projectId || null, asOfTimeISO, userId || null],
    ));
    return result.rows[0] || null;
  }

  /**
   * Get memory version history
   */
  async getMemoryHistory(
    tenantId: string,
    memoryId: string,
    projectId?: string,
    userId?: string,
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
      FROM memories m
      LEFT JOIN projects p ON p.id = m.project_id AND p.tenant_id = m.tenant_id
      WHERE m.id = $1
        AND m.tenant_id = $2
        AND ($3::uuid IS NULL OR m.project_id = $3::uuid)
        AND (
          (COALESCE(m.visibility, 'shared') = 'personal' AND m.user_id = $4::uuid)
          OR (COALESCE(m.visibility, 'shared') IN ('shared', 'project') AND (
            p.id IS NULL OR p.is_personal = false OR p.owner_id = $4::uuid
            OR EXISTS (SELECT 1 FROM project_members pm
                       WHERE pm.project_id = p.id AND pm.user_id = $4::uuid)
          ))
        )
      ORDER BY m.valid_from DESC
      LIMIT 100
    `;

    const result = await this.withTenantContext(tenantId, client => client.query(
      query,
      [memoryId, tenantId, projectId || null, userId || null],
    ));
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
      FROM memories m
      LEFT JOIN projects p ON p.id = m.project_id AND p.tenant_id = m.tenant_id
      WHERE m.tenant_id = $1
        AND ($2::uuid IS NULL OR m.project_id = $2::uuid)
        AND m.valid_from <= $3
        AND (m.valid_until IS NULL OR m.valid_until > $3)
        AND (
          (COALESCE(m.visibility, 'shared') = 'personal' AND m.user_id = $4::uuid)
          OR (COALESCE(m.visibility, 'shared') IN ('shared', 'project') AND (
            p.id IS NULL OR p.is_personal = false OR p.owner_id = $4::uuid
            OR EXISTS (SELECT 1 FROM project_members pm
                       WHERE pm.project_id = p.id AND pm.user_id = $4::uuid)
          ))
        )
      GROUP BY m.category
    `;

    const insertQuery = `
      INSERT INTO temporal_snapshots 
      (tenant_id, project_id, snapshot_name, snapshot_time, total_memories, categories_snapshot, created_by_user_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id
    `;

    return this.withTenantContext(tenantId, async client => {
      const statsResult = await client.query(
        statsQuery,
        [tenantId, projectId || null, snapTimeISO, userId || null],
      );
      const categoriesSnapshot = statsResult.rows.reduce((acc: any, row: any) => {
        acc[row.category || 'uncategorized'] = parseInt(row.cat_count);
        return acc;
      }, {});
      const totalMemories = statsResult.rows.reduce(
        (sum: number, row: any) => sum + parseInt(row.cat_count),
        0,
      );
      const result = await client.query(insertQuery, [
        tenantId,
        projectId || null,
        snapshotName,
        snapTimeISO,
        totalMemories,
        JSON.stringify(categoriesSnapshot),
        userId || null,
      ]);
      return result.rows[0].id;
    });
  }

  /**
   * Get snapshot by name
   */
  async getSnapshot(
    tenantId: string,
    snapshotName: string,
    projectId?: string,
    userId?: string,
  ): Promise<any> {
    const query = `
      SELECT ts.* FROM temporal_snapshots ts
      LEFT JOIN projects p ON p.id = ts.project_id AND p.tenant_id = ts.tenant_id
      WHERE ts.tenant_id = $1 AND ts.snapshot_name = $2
        AND ($3::uuid IS NULL OR ts.project_id = $3::uuid)
        AND (ts.created_by_user_id IS NULL OR ts.created_by_user_id = $4::uuid)
        AND (p.id IS NULL OR p.is_personal = false OR p.owner_id = $4::uuid
             OR EXISTS (SELECT 1 FROM project_members pm
                        WHERE pm.project_id = p.id AND pm.user_id = $4::uuid))
      LIMIT 1
    `;

    const result = await this.withTenantContext(tenantId, client => client.query(
      query,
      [tenantId, snapshotName, projectId || null, userId || null],
    ));
    return result.rows[0] || null;
  }

  /**
   * List snapshots for tenant
   */
  async listSnapshots(
    tenantId: string,
    projectId?: string,
    limit: number = 50,
    userId?: string,
  ): Promise<any[]> {
    const query = `
      SELECT 
        id,
        snapshot_name,
        snapshot_time,
        total_memories,
        categories_snapshot,
        created_at
      FROM temporal_snapshots ts
      LEFT JOIN projects p ON p.id = ts.project_id AND p.tenant_id = ts.tenant_id
      WHERE ts.tenant_id = $1
        AND ($2::uuid IS NULL OR ts.project_id = $2::uuid)
        AND (ts.created_by_user_id IS NULL OR ts.created_by_user_id = $4::uuid)
        AND (p.id IS NULL OR p.is_personal = false OR p.owner_id = $4::uuid
             OR EXISTS (SELECT 1 FROM project_members pm
                        WHERE pm.project_id = p.id AND pm.user_id = $4::uuid))
      ORDER BY ts.snapshot_time DESC
      LIMIT $3
    `;

    const result = await this.withTenantContext(tenantId, client => client.query(
      query,
      [tenantId, projectId || null, limit, userId || null],
    ));
    return result.rows;
  }

  /**
   * Delete snapshot
   */
  async deleteSnapshot(
    tenantId: string,
    snapshotId: string,
    projectId?: string,
    userId?: string,
  ): Promise<void> {
    const query = `
      DELETE FROM temporal_snapshots ts
      WHERE ts.id = $1 AND ts.tenant_id = $2
        AND ($3::uuid IS NULL OR ts.project_id = $3::uuid)
        AND ts.created_by_user_id = $4::uuid
        AND (
          ts.project_id IS NULL OR EXISTS (
            SELECT 1 FROM projects p
            WHERE p.id = ts.project_id AND p.tenant_id = ts.tenant_id
              AND (p.is_personal = false OR p.owner_id = $4::uuid
                   OR EXISTS (SELECT 1 FROM project_members pm
                              WHERE pm.project_id = p.id AND pm.user_id = $4::uuid))
          )
        )
    `;

    await this.withTenantContext(tenantId, client =>
      client.query(query, [snapshotId, tenantId, projectId || null, userId || null])
    );
  }

  /**
   * Compare knowledge graph between two timestamps
   */
  async compareSnapshots(
    tenantId: string,
    timeA: Date,
    timeB: Date,
    projectId?: string,
    userId?: string,
  ): Promise<SnapshotDiff> {
    const [memoriesA, memoriesB] = await Promise.all([
      this.getMemoriesAtTime(tenantId, timeA, projectId, userId),
      this.getMemoriesAtTime(tenantId, timeB, projectId, userId)
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
    projectId?: string,
    userId?: string,
  ): Promise<Memory[]> {
    const asOfTimeISO = asOfTime.toISOString();
    const query = `
      SELECT m.* FROM memories m
      LEFT JOIN projects p ON p.id = m.project_id AND p.tenant_id = m.tenant_id
      WHERE m.tenant_id = $1
        AND ($2::uuid IS NULL OR m.project_id = $2::uuid)
        AND m.valid_from <= $3
        AND (m.valid_until IS NULL OR m.valid_until > $3)
        AND (
          (COALESCE(m.visibility, 'shared') = 'personal' AND m.user_id = $4::uuid)
          OR (COALESCE(m.visibility, 'shared') IN ('shared', 'project') AND (
            p.id IS NULL OR p.is_personal = false OR p.owner_id = $4::uuid
            OR EXISTS (SELECT 1 FROM project_members pm
                       WHERE pm.project_id = p.id AND pm.user_id = $4::uuid)
          ))
        )
      ORDER BY m.created_at DESC
    `;

    const result = await this.withTenantContext(tenantId, client => client.query(
      query,
      [tenantId, projectId || null, asOfTimeISO, userId || null],
    ));
    return result.rows;
  }

  /**
   * Get temporal statistics
   */
  async getTemporalStats(
    tenantId: string,
    projectId?: string,
    userId?: string,
  ): Promise<any> {
    const query = `
      SELECT 
        COUNT(DISTINCT id) as total_unique_memories,
        COUNT(*) as total_versions,
        AVG(EXTRACT(EPOCH FROM (COALESCE(valid_until, NOW()) - valid_from))) as avg_version_lifetime_seconds,
        COUNT(*) FILTER (WHERE valid_until IS NULL) as current_versions,
        COUNT(*) FILTER (WHERE valid_until IS NOT NULL) as historical_versions
      FROM memories m
      LEFT JOIN projects p ON p.id = m.project_id AND p.tenant_id = m.tenant_id
      WHERE m.tenant_id = $1
        AND ($2::uuid IS NULL OR m.project_id = $2::uuid)
        AND (
          (COALESCE(m.visibility, 'shared') = 'personal' AND m.user_id = $3::uuid)
          OR (COALESCE(m.visibility, 'shared') IN ('shared', 'project') AND (
            p.id IS NULL OR p.is_personal = false OR p.owner_id = $3::uuid
            OR EXISTS (SELECT 1 FROM project_members pm
                       WHERE pm.project_id = p.id AND pm.user_id = $3::uuid)
          ))
        )
    `;

    const result = await this.withTenantContext(tenantId, client => client.query(
      query,
      [tenantId, projectId || null, userId || null],
    ));
    
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
    projectId?: string,
    userId?: string,
  ): Promise<Memory | null> {
    // Get the memory version at the rollback time
    const historicalVersion = await this.getMemoryAtTime(
      tenantId,
      memoryId,
      rollbackToTime,
      projectId,
      userId,
    );
    
    if (!historicalVersion) {
      return null;
    }

    // Close current version
    const closeQuery = `
      UPDATE memories m
      SET valid_until = NOW()
      WHERE m.id = $1
        AND m.tenant_id = $2
        AND ($3::uuid IS NULL OR m.project_id = $3::uuid)
        AND m.valid_until IS NULL
        AND (
          (COALESCE(m.visibility, 'shared') = 'personal' AND m.user_id = $4::uuid)
          OR (COALESCE(m.visibility, 'shared') IN ('shared', 'project') AND (
            m.project_id IS NULL OR EXISTS (
              SELECT 1 FROM projects p
              WHERE p.id = m.project_id AND p.tenant_id = m.tenant_id
                AND (p.is_personal = false OR p.owner_id = $4::uuid
                     OR EXISTS (SELECT 1 FROM project_members pm
                                WHERE pm.project_id = p.id AND pm.user_id = $4::uuid))
            )
          ))
        )
    `;

    // Insert new version with historical content
    const insertQuery = `
      INSERT INTO memories (
        id, tenant_id, project_id, user_id, content, category,
        embedding, metadata, visibility, valid_from, created_at
      ) 
      SELECT 
        m.id, m.tenant_id, m.project_id, m.user_id, m.content, m.category,
        m.embedding, m.metadata, m.visibility, NOW(), m.created_at
      FROM memories m
      WHERE m.id = $1
        AND m.tenant_id = $2
        AND ($3::uuid IS NULL OR m.project_id = $3::uuid)
        AND m.valid_from = $5
        AND (
          (COALESCE(m.visibility, 'shared') = 'personal' AND m.user_id = $4::uuid)
          OR (COALESCE(m.visibility, 'shared') IN ('shared', 'project') AND (
            m.project_id IS NULL OR EXISTS (
              SELECT 1 FROM projects p
              WHERE p.id = m.project_id AND p.tenant_id = m.tenant_id
                AND (p.is_personal = false OR p.owner_id = $4::uuid
                     OR EXISTS (SELECT 1 FROM project_members pm
                                WHERE pm.project_id = p.id AND pm.user_id = $4::uuid))
            )
          ))
        )
      RETURNING *
    `;

    return this.withTenantContext(tenantId, async client => {
      const closeResult = await client.query(
        closeQuery,
        [memoryId, tenantId, projectId || null, userId || null],
      );
      if (closeResult.rowCount === 0) return null;
      const result = await client.query(insertQuery, [
        memoryId,
        tenantId,
        projectId || null,
        userId || null,
        historicalVersion.valid_from,
      ]);
      return result.rows[0] || null;
    });
  }
}
