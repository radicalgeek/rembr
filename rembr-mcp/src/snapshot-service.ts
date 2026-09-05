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
  user_id?: string | null;
  visibility?: 'personal' | 'shared' | 'project';
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
  project_id?: string | null;
  user_id?: string | null;
  visibility?: 'personal' | 'shared' | 'project';
  content: string;
  category: string | null;
  metadata: Record<string, any> | null;
  relevance_score: number;
  position: number;
}

export const HARD_SNAPSHOT_MAX_ITEMS = 500;
export const HARD_SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;
export const HARD_SNAPSHOT_MAX_TOKENS = 200_000;
export const SNAPSHOT_PAGE_MAX_ITEMS = 25;
export const SNAPSHOT_PAGE_MAX_BYTES = 1024 * 1024;

export class SnapshotService {
  constructor(private db: MemoryDatabase) {}

  private assertSourceBounds(stats: any, expectedCount?: number): void {
    const count = Number(stats?.source_count || 0);
    const bytes = Number(stats?.source_bytes || 0);
    const tokens = Number(stats?.source_tokens || 0);
    if (![count, bytes, tokens].every(Number.isSafeInteger)
        || count < 0 || bytes < 0 || tokens < 0) {
      throw new Error('Snapshot source statistics are invalid');
    }
    if (expectedCount !== undefined && count !== expectedCount) {
      throw new Error('One or more snapshot memories were not found or access was denied');
    }
    if (count > HARD_SNAPSHOT_MAX_ITEMS
        || bytes > HARD_SNAPSHOT_MAX_BYTES
        || tokens > HARD_SNAPSHOT_MAX_TOKENS) {
      throw new Error(
        `Snapshot source exceeds the hard copy boundary (${HARD_SNAPSHOT_MAX_ITEMS} items, ` +
        `${HARD_SNAPSHOT_MAX_BYTES} bytes, ${HARD_SNAPSHOT_MAX_TOKENS} tokens)`,
      );
    }
  }

  private assertMaterialisedBounds(memories: any[]): void {
    const stats = memories.reduce((acc, memory) => {
      const content = String(memory.content || '');
      acc.source_count += 1;
      acc.source_bytes += Buffer.byteLength(content, 'utf8');
      acc.source_tokens += Math.ceil(content.length / 4);
      return acc;
    }, { source_count: 0, source_bytes: 0, source_tokens: 0 });
    this.assertSourceBounds(stats);
  }

