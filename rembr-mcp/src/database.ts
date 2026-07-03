import pkg from 'pg';
const { Pool } = pkg;
import type { Pool as PoolType } from 'pg';

export interface AuthContext {
  tenant_id: string;
  project_id?: string;
  user_id?: string;
}

export interface Memory {
  id: string;
  tenant_id: string;
  project_id?: string;
  content: string;
  category: string;
  metadata: Record<string, any>;
  created_at: Date;
  updated_at: Date;
  relevance_score: number;
  // PII detection fields (Phase 0.5)
  pii_detected?: boolean;
  pii_types?: string[];
  pii_confidence?: number;
  pii_scanned_at?: Date;
}

export interface MemoryEmbedding {
  memory_id: string;
  embedding: number[];
  provider: string;
  model: string;
  dimensions: number;
  created_at: Date;
}

export interface TenantPlan {
  tenant_id: string;
  plan: 'free' | 'pro' | 'team' | 'business' | 'enterprise';
  memory_limit: number;
  search_limit_daily: number;
  project_limit: number;
}

export interface Context {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  category: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ContextSummary {
  context_id: string;
  summary_text: string;
  memory_count: number;
  generated_at: Date;
}

export interface ContextMemory {
  context_id: string;
  memory_id: string;
  relevance_score: number;
  added_at: Date;
}

export class MemoryDatabase {
  private pool: PoolType;
  private readPool: PoolType | null = null;

