import { randomUUID } from 'crypto';
import type { MemoryDatabase } from './database.js';

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

const CONTEXT_LIMITS: Record<string, number> = {
  dev: 100,
  free: 100,
  pro: 2_500,
  team: 25_000,
  business: 100_000,
  enterprise: 1_000_000,
};

/**
 * ContextService handles context operations for RLM integration.
 * Provides logical groupings within projects: Project → Context → Memories
 */
export class ContextService {
  private tenantId: string;
  private projectId: string | undefined;
  private userId: string | undefined;
  private db: MemoryDatabase;

  constructor(tenantId: string, projectId: string | undefined, db: MemoryDatabase, userId?: string) {
    this.tenantId = tenantId;
    this.projectId = projectId;
    this.db = db;
    this.userId = userId;
  }

  /**
   * Check search limit before searching
   */
  private async checkSearchLimit(): Promise<void> {
    await this.db.reserveSearchQuota(
      this.tenantId,
      await this.getOrCreateDefaultProject(),
    );
  }

  /**
   * Get or create default project for this tenant
   */
  private async getOrCreateDefaultProject(): Promise<string> {
    if (this.projectId) {
      const scoped = await this.db.query(
        `SELECT p.id FROM projects p
         WHERE p.id = $1 AND p.tenant_id = $2
           AND (p.is_personal = false OR p.owner_id = $3::uuid
                OR EXISTS (SELECT 1 FROM project_members pm
                           WHERE pm.project_id = p.id AND pm.user_id = $3::uuid))`,
        [this.projectId, this.tenantId, this.userId || null],
        this.tenantId,
      );
      if (scoped.rows.length === 0) {
        throw new Error('Project not found or access denied');
      }
      return this.projectId;
    }

    // Unscoped credentials may use only the shared system default. A personal
    // project named "default" must never be selected through name collision.
    const sharedDefaultName = '__rembr_shared_default__';
    return this.db.withTenantTransaction(this.tenantId, async client => {
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [`default-hierarchy:${this.tenantId}`],
      );
      const result = await client.query(
        `SELECT id FROM projects
         WHERE tenant_id = $1 AND name = $2 AND is_personal = false
         ORDER BY created_at, id LIMIT 1`,
        [this.tenantId, sharedDefaultName],
      );
      if (result.rows[0]) return result.rows[0].id;

      const projectId = randomUUID();
      const inserted = await client.query(
        `INSERT INTO projects (id, tenant_id, name, description, is_personal)
         VALUES ($1, $2, $3, $4, false)
         ON CONFLICT (tenant_id)
           WHERE name = '__rembr_shared_default__' AND is_personal = false
         DO NOTHING
         RETURNING id`,
        [projectId, this.tenantId, sharedDefaultName, 'Shared default project for this tenant'],
      );
      if (inserted.rows[0]) return inserted.rows[0].id;
      const existing = await client.query(
        `SELECT id FROM projects
         WHERE tenant_id = $1 AND name = $2 AND is_personal = false
         ORDER BY created_at, id LIMIT 1`,
        [this.tenantId, sharedDefaultName],
      );
      if (!existing.rows[0]) throw new Error('Unable to provision shared default project');
      return existing.rows[0].id;
    });
  }

  /**
   * Get or create default context for this project
   */
  private async getOrCreateDefaultContext(): Promise<string> {
    const projectId = await this.getOrCreateDefaultProject();
    
    return this.db.withTenantTransaction(this.tenantId, async client => {
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [`context-quota:${this.tenantId}`],
      );
      const result = await client.query(
        `SELECT id FROM contexts WHERE project_id = $1 AND name = $2
         ORDER BY created_at, id LIMIT 1`,
        [projectId, 'default'],
      );
      if (result.rows[0]) return result.rows[0].id;

      const tenant = await client.query(
        `SELECT LOWER(COALESCE(plan, 'free')) AS plan
         FROM tenants WHERE id = $1 FOR UPDATE`,
        [this.tenantId],
      );
      if (!tenant.rows[0]) throw new Error('Tenant plan not found');
      const contextLimit = CONTEXT_LIMITS[String(tenant.rows[0].plan || 'free')] || CONTEXT_LIMITS.free;
      const usage = await client.query(
        `SELECT COUNT(*)::int AS context_count
         FROM contexts c JOIN projects p ON p.id = c.project_id
         WHERE p.tenant_id = $1`,
        [this.tenantId],
      );
      if (Number(usage.rows[0]?.context_count || 0) >= contextLimit) {
        throw new Error(`Context limit reached (${contextLimit} contexts). Please upgrade your plan.`);
      }

      const inserted = await client.query(
        `INSERT INTO contexts (id, project_id, name, description)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (project_id, name) DO NOTHING
         RETURNING id`,
        [randomUUID(), projectId, 'default', 'Default context for this project'],
      );
      if (inserted.rows[0]) return inserted.rows[0].id;
      const existing = await client.query(
        `SELECT id FROM contexts WHERE project_id = $1 AND name = $2
         ORDER BY created_at, id LIMIT 1`,
        [projectId, 'default'],
      );
      if (!existing.rows[0]) throw new Error('Unable to provision default context');
      return existing.rows[0].id;
    });
  }

  /**
   * Ensure tenant has complete default hierarchy (project + context)
   */
  async ensureDefaults(): Promise<{ projectId: string; contextId: string }> {
    const projectId = await this.getOrCreateDefaultProject();
    const contextId = await this.getOrCreateDefaultContext();
    return { projectId, contextId };
  }

  /**
   * List all contexts for the current project
   */
  async listContexts(category?: string, limit: number = 50): Promise<Context[]> {
    const projectId = await this.getOrCreateDefaultProject();
    return await this.db.listContexts(projectId, this.tenantId, category, limit);
  }

  /**
   * Create a new context within the current project
   */
  async createContext(
    name: string,
    description?: string,
    category?: string
  ): Promise<Context> {
    const projectId = await this.getOrCreateDefaultProject();

    const context: Context = {
      id: randomUUID(),
      project_id: projectId,
      name,
      description: description || null,
      category: category || null,
      created_at: new Date(),
      updated_at: new Date(),
    };

    try {
      return await this.db.withTenantTransaction(this.tenantId, async client => {
        await client.query(
          `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
          [`context-quota:${this.tenantId}`],
        );

        const project = await client.query(
          `SELECT 1 FROM projects p
           WHERE p.id = $1 AND p.tenant_id = $2
             AND (p.is_personal = false OR p.owner_id = $3::uuid
                  OR EXISTS (SELECT 1 FROM project_members pm
                             WHERE pm.project_id = p.id AND pm.user_id = $3::uuid))
           FOR SHARE OF p`,
          [projectId, this.tenantId, this.userId || null],
        );
        if (project.rows.length === 0) throw new Error('Project not found or access denied');

        const tenant = await client.query(
          `SELECT LOWER(COALESCE(plan, 'free')) AS plan
           FROM tenants WHERE id = $1 FOR UPDATE`,
          [this.tenantId],
        );
        if (!tenant.rows[0]) throw new Error('Tenant plan not found');
        const planName = String(tenant.rows[0].plan || 'free');
        const contextLimit = CONTEXT_LIMITS[planName] || CONTEXT_LIMITS.free;
        const usage = await client.query(
          `SELECT COUNT(*)::int AS context_count
           FROM contexts c
           JOIN projects p ON p.id = c.project_id
           WHERE p.tenant_id = $1`,
          [this.tenantId],
        );
        const contextCount = Number(usage.rows[0]?.context_count || 0);
        if (contextCount >= contextLimit) {
          throw new Error(`Context limit reached (${contextLimit} contexts). Please upgrade your plan.`);
        }

        const inserted = await client.query(
          `INSERT INTO contexts (id, project_id, name, description, category)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING *`,
          [context.id, projectId, name, description || null, category || null],
        );
        return inserted.rows[0] as Context;
      });
    } catch (error: any) {
      if (error.code === '23505' && error.constraint === 'contexts_project_id_name_key') {
        throw new Error(`Context with name '${name}' already exists in this project`);
      }
      throw error;
    }
  }

  /**
   * Get or generate a summary of all memories in a context
   */
  async getContextSummary(contextId: string, regenerate: boolean = false): Promise<ContextSummary> {
    // Verify context access through project ownership
    const context = await this.db.getContext(contextId, this.tenantId);
    if (!context) {
      throw new Error(`Context ${contextId} not found`);
    }

    const projectId = await this.getOrCreateDefaultProject();
    if (context.project_id !== projectId) {
      throw new Error(`Context ${contextId} not found or access denied`);
    }

    // Get all memories in this context  
    const memories = await this.db.getContextMemories(
      contextId,
      this.tenantId,
      this.projectId,
      this.userId,
      500,
      1,
      false,
    );
    
    // Generate summary text (simple concatenation for now - could use LLM later)
    const summaryText = memories.length > 0
      ? `Context contains ${memories.length} memories across categories: ${
          [...new Set(memories.map(m => m.category))].join(', ')
        }`
      : 'Empty context - no memories yet';

    const summary: ContextSummary = {
      context_id: contextId,
      summary_text: summaryText,
      memory_count: Number(memories[0]?.total_count || memories.length),
      generated_at: new Date(),
    };

    // Context membership can include personal memories, so a single cached
    // summary row cannot represent every caller's audience safely. Return the
    // caller-scoped summary ephemerally until summaries have an audience key.
    return summary;
  }

  /**
   * Search memories within a specific context
   */
  async searchContext(
    contextId: string,
    query: string,
    limit: number = 10,
    minSimilarity: number = 0.7
  ): Promise<any[]> {
    // Check search limit
    await this.checkSearchLimit();

    // Verify context access
    const context = await this.db.getContext(contextId, this.tenantId);
    if (!context) {
      throw new Error(`Context ${contextId} not found`);
    }

    const projectId = await this.getOrCreateDefaultProject();
    if (context.project_id !== projectId) {
      throw new Error(`Context ${contextId} not found or access denied`);
    }

    return await this.db.searchContextMemories(
      contextId,
      query,
      limit,
      minSimilarity,
      this.tenantId,
      this.projectId,
      this.userId,
    );
  }

  /**
   * Add an existing memory to a context
   */
  async addMemoryToContext(
    contextId: string,
    memoryId: string,
    relevanceScore: number = 1.0
  ): Promise<void> {
    // Verify context access
    const context = await this.db.getContext(contextId, this.tenantId);
    if (!context) {
      throw new Error(`Context ${contextId} not found`);
    }

    const projectId = await this.getOrCreateDefaultProject();
    if (context.project_id !== projectId) {
      throw new Error(`Context ${contextId} not found or access denied`);
    }

    // Verify memory belongs to this tenant (use default project)
    const memory = await this.db.getMemoryById(memoryId, this.tenantId, projectId, this.userId);
    if (!memory) {
      throw new Error(`Memory ${memoryId} not found or access denied`);
    }

    const contextMemory: ContextMemory = {
      context_id: contextId,
      memory_id: memoryId,
      relevance_score: relevanceScore,
      added_at: new Date(),
    };

    await this.db.addMemoryToContext(
      contextMemory,
      this.tenantId,
      projectId,
      this.userId,
    );
  }
}
