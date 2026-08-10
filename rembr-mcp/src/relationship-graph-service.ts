import type { Pool } from 'pg';

export const MAX_RELATIONSHIP_GRAPH_DEPTH = 3;
export const MAX_RELATIONSHIP_GRAPH_BRANCHING = 10;
export const MAX_RELATIONSHIP_GRAPH_NODES = 100;
export const MAX_RELATIONSHIP_GRAPH_CONTENT_CHARS = 2_048;
export const MAX_RELATIONSHIP_GRAPH_EVIDENCE_CHARS = 2_048;

export interface RelationshipGraphAccessContext {
  tenantId: string;
  projectId?: string;
  userId?: string;
}

export interface ExploreRelationshipGraphOptions {
  memoryId: string;
  depth?: number;
  minConfidence?: number;
  relationshipTypes?: string[];
}

export interface RelationshipGraphRow {
  id: string;
  content: string;
  category: string;
  created_at: Date | string;
  depth: number;
  relationship_type: string | null;
  confidence: number | string | null;
  evidence: string | null;
  connected_to: string | null;
}

export interface ExploreRelationshipGraphResult {
  startMemory: Omit<RelationshipGraphRow, 'depth' | 'relationship_type' | 'confidence' | 'evidence' | 'connected_to'>;
  neighbors: RelationshipGraphRow[];
  truncated: boolean;
  maxDepth: number;
  minConfidence: number;
}

/**
 * Traverse only the caller's accessible memory subgraph.
 *
 * Relationship rows have no tenant/audience columns, so both endpoints must
 * independently join the canonical accessible-memory set before an edge can
 * participate in recursion or expose evidence. A correlated top-edge query
 * bounds branching at each visited node before the next recursive level runs,
 * avoiding a tenant-wide relationship materialisation and dense-graph blow-up.
 */