  constructor(connectionString?: string) {
    // Build connection string from individual components (preferred) or use DATABASE_URL
    let primaryConnectionString: string;
    let readConnectionString: string | undefined;
    
    const dbHost = process.env.DB_HOST;
    const dbPort = process.env.DB_PORT || '5432';
    const dbName = process.env.DB_NAME;
    const dbUser = process.env.DB_USER;
    const dbPassword = process.env.DB_PASSWORD;
    const dbReadHost = process.env.DB_READ_HOST;
    
    if (dbHost && dbName && dbUser && dbPassword) {
      // Build from components - this is the reliable way
      const encodedPassword = encodeURIComponent(dbPassword);
      primaryConnectionString = `postgresql://${dbUser}:${encodedPassword}@${dbHost}:${dbPort}/${dbName}`;
      console.log(`✅ Database connection built from components: ${dbUser}@${dbHost}:${dbPort}/${dbName}`);
      
      if (dbReadHost) {
        readConnectionString = `postgresql://${dbUser}:${encodedPassword}@${dbReadHost}:${dbPort}/${dbName}`;
        console.log(`✅ Read replica connection: ${dbUser}@${dbReadHost}:${dbPort}/${dbName}`);
      }
    } else if (connectionString || process.env.DATABASE_URL) {
      // Fall back to connection string
      primaryConnectionString = connectionString || process.env.DATABASE_URL!;
      readConnectionString = process.env.DATABASE_READ_URL;
      console.log('ℹ️ Using DATABASE_URL environment variable');
    } else {
      throw new Error('Database connection not configured. Set DB_HOST, DB_NAME, DB_USER, DB_PASSWORD or DATABASE_URL');
    }

    // Primary pool for write operations
    this.pool = new Pool({
      connectionString: primaryConnectionString,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
    
    this.pool.on('error', (err: Error) => {
      console.error('Unexpected database error (primary):', err);
    });

    // Read replica pool for read-heavy operations (optional)
    if (readConnectionString) {
      this.readPool = new Pool({
        connectionString: readConnectionString,
        max: 30, // More connections for read operations
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
      });

      this.readPool.on('error', (err: Error) => {
        console.error('Unexpected database error (read replica):', err);
        // Fall back to primary on read replica errors
        this.readPool = null;
      });

      console.log('✅ Read replica pool initialized');
    } else {
      console.log('ℹ️ No read replica configured, using primary for all operations');
    }
  }

  get dbPool(): PoolType {
    return this.pool;
  }

  /**
   * Get the appropriate pool for read operations
   * Uses read replica if available, falls back to primary
   */
  get readDbPool(): PoolType {
    return this.readPool || this.pool;
  }

  async initializeSchema(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Enable pgvector extension
      await client.query('CREATE EXTENSION IF NOT EXISTS vector');

      // Create tenant_plans table (for rate limiting and quota checks)
      await client.query(`
        CREATE TABLE IF NOT EXISTS tenant_plans (
          tenant_id UUID PRIMARY KEY,
          plan TEXT NOT NULL CHECK (plan IN ('free', 'pro', 'team', 'business', 'enterprise')),
          memory_limit INTEGER NOT NULL,
          search_limit_daily INTEGER NOT NULL,
          project_limit INTEGER NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);

      // Create memories table with tenant_id
      await client.query(`
        CREATE TABLE IF NOT EXISTS memories (
          id UUID PRIMARY KEY,
          tenant_id UUID NOT NULL,
          project_id UUID,
          content TEXT NOT NULL,
          category TEXT NOT NULL,
          metadata JSONB DEFAULT '{}',
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          relevance_score REAL DEFAULT 1.0
        )
      `);

      // Create embeddings table with pgvector
      await client.query(`
        CREATE TABLE IF NOT EXISTS memory_embeddings (
          memory_id UUID PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
          embedding vector(768),
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          dimensions INTEGER NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);

      // Create usage tracking table for rate limiting. Shape matches the
      // production schema (deploy/k8s/02-create-schema.sql) minus FKs to
      // UI-owned tables, so createMemory's INSERT (id, project_id,
      // memories_stored, ON CONFLICT (tenant_id, project_id, date)) works on
      // an engine-only database too. Pre-existing tables are left untouched.
      await client.query(`
        CREATE TABLE IF NOT EXISTS usage_daily (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL,
          project_id UUID,
          api_key_id UUID,
          oauth_app_id UUID,
          auth_method VARCHAR(50),
          date DATE NOT NULL,
          memories_stored INTEGER DEFAULT 0,
          searches_performed INTEGER DEFAULT 0,
          embeddings_generated INTEGER DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(tenant_id, project_id, date)
        )
      `);

      // mcp_sessions removed — MCP 2026-07-28 (SEP-2575) drops protocol
      // sessions and session-based auth (migration 026).

      // Create indexes
      await client.query('CREATE INDEX IF NOT EXISTS idx_memories_tenant_id ON memories(tenant_id)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_memories_project_id ON memories(project_id)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at DESC)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_usage_tenant_date ON usage_daily(tenant_id, date)');
      
      // Full-text search index using GIN (Generalized Inverted Index) for phrase search
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_memories_content_fts 
        ON memories 
        USING gin(to_tsvector('english', content))
      `);
      
      // Vector similarity index using HNSW (Hierarchical Navigable Small World)
      await client.query('CREATE INDEX IF NOT EXISTS idx_embeddings_vector ON memory_embeddings USING hnsw (embedding vector_cosine_ops)');

      // Enable Row-Level Security
      await client.query('ALTER TABLE memories ENABLE ROW LEVEL SECURITY');
      await client.query('ALTER TABLE memory_embeddings ENABLE ROW LEVEL SECURITY');
      await client.query('ALTER TABLE usage_daily ENABLE ROW LEVEL SECURITY');

      // Create RLS policies for memories (tenant isolation)
      // Note: Key must match setTenantContext: app.current_tenant
      await client.query(`
        DROP POLICY IF EXISTS tenant_isolation_select ON memories
      `);
      await client.query(`
        CREATE POLICY tenant_isolation_select ON memories
        FOR SELECT
        USING (tenant_id::TEXT = current_setting('app.current_tenant', TRUE))
      `);

      await client.query(`
        DROP POLICY IF EXISTS tenant_isolation_insert ON memories
      `);
      await client.query(`
        CREATE POLICY tenant_isolation_insert ON memories
        FOR INSERT
        WITH CHECK (tenant_id::TEXT = current_setting('app.current_tenant', TRUE))
      `);

      await client.query(`
        DROP POLICY IF EXISTS tenant_isolation_update ON memories
      `);
      await client.query(`
        CREATE POLICY tenant_isolation_update ON memories
        FOR UPDATE
        USING (tenant_id::TEXT = current_setting('app.current_tenant', TRUE))
      `);

      await client.query(`
        DROP POLICY IF EXISTS tenant_isolation_delete ON memories
      `);
      await client.query(`
        CREATE POLICY tenant_isolation_delete ON memories
        FOR DELETE
        USING (tenant_id::TEXT = current_setting('app.current_tenant', TRUE))
      `);

      // RLS policies for embeddings (via memories join)
      await client.query(`
        DROP POLICY IF EXISTS embedding_isolation_select ON memory_embeddings
      `);
      await client.query(`
        CREATE POLICY embedding_isolation_select ON memory_embeddings
        FOR SELECT
        USING (EXISTS (
          SELECT 1 FROM memories 
          WHERE memories.id = memory_embeddings.memory_id 
          AND memories.tenant_id::TEXT = current_setting('app.current_tenant', TRUE)
        ))
      `);

      await client.query(`
        DROP POLICY IF EXISTS embedding_isolation_insert ON memory_embeddings
      `);
      await client.query(`
        CREATE POLICY embedding_isolation_insert ON memory_embeddings
        FOR INSERT
        WITH CHECK (EXISTS (
          SELECT 1 FROM memories 
          WHERE memories.id = memory_embeddings.memory_id 
          AND memories.tenant_id::TEXT = current_setting('app.current_tenant', TRUE)
        ))
      `);

      await client.query(`
        DROP POLICY IF EXISTS embedding_isolation_delete ON memory_embeddings
      `);
      await client.query(`
        CREATE POLICY embedding_isolation_delete ON memory_embeddings
        FOR DELETE
        USING (EXISTS (
          SELECT 1 FROM memories 
          WHERE memories.id = memory_embeddings.memory_id 
          AND memories.tenant_id::TEXT = current_setting('app.current_tenant', TRUE)
        ))
      `);

      // RLS for usage_daily
      await client.query(`
        DROP POLICY IF EXISTS usage_isolation_all ON usage_daily
      `);
      await client.query(`
        CREATE POLICY usage_isolation_all ON usage_daily
        FOR ALL
        USING (tenant_id::TEXT = current_setting('app.current_tenant', TRUE))
      `);

      // Inline migration: add hash_algorithm column to api_keys if missing (RAD-5 / REM-252)
      // This is idempotent (IF NOT EXISTS) — safe to run on every startup.
      // Wrapped in a SAVEPOINT: a failure here (e.g. api_keys does not exist
      // on an engine-only database) would otherwise abort the surrounding
      // transaction, turning the final COMMIT into a silent ROLLBACK that
      // discards the entire schema initialization.
      await client.query('SAVEPOINT api_keys_inline_migration');
      try {
        await client.query(`
          ALTER TABLE api_keys
          ADD COLUMN IF NOT EXISTS hash_algorithm VARCHAR(20) NOT NULL DEFAULT 'sha256'
        `);
        await client.query('RELEASE SAVEPOINT api_keys_inline_migration');
      } catch (_colErr) {
        // api_keys may not exist yet (it is owned by the UI-side schema), or
        // the column may conflict — roll back just this statement.
        await client.query('ROLLBACK TO SAVEPOINT api_keys_inline_migration');
      }

      await client.query('COMMIT');
      console.log('Database schema initialized successfully with RLS policies');
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Failed to initialize schema:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  // Set tenant context for RLS
  // Uses set_config with is_local=true (transaction-scoped, pgBouncer transaction mode compatible).
  // Key MUST match RLS policy: current_setting('app.current_tenant', TRUE) — see 06-postgres-init-db.yaml.
  // Parameterized to prevent SQL injection via tenantId.
  async setTenantContext(client: any, tenantId: string): Promise<void> {
    await client.query('SELECT set_config($1, $2, true)', ['app.current_tenant', tenantId]);
  }

  // Helper method for services to execute queries with automatic tenant context.
  // When tenantId is provided, wraps in an explicit transaction so that
  // set_config(is_local=true) is visible to the subsequent query in the same txn.
  async query(sql: string, params?: any[], tenantId?: string): Promise<any> {
    const client = await this.pool.connect();
    try {
      if (tenantId) {
        await client.query('BEGIN');
        await this.setTenantContext(client, tenantId);
        const result = await client.query(sql, params);
        await client.query('COMMIT');
        return result;
      }
      return await client.query(sql, params);
    } catch (err) {
      if (tenantId) {
        try { await client.query('ROLLBACK'); } catch {}
      }
      throw err;
    } finally {
      client.release();
    }
  }

  // Get tenant plan info with fallback to default limits
  async getTenantPlan(tenantId: string): Promise<TenantPlan | null> {
    const client = await this.readDbPool.connect();
    try {
      await client.query('BEGIN');
      await this.setTenantContext(client, tenantId);
      const result = await client.query(
        'SELECT * FROM tenant_plans WHERE tenant_id = $1',
        [tenantId]
      );
    
      if (result.rows[0]) {
        await client.query('COMMIT');
        return result.rows[0];
      }
      
      // Fallback: Check if tenant exists and create default plan entry
      const tenantResult = await client.query(
        'SELECT plan FROM tenants WHERE id = $1',
        [tenantId]
      );
      
      if (!tenantResult.rows[0]) {
        await client.query('COMMIT');
        return null;
      }
      
      const validPlans = ['free', 'pro', 'team', 'business', 'enterprise'];
      const rawPlan = (tenantResult.rows[0].plan || 'free').toLowerCase();
      const plan = validPlans.includes(rawPlan) ? rawPlan : 'free';
      
      // Define plan limits
      const planLimits: Record<string, { memory: number; search: number; project: number }> = {
        free: { memory: 1000, search: 100, project: 5 },
        pro: { memory: 25000, search: 250000, project: 25 },
        team: { memory: 250000, search: 2500000, project: 999 },
        business: { memory: 1000000, search: 10000000, project: 999 },
        enterprise: { memory: 999999999, search: 999999999, project: 999 }
      };
      
      const limits = planLimits[plan] || planLimits.free;
      
      // Create tenant_plans entry
      await client.query(
        `INSERT INTO tenant_plans (tenant_id, plan, memory_limit, search_limit_daily, project_limit)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id) DO NOTHING`,
        [tenantId, plan, limits.memory, limits.search, limits.project]
      );
      
      // Return the plan we just created
      const planInfo = {
        tenant_id: tenantId,
        plan: plan as 'free' | 'pro' | 'team' | 'business' | 'enterprise',
        memory_limit: limits.memory,
        search_limit_daily: limits.search,
        project_limit: limits.project
      };
      await client.query('COMMIT');
      return planInfo;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch {}
      throw err;
    } finally {
      client.release();
    }
  }

  // Create memory (tenant context must be set)
  async createMemory(
    id: string,
    tenantId: string,
    projectId: string | undefined,
    content: string,
    category: string,
    metadata: Record<string, any>,
    relevanceScore: number = 1.0,
    piiData?: { detected: boolean; types: string[]; confidence: number }
  ): Promise<Memory> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.setTenantContext(client, tenantId);

      const metadataString = typeof metadata === 'string' ? metadata : JSON.stringify(metadata);

      // Include PII fields if provided
      const query = piiData
        ? `INSERT INTO memories (id, tenant_id, project_id, content, category, metadata, relevance_score, pii_detected, pii_types, pii_confidence, pii_scanned_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
           RETURNING *`
        : `INSERT INTO memories (id, tenant_id, project_id, content, category, metadata, relevance_score)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING *`;

      const params = piiData
        ? [id, tenantId, projectId, content, category, metadataString, relevanceScore, piiData.detected, piiData.types, piiData.confidence]
        : [id, tenantId, projectId, content, category, metadataString, relevanceScore];

      const result = await client.query(query, params);

      // Update usage counter
      await client.query(
        `INSERT INTO usage_daily (id, tenant_id, project_id, date, memories_stored)
         VALUES (gen_random_uuid(), $1, $2, CURRENT_DATE, 1)
         ON CONFLICT (tenant_id, project_id, date)
         DO UPDATE SET memories_stored = usage_daily.memories_stored + 1`,
        [tenantId, projectId]
      );

      await client.query('COMMIT');
      const resultMetadata = result.rows[0].metadata;
      return {
        ...result.rows[0],
        metadata: typeof resultMetadata === 'string' ? JSON.parse(resultMetadata) : resultMetadata
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // Store embedding for a memory
  async storeEmbedding(
    memoryId: string,
    tenantId: string,
    embedding: number[],
    provider: string,
    model: string,
    modelFingerprint?: string
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.setTenantContext(client, tenantId);

      const embeddingStr = `[${embedding.join(',')}]`;

      const memoryExists = await client.query(
        'SELECT 1 FROM memories WHERE id = $1 AND tenant_id = $2',
        [memoryId, tenantId]
      );
      if (memoryExists.rowCount === 0) {
        console.warn(`Skipping embedding storage for ${memoryId}: memory no longer exists or is not visible for tenant ${tenantId}`);
        await client.query('COMMIT');
        return;
      }
      
      let canStoreFingerprint = false;
      if (modelFingerprint) {
        const columnCheck = await client.query(
          `SELECT EXISTS (
             SELECT 1
             FROM information_schema.columns
             WHERE table_schema = 'public'
               AND table_name = 'memory_embeddings'
               AND column_name = 'model_fingerprint'
           ) AS exists`
        );
        canStoreFingerprint = columnCheck.rows[0]?.exists === true;
      }

      if (modelFingerprint && canStoreFingerprint) {
        // REM-249: Store with model fingerprint for consistency tracking
        await client.query(
          `INSERT INTO memory_embeddings (memory_id, embedding, provider, model, dimensions, model_fingerprint, is_stale)
           VALUES ($1, $2, $3, $4, $5, $6, FALSE)
           ON CONFLICT (memory_id) DO UPDATE
           SET embedding = $2, provider = $3, model = $4, dimensions = $5, model_fingerprint = $6, 
               is_stale = FALSE, stale_since = NULL, created_at = NOW()`,
          [memoryId, embeddingStr, provider, model, embedding.length, modelFingerprint]
        );
      } else {
        // Fallback: no fingerprint (backwards compatibility)
        if (modelFingerprint) {
          console.warn('memory_embeddings model consistency columns are missing; storing embedding without fingerprint metadata');
        }
        await client.query(
          `INSERT INTO memory_embeddings (memory_id, embedding, provider, model, dimensions)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (memory_id) DO UPDATE
           SET embedding = $2, provider = $3, model = $4, dimensions = $5, created_at = NOW()`,
          [memoryId, embeddingStr, provider, model, embedding.length]
        );
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // Get memory by ID
  // List recent memories (uses read pool for better distribution)
  async getRecentMemories(tenantId: string, limit: number = 10, category?: string): Promise<Memory[]> {
    console.log(`🔍 Database.getRecentMemories called with tenantId=${tenantId}, limit=${limit}, category=${category}`);
    const client = await this.readDbPool.connect();
    try {
      await client.query('BEGIN');
      await this.setTenantContext(client, tenantId);
      // Explicit tenant filter + RLS via app.current_tenant GUC
      let query = 'SELECT * FROM memories WHERE tenant_id = $1';
      const params: any[] = [tenantId];

      if (category) {
        query += ' AND category = $' + (params.length + 1);
        params.push(category);
      }

      query += ' ORDER BY created_at DESC LIMIT $' + (params.length + 1);
      params.push(limit);

      console.log(`📞 Executing query: ${query} with params:`, params);
      const result = await client.query(query, params);
      console.log(`✅ Query completed, returned ${result.rows.length} rows`);

      const memories = result.rows.map(row => {
        const metadata = row.metadata;
        return {
          ...row,
          metadata: typeof metadata === 'string' ? JSON.parse(metadata || '{}') : (metadata || {})
        };
      });
      
      console.log(`✅ Database.getRecentMemories completed successfully`);
      await client.query('COMMIT');
      return memories;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch {}
      throw err;
    } finally {
      client.release();
    }
  }

  // Search memories by text (uses read pool for better distribution)
  async searchMemories(
    tenantId: string,
    query: string,
    category?: string,
    limit: number = 10,
    phraseSearch: boolean = false,
    metadataFilter?: Record<string, any>,
    userId?: string
  ): Promise<Memory[]> {
    const client = await this.readDbPool.connect();
    try {
      await client.query('BEGIN');
      await this.setTenantContext(client, tenantId);

      let sql: string;
      const params: any[] = [];
      let paramIndex = 1;

      if (phraseSearch) {
        // Use PostgreSQL full-text search for phrase matching
        // phraseto_tsquery handles multi-word phrases correctly
        const phraseQuery = query.toLowerCase();
        
        sql = `SELECT m.*, ts_rank(to_tsvector('english', m.content), phraseto_tsquery('english', $${paramIndex})) as rank 
               FROM memories m
               LEFT JOIN projects p ON m.project_id = p.id
               WHERE m.tenant_id = $${paramIndex + 1} 
                 AND to_tsvector('english', m.content) @@ phraseto_tsquery('english', $${paramIndex}::text)
                 AND (
                   p.is_personal = false  -- Shared projects
                   OR p.is_personal IS NULL  -- No project assigned
                   OR (p.is_personal = true AND p.owner_id = $${paramIndex + 2})  -- Own personal projects
                 )`;
        params.push(phraseQuery);
        params.push(tenantId);
        params.push(userId);
        paramIndex += 3;
      } else {
        // Use pg_trgm for fuzzy text matching
        const searchQuery = `%${query.toLowerCase()}%`;
        sql = `SELECT m.* 
               FROM memories m
               LEFT JOIN projects p ON m.project_id = p.id
               WHERE m.tenant_id = $2 
                 AND LOWER(m.content) LIKE $1
                 AND (
                   p.is_personal = false  -- Shared projects
                   OR p.is_personal IS NULL  -- No project assigned
                   OR (p.is_personal = true AND p.owner_id = $3)  -- Own personal projects
                 )`;
        params.push(searchQuery);
        params.push(tenantId);
        params.push(userId);
        paramIndex += 3;
      }

      if (category) {
        sql += ` AND category = $${paramIndex}`;
        params.push(category);
        paramIndex++;
      }

      // Add metadata filtering
      if (metadataFilter && Object.keys(metadataFilter).length > 0) {
        for (const [key, value] of Object.entries(metadataFilter)) {
          sql += ` AND metadata->>'${key}' = $${paramIndex}`;
          params.push(String(value));
          paramIndex++;
        }
      }

      sql += phraseSearch 
        ? ` ORDER BY rank DESC, created_at DESC LIMIT $${paramIndex}`
        : ` ORDER BY created_at DESC LIMIT $${paramIndex}`;
      params.push(limit);

      const result = await client.query(sql, params);

      const rows = result.rows.map((row: any) => {
        const metadata = row.metadata;
        return {
          ...row,
          metadata: typeof metadata === 'string' ? JSON.parse(metadata || '{}') : (metadata || {})
        };
      });
      await client.query('COMMIT');
      return rows;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch {}
      throw err;
    } finally {
      client.release();
    }
  }

  // Semantic search using pgvector
  async semanticSearch(
    tenantId: string,
    projectId: string | undefined,
    queryEmbedding: number[],
    limit: number = 5,
    category?: string,
    metadataFilter?: Record<string, any>,
    userId?: string
  ): Promise<Array<Memory & { similarity: number }>> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.setTenantContext(client, tenantId);

      // Increment search counter
      await client.query(
        `INSERT INTO usage_daily (id, tenant_id, project_id, date, searches_performed)
         VALUES (gen_random_uuid(), $1, $2, CURRENT_DATE, 1)
         ON CONFLICT (tenant_id, project_id, date)
         DO UPDATE SET searches_performed = usage_daily.searches_performed + 1`,
        [tenantId, projectId]
      );

      // Ensure queryEmbedding is a proper array
      let embeddingArray: number[];
      
      if (!queryEmbedding) {
        throw new Error('queryEmbedding is null or undefined');
      }
      
      if (Array.isArray(queryEmbedding)) {
        embeddingArray = queryEmbedding;
      } else if (typeof queryEmbedding === 'string') {
        // Try to parse JSON if it's a string
        try {
          embeddingArray = JSON.parse(queryEmbedding);
          if (!Array.isArray(embeddingArray)) {
            throw new Error('Parsed queryEmbedding is not an array');
          }
        } catch (e) {
          throw new Error(`Failed to parse queryEmbedding string: ${e}`);
        }
      } else {
        throw new Error(`Invalid queryEmbedding: expected array or string, got ${typeof queryEmbedding}. Value: ${JSON.stringify(queryEmbedding)}`);
      }
      
      if (embeddingArray.length === 0) {
        throw new Error('queryEmbedding array is empty');
      }

      const embeddingStr = `[${embeddingArray.join(',')}]`;
      let sql = `
        SELECT m.*, 
               1 - (e.embedding <=> $1::vector) as similarity
        FROM memories m
        JOIN memory_embeddings e ON m.id = e.memory_id
        LEFT JOIN projects p ON m.project_id = p.id
        WHERE m.tenant_id = $2
          AND (
            p.is_personal = false  -- Shared projects
            OR p.is_personal IS NULL  -- No project assigned
            OR (p.is_personal = true AND p.owner_id = $3)  -- Own personal projects
          )
      `;
      const params: any[] = [embeddingStr, tenantId, userId];
      let paramIndex = 4;
      
      if (projectId) {
        sql += ` AND m.project_id = $${paramIndex}`;
        params.push(projectId);
        paramIndex++;
      }

      if (category) {
        sql += ` AND m.category = $${paramIndex}`;
        params.push(category);
        paramIndex++;
      }

      // Add metadata filtering
      if (metadataFilter && Object.keys(metadataFilter).length > 0) {
        for (const [key, value] of Object.entries(metadataFilter)) {
          sql += ` AND m.metadata->>'${key}' = $${paramIndex}`;
          params.push(String(value));
          paramIndex++;
        }
      }

      sql += ` ORDER BY e.embedding <=> $1::vector LIMIT $${paramIndex}`;
      params.push(limit);

      console.log(`🔍 Executing semantic search SQL with ${params.length} params`);
      console.log(`   Tenant: ${tenantId}, Project: ${projectId || 'null'}, Category: ${category || 'any'}`);
      console.log(`   Embedding dimension: ${embeddingArray.length}`);
      console.log(`   SQL: ${sql}`);
      console.log(`   Params: ${JSON.stringify(params.map((p, i) => i === 0 ? `[embedding:${embeddingArray.length}d]` : p))}`);
      
      const result = await client.query(sql, params);
      console.log(`✅ Semantic search query returned ${result.rows.length} rows`);

      const rows = result.rows.map((row: any) => {
        const metadata = row.metadata;
        return {
          ...row,
          metadata: typeof metadata === 'string' ? JSON.parse(metadata || '{}') : (metadata || {})
        };
      });
      await client.query('COMMIT');
      return rows;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally {
      client.release();
    }
  }

  // Update memory
  async updateMemory(
    id: string,
    tenantId: string,
    updates: Partial<Pick<Memory, 'content' | 'category' | 'metadata' | 'relevance_score'>>
  ): Promise<Memory | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.setTenantContext(client, tenantId);

      const fields: string[] = [];
      const values: any[] = [];
      let paramCount = 1;

      if (updates.content !== undefined) {
        fields.push(`content = $${paramCount++}`);
        values.push(updates.content);
      }
      if (updates.category !== undefined) {
        fields.push(`category = $${paramCount++}`);
        values.push(updates.category);
      }
      if (updates.metadata !== undefined) {
        fields.push(`metadata = $${paramCount++}`);
        values.push(JSON.stringify(updates.metadata));
      }
      if (updates.relevance_score !== undefined) {
        fields.push(`relevance_score = $${paramCount++}`);
        values.push(updates.relevance_score);
      }

      if (fields.length === 0) return null;

      fields.push(`updated_at = NOW()`);
      values.push(id);

      // Explicit tenant filter — superuser bypasses RLS
      values.push(tenantId);
      const result = await client.query(
        `UPDATE memories SET ${fields.join(', ')} WHERE id = $${paramCount} AND tenant_id = $${paramCount + 1} RETURNING *`,
        values
      );

      await client.query('COMMIT');

      if (result.rows.length === 0) return null;

      const metadata = result.rows[0].metadata;
      return {
        ...result.rows[0],
        metadata: typeof metadata === 'string' ? JSON.parse(metadata || '{}') : (metadata || {})
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // Delete memory
  async deleteMemory(id: string, tenantId: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.setTenantContext(client, tenantId);

      // Explicit tenant filter — superuser bypasses RLS
      const result = await client.query(
        'DELETE FROM memories WHERE id = $1 AND tenant_id = $2',
        [id, tenantId]
      );

      await client.query('COMMIT');
      return result.rowCount !== null && result.rowCount > 0;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally {
      client.release();
    }
  }

  // Get memory count for tenant
  async getMemoryCount(tenantId: string): Promise<number> {
    const client = await this.readDbPool.connect();
    try {
      await client.query('BEGIN');
      await this.setTenantContext(client, tenantId);
      // Explicit tenant filter — cannot rely on RLS because the DB user
      // may be a superuser (which bypasses RLS entirely)
      const result = await client.query(
        'SELECT COUNT(*) as count FROM memories WHERE tenant_id = $1',
        [tenantId]
      );
      await client.query('COMMIT');
      return parseInt(result.rows[0].count);
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch {}
      throw err;
    } finally {
      client.release();
    }
  }

  // Get today's search count for rate limiting
  async getTodaySearchCount(tenantId: string): Promise<number> {
    const client = await this.readDbPool.connect();
    try {
      await client.query('BEGIN');
      await this.setTenantContext(client, tenantId);
      const result = await client.query(
        `SELECT COALESCE(searches_performed, 0) as count 
         FROM usage_daily 
         WHERE tenant_id = $1 AND date = CURRENT_DATE`,
        [tenantId]
      );
      await client.query('COMMIT');
      return result.rows[0]?.count || 0;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch {}
      throw err;
    } finally {
      client.release();
    }
  }

  // Get project count for tenant (for quota checking)
  async getProjectCount(tenantId: string): Promise<number> {
    const client = await this.readDbPool.connect();
    try {
      await client.query('BEGIN');
      await this.setTenantContext(client, tenantId);
      const result = await client.query(
        'SELECT COUNT(*) as count FROM projects WHERE tenant_id = $1',
        [tenantId]
      );
      await client.query('COMMIT');
      return parseInt(result.rows[0].count) || 0;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch {}
      throw err;
    } finally {
      client.release();
    }
  }

  // Increment search count for usage tracking
  async incrementSearchCount(tenantId: string, projectId?: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.setTenantContext(client, tenantId);
      const today = new Date().toISOString().split('T')[0];
      await client.query(
        `INSERT INTO usage_daily (id, tenant_id, project_id, date, searches_performed)
         VALUES (gen_random_uuid(), $1, $2, $3, 1)
         ON CONFLICT (tenant_id, project_id, date)
         DO UPDATE SET searches_performed = usage_daily.searches_performed + 1`,
        [tenantId, projectId, today]
      );
      await client.query('COMMIT');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally {
      client.release();
    }
  }

  // Get default project for a tenant
  async getDefaultProject(tenantId: string): Promise<string | null> {
    const client = await this.readDbPool.connect();
    try {
      await this.setTenantContext(client, tenantId);
      const result = await client.query(
        `SELECT id FROM projects 
         WHERE tenant_id = $1 
         ORDER BY created_at ASC 
         LIMIT 1`,
        [tenantId]
      );
      return result.rows[0]?.id || null;
    } finally {
      client.release();
    }
  }

  // Context Methods
  async listContexts(projectId: string, category?: string): Promise<Context[]> {
    const client = await this.readDbPool.connect();
    try {
      let query = 'SELECT * FROM contexts WHERE project_id = $1';
      const params: any[] = [projectId];
      
      if (category !== undefined && category !== null) {
        query += ' AND category = $2';
        params.push(category);
      }
      
      query += ' ORDER BY created_at DESC';
      
      const result = await client.query(query, params);
      return result.rows;
    } finally {
      client.release();
    }
  }

  async getContext(contextId: string, tenantId?: string): Promise<Context | null> {
    const client = await this.readDbPool.connect();
    try {
      // contexts table doesn't have tenant_id — scoped via project_id → projects.tenant_id
      let result;
      if (tenantId) {
        result = await client.query(
          `SELECT c.* FROM contexts c
           JOIN projects p ON c.project_id = p.id
           WHERE c.id = $1 AND p.tenant_id = $2`,
          [contextId, tenantId]
        );
      } else {
        result = await client.query(
          'SELECT * FROM contexts WHERE id = $1',
          [contextId]
        );
      }
      return result.rows[0] || null;
    } finally {
      client.release();
    }
  }

  async createContext(context: Context): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        `INSERT INTO contexts (id, project_id, name, description, category, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          context.id,
          context.project_id,
          context.name,
          context.description || null,
          context.category || null,
          context.created_at,
          context.updated_at
        ]
      );
    } finally {
      client.release();
    }
  }

  // Context Summary Methods
  async getContextSummary(contextId: string): Promise<ContextSummary | null> {
    const client = await this.readDbPool.connect();
    try {
      const result = await client.query(
        'SELECT * FROM context_summaries WHERE context_id = $1',
        [contextId]
      );
      return result.rows[0] || null;
    } finally {
      client.release();
    }
  }

  async saveContextSummary(summary: ContextSummary): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        `INSERT INTO context_summaries (context_id, summary_text, memory_count, generated_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (context_id) 
         DO UPDATE SET 
           summary_text = EXCLUDED.summary_text,
           memory_count = EXCLUDED.memory_count,
           generated_at = EXCLUDED.generated_at`,
        [
          summary.context_id,
          summary.summary_text,
          summary.memory_count,
          summary.generated_at
        ]
      );
    } finally {
      client.release();
    }
  }

  // Context Memory Methods
  async getContextMemories(contextId: string, tenantId: string): Promise<Memory[]> {
    const client = await this.readDbPool.connect();
    try {
      // Explicit tenant filter to enforce RLS
      const query = `SELECT m.* 
         FROM memories m
         INNER JOIN memory_contexts mc ON m.id = mc.memory_id
         WHERE mc.context_id = $1 AND m.tenant_id = $2
         ORDER BY mc.added_at DESC`;
      const params = [contextId, tenantId];
      const result = await client.query(query, params);
      return result.rows;
    } finally {
      client.release();
    }
  }

  async searchContextMemories(
    contextId: string,
    query: string,
    limit: number,
    minSimilarity: number
  ): Promise<any[]> {
    const client = await this.readDbPool.connect();
    try {
      // This assumes you have embedding for the query - you'll need to generate it first
      // For now, doing text-based search within the context
      const result = await client.query(
        `SELECT m.*, mc.relevance_score,
                similarity(m.content, $1) as text_similarity
         FROM memories m
         INNER JOIN memory_contexts mc ON m.id = mc.memory_id
         WHERE mc.context_id = $2 
           AND similarity(m.content, $1) >= $3
         ORDER BY text_similarity DESC
         LIMIT $4`,
        [query, contextId, minSimilarity, limit]
      );
      return result.rows;
    } finally {
      client.release();
    }
  }

  async addMemoryToContext(contextMemory: ContextMemory): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        `INSERT INTO memory_contexts (id, context_id, memory_id, relevance_score, added_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4)
         ON CONFLICT (memory_id, context_id) DO NOTHING`,
        [
          contextMemory.context_id,
          contextMemory.memory_id,
          contextMemory.relevance_score,
          contextMemory.added_at
        ]
      );
    } finally {
      client.release();
    }
  }

  async getMemoryById(
    memoryId: string,
    tenantId: string,
    projectId?: string
  ): Promise<Memory | null> {
    const client = await this.readDbPool.connect();
    try {
      await client.query('BEGIN');
      await this.setTenantContext(client, tenantId);
      
      if (projectId !== undefined && projectId !== null) {
        const scopedResult = await client.query(
          'SELECT * FROM memories WHERE id = $1 AND tenant_id = $2 AND project_id = $3',
          [memoryId, tenantId, projectId]
        );
        if (scopedResult.rows[0]) {
          await client.query('COMMIT');
          return scopedResult.rows[0];
        }
      }

      const result = await client.query(
        'SELECT * FROM memories WHERE id = $1 AND tenant_id = $2',
        [memoryId, tenantId]
      );
      await client.query('COMMIT');
      return result.rows[0] || null;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally {
      client.release();
    }
  }

  async getEmbedding(memoryId: string, tenantId: string): Promise<MemoryEmbedding | null> {
    const client = await this.readDbPool.connect();
    try {
      await client.query('BEGIN');
      await this.setTenantContext(client, tenantId);
      
      const result = await client.query(
        `SELECT e.* 
         FROM memory_embeddings e
         JOIN memories m ON e.memory_id = m.id
         WHERE e.memory_id = $1 AND m.tenant_id = $2`,
        [memoryId, tenantId]
      );
      
      if (result.rows.length === 0) {
        await client.query('COMMIT');
        return null;
      }
      
      const row = result.rows[0];
      console.log('Raw embedding from DB:', row.embedding, 'type:', typeof row.embedding);
      // Parse pgvector embedding format to number array
      let embedding: number[];
      if (typeof row.embedding === 'string') {
        // pgvector returns format like "[1,2,3]"
        console.log('Parsing string embedding:', row.embedding);
        embedding = JSON.parse(row.embedding);
      } else if (Array.isArray(row.embedding)) {
        console.log('Using array embedding directly');
        embedding = row.embedding;
      } else {
        throw new Error(`Invalid embedding format: ${typeof row.embedding}`);
      }
      console.log('Parsed embedding array length:', embedding.length);
      
      const embeddingResult = {
        memory_id: row.memory_id,
        embedding,
        provider: row.provider,
        model: row.model,
        dimensions: row.dimensions,
        created_at: row.created_at
      };
      await client.query('COMMIT');
      return embeddingResult;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch {}
      throw err;
    } finally {
      client.release();
    }
  }

  async getEmbeddingCount(tenantId: string, projectId?: string): Promise<number> {
    const client = await this.readDbPool.connect();
    try {
      await client.query('BEGIN');
      await this.setTenantContext(client, tenantId);
      
      let query = `
        SELECT COUNT(DISTINCT e.memory_id) as count
        FROM memory_embeddings e
        JOIN memories m ON e.memory_id = m.id
        WHERE m.tenant_id = $1
      `;
      const params: any[] = [tenantId];
      
      if (projectId !== undefined && projectId !== null) {
        query += ' AND m.project_id = $2';
        params.push(projectId);
      }
      
      const result = await client.query(query, params);
      await client.query('COMMIT');
      return parseInt(result.rows[0].count, 10);
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch {}
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * REM-249: Mark embeddings as stale when model fingerprint changes.
   * Called on startup to detect incompatible embeddings.
   */
  async markStaleEmbeddings(tenantId: string, currentFingerprint: string): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.setTenantContext(client, tenantId);
      
      const result = await client.query(
        `UPDATE memory_embeddings me
         SET is_stale = TRUE, stale_since = NOW()
         FROM memories m
         WHERE me.memory_id = m.id
           AND m.tenant_id = $1
           AND me.model_fingerprint IS NOT NULL
           AND me.model_fingerprint != $2
           AND me.is_stale = FALSE`,
        [tenantId, currentFingerprint]
      );

      await client.query('COMMIT');
      return result.rowCount || 0;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch {}
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * REM-249: Get count of stale embeddings for a tenant.
   */
  async getStaleEmbeddingCount(tenantId: string): Promise<number> {
    const client = await this.readDbPool.connect();
    try {
      await this.setTenantContext(client, tenantId);
      
      const result = await client.query(
        `SELECT COUNT(*) as count
         FROM memory_embeddings me
         JOIN memories m ON me.memory_id = m.id
         WHERE m.tenant_id = $1 AND me.is_stale = TRUE`,
        [tenantId]
      );

      return parseInt(result.rows[0].count, 10);
    } finally {
      client.release();
    }
  }

  /**
   * REM-249: Get list of stale embeddings for re-embedding.
   */
  async getStaleEmbeddings(tenantId: string, limit: number = 100): Promise<Array<{
    memory_id: string;
    content: string;
    old_model: string;
    old_fingerprint: string;
  }>> {
    const client = await this.readDbPool.connect();
    try {
      await this.setTenantContext(client, tenantId);
      
      const result = await client.query(
        `SELECT 
           me.memory_id,
           m.content,
           me.model as old_model,
           me.model_fingerprint as old_fingerprint
         FROM memory_embeddings me
         JOIN memories m ON me.memory_id = m.id
         WHERE m.tenant_id = $1 AND me.is_stale = TRUE
         ORDER BY me.stale_since ASC
         LIMIT $2`,
        [tenantId, limit]
      );

      return result.rows;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
    if (this.readPool) {
      await this.readPool.end();
    }
  }
}