  /**
   * Create an immutable snapshot of memories
   */
  async createSnapshot(
    authContext: AuthContext,
    options: SnapshotOptions
  ): Promise<{ snapshot: Snapshot; memories: SnapshotMemory[] }> {
    const { tenant_id } = authContext;
    let project_id = options.projectId || authContext.project_id || null;

    if (authContext.project_id && project_id !== authContext.project_id) {
      throw new Error('Snapshot project is outside the credential scope');
    }

    // Search determines candidate IDs outside the write transaction; every
    // candidate is re-authorised and copied under row locks below.
    let queryCandidateIds: string[] = [];
    if (!options.memoryIds?.length && !options.contextIds?.length && options.query) {
      const searchResults = await this.db.searchMemories(
        tenant_id,
        options.query,
        undefined,
        options.maxTokens ? Math.min(500, Math.floor(options.maxTokens / 100)) : 50,
        false,
        undefined,
        authContext.user_id,
        project_id || undefined,
      );
      queryCandidateIds = searchResults.map(memory => memory.id);
    }

    const expiresAt = options.ttlHours
      ? new Date(Date.now() + options.ttlHours * 60 * 60 * 1000)
      : null;

    if (!options.memoryIds?.length && !options.contextIds?.length && !options.query) {
      throw new Error('Must provide memoryIds, contextIds, or query for snapshot');
    }

    return this.db.withTenantTransaction(tenant_id, async client => {
      // One lock serialises cleanup, count and insert for every snapshot in the
      // tenant. Concurrent requests therefore cannot both spend the same quota.
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [`storage-quota:${tenant_id}`],
      );

      if (project_id) {
        const access = await client.query(
          `SELECT 1 FROM projects p
           WHERE p.id = $1 AND p.tenant_id = $2
             AND (p.is_personal = false OR p.owner_id = $3::uuid
                  OR EXISTS (SELECT 1 FROM project_members pm
                             WHERE pm.project_id = p.id AND pm.user_id = $3::uuid))`,
          [project_id, tenant_id, authContext.user_id || null],
        );
        if (access.rows.length === 0) throw new Error('Snapshot project not found or access denied');
      }

      const selectedContextIds = [...new Set(options.contextIds || [])];
      let memories: any[] = [];

      if (options.memoryIds?.length) {
        const requestedIds = [...new Set(options.memoryIds)];
        if (requestedIds.length > HARD_SNAPSHOT_MAX_ITEMS) {
          throw new Error(`Snapshot may copy at most ${HARD_SNAPSHOT_MAX_ITEMS} memories`);
        }
        const stats = await client.query(
          `SELECT COUNT(*)::int AS source_count,
                  COALESCE(SUM(octet_length(m.content)), 0)::bigint AS source_bytes,
                  COALESCE(SUM(CEIL(char_length(m.content)::numeric / 4)), 0)::bigint AS source_tokens
           FROM memories m
           LEFT JOIN projects p ON p.id = m.project_id AND p.tenant_id = m.tenant_id
           WHERE m.tenant_id = $1
             AND m.id = ANY($2::uuid[])
             AND ($3::uuid IS NULL OR m.project_id = $3::uuid)
             AND (
               (COALESCE(m.visibility, 'shared') = 'personal' AND m.user_id = $4::uuid)
               OR (COALESCE(m.visibility, 'shared') = 'shared' AND m.project_id IS NULL)
               OR (COALESCE(m.visibility, 'shared') IN ('shared', 'project')
                   AND p.id IS NOT NULL
                   AND (p.is_personal = false OR p.owner_id = $4::uuid
                        OR EXISTS (SELECT 1 FROM project_members pm
                                   WHERE pm.project_id = p.id AND pm.user_id = $4::uuid)))
             )`,
          [tenant_id, requestedIds, project_id, authContext.user_id || null],
        );
        this.assertSourceBounds(stats.rows[0], requestedIds.length);
        const result = await client.query(
          `SELECT m.* FROM memories m
           LEFT JOIN projects p ON p.id = m.project_id AND p.tenant_id = m.tenant_id
           WHERE m.tenant_id = $1
             AND m.id = ANY($2::uuid[])
             AND ($3::uuid IS NULL OR m.project_id = $3::uuid)
             AND (
               (COALESCE(m.visibility, 'shared') = 'personal' AND m.user_id = $4::uuid)
               OR (COALESCE(m.visibility, 'shared') = 'shared' AND m.project_id IS NULL)
               OR (COALESCE(m.visibility, 'shared') IN ('shared', 'project')
                   AND p.id IS NOT NULL
                   AND (p.is_personal = false OR p.owner_id = $4::uuid
                        OR EXISTS (SELECT 1 FROM project_members pm
                                   WHERE pm.project_id = p.id AND pm.user_id = $4::uuid)))
             )
           ORDER BY array_position($2::uuid[], m.id)
           FOR SHARE OF m`,
          [tenant_id, requestedIds, project_id, authContext.user_id || null],
        );
        if (result.rows.length !== requestedIds.length) {
          throw new Error('One or more snapshot memories were not found or access was denied');
        }
        memories = result.rows;
      } else if (selectedContextIds.length > 0) {
        const contexts = await client.query(
          `SELECT c.id, c.project_id FROM contexts c
           JOIN projects p ON p.id = c.project_id AND p.tenant_id = $1
           WHERE c.id = ANY($2::uuid[])
             AND ($3::uuid IS NULL OR c.project_id = $3::uuid)
             AND (p.is_personal = false OR p.owner_id = $4::uuid
                  OR EXISTS (SELECT 1 FROM project_members pm
                             WHERE pm.project_id = p.id AND pm.user_id = $4::uuid))
           FOR SHARE OF c`,
          [tenant_id, selectedContextIds, project_id, authContext.user_id || null],
        );
        if (contexts.rows.length !== selectedContextIds.length) {
          throw new Error('One or more contexts were not found or access was denied');
        }
        // Aggregate in PostgreSQL before selecting content. A single large
        // context therefore cannot bypass the explicit-ID cap and make the
        // request process materialise an unbounded working set.
        const stats = await client.query(
          `SELECT COUNT(*)::int AS source_count,
                  COALESCE(SUM(octet_length(m.content)), 0)::bigint AS source_bytes,
                  COALESCE(SUM(CEIL(char_length(m.content)::numeric / 4)), 0)::bigint AS source_tokens
           FROM memories m
           WHERE m.tenant_id = $1
             AND EXISTS (
               SELECT 1 FROM memory_contexts mc
               JOIN contexts c ON c.id = mc.context_id
               WHERE mc.memory_id = m.id
                 AND c.id = ANY($2::uuid[])
                 AND c.project_id = m.project_id
             )
             AND ($3::uuid IS NULL OR m.project_id = $3::uuid)
             AND (COALESCE(m.visibility, 'shared') IN ('shared', 'project')
                  OR (m.visibility = 'personal' AND m.user_id = $4::uuid))`,
          [tenant_id, selectedContextIds, project_id, authContext.user_id || null],
        );
        this.assertSourceBounds(stats.rows[0]);
        const result = await client.query(
          `SELECT m.* FROM memories m
           WHERE m.tenant_id = $1
             AND EXISTS (
               SELECT 1 FROM memory_contexts mc
               JOIN contexts c ON c.id = mc.context_id
               WHERE mc.memory_id = m.id
                 AND c.id = ANY($2::uuid[])
                 AND c.project_id = m.project_id
             )
             AND ($3::uuid IS NULL OR m.project_id = $3::uuid)
             AND (COALESCE(m.visibility, 'shared') IN ('shared', 'project')
                  OR (m.visibility = 'personal' AND m.user_id = $4::uuid))
           ORDER BY m.created_at, m.id
           FOR SHARE OF m`,
          [tenant_id, selectedContextIds, project_id, authContext.user_id || null],
        );
        memories = result.rows;
      } else {
        const candidateIds = [...new Set(queryCandidateIds)];
        if (candidateIds.length > HARD_SNAPSHOT_MAX_ITEMS) {
          throw new Error(`Snapshot may copy at most ${HARD_SNAPSHOT_MAX_ITEMS} memories`);
        }
        if (candidateIds.length > 0) {
          const result = await client.query(
            `SELECT m.* FROM memories m
             LEFT JOIN projects p ON p.id = m.project_id AND p.tenant_id = m.tenant_id
             WHERE m.tenant_id = $1 AND m.id = ANY($2::uuid[])
               AND ($3::uuid IS NULL OR m.project_id = $3::uuid)
               AND (
                 (COALESCE(m.visibility, 'shared') = 'personal' AND m.user_id = $4::uuid)
                 OR (COALESCE(m.visibility, 'shared') = 'shared' AND m.project_id IS NULL)
                 OR (COALESCE(m.visibility, 'shared') IN ('shared', 'project')
                     AND p.id IS NOT NULL
                     AND (p.is_personal = false OR p.owner_id = $4::uuid
                          OR EXISTS (SELECT 1 FROM project_members pm
                                     WHERE pm.project_id = p.id AND pm.user_id = $4::uuid)))
               )
             ORDER BY array_position($2::uuid[], m.id)
             FOR SHARE OF m`,
            [tenant_id, candidateIds, project_id, authContext.user_id || null],
          );
          memories = result.rows;
        }
      }

      // Defence in depth for query candidates and for rows changed between a
      // preflight aggregate and their FOR SHARE materialisation.
      this.assertMaterialisedBounds(memories);

      const sourceProjects = new Set<string | null>();
      for (const memory of memories) sourceProjects.add(memory.project_id || null);
      if (selectedContextIds.length > 0) {
        const contextProjects = await client.query(
          `SELECT DISTINCT project_id FROM contexts WHERE id = ANY($1::uuid[])`,
          [selectedContextIds],
        );
        for (const row of contextProjects.rows) sourceProjects.add(row.project_id || null);
      }
      if (sourceProjects.size > 1) {
        throw new Error('Snapshots cannot mix memories or contexts from different projects');
      }

      const tokenEstimate = memories.reduce(
        (sum, memory) => sum + Math.ceil(String(memory.content || '').length / 4),
        0,
      );
      if (options.maxTokens !== undefined && tokenEstimate > options.maxTokens) {
        throw new Error(
          `Snapshot sources require approximately ${tokenEstimate} tokens, exceeding maxTokens ${options.maxTokens}. ` +
          'Narrow the source set or raise maxTokens; snapshots never split or silently omit an explicit memory.',
        );
      }

      const derivedProject = sourceProjects.size === 1 ? [...sourceProjects][0] : null;
      if (project_id && derivedProject !== null && derivedProject !== project_id) {
        throw new Error('Snapshot source is outside the selected project');
      }
      if (!project_id && derivedProject) project_id = derivedProject;

      let snapshotVisibility: 'personal' | 'shared' | 'project' = 'shared';
      if (memories.some(memory => memory.visibility === 'personal')) {
        snapshotVisibility = 'personal';
      } else if (project_id) {
        snapshotVisibility = 'project';
      } else if (memories.length === 0 && authContext.user_id) {
        snapshotVisibility = 'personal';
      }

      // Expired copies stop consuming quota only when they are actually
      // removed. This tenant-scoped cleanup is part of the same locked unit.
      await client.query(
        `WITH expired AS (
           SELECT id FROM context_snapshots
           WHERE tenant_id = $1 AND expires_at IS NOT NULL AND expires_at <= NOW()
           ORDER BY expires_at, id
           LIMIT 1000
         )
         DELETE FROM context_snapshots s
         USING expired
         WHERE s.id = expired.id AND s.tenant_id = $1`,
        [tenant_id],
      );

      const planResult = await client.query(
        `SELECT COALESCE(tp.memory_limit,
             CASE LOWER(COALESCE(t.plan, 'free'))
               WHEN 'dev' THEN 1000 WHEN 'free' THEN 1000
               WHEN 'pro' THEN 25000 WHEN 'team' THEN 250000
               WHEN 'business' THEN 1000000 WHEN 'enterprise' THEN 999999999
               ELSE 1000
             END) AS memory_limit
         FROM tenants t
         LEFT JOIN tenant_plans tp ON tp.tenant_id = t.id
         WHERE t.id = $1
         FOR UPDATE OF t`,
        [tenant_id],
      );
      if (!planResult.rows[0]) throw new Error('Tenant plan not found');
      const memoryLimit = Number(planResult.rows[0].memory_limit);
      const usageResult = await client.query(
        `SELECT
           (SELECT COUNT(*) FROM memories WHERE tenant_id = $1) +
           (SELECT COUNT(*) FROM snapshot_memories sm
            JOIN context_snapshots s ON s.id = sm.snapshot_id
            WHERE s.tenant_id = $1) AS stored_items`,
        [tenant_id],
      );
      const currentCount = Number(usageResult.rows[0]?.stored_items || 0);
      if (currentCount + memories.length > memoryLimit) {
        throw new Error(
          `Creating snapshot would exceed memory limit (${memoryLimit}). ` +
          `Current stored items: ${currentCount}, Snapshot copies: ${memories.length}`,
        );
      }

      const snapshotResult = await client.query(
        `INSERT INTO context_snapshots (
          id, tenant_id, project_id, user_id, visibility, name, description, query, max_tokens,
          token_count, memory_count, expires_at, metadata
        ) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING *`,
        [
          tenant_id, project_id, authContext.user_id || null, snapshotVisibility,
          options.name || null, options.description || null, options.query || null,
          options.maxTokens || null, tokenEstimate, memories.length, expiresAt,
          JSON.stringify(options),
        ],
      );
      const snapshot = snapshotResult.rows[0] as Snapshot;

      let snapshotMemories: SnapshotMemory[] = [];
      const orderedIds = memories.map(memory => memory.id);
      if (orderedIds.length > 0) {
        const copies = await client.query(
          `INSERT INTO snapshot_memories (
             id, snapshot_id, memory_id, project_id, user_id, visibility,
             content, category, metadata, relevance_score, position
           )
           SELECT gen_random_uuid(), $1, m.id, m.project_id, m.user_id,
                  COALESCE(m.visibility, 'shared'), m.content, m.category,
                  m.metadata, COALESCE(m.relevance_score, 1.0),
                  array_position($2::uuid[], m.id) - 1
           FROM memories m
           WHERE m.tenant_id = $3 AND m.id = ANY($2::uuid[])
           ORDER BY array_position($2::uuid[], m.id)
           RETURNING *`,
          [snapshot.id, orderedIds, tenant_id],
        );
        snapshotMemories = copies.rows.sort(
          (left: SnapshotMemory, right: SnapshotMemory) => left.position - right.position,
        );
      }

      if (selectedContextIds.length > 0) {
        await client.query(
          `INSERT INTO snapshot_contexts (snapshot_id, context_id)
           SELECT $1, context_id FROM unnest($2::uuid[]) AS context_id
           ON CONFLICT DO NOTHING`,
          [snapshot.id, selectedContextIds],
        );
      }

      return { snapshot, memories: snapshotMemories };
    });
  }

  /**
   * Get a snapshot by ID
   */
  async getSnapshot(
    snapshotId: string,
    authContext: AuthContext,
    page: { offset?: number; limit?: number } = {},
  ): Promise<{
    snapshot: Snapshot;
    memories: SnapshotMemory[];
    pagination: {
      offset: number;
      limit: number;
      returned: number;
      total: number;
      has_more: boolean;
      next_offset: number | null;
      oversized_omitted?: boolean;
    };
  } | null> {
    const { tenant_id } = authContext;
    const offset = Number.isSafeInteger(page.offset) && Number(page.offset) >= 0
      ? Number(page.offset)
      : 0;
    const limit = Number.isSafeInteger(page.limit) && Number(page.limit) > 0
      ? Math.min(Number(page.limit), SNAPSHOT_PAGE_MAX_ITEMS)
      : SNAPSHOT_PAGE_MAX_ITEMS;

    // Get snapshot
    const snapshotResult = await this.db.query(
      `SELECT s.* FROM context_snapshots s
       LEFT JOIN projects p ON p.id = s.project_id AND p.tenant_id = s.tenant_id
       WHERE s.id = $1 AND s.tenant_id = $2
         AND ($3::uuid IS NULL OR s.project_id = $3::uuid)
         AND (
           (COALESCE(s.visibility, 'shared') = 'personal' AND s.user_id = $4::uuid)
           OR (COALESCE(s.visibility, 'shared') = 'shared' AND s.project_id IS NULL)
           OR (COALESCE(s.visibility, 'shared') IN ('shared', 'project')
               AND p.id IS NOT NULL
               AND (p.is_personal = false OR p.owner_id = $4::uuid
                    OR EXISTS (SELECT 1 FROM project_members pm
                               WHERE pm.project_id = p.id AND pm.user_id = $4::uuid)))
         )`,
      [snapshotId, tenant_id, authContext.project_id || null, authContext.user_id || null],
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
      `WITH page AS (
         SELECT sm.* FROM snapshot_memories sm
         JOIN context_snapshots s ON s.id = sm.snapshot_id
         LEFT JOIN projects p ON p.id = sm.project_id AND p.tenant_id = s.tenant_id
         WHERE sm.snapshot_id = $1 AND s.tenant_id = $2
           AND sm.project_id IS NOT DISTINCT FROM s.project_id
           AND ($4::uuid IS NULL OR sm.project_id = $4::uuid)
           AND (
             (COALESCE(sm.visibility, 'shared') = 'personal' AND sm.user_id = $3::uuid)
             OR (COALESCE(sm.visibility, 'shared') = 'shared' AND sm.project_id IS NULL)
             OR (COALESCE(sm.visibility, 'shared') IN ('shared', 'project')
                 AND p.id IS NOT NULL
                 AND (p.is_personal = false OR p.owner_id = $3::uuid
                      OR EXISTS (SELECT 1 FROM project_members pm
                                 WHERE pm.project_id = p.id AND pm.user_id = $3::uuid)))
           )
         ORDER BY sm.position
         LIMIT $5 OFFSET $6
       ), sized AS (
         SELECT page.*,
                SUM(octet_length(page.content)) OVER (ORDER BY page.position) AS cumulative_bytes
         FROM page
       )
       SELECT * FROM sized
       WHERE cumulative_bytes <= $7
       ORDER BY position`,
      [
        snapshotId, tenant_id, authContext.user_id || null, authContext.project_id || null,
        limit, offset, SNAPSHOT_PAGE_MAX_BYTES,
      ],
      tenant_id,
    );

    const memories = memoriesResult.rows.map(({ cumulative_bytes: _ignored, ...memory }: any) => memory);
    const total = Math.max(0, Number(snapshot.memory_count || 0));
    const skippedOversizedPage = memories.length === 0 && offset < total;
    const nextOffset = skippedOversizedPage
      ? Math.min(total, offset + limit)
      : Math.min(total, offset + memories.length);

    return {
      snapshot,
      memories,
      pagination: {
        offset,
        limit,
        returned: memories.length,
        total,
        has_more: nextOffset < total,
        next_offset: nextOffset < total ? nextOffset : null,
        ...(skippedOversizedPage ? { oversized_omitted: true } : {}),
      },
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
    if (authContext.project_id && projectId && projectId !== authContext.project_id) {
      throw new Error('Snapshot project is outside the credential scope');
    }
    const project_id = projectId || authContext.project_id || null;
    

    let sql = `SELECT s.* FROM context_snapshots s
      LEFT JOIN projects p ON p.id = s.project_id AND p.tenant_id = s.tenant_id
      WHERE s.tenant_id = $1
        AND (
          (COALESCE(s.visibility, 'shared') = 'personal' AND s.user_id = $2::uuid)
          OR (COALESCE(s.visibility, 'shared') = 'shared' AND s.project_id IS NULL)
          OR (COALESCE(s.visibility, 'shared') IN ('shared', 'project')
              AND p.id IS NOT NULL
              AND (p.is_personal = false OR p.owner_id = $2::uuid
                   OR EXISTS (SELECT 1 FROM project_members pm
                              WHERE pm.project_id = p.id AND pm.user_id = $2::uuid)))
        )`;
    const params: any[] = [tenant_id, authContext.user_id || null];

    if (project_id) {
      sql += ` AND s.project_id = $${params.length + 1}`;
      params.push(project_id);
    }

    if (query) {
      sql += ` AND (s.name ILIKE $${params.length + 1} OR s.description ILIKE $${params.length + 1})`;
      params.push(`%${query}%`);
    }

    // Exclude expired snapshots
    sql += ` AND (s.expires_at IS NULL OR s.expires_at > NOW())`;

    sql += ` ORDER BY s.created_at DESC LIMIT $${params.length + 1}`;
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
      `DELETE FROM context_snapshots s
       WHERE s.id = $1 AND s.tenant_id = $2
         AND ($3::uuid IS NULL OR s.project_id = $3::uuid)
         AND (
           (COALESCE(s.visibility, 'shared') = 'personal' AND s.user_id = $4::uuid)
           OR (COALESCE(s.visibility, 'shared') = 'shared' AND s.project_id IS NULL)
           OR (COALESCE(s.visibility, 'shared') IN ('shared', 'project')
             AND s.project_id IS NOT NULL AND EXISTS (
               SELECT 1 FROM projects p
               WHERE p.id = s.project_id AND p.tenant_id = s.tenant_id
                 AND (p.is_personal = false OR p.owner_id = $4::uuid
                      OR EXISTS (SELECT 1 FROM project_members pm
                                 WHERE pm.project_id = p.id AND pm.user_id = $4::uuid))
             )
           )
         )`,
      [snapshotId, tenant_id, authContext.project_id || null, authContext.user_id || null],
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
      `DELETE FROM context_snapshots s
       WHERE s.tenant_id = $1
         AND s.expires_at IS NOT NULL AND s.expires_at < NOW()
         AND ($2::uuid IS NULL OR s.project_id = $2::uuid)
         AND (
           (COALESCE(s.visibility, 'shared') = 'personal' AND s.user_id = $3::uuid)
           OR (COALESCE(s.visibility, 'shared') = 'shared' AND s.project_id IS NULL)
           OR (COALESCE(s.visibility, 'shared') IN ('shared', 'project')
             AND s.project_id IS NOT NULL AND EXISTS (
               SELECT 1 FROM projects p
               WHERE p.id = s.project_id AND p.tenant_id = s.tenant_id
                 AND (p.is_personal = false OR p.owner_id = $3::uuid
                      OR EXISTS (SELECT 1 FROM project_members pm
                                 WHERE pm.project_id = p.id AND pm.user_id = $3::uuid))
             )
           )
         )`,
      [tenant_id, authContext.project_id || null, authContext.user_id || null],
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
    if (authContext.project_id && projectId && projectId !== authContext.project_id) {
      throw new Error('Snapshot project is outside the credential scope');
    }
    const project_id = projectId || authContext.project_id || null;
    

    let sql = `SELECT s.* FROM context_snapshots s
      LEFT JOIN projects p ON p.id = s.project_id AND p.tenant_id = s.tenant_id
      WHERE s.tenant_id = $1
        AND (
          (COALESCE(s.visibility, 'shared') = 'personal' AND s.user_id = $2::uuid)
          OR (COALESCE(s.visibility, 'shared') = 'shared' AND s.project_id IS NULL)
          OR (COALESCE(s.visibility, 'shared') IN ('shared', 'project')
              AND p.id IS NOT NULL
              AND (p.is_personal = false OR p.owner_id = $2::uuid
                   OR EXISTS (SELECT 1 FROM project_members pm
                              WHERE pm.project_id = p.id AND pm.user_id = $2::uuid)))
        )`;
    const params: any[] = [tenant_id, authContext.user_id || null];

    if (project_id) {
      sql += ` AND s.project_id = $${params.length + 1}`;
      params.push(project_id);
    }

    // Exclude expired
    sql += ` AND (s.expires_at IS NULL OR s.expires_at > NOW())`;

    sql += ` ORDER BY s.created_at DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    const result = await this.db.query(sql, params, tenant_id);
    return result.rows;
  }

  private async requireProjectAccess(projectId: string, authContext: AuthContext): Promise<void> {
    const result = await this.db.query(
      `SELECT 1 FROM projects p
       WHERE p.id = $1 AND p.tenant_id = $2
         AND (p.is_personal = false OR p.owner_id = $3::uuid
              OR EXISTS (SELECT 1 FROM project_members pm
                         WHERE pm.project_id = p.id AND pm.user_id = $3::uuid))`,
      [projectId, authContext.tenant_id, authContext.user_id || null],
      authContext.tenant_id,
    );
    if (result.rows.length === 0) {
      throw new Error('Snapshot project not found or access denied');
    }
  }
}