export async function exploreAccessibleRelationshipGraph(
  pool: Pick<Pool, 'connect'>,
  context: RelationshipGraphAccessContext,
  options: ExploreRelationshipGraphOptions,
): Promise<ExploreRelationshipGraphResult | null> {
  const maxDepth = Math.min(
    MAX_RELATIONSHIP_GRAPH_DEPTH,
    Math.max(1, Math.trunc(options.depth ?? 2)),
  );
  const minConfidence = Math.min(1, Math.max(0, options.minConfidence ?? 0.5));
  const relationshipTypes = options.relationshipTypes?.length
    ? options.relationshipTypes.slice(0, 20)
    : null;
  const client = await pool.connect();
  let completed = false;

  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query('SELECT set_config($1, $2, true)', ['app.current_tenant', context.tenantId]);

    const startResult = await client.query(
      `SELECT m.id, LEFT(m.content, $5::integer) AS content, m.category, m.created_at
       FROM memories m
       LEFT JOIN projects p ON p.id = m.project_id AND p.tenant_id = m.tenant_id
       WHERE m.id = $1::uuid
         AND m.tenant_id = $2::uuid
         AND ($3::uuid IS NULL OR m.project_id = $3::uuid)
         AND (
           (COALESCE(m.visibility, 'shared') = 'personal' AND m.user_id = $4::uuid)
           OR (COALESCE(m.visibility, 'shared') = 'shared' AND m.project_id IS NULL)
           OR (
             COALESCE(m.visibility, 'shared') IN ('shared', 'project')
             AND p.id IS NOT NULL
             AND (
               p.is_personal = false
               OR p.owner_id = $4::uuid
               OR EXISTS (
                 SELECT 1 FROM project_members pm
                 WHERE pm.project_id = p.id AND pm.user_id = $4::uuid
               )
             )
           )
         )`,
      [
        options.memoryId,
        context.tenantId,
        context.projectId || null,
        context.userId || null,
        MAX_RELATIONSHIP_GRAPH_CONTENT_CHARS,
      ],
    );

    if (startResult.rows.length !== 1) {
      await client.query('ROLLBACK');
      completed = true;
      return null;
    }

    const result = await client.query(
      `WITH RECURSIVE accessible_memory_ids AS NOT MATERIALIZED (
         SELECT m.id
         FROM memories m
         LEFT JOIN projects p ON p.id = m.project_id AND p.tenant_id = m.tenant_id
         WHERE m.tenant_id = $4::uuid
           AND ($5::uuid IS NULL OR m.project_id = $5::uuid)
           AND (
             (COALESCE(m.visibility, 'shared') = 'personal' AND m.user_id = $6::uuid)
             OR (COALESCE(m.visibility, 'shared') = 'shared' AND m.project_id IS NULL)
             OR (
               COALESCE(m.visibility, 'shared') IN ('shared', 'project')
               AND p.id IS NOT NULL
               AND (
                 p.is_personal = false
                 OR p.owner_id = $6::uuid
                 OR EXISTS (
                   SELECT 1 FROM project_members pm
                   WHERE pm.project_id = p.id AND pm.user_id = $6::uuid
                 )
               )
             )
           )
       ),
       graph_traversal(node_id, depth, path, via_relationship_id, parent_id, edge_confidence) AS (
         SELECT am.id, 0, ARRAY[am.id], NULL::uuid, NULL::uuid, NULL::double precision
         FROM accessible_memory_ids am
         WHERE am.id = $1::uuid

         UNION ALL

         SELECT edge.to_id,
                gt.depth + 1,
                gt.path || edge.to_id,
                edge.relationship_id,
                gt.node_id,
                edge.confidence
         FROM graph_traversal gt
         JOIN LATERAL (
           SELECT mr.id AS relationship_id,
                  CASE
                    WHEN mr.source_memory_id = gt.node_id THEN mr.target_memory_id
                    ELSE mr.source_memory_id
                  END AS to_id,
                  mr.confidence
           FROM memory_relationships mr
           JOIN accessible_memory_ids source_memory ON source_memory.id = mr.source_memory_id
           JOIN accessible_memory_ids target_memory ON target_memory.id = mr.target_memory_id
           WHERE (mr.source_memory_id = gt.node_id OR mr.target_memory_id = gt.node_id)
             AND mr.confidence >= $3
             AND ($7::text[] IS NULL OR mr.relationship_type = ANY($7::text[]))
             AND NOT (
               CASE
                 WHEN mr.source_memory_id = gt.node_id THEN mr.target_memory_id
                 ELSE mr.source_memory_id
               END = ANY(gt.path)
             )
           ORDER BY mr.confidence DESC, mr.id
           LIMIT $9::integer
         ) edge ON true
         WHERE gt.depth < $2::integer
       ),
       closest AS (
         SELECT DISTINCT ON (node_id)
                node_id, depth, via_relationship_id, parent_id, edge_confidence
         FROM graph_traversal
         WHERE depth > 0
         ORDER BY node_id, depth, edge_confidence DESC, via_relationship_id
       )
       SELECT m.id,
              LEFT(m.content, $8::integer) AS content,
              m.category,
              m.created_at,
              c.depth,
              mr.relationship_type,
              mr.confidence,
              LEFT(mr.evidence, $11::integer) AS evidence,
              c.parent_id AS connected_to
       FROM closest c
       JOIN accessible_memory_ids accessible_result ON accessible_result.id = c.node_id
       JOIN memories m ON m.id = accessible_result.id AND m.tenant_id = $4::uuid
       JOIN memory_relationships mr ON mr.id = c.via_relationship_id
       JOIN accessible_memory_ids source_memory ON source_memory.id = mr.source_memory_id
       JOIN accessible_memory_ids target_memory ON target_memory.id = mr.target_memory_id
       ORDER BY c.depth ASC, mr.confidence DESC, m.id
       LIMIT $10::integer`,
      [
        options.memoryId,
        maxDepth,
        minConfidence,
        context.tenantId,
        context.projectId || null,
        context.userId || null,
        relationshipTypes,
        MAX_RELATIONSHIP_GRAPH_CONTENT_CHARS,
        MAX_RELATIONSHIP_GRAPH_BRANCHING,
        MAX_RELATIONSHIP_GRAPH_NODES + 1,
        MAX_RELATIONSHIP_GRAPH_EVIDENCE_CHARS,
      ],
    );

    await client.query('COMMIT');
    completed = true;
    const rows = result.rows as RelationshipGraphRow[];
    const truncated = rows.length > MAX_RELATIONSHIP_GRAPH_NODES;
    const neighbors = rows.slice(0, MAX_RELATIONSHIP_GRAPH_NODES).map(row => ({
      ...row,
      content: String(row.content || '').slice(0, MAX_RELATIONSHIP_GRAPH_CONTENT_CHARS),
      evidence: row.evidence === null
        ? null
        : String(row.evidence).slice(0, MAX_RELATIONSHIP_GRAPH_EVIDENCE_CHARS),
    }));
    const start = startResult.rows[0];

    return {
      startMemory: {
        id: start.id,
        content: String(start.content || '').slice(0, MAX_RELATIONSHIP_GRAPH_CONTENT_CHARS),
        category: start.category,
        created_at: start.created_at,
      },
      neighbors,
      truncated,
      maxDepth,
      minConfidence,
    };
  } finally {
    if (!completed) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the original query error.
      }
    }
    client.release();
  }
}
