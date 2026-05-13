/**
 * Vector Search Service (REM-249)
 *
 * Provides:
 * - Adaptive ef_search tuning: automatically raises the HNSW candidate-list
 *   size as a tenant's memory count grows, preserving recall quality at scale.
 * - Index health monitoring: reports bloat, row count, and tuning advice.
 * - Slow-query logging: surfaces searches that exceed the latency budget.
 *
 * Background:
 *   pgvector HNSW indexes use ef_search (default = 40 in pgvector; rembr's
 *   database default = 64 via migration 006-vector-index-tuning.sql) as the
 *   candidate-list size during ANN graph traversal.
 *
 *   At scale the optimal value rises:
 *     < 10 k memories   → 40  (low noise, fast, high recall)
 *     10 k–100 k        → 64  (rembr database default)
 *     100 k–500 k       → 100 (recall ≥ 97 %)
 *     > 500 k           → 128 (recall ≥ 99 %, ~2× query cost)
 *
 *   We set ef_search with SET LOCAL so it scopes to the current transaction
 *   and never leaks across concurrent sessions.
 */

import { Pool, PoolClient } from 'pg';

// ─────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────

/** Thresholds (inclusive lower bound) → ef_search value */
const EF_SEARCH_TIERS: Array<[number, number]> = [
  [500_000, 128],
  [100_000, 100],
  [10_000, 64],
  [0, 40],
];

/** Log searches that exceed this latency in ms */
const SLOW_QUERY_THRESHOLD_MS = 200;

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

export interface VectorSearchInput {
  tenantId: string;
  projectId?: string;
  userId?: string;
  queryEmbedding: number[];
  limit?: number;
  category?: string;
  metadataFilter?: Record<string, unknown>;
  /** Override automatic ef_search selection (advanced use only) */
  efSearch?: number;
}

export interface VectorSearchResult {
  id: string;
  content: string;
  category: string | null;
  metadata: Record<string, unknown>;
  similarity: number;
  tenant_id: string;
  project_id: string | null;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

export interface IndexHealthReport {
  indexName: string;
  tableName: string;
  rowCount: number;
  indexSizeBytes: number;
  tableSizeBytes: number;
  bloatRatio: number;
  efSearchRecommended: number;
  /** ISO timestamp of last VACUUM on the parent table, or null if never */
  lastVacuumAt: string | null;
  /** ISO timestamp of last ANALYZE on the parent table, or null if never */
  lastAnalyzeAt: string | null;
  advice: string[];
}

export interface VectorSearchStats {
  tenantMemoryCount: number;
  efSearchUsed: number;
  durationMs: number;
  resultCount: number;
  slowQuery: boolean;
}

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────

/**
 * Determine the appropriate ef_search value for a given memory count.
 * Exposed for testing.
 */
export function efSearchForCount(count: number): number {
  for (const [threshold, value] of EF_SEARCH_TIERS) {
    if (count >= threshold) return value;
  }
  return 40; // fallback (shouldn't be reached)
}

// ─────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────

export class VectorSearchService {
  constructor(private readonly pool: Pool) {}

