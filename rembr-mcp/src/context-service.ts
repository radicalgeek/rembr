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

/**
 * ContextService handles context operations for RLM integration.
 * Provides logical groupings within projects: Project → Context → Memories
 */
export class ContextService {
  private tenantId: string;
  private projectId: string | undefined;
  private db: MemoryDatabase;

  constructor(tenantId: string, projectId: string | undefined, db: MemoryDatabase) {
    this.tenantId = tenantId;
    this.projectId = projectId;
    this.db = db;
  }

  /**
   * Check project limit before creating context
   */
  private async checkProjectLimit(): Promise<void> {
    const plan = await this.db.getTenantPlan(this.tenantId);
    if (!plan) {
      throw new Error('Tenant plan not found');
    }

    // Get project count for this tenant
    const projectCount = await this.db.getProjectCount(this.tenantId);
    if (projectCount >= plan.project_limit) {
      throw new Error(`Project limit reached (${plan.project_limit} projects). Please upgrade your plan.`);
    }
  }

  /**
   * Check search limit before searching
   */
  private async checkSearchLimit(): Promise<void> {
    const plan = await this.db.getTenantPlan(this.tenantId);
    if (!plan) {
      throw new Error('Tenant plan not found');
    }

    const searchCount = await this.db.getTodaySearchCount(this.tenantId);
    if (plan.search_limit_daily > 0 && searchCount >= plan.search_limit_daily) {
      throw new Error(`Daily search limit reached (${plan.search_limit_daily} searches). Resets at midnight UTC.`);
    }

    // Track usage
    await this.db.incrementSearchCount(this.tenantId, await this.getOrCreateDefaultProject());
  }

  /**
   * Get or create default project for this tenant
   */
  private async getOrCreateDefaultProject(): Promise<string> {
    if (this.projectId) {
      return this.projectId;
    }

    // Check if tenant has a default project
    let result = await this.db.dbPool.query(
      'SELECT id FROM projects WHERE tenant_id = $1 AND name = $2',
      [this.tenantId, 'default']
    );

    if (result.rows.length === 0) {
      // Create default project
      const projectId = randomUUID();
      await this.db.dbPool.query(
        'INSERT INTO projects (id, tenant_id, name, description) VALUES ($1, $2, $3, $4)',
        [projectId, this.tenantId, 'default', 'Default project for this tenant']
      );
      return projectId;
    }

    return result.rows[0].id;
  }

  /**
   * Get or create default context for this project
   */
  private async getOrCreateDefaultContext(): Promise<string> {
    const projectId = await this.getOrCreateDefaultProject();
    
    // Check if project has a default context
    let result = await this.db.dbPool.query(
      'SELECT id FROM contexts WHERE project_id = $1 AND name = $2',
      [projectId, 'default']
    );

    if (result.rows.length === 0) {
      // Create default context
      const contextId = randomUUID();
      await this.db.dbPool.query(
        'INSERT INTO contexts (id, project_id, name, description) VALUES ($1, $2, $3, $4)',
        [contextId, projectId, 'default', 'Default context for this project']
      );
      return contextId;
    }

    return result.rows[0].id;
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
  async listContexts(category?: string): Promise<Context[]> {
    const projectId = await this.getOrCreateDefaultProject();
    return await this.db.listContexts(projectId, category);
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

    // Check project limit (contexts are part of project quota)
    await this.checkProjectLimit();

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
      await this.db.createContext(context);
      return context;
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

    // Check if we have a cached summary and don't need to regenerate
    if (!regenerate) {
      const existingSummary = await this.db.getContextSummary(contextId);
      if (existingSummary) {
        return existingSummary;
      }
    }

    // Get all memories in this context  
    const memories = await this.db.getContextMemories(contextId, this.tenantId);
    
    // Generate summary text (simple concatenation for now - could use LLM later)
    const summaryText = memories.length > 0
      ? `Context contains ${memories.length} memories across categories: ${
          [...new Set(memories.map(m => m.category))].join(', ')
        }`
      : 'Empty context - no memories yet';

    const summary: ContextSummary = {
      context_id: contextId,
      summary_text: summaryText,
      memory_count: memories.length,
      generated_at: new Date(),
    };

    await this.db.saveContextSummary(summary);
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

    return await this.db.searchContextMemories(contextId, query, limit, minSimilarity);
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
    const memory = await this.db.getMemoryById(memoryId, this.tenantId, projectId);
    if (!memory) {
      throw new Error(`Memory ${memoryId} not found or access denied`);
    }

    const contextMemory: ContextMemory = {
      context_id: contextId,
      memory_id: memoryId,
      relevance_score: relevanceScore,
      added_at: new Date(),
    };

    await this.db.addMemoryToContext(contextMemory);
  }
}