  /**
   * Execute a vector similarity search with adaptive ef_search tuning.
   *
   * Steps:
   *  1. Open a client and begin a transaction.
   *  2. Set the RLS tenant context.
   *  3. Count the tenant's indexed memories to pick ef_search.
   *  4. SET LOCAL hnsw.ef_search = <value> (transaction-scoped).
   *  5. Run the ANN query.
   *  6. Commit and release.
   */
  async search(
    input: VectorSearchInput,
  ): Promise<{ results: VectorSearchResult[]; stats: VectorSearchStats }> {
    const {
      tenantId,
      projectId,
      userId,
      queryEmbedding,
      limit = 10,
      category,
      metadataFilter,
      efSearch: efSearchOverride,
    } = input;

    const client = await this.pool.connect();
    const startMs = Date.now();

    try {
      await client.query('BEGIN');

      // Set RLS context
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);

      // Count indexed memories for this tenant
      const countRes = await client.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt
         FROM memory_embeddings e
         JOIN memories m ON m.id = e.memory_id
         WHERE m.tenant_id = $1`,
        [tenantId],
      );
      const memoryCount = parseInt(countRes.rows[0]?.cnt ?? '0', 10);

      // Pick ef_search
      const efSearch = efSearchOverride ?? efSearchForCount(memoryCount);
      await client.query(`SET LOCAL hnsw.ef_search = ${efSearch}`);

      // Build search query
      const embeddingStr = `[${queryEmbedding.join(',')}]`;

      let sql = `
        SELECT
          m.*,
          1 - (e.embedding <=> $1::vector) AS similarity
        FROM memories m
        JOIN memory_embeddings e ON m.id = e.memory_id
        LEFT JOIN projects p ON m.project_id = p.id
        WHERE m.tenant_id = $2
          AND (
            p.is_personal = false
            OR p.is_personal IS NULL
            OR (p.is_personal = true AND p.owner_id = $3)
          )
      `;
      const params: unknown[] = [embeddingStr, tenantId, userId ?? null];
      let pi = 4;

      if (projectId) {
        sql += ` AND m.project_id = $${pi++}`;
        params.push(projectId);
      }

      if (category) {
        sql += ` AND m.category = $${pi++}`;
        params.push(category);
      }

      if (metadataFilter && Object.keys(metadataFilter).length > 0) {
        for (const [key, value] of Object.entries(metadataFilter)) {
          sql += ` AND m.metadata->>'${key.replace(/'/g, "''")}' = $${pi++}`;
          params.push(String(value));
        }
      }

      sql += ` ORDER BY e.embedding <=> $1::vector LIMIT $${pi}`;
      params.push(limit);

      const res = await client.query<VectorSearchResult>(sql, params);
      await client.query('COMMIT');

      const durationMs = Date.now() - startMs;
      const slowQuery = durationMs > SLOW_QUERY_THRESHOLD_MS;

      if (slowQuery) {
        console.warn(
          `⚠️  [VectorSearchService] Slow query: ${durationMs}ms ` +
            `(tenant=${tenantId}, efSearch=${efSearch}, count=${memoryCount})`,
        );
      }

      const results = res.rows.map((row) => ({
        ...row,
        metadata:
          typeof row.metadata === 'string'
            ? JSON.parse((row.metadata as string) || '{}')
            : (row.metadata ?? {}),
      }));

      const stats: VectorSearchStats = {
        tenantMemoryCount: memoryCount,
        efSearchUsed: efSearch,
        durationMs,
        resultCount: results.length,
        slowQuery,
      };

      return { results, stats };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Return health information for the two primary HNSW indexes:
   *   idx_memories_embedding   (memories.embedding)
   *   idx_embeddings_vector    (memory_embeddings.embedding)
   *
   * Advice thresholds:
   *  - Recommend increasing ef_search when row count crosses a tier boundary.
   *  - Warn about index bloat if bloatRatio > 0.3 (30 % wasted pages).
   *  - Suggest REINDEX when bulk-deletes have removed > 50 % of rows
   *    (approximated by a high bloat ratio combined with a low row count).
   */
  async indexHealth(): Promise<IndexHealthReport[]> {
    const client = await this.pool.connect();
    try {
      const res = await client.query<{
        indexname: string;
        tablename: string;
        row_estimate: string;
        index_size: string;
        table_size: string;
        last_vacuum: string | null;
        last_analyze: string | null;
      }>(`
        SELECT
          ix.relname                            AS indexname,
          t.relname                             AS tablename,
          t.reltuples::BIGINT                   AS row_estimate,
          pg_relation_size(ix.oid)              AS index_size,
          pg_total_relation_size(t.oid)         AS table_size,
          psu.last_vacuum::TEXT                 AS last_vacuum,
          psu.last_analyze::TEXT                AS last_analyze
        FROM pg_class ix
        JOIN pg_index i    ON ix.oid = i.indexrelid
        JOIN pg_class t    ON t.oid  = i.indrelid
        LEFT JOIN pg_stat_user_tables psu ON psu.relname = t.relname
        WHERE ix.relname IN ('idx_memories_embedding', 'idx_embeddings_vector')
        ORDER BY ix.relname
      `);

      return res.rows.map((row) => {
        const rowCount = parseInt(row.row_estimate, 10);
        const indexSizeBytes = parseInt(row.index_size, 10);
        const tableSizeBytes = parseInt(row.table_size, 10);
        const bloatRatio =
          tableSizeBytes > 0
            ? Math.max(0, (indexSizeBytes - rowCount * 800) / tableSizeBytes)
            : 0;
        const efSearchRecommended = efSearchForCount(rowCount);
        const lastVacuumAt = row.last_vacuum ?? null;
        const lastAnalyzeAt = row.last_analyze ?? null;
        const advice: string[] = [];

        if (bloatRatio > 0.5) {
          advice.push(
            `High index bloat (${(bloatRatio * 100).toFixed(0)}%). Consider REINDEX CONCURRENTLY if bulk deletes have occurred.`,
          );
        } else if (bloatRatio > 0.3) {
          advice.push(
            `Moderate index bloat (${(bloatRatio * 100).toFixed(0)}%). Monitor and schedule REINDEX if it continues to grow.`,
          );
        }

        if (efSearchRecommended > 64) {
          advice.push(
            `Row count (${rowCount.toLocaleString()}) has crossed a scale tier. ` +
              `Consider ALTER DATABASE rembr SET hnsw.ef_search = ${efSearchRecommended};`,
          );
        }

        // Warn if the table has never been analyzed, or not in the last 7 days
        if (!lastAnalyzeAt) {
          advice.push('Table has never been ANALYZEd. Run ANALYZE manually to update planner statistics.');
        } else {
          const daysSinceAnalyze =
            (Date.now() - new Date(lastAnalyzeAt).getTime()) / (1000 * 60 * 60 * 24);
          if (daysSinceAnalyze > 7) {
            advice.push(
              `Last ANALYZE was ${daysSinceAnalyze.toFixed(0)} days ago. ` +
                `Consider running ANALYZE ${row.tablename} to refresh planner statistics.`,
            );
          }
        }

        if (advice.length === 0) {
          advice.push('Index is healthy. No action required.');
        }

        return {
          indexName: row.indexname,
          tableName: row.tablename,
          rowCount,
          indexSizeBytes,
          tableSizeBytes,
          bloatRatio,
          efSearchRecommended,
          lastVacuumAt,
          lastAnalyzeAt,
          advice,
        };
      });
    } finally {
      client.release();
    }
  }
}
