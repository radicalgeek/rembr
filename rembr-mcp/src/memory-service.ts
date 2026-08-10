import { MemoryDatabase, Memory, TenantPlan } from './database.js';
import { EmbeddingProvider, OllamaEmbeddingProvider } from './ollama-provider.js';
import { QueryIntentService, QueryIntent } from './query-intent-service.js';
import { MemoryRelationshipService } from './memory-relationship-service.js';
import { ContextualEmbeddingService } from './contextual-embedding-service.js';
import { AdvancedAnalyticsService } from './advanced-analytics-service.js';
import { MemoryMaintenanceService } from './memory-maintenance-service.js';
import { piiDetector } from './pii-detector.js';
import { 
  trackEmbeddingFailure, 
  trackEmbeddingInflight, 
  trackBackgroundProcessing,
  updateEmbeddingBacklog,
  embeddingRetryCounter
} from './metrics.js';
import { truncateToTokenBudget, getBudgetLimit } from './token-budget.js';
import { randomUUID } from 'crypto';

export interface CreateMemoryInput {
  content: string;
  category: string;
  project_id?: string;
  metadata?: Record<string, any>;
  relevance_score?: number;
}

export interface UpdateMemoryInput {
  content?: string;
  category?: string;
  metadata?: Record<string, any>;
  relevance_score?: number;
}

export interface SearchMemoryInput {
  query: string;
  category?: string;
  limit?: number;
  min_similarity?: number;
  search_mode?: 'hybrid' | 'semantic' | 'text' | 'phrase';
  metadata_filter?: Record<string, any>;
  // Budget-aware search parameters (REM-103)
  max_tokens?: number;
  token_budget_category?: string;
  // PII filter (REM-50)
  exclude_pii?: boolean;
}

export interface HybridSearchResult extends Memory {
  score: number;
  semantic_similarity?: number;
  text_match?: boolean;
}

export interface ConnectedMemory {
  id: string;
  content: string;
  relationship_type: string;
  confidence: number;
  evidence?: string;
}

export interface ExpandedSearchResult extends HybridSearchResult {
  connected_memories?: ConnectedMemory[];
  graph_boost?: number;
}

export interface SearchDiagnostics {
  semantic_status: 'succeeded' | 'failed' | 'unavailable' | 'skipped';
  semantic_error?: string;
  fallback_used: boolean;
  min_similarity: number;
  embedding_coverage: number | null;
  embedding_pending: number | null;
  embedding_total: number | null;
}

export type SearchMemoryResults = ExpandedSearchResult[] & {
  search_metadata?: SearchDiagnostics;
};

export interface MemoryStats {
  total_memories: number;
  by_category: Record<string, number>;
  plan: string;
  memory_limit: number;
  searches_today: number | null;
  searches_today_scope: 'tenant' | 'project' | 'unavailable';
  search_limit_daily: number;
  usage_percentage: number;
  scope: 'authorised_audience';
}

export interface EmbeddingStats {
  total_embeddings: number;
  embedding_provider: string;
  embedding_model: string;
  dimensions: number;
  semantic_search_available: boolean;
  memories_without_embeddings: number;
}

export const MEMORY_CATEGORIES = [
  // Original 8 categories
  'facts',
  'preferences', 
  'conversations',
  'projects',
  'learning',
  'goals',
  'context',
  'reminders',
  // New RLM-optimized categories (Week 13)
  'patterns',      // Code patterns, architectural patterns, best practices
  'decisions',     // Technical decisions, trade-offs, architectural choices
  'workflows',     // Process flows, deployment procedures, development workflows
  'insights'       // Analytical findings, performance insights, optimization opportunities
] as const;

export type MemoryCategory = typeof MEMORY_CATEGORIES[number];

export class MemoryService {
  private db: MemoryDatabase;
  private embeddingProvider?: EmbeddingProvider;
  private tenantId: string;
  private projectId?: string;
  private userId?: string;
  
  // Week 13 Context Intelligence services
  private queryIntentService: QueryIntentService;
  private relationshipService!: MemoryRelationshipService;
  private contextualEmbeddingService!: ContextualEmbeddingService;
  private advancedAnalyticsService!: AdvancedAnalyticsService;

  constructor(
    tenantId: string,
    projectId: string | undefined,
    db: MemoryDatabase,
    embeddingProvider?: EmbeddingProvider,
    userId?: string
  ) {
    this.tenantId = tenantId;
    this.projectId = projectId;
    this.db = db;
    this.embeddingProvider = embeddingProvider;
    this.userId = userId;
    
    // Initialize Context Intelligence services
    this.queryIntentService = new QueryIntentService(db);
    if (embeddingProvider) {
      this.relationshipService = new MemoryRelationshipService(db, embeddingProvider);
      this.contextualEmbeddingService = new ContextualEmbeddingService(db, embeddingProvider);
      this.advancedAnalyticsService = new AdvancedAnalyticsService(db, embeddingProvider);
    }
  }

  /**
   * Get or create default project for this tenant
   */
  private async getOrCreateDefaultProject(): Promise<string> {
    if (this.projectId) {
      return this.projectId;
    }

    // Use a reserved shared sentinel so a personal project named "default"
    // can never be selected by an unscoped agent.  The advisory lock and
    // partial unique index make concurrent first-use provisioning idempotent.
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

  // Store a new memory
  async storeMemory(input: CreateMemoryInput): Promise<Memory> {
    const id = randomUUID();
    
    // Always use default project to ensure consistency
    const projectId = await this.getOrCreateDefaultProject();
    
    // Detect PII in content (Phase 0.5 / REM-51)
    // Use plan-aware sensitivity: Pro+ gets 'high', Free gets 'medium'
    const tenantPlan = await this.db.getTenantPlan(this.tenantId);
    const { getPIICapabilities } = await import('./pii-plan-limits.js');
    const piiCaps = getPIICapabilities(tenantPlan?.plan || 'free');
    const piiSensitivity = piiCaps.maxSensitivity;

    const piiResult = piiDetector.detectPII(input.content, piiSensitivity);
    const piiData = {
      detected: piiResult.hasPII,
      types: piiResult.types,
      confidence: piiResult.confidence,
    };
    
    const memory = await this.db.createMemory(
      id,
      this.tenantId,
      projectId,
      input.content,
      input.category,
      input.metadata || {},
      input.relevance_score || 1.0,
      piiData,
      this.userId,
    );

    // Keep store_memory on the durable write path only. Continuous indexing,
    // relationships, contradictions, and cleanup are handled by the maintenance
    // worker; inline processing can be enabled for local debugging.
    if (process.env.ENABLE_INLINE_MEMORY_BACKGROUND_PROCESSING === 'true') {
      const backgroundJob = setImmediate(() => {
        this.scheduleBackgroundProcessing(id, projectId, input.content);
      });
      backgroundJob.unref?.();
    }

    return memory;
  }

  /** Max concurrent embedding generation jobs */
  private static readonly MAX_INFLIGHT_EMBEDDINGS = 3;
  private static inflightEmbeddings = 0;
  private static missingEmbeddingBackfills = new Set<string>();
  /** Total in-flight background jobs across all types */
  static get totalInflight(): number {
    return MemoryService.inflightEmbeddings;
  }
  /** Max retry attempts for failed embedding generation */
  private static readonly MAX_EMBEDDING_RETRIES = 3;

  /**
   * Schedule background processing for a memory (embedding generation, relationship inference, contradiction detection)
   * This runs asynchronously and does NOT block the API response, fixing the 2-10 second timeout issue
   * 
   * Includes: concurrency limiting, retry with backoff, and Prometheus metrics for all stages
   */
  private scheduleBackgroundProcessing(memoryId: string, projectId: string, content: string): void {
    // Background embedding generation with retry and metrics
    if (this.embeddingProvider) {
      this.scheduleEmbeddingWithRetry(memoryId, projectId, content, 0);
    } else {
      console.warn('Embedding provider unavailable; a stored memory remains pending semantic indexing');
    }

    this.enqueueContradictionDetection(memoryId);
  }

  private enqueueContradictionDetection(memoryId: string): void {
    const maintenance = new MemoryMaintenanceService(this.db);
    maintenance.enqueueContradictionDetectionJobForMemory(this.tenantId, memoryId)
      .then(result => {
        if (result.created > 0) {
          if (process.env.NODE_ENV !== 'production') console.log('Queued contradiction detection');
        }
      })
      .catch(error => {
        console.error('Failed to queue contradiction detection');
      });
  }

  /**
   * Attempt embedding generation with retry and exponential backoff.
   * Respects concurrency limit to prevent Ollama overload.
   */
  private scheduleEmbeddingWithRetry(memoryId: string, projectId: string, content: string, attempt: number): void {
    // Concurrency gate: if too many in-flight, delay and retry
    if (MemoryService.inflightEmbeddings >= MemoryService.MAX_INFLIGHT_EMBEDDINGS) {
      const delayMs = 1000 * (attempt + 1); // Back off on concurrency pressure
      console.log(`⏳ Embedding queue full (${MemoryService.inflightEmbeddings}/${MemoryService.MAX_INFLIGHT_EMBEDDINGS}); delaying a pending job by ${delayMs}ms`);
      setTimeout(() => this.scheduleEmbeddingWithRetry(memoryId, projectId, content, attempt), delayMs);
      return;
    }

    MemoryService.inflightEmbeddings++;
    trackEmbeddingInflight(1);
    const startTime = Date.now();

    if (process.env.NODE_ENV !== 'production') {
      console.log(`Generating memory embedding (attempt ${attempt + 1}/${MemoryService.MAX_EMBEDDING_RETRIES}, inflight: ${MemoryService.inflightEmbeddings})`);
    }

    this.embeddingProvider!.generateEmbedding(content, { tenantId: this.tenantId })
      .then(async (embedding) => {
        const durationSec = (Date.now() - startTime) / 1000;
        if (process.env.NODE_ENV !== 'production') console.log(`Generated embedding in ${durationSec.toFixed(2)}s`);
        
        await this.db.storeEmbedding(
          memoryId,
          this.tenantId,
          embedding,
          this.embeddingProvider!.name,
          this.embeddingProvider!.model,
          this.embeddingProvider!.getModelFingerprint()  // REM-249
        );
        
        trackBackgroundProcessing('embedding', 'success', this.tenantId, durationSec);
        if (process.env.NODE_ENV !== 'production') console.log('Stored memory embedding');
        
        // After embedding is ready, infer relationships
        return this.scheduleRelationshipInference(memoryId, projectId);
      })
      .catch(error => {
        const durationSec = (Date.now() - startTime) / 1000;
        trackBackgroundProcessing('embedding', 'error', this.tenantId, durationSec);

        // Classify failure reason for metrics
        const reason = error?.message?.includes('timeout') ? 'timeout' :
                       error?.message?.includes('ECONNREFUSED') ? 'ollama_down' :
                       error?.message?.includes('Invalid embedding dimensions') ? 'invalid_dims' : 'unknown';
        trackEmbeddingFailure(reason, this.tenantId);

        // Retry with exponential backoff
        if (attempt < MemoryService.MAX_EMBEDDING_RETRIES - 1) {
          const backoffMs = Math.min(1000 * Math.pow(2, attempt), 30000); // 1s, 2s, 4s... max 30s
          embeddingRetryCounter.inc();
          console.warn(`Embedding failed (attempt ${attempt + 1}/${MemoryService.MAX_EMBEDDING_RETRIES}, reason: ${reason}); retrying in ${backoffMs}ms`);
          setTimeout(() => this.scheduleEmbeddingWithRetry(memoryId, projectId, content, attempt + 1), backoffMs);
        } else {
          console.error(`Embedding generation failed after ${MemoryService.MAX_EMBEDDING_RETRIES} attempts (reason: ${reason})`);
        }
      })
      .finally(() => {
        MemoryService.inflightEmbeddings--;
        trackEmbeddingInflight(-1);
      });
  }

  /**
   * Schedule relationship inference after embedding is available
   */
  private async scheduleRelationshipInference(memoryId: string, projectId: string): Promise<void> {
    if (!this.relationshipService) {
      return;
    }

    const startTime = Date.now();
    try {
      const relationships = await this.relationshipService.inferRelationshipsForMemory(
        memoryId, 
        this.tenantId, 
        projectId
      );
      
      // Auto-accept medium+ confidence relationships (lowered from 0.8 to 0.6)
      const qualityRelationships = relationships.filter(r => r.confidence >= 0.6);
      
      if (qualityRelationships.length > 0) {
        if (process.env.NODE_ENV !== 'production') console.log(`Storing ${qualityRelationships.length} inferred relationships`);
        
        await this.relationshipService.storeRelationships(
          qualityRelationships,
          this.tenantId
        );
      }
      
      const durationSec = (Date.now() - startTime) / 1000;
      trackBackgroundProcessing('relationship', 'success', this.tenantId, durationSec);
    } catch (error) {
      const durationSec = (Date.now() - startTime) / 1000;
      trackBackgroundProcessing('relationship', 'error', this.tenantId, durationSec);
      console.error('Background relationship inference failed');
    }
  }

  // Hybrid search: combine semantic and text search with graph-aware ranking
  async searchMemory(input: SearchMemoryInput): Promise<SearchMemoryResults> {
    await this.db.reserveSearchQuota(this.tenantId, this.projectId);

    const limit = input.limit || 10;
    const minSimilarity = input.min_similarity ?? this.getDefaultSearchMinSimilarity();
    const searchMode = input.search_mode || 'hybrid';

    // Weights for hybrid search
    const SEMANTIC_WEIGHT = 0.7;
    const TEXT_WEIGHT = 0.3;

    const results: HybridSearchResult[] = [];
    const diagnostics: SearchDiagnostics = {
      semantic_status: searchMode === 'text' || searchMode === 'phrase' ? 'skipped' : 'unavailable',
      fallback_used: false,
      min_similarity: minSimilarity,
      embedding_coverage: null,
      embedding_pending: null,
      embedding_total: null,
    };

    if ((searchMode === 'semantic' || searchMode === 'hybrid') && !this.embeddingProvider) {
      diagnostics.semantic_status = 'unavailable';
      diagnostics.semantic_error = 'No embedding provider configured';
      diagnostics.fallback_used = searchMode === 'hybrid';
      if (searchMode === 'semantic') {
        throw new Error('Semantic search unavailable: no embedding provider configured');
      }
    }

    // Semantic search if embedding provider is available
    if ((searchMode === 'semantic' || searchMode === 'hybrid') && this.embeddingProvider) {
      try {
        if (process.env.NODE_ENV !== 'production') console.log('Generating search-query embedding');
        const queryEmbedding = await this.embeddingProvider.generateEmbedding(input.query, { tenantId: this.tenantId });
        console.log(`✅ Query embedding generated, length: ${queryEmbedding.length}`);
        
        const semanticResults = await this.db.semanticSearch(
          this.tenantId,
          this.projectId,
          queryEmbedding,
          limit * 2, // Get more results for reranking
          input.category,
          input.metadata_filter,
          this.userId
        );
        console.log(`📊 Semantic search returned ${semanticResults.length} results`);

        for (const result of semanticResults) {
          if (result.similarity >= minSimilarity) {
            results.push({
              ...result,
              score: searchMode === 'semantic' ? result.similarity : result.similarity * SEMANTIC_WEIGHT,
              semantic_similarity: result.similarity
            });
          }
        }
        console.log(`✅ ${results.length} results passed similarity threshold`);
        diagnostics.semantic_status = 'succeeded';
      } catch (error) {
        console.error('Semantic search failed');
        diagnostics.semantic_status = 'failed';
        diagnostics.semantic_error = 'Embedding-backed search failed';
        if (searchMode === 'semantic') {
          throw new Error('Semantic search unavailable');
        }
        diagnostics.fallback_used = true;
      }
    }

    // Text or phrase search
    if (searchMode === 'text' || searchMode === 'hybrid' || searchMode === 'phrase') {
      const textResults = await this.db.searchMemories(
        this.tenantId,
        input.query,
        input.category,
        limit * 2,
        searchMode === 'phrase',
        input.metadata_filter,
        this.userId,
        this.projectId
      );

      // Merge text results with semantic results
      for (const textResult of textResults) {
        const existingIdx = results.findIndex(r => r.id === textResult.id);
        
        if (existingIdx >= 0) {
          // Boost score for results that appear in both
          results[existingIdx].score += searchMode === 'hybrid' ? TEXT_WEIGHT : 1.0;
          results[existingIdx].text_match = true;
        } else {
          // Add new text-only result
          results.push({
            ...textResult,
            score: searchMode === 'text' || searchMode === 'phrase' ? 1.0 : TEXT_WEIGHT,
            text_match: true
          });
        }
      }
    }

    // Phase 1 Enhancement: Graph-aware search with relationship traversal
    const expandedResults = await this.expandViaGraph(results);
    const rankedResults = this.rankWithGraphSignals(expandedResults);

    // Sort by enhanced score
    const sortedResults = rankedResults.sort((a, b) => b.score - a.score);
    
    // Filter out PII-flagged memories if requested (REM-50)
    const filteredResults = input.exclude_pii
      ? sortedResults.filter(r => !r.pii_detected)
      : sortedResults;

    try {
      const embeddingStatus = await this.getPendingEmbeddingCount();
      diagnostics.embedding_pending = embeddingStatus.pending;
      diagnostics.embedding_total = embeddingStatus.total;
      diagnostics.embedding_coverage = embeddingStatus.total > 0
        ? (embeddingStatus.total - embeddingStatus.pending) / embeddingStatus.total
        : 1;
    } catch (error) {
      console.warn('Failed to calculate search embedding coverage');
    }
    
    // Apply token budget truncation if requested (REM-103)
    let maxTokens = input.max_tokens;
    
    // If token_budget_category is provided, fetch limit from context_budgets table
    if (!maxTokens && input.token_budget_category) {
      try {
        const budgetLimit = await getBudgetLimit(
          this.db.dbPool,
          this.tenantId,
          input.token_budget_category
        );
        if (budgetLimit) {
          maxTokens = budgetLimit;
          if (process.env.NODE_ENV !== 'production') console.log(`Using a ${budgetLimit}-token search budget`);
        } else {
          console.warn('Requested search-budget category was not found or is inactive');
        }
      } catch (error) {
        console.error('❌ Failed to fetch budget limit:', error);
      }
    }
    
    // Apply truncation if max_tokens is set
    if (maxTokens) {
      const budgetResult = truncateToTokenBudget(filteredResults.slice(0, limit), maxTokens);
      console.log(`📊 Budget-aware search: ${budgetResult.results.length}/${limit} results fit in ${budgetResult.total_tokens}/${maxTokens} tokens`);
      
      if (budgetResult.warning) {
        console.warn(`⚠️  ${budgetResult.warning}`);
      }
      
      return this.withSearchMetadata(budgetResult.results, diagnostics);
    }
    
    // Return top N without budget truncation
    return this.withSearchMetadata(filteredResults.slice(0, limit), diagnostics);
  }

  private withSearchMetadata(
    results: ExpandedSearchResult[],
    diagnostics: SearchDiagnostics,
  ): SearchMemoryResults {
    const enriched = results as SearchMemoryResults;
    enriched.search_metadata = diagnostics;
    return enriched;
  }

  private getDefaultSearchMinSimilarity(): number {
    const configured = Number(process.env.SEARCH_DEFAULT_MIN_SIMILARITY);
    if (Number.isFinite(configured) && configured >= 0 && configured <= 1) {
      return configured;
    }

    const provider = this.embeddingProvider?.name.toLowerCase() || '';
    return provider.includes('openai-compatible') ? 0.35 : 0.5;
  }

  // List recent memories
  async listMemories(limit: number = 10, category?: string): Promise<Memory[]> {
    if (process.env.NODE_ENV !== 'production') console.log(`Listing memories with limit ${limit}`);
    try {
      const memories = await this.db.getRecentMemories(
        this.tenantId,
        limit,
        category,
        this.projectId,
        this.userId,
      );
      console.log(`✅ MemoryService.listMemories completed, retrieved ${memories.length} memories`);
      return memories;
    } catch (error) {
      console.error('Memory listing failed');
      throw error;
    }
  }

  // Get specific memory by ID
  async getMemory(id: string): Promise<Memory | null> {
    return await this.db.getMemoryById(id, this.tenantId, this.projectId, this.userId);
  }

  // Update memory
  async updateMemory(id: string, updates: UpdateMemoryInput): Promise<Memory | null> {
    const updated = await this.db.updateMemory(id, this.tenantId, updates, this.projectId, this.userId);
    
    // Re-scan for PII if content changed (REM-50/REM-51)
    if (updated && updates.content) {
      try {
        const tenantPlan = await this.db.getTenantPlan(this.tenantId);
        const { getPIICapabilities } = await import('./pii-plan-limits.js');
        const piiCaps = getPIICapabilities(tenantPlan?.plan || 'free');
        const piiResult = piiDetector.detectPII(updates.content, piiCaps.maxSensitivity);
        await this.db.dbPool.query(
          `UPDATE memories SET 
             pii_detected = $1, 
             pii_types = $2, 
             pii_confidence = $3, 
             pii_scanned_at = NOW() 
           WHERE id = $4 AND tenant_id = $5`,
          [piiResult.hasPII, piiResult.types, piiResult.confidence, id, this.tenantId]
        );
      } catch (error) {
        console.error('Failed to re-scan PII on update:', error);
      }
    }
    
    // Regenerate embedding if content changed
    if (updated && updates.content && this.embeddingProvider) {
      try {
        const embedding = await this.embeddingProvider.generateEmbedding(updates.content, { tenantId: this.tenantId });
        await this.db.storeEmbedding(
          id,
          this.tenantId,
          embedding,
          this.embeddingProvider.name,
          this.embeddingProvider.model,
          this.embeddingProvider.getModelFingerprint()  // REM-249
        );
        
        this.enqueueContradictionDetection(id);
      } catch (error) {
        console.error('Failed to regenerate embedding:', error);
      }
    }

    return updated;
  }

  // Delete memory
  async deleteMemory(id: string): Promise<boolean> {
    return await this.db.deleteMemory(id, this.tenantId, this.projectId, this.userId);
  }

  /**
   * Phase 1: Graph traversal method to find connected memories
   * Expands search results by following relationship connections
   */
  private async expandViaGraph(coreResults: HybridSearchResult[]): Promise<ExpandedSearchResult[]> {
    if (coreResults.length === 0) return [];

    const memoryIds = coreResults.map(r => r.id);
    
    try {
      // Find connected memories via relationships
      const query = `
        SELECT DISTINCT
          mr.source_memory_id,
          mr.target_memory_id,
          mr.relationship_type,
          mr.confidence,
          LEFT(mr.evidence, 2048) AS evidence,
          m.id,
          LEFT(m.content, 2048) AS content,
          m.category,
          m.created_at
        FROM memory_relationships mr
        JOIN memories m ON (m.id = mr.source_memory_id OR m.id = mr.target_memory_id)
        LEFT JOIN projects p ON p.id = m.project_id AND p.tenant_id = m.tenant_id
        WHERE (mr.source_memory_id = ANY($1) OR mr.target_memory_id = ANY($1))
          AND mr.confidence > 0.6  -- Only high-confidence relationships
          AND m.tenant_id = $2
          AND ($4::uuid IS NULL OR m.project_id = $4::uuid)
          AND (
            (COALESCE(m.visibility, 'shared') = 'personal' AND m.user_id = $3::uuid)
            OR (COALESCE(m.visibility, 'shared') = 'shared' AND m.project_id IS NULL)
            OR (
              COALESCE(m.visibility, 'shared') IN ('shared', 'project')
              AND p.id IS NOT NULL
              AND (p.is_personal = false OR p.owner_id = $3::uuid
                   OR EXISTS (SELECT 1 FROM project_members pm
                              WHERE pm.project_id = p.id AND pm.user_id = $3::uuid))
            )
          )
          AND m.id != ALL($1)  -- Exclude original results
        ORDER BY mr.confidence DESC
        LIMIT 50  -- Cap connected memories to avoid explosion
      `;

      const result = await this.db.query(
        query,
        [memoryIds, this.tenantId, this.userId || null, this.projectId || null],
        this.tenantId,
      );
      const connectedRows = result.rows;

      // Group connected memories by source memory
      const connectionsMap = new Map<string, ConnectedMemory[]>();
      
      for (const row of connectedRows) {
        // Determine which memory this connects to from our core results
        const coreMemoryId = memoryIds.includes(row.source_memory_id) 
          ? row.source_memory_id 
          : row.target_memory_id;
        
        if (!connectionsMap.has(coreMemoryId)) {
          connectionsMap.set(coreMemoryId, []);
        }

        connectionsMap.get(coreMemoryId)!.push({
          id: row.id,
          content: row.content,
          relationship_type: row.relationship_type,
          confidence: row.confidence,
          evidence: row.evidence
        });
      }

      // Merge with core results
      return coreResults.map(result => ({
        ...result,
        connected_memories: connectionsMap.get(result.id) || []
      }));
      
    } catch (error) {
      console.error('Graph expansion failed:', error);
      // Fall back to original results without graph enhancement
      return coreResults.map(result => ({ ...result, connected_memories: [] }));
    }
  }

  /**
   * Phase 1: Proprietary ranking algorithm with relationship signals
   * Boosts scores based on graph connections and relationship types
   */
  private rankWithGraphSignals(results: ExpandedSearchResult[]): ExpandedSearchResult[] {
    return results.map(result => {
      let score = result.score;
      let graphBoost = 0;
      
      if (result.connected_memories && result.connected_memories.length > 0) {
        // PROPRIETARY: Boost score based on relationships
        const relationshipBoost = result.connected_memories.reduce((boost, conn) => {
          // Different relationship types have different value
          const typeMultipliers: Record<string, number> = {
            'supports': 0.15,      // Strong positive signal
            'refines': 0.12,       // Adds detail
            'relates_to': 0.08,    // General connection
            'supersedes': 0.10,    // Evolution/improvement
            'contradicts': -0.05   // Negative signal (but still relevant)
          };
          
          const typeMultiplier = typeMultipliers[conn.relationship_type] || 0.05;
          
          return boost + (conn.confidence * typeMultiplier);
        }, 0);
        
        graphBoost = relationshipBoost;
        score = Math.min(1.0, score + relationshipBoost);
      }
      
      return {
        ...result,
        score,
        graph_boost: graphBoost
      };
    });
  }

  // Get statistics
  async getStats(includeTenantSearchUsage: boolean = false): Promise<MemoryStats> {
    const plan = await this.db.getTenantPlan(this.tenantId);
    if (!plan) {
      throw new Error('Tenant plan not found');
    }

    const scopedEmbeddingState = await this.getPendingEmbeddingCount();
    const totalMemories = scopedEmbeddingState.total;
    // Usage rows are project-keyed but not user-keyed. Only an explicitly
    // privileged tenant view may receive the unscoped tenant aggregate.
    const searchesToday = this.projectId
      ? Number(await this.db.getTodaySearchCount(this.tenantId, this.projectId))
      : includeTenantSearchUsage
        ? Number(await this.db.getTodaySearchCount(this.tenantId))
        : null;

    // Exact bounded aggregate. The former per-category recent-memory query
    // silently capped every category at 1,000 and therefore reported false
    // totals for mature agent tenants.
    const categoryResult = await this.db.query(
      `SELECT m.category, COUNT(*)::integer AS count
       FROM memories m
       LEFT JOIN projects p ON p.id = m.project_id AND p.tenant_id = m.tenant_id
       WHERE m.tenant_id = $1
         AND ($2::uuid IS NULL OR m.project_id = $2::uuid)
         AND m.category = ANY($4::text[])
         AND (
           (COALESCE(m.visibility, 'shared') = 'personal' AND m.user_id = $3::uuid)
           OR (COALESCE(m.visibility, 'shared') = 'shared' AND m.project_id IS NULL)
           OR (
             COALESCE(m.visibility, 'shared') IN ('shared', 'project')
             AND p.id IS NOT NULL
             AND (p.is_personal = false OR p.owner_id = $3::uuid
                  OR EXISTS (SELECT 1 FROM project_members pm
                             WHERE pm.project_id = p.id AND pm.user_id = $3::uuid))
           )
         )
       GROUP BY m.category`,
      [this.tenantId, this.projectId || null, this.userId || null, [...MEMORY_CATEGORIES]],
      this.tenantId,
    );
    const byCategory: Record<string, number> = Object.fromEntries(
      MEMORY_CATEGORIES.map(category => [category, 0]),
    );
    for (const row of categoryResult.rows) {
      if (typeof row.category === 'string' && row.category in byCategory) {
        byCategory[row.category] = Number(row.count || 0);
      }
    }

    return {
      total_memories: totalMemories,
      by_category: byCategory,
      plan: plan.plan,
      memory_limit: plan.memory_limit,
      searches_today: searchesToday,
      searches_today_scope: this.projectId
        ? 'project'
        : includeTenantSearchUsage ? 'tenant' : 'unavailable',
      search_limit_daily: plan.search_limit_daily,
      usage_percentage: Math.round((totalMemories / plan.memory_limit) * 100),
      scope: 'authorised_audience',
    };
  }

  // Find similar memories to a given memory
  async findSimilarMemories(
    memoryId: string,
    limit: number = 10,
    minSimilarity: number = 0.5,
    category?: string
  ): Promise<Array<Memory & { similarity: number }>> {
    if (!this.embeddingProvider) {
      throw new Error('Semantic search not available - embeddings not configured');
    }

    // Authorise the source before touching its embedding. Otherwise an
    // arbitrary same-tenant UUID becomes a private/project existence oracle.
    const sourceMemory = await this.db.getMemoryById(
      memoryId,
      this.tenantId,
      this.projectId,
      this.userId,
    );
    if (!sourceMemory) {
      throw new Error('Memory not found or access denied');
    }

    // Get the authorised source memory's embedding.
    const embedding = await this.db.getEmbedding(memoryId, this.tenantId);
    if (!embedding) {
      throw new Error('Memory has no embedding');
    }

    await this.db.reserveSearchQuota(this.tenantId, this.projectId);

    // Ensure we have a valid embedding array
    let embeddingArray: number[];
    if (Array.isArray(embedding.embedding)) {
      embeddingArray = embedding.embedding;
    } else {
      throw new Error(`Invalid embedding format: expected array, got ${typeof embedding.embedding}`);
    }

    // Search for similar memories
    const results = await this.db.semanticSearch(
      this.tenantId,
      this.projectId,
      embeddingArray,
      limit + 1, // +1 to exclude the source memory
      category,
      undefined,
      this.userId,
    );

    // Filter out the source memory and apply similarity threshold
    return results
      .filter(r => r.id !== memoryId && r.similarity >= minSimilarity)
      .slice(0, limit);
  }

  // Get embedding statistics
  async getEmbeddingStats(): Promise<EmbeddingStats> {
    const scoped = await this.getPendingEmbeddingCount();
    const totalMemories = scoped.total;
    const backlog = scoped.pending;
    const embeddingCount = totalMemories - backlog;

    // Update Prometheus gauge so alerting can fire on backlog growth
    updateEmbeddingBacklog(this.tenantId, backlog);

    let provider = 'none';
    let model = 'none';
    let dimensions = 0;

    if (this.embeddingProvider) {
      provider = this.embeddingProvider.name;
      model = this.embeddingProvider.model;
      dimensions = this.embeddingProvider.dimensions;
    }

    return {
      total_embeddings: embeddingCount,
      embedding_provider: provider,
      embedding_model: model,
      dimensions,
      semantic_search_available: !!this.embeddingProvider,
      memories_without_embeddings: backlog
    };
  }

  /**
   * Get count of memories without embeddings (pending indexing).
   * Lightweight query for use in search responses.
   */
  async getPendingEmbeddingCount(): Promise<{ pending: number; total: number }> {
    const result = await this.db.query(`
      SELECT COUNT(*)::int AS total, COUNT(e.memory_id)::int AS indexed
      FROM memories m
      LEFT JOIN memory_embeddings e ON e.memory_id = m.id
      LEFT JOIN projects p ON p.id = m.project_id AND p.tenant_id = m.tenant_id
      WHERE m.tenant_id = $1
        AND ($2::uuid IS NULL OR m.project_id = $2::uuid)
        AND (
          (COALESCE(m.visibility, 'shared') = 'personal' AND m.user_id = $3::uuid)
          OR (COALESCE(m.visibility, 'shared') = 'shared' AND m.project_id IS NULL)
          OR (
            COALESCE(m.visibility, 'shared') IN ('shared', 'project')
            AND p.id IS NOT NULL
            AND (p.is_personal = false OR p.owner_id = $3::uuid
                 OR EXISTS (SELECT 1 FROM project_members pm
                            WHERE pm.project_id = p.id AND pm.user_id = $3::uuid))
          )
        )
    `, [this.tenantId, this.projectId || null, this.userId || null], this.tenantId);
    const total = Number(result.rows[0]?.total || 0);
    const indexed = Number(result.rows[0]?.indexed || 0);
    return { pending: Math.max(0, total - indexed), total };
  }

  /**
   * Backfill embeddings for memories that are missing them.
   * Called by the periodic backfill job or admin endpoint.
   * Processes in batches with concurrency control.
   */
  async backfillMissingEmbeddings(batchSize: number = 10): Promise<{ generated: number; failed: number; total: number }> {
    if (!this.embeddingProvider) {
      throw new Error('Embedding provider not available');
    }

    // Query memories without embeddings
    const result = await this.db.query(`
      SELECT m.id, m.content, m.tenant_id
      FROM memories m
      LEFT JOIN memory_embeddings me ON m.id = me.memory_id
      LEFT JOIN projects p ON p.id = m.project_id AND p.tenant_id = m.tenant_id
      WHERE m.tenant_id = $1 AND me.memory_id IS NULL
        AND ($2::uuid IS NULL OR m.project_id = $2::uuid)
        AND (
          (COALESCE(m.visibility, 'shared') = 'personal' AND m.user_id = $3::uuid)
          OR (COALESCE(m.visibility, 'shared') = 'shared' AND m.project_id IS NULL)
          OR (COALESCE(m.visibility, 'shared') IN ('shared', 'project')
              AND p.id IS NOT NULL
              AND (p.is_personal = false OR p.owner_id = $3::uuid
                   OR EXISTS (SELECT 1 FROM project_members pm
                              WHERE pm.project_id = p.id AND pm.user_id = $3::uuid)))
        )
      ORDER BY m.created_at DESC
      LIMIT $4
    `, [this.tenantId, this.projectId || null, this.userId || null, batchSize], this.tenantId);

    let generated = 0;
    let failed = 0;

    for (const row of result.rows) {
      try {
        trackEmbeddingInflight(1);
        const startTime = Date.now();
        
        const embedding = await this.embeddingProvider.generateEmbedding(row.content, { tenantId: this.tenantId });
        await this.db.storeEmbedding(
          row.id,
          this.tenantId,
          embedding,
          this.embeddingProvider.name,
          this.embeddingProvider.model,
          this.embeddingProvider.getModelFingerprint()  // REM-249
        );
        
        const durationSec = (Date.now() - startTime) / 1000;
        trackBackgroundProcessing('embedding', 'success', this.tenantId, durationSec);
        generated++;
        if (process.env.NODE_ENV !== 'production') console.log(`Backfill generated an embedding in ${durationSec.toFixed(2)}s`);
      } catch (error: any) {
        const reason = error?.message?.includes('timeout') ? 'timeout' :
                       error?.message?.includes('ECONNREFUSED') ? 'ollama_down' : 'unknown';
        trackEmbeddingFailure(reason, this.tenantId);
        failed++;
        console.error(`Backfill embedding failed (${reason})`);
        
        // If Ollama is down, stop the batch early — no point continuing
        if (reason === 'ollama_down' || reason === 'timeout') {
          console.warn(`⚠️  Backfill: stopping batch early due to ${reason}`);
          break;
        }
      } finally {
        trackEmbeddingInflight(-1);
      }
    }

    // Update backlog gauge without recursively scheduling another backfill.
    const remaining = (await this.getPendingEmbeddingCount()).pending;
    updateEmbeddingBacklog(this.tenantId, remaining);
    console.log(`📊 Backfill complete: ${generated} generated, ${failed} failed, ${remaining} remaining`);

    return { generated, failed, total: result.rows.length };
  }

  private scheduleMissingEmbeddingBackfill(backlog: number): void {
    if (!this.embeddingProvider || MemoryService.missingEmbeddingBackfills.has(this.tenantId)) {
      return;
    }

    MemoryService.missingEmbeddingBackfills.add(this.tenantId);
    setTimeout(async () => {
      try {
        await this.backfillMissingEmbeddings(Math.min(25, Math.max(1, backlog)));
      } catch (error) {
        console.error('Tenant embedding backfill failed');
      } finally {
        MemoryService.missingEmbeddingBackfills.delete(this.tenantId);
      }
    }, 0);
  }

  // Week 13: Context Intelligence Methods

  /**
   * Classify the intent of a query using RLM-optimized analysis
   */
  async classifyQueryIntent(context: {
    query: string;
    recent_categories?: string[];
    project_domain?: string;
  }): Promise<QueryIntent> {
    return await this.queryIntentService.classifyIntent(context);
  }

  /**
   * Infer relationships for a specific memory using semantic analysis
   */
  async inferMemoryRelationships(memoryId: string, minConfidence: number = 0.6): Promise<any[]> {
    if (!this.relationshipService) {
      throw new Error('Relationship service not available - embedding provider required');
    }
    
    const relationships = await this.relationshipService.inferRelationshipsForMemory(
      memoryId, 
      this.tenantId, 
      this.projectId,
      this.userId,
    );
    
    // Filter by confidence and store high-confidence relationships
    const highConfidenceRelationships = relationships.filter(r => r.confidence >= minConfidence);
    
    if (highConfidenceRelationships.length > 0) {
      await this.relationshipService.storeRelationships(highConfidenceRelationships, this.tenantId);
    }
    
    return relationships;
  }

  /**
   * Enhanced search with intent classification and contextual embeddings
   */
  async enhancedSearch(options: {
    query: string;
    enable_intent_classification?: boolean;
    enable_relationship_expansion?: boolean;
    domain_context?: string;
    limit?: number;
  }): Promise<{
    memories: HybridSearchResult[];
    intent?: QueryIntent;
    domain_context?: string;
    relationship_expansion: boolean;
  }> {
    const { 
      query, 
      enable_intent_classification = true, 
      enable_relationship_expansion = false,
      domain_context,
      limit = 10 
    } = options;

    let intent: QueryIntent | undefined;
    let searchCategory: string | undefined;
    
    // Step 1: Classify intent if enabled
    if (enable_intent_classification) {
      intent = await this.classifyQueryIntent({ query, project_domain: domain_context });
      searchCategory = intent.primary_category;
    }

    // Step 2: Perform base search with intent-optimized parameters
    const baseResults = await this.searchMemory({
      query,
      category: searchCategory,
      limit: enable_relationship_expansion ? Math.floor(limit * 0.7) : limit,
      search_mode: 'hybrid'
    });

    let allResults = baseResults;

    // Step 3: Expand with related memories if enabled
    if (enable_relationship_expansion && baseResults.length > 0) {
      const expandedResults = new Set<string>();
      
      for (const result of baseResults.slice(0, 3)) { // Expand top 3 results
        try {
          const relationships = await this.inferMemoryRelationships(result.id, 0.7);
          for (const rel of relationships.slice(0, 2)) { // Top 2 relationships per memory
            expandedResults.add(rel.target_memory_id);
          }
        } catch (error) {
          console.warn('Relationship expansion failed for a search result');
        }
      }

      // Fetch expanded memories
      if (expandedResults.size > 0) {
        const expandedMemories = await this.getMemoriesByIds(Array.from(expandedResults));
        allResults = [...baseResults, ...expandedMemories.slice(0, limit - baseResults.length)];
      }
    }

    return {
      memories: allResults,
      intent,
      domain_context,
      relationship_expansion: enable_relationship_expansion
    };
  }

  /**
   * Get analytical insights about memory patterns and usage
   */
  async getMemoryInsights(analysisType: string, timeRangeDays: number = 30): Promise<any> {
    const since = new Date();
    since.setDate(since.getDate() - timeRangeDays);

    switch (analysisType) {
      case 'patterns':
        return await this.getPatternInsights(since);
      case 'relationships':
        return await this.getRelationshipInsights(since);
      case 'usage':
        return await this.getUsageInsights(since);
      case 'categories':
        return await this.getCategoryInsights(since);
      case 'domains':
        return await this.getDomainInsights(since);
      default:
        throw new Error(`Unknown analysis type: ${analysisType}`);
    }
  }

  /**
   * Helper method to get memories by IDs
   */
  private async getMemoriesByIds(ids: string[]): Promise<HybridSearchResult[]> {
    if (ids.length === 0) return [];

    const query = `
      SELECT m.id, m.content, m.category, m.metadata, m.created_at, m.updated_at, m.relevance_score
      FROM memories m
      LEFT JOIN projects p ON p.id = m.project_id AND p.tenant_id = m.tenant_id
      WHERE m.tenant_id = $1
        AND ($2::uuid IS NULL OR m.project_id = $2::uuid)
        AND m.id = ANY($3::uuid[])
        AND (
          (COALESCE(m.visibility, 'shared') = 'personal' AND m.user_id = $4::uuid)
          OR (COALESCE(m.visibility, 'shared') = 'shared' AND m.project_id IS NULL)
          OR (
            COALESCE(m.visibility, 'shared') IN ('shared', 'project')
            AND p.id IS NOT NULL
            AND (p.is_personal = false OR p.owner_id = $4::uuid
                 OR EXISTS (SELECT 1 FROM project_members pm
                            WHERE pm.project_id = p.id AND pm.user_id = $4::uuid))
          )
        )
      ORDER BY m.created_at DESC
    `;

    const params = [this.tenantId, this.projectId || null, ids, this.userId || null];
    const result = await this.db.query(query, params, this.tenantId);
    
    return result.rows.map((row: any) => ({
      ...row,
      score: 1.0 // Default score for direct retrieval
    }));
  }

  /**
   * Insight analysis methods
   */
  private async getPatternInsights(since: Date): Promise<any> {
    // Analyze common patterns in memory content
    const query = `
      SELECT m.category, COUNT(*) as count,
             AVG(LENGTH(m.content)) as avg_length,
             COUNT(CASE WHEN m.metadata IS NOT NULL AND m.metadata != '{}' THEN 1 END) as with_metadata
      FROM memories m
      LEFT JOIN projects p ON p.id = m.project_id AND p.tenant_id = m.tenant_id
      WHERE m.tenant_id = $1
        AND ($2::uuid IS NULL OR m.project_id = $2::uuid)
        AND (
          (COALESCE(m.visibility, 'shared') = 'personal' AND m.user_id = $3::uuid)
          OR (COALESCE(m.visibility, 'shared') = 'shared' AND m.project_id IS NULL)
          OR (COALESCE(m.visibility, 'shared') IN ('shared', 'project')
              AND p.id IS NOT NULL
              AND (p.is_personal = false OR p.owner_id = $3::uuid
                   OR EXISTS (SELECT 1 FROM project_members pm
                              WHERE pm.project_id = p.id AND pm.user_id = $3::uuid)))
        )
        AND m.created_at >= $4
      GROUP BY m.category
      ORDER BY count DESC
    `;

    const params = [this.tenantId, this.projectId || null, this.userId || null, since];
    const result = await this.db.query(query, params, this.tenantId);
    
    return {
      category_patterns: result.rows,
      analysis_period: `${Math.floor((Date.now() - since.getTime()) / (1000 * 60 * 60 * 24))} days`,
      total_categories: result.rows.length
    };
  }

  private async getRelationshipInsights(since: Date): Promise<any> {
    try {
      const query = `
        SELECT mr.relationship_type, COUNT(*) as count, AVG(mr.confidence) as avg_confidence
        FROM memory_relationships mr
        JOIN memories ms ON ms.id = mr.source_memory_id
        JOIN memories mt ON mt.id = mr.target_memory_id
        LEFT JOIN projects ps ON ps.id = ms.project_id AND ps.tenant_id = ms.tenant_id
        LEFT JOIN projects pt ON pt.id = mt.project_id AND pt.tenant_id = mt.tenant_id
        WHERE ms.tenant_id = $1 AND mt.tenant_id = $1
          AND ($2::uuid IS NULL OR (ms.project_id = $2::uuid AND mt.project_id = $2::uuid))
          AND (
            (COALESCE(ms.visibility, 'shared') = 'personal' AND ms.user_id = $3::uuid)
            OR (COALESCE(ms.visibility, 'shared') = 'shared' AND ms.project_id IS NULL)
            OR (COALESCE(ms.visibility, 'shared') IN ('shared', 'project')
                AND ps.id IS NOT NULL
                AND (ps.is_personal = false OR ps.owner_id = $3::uuid
                     OR EXISTS (SELECT 1 FROM project_members pm
                                WHERE pm.project_id = ps.id AND pm.user_id = $3::uuid)))
          )
          AND (
            (COALESCE(mt.visibility, 'shared') = 'personal' AND mt.user_id = $3::uuid)
            OR (COALESCE(mt.visibility, 'shared') = 'shared' AND mt.project_id IS NULL)
            OR (COALESCE(mt.visibility, 'shared') IN ('shared', 'project')
                AND pt.id IS NOT NULL
                AND (pt.is_personal = false OR pt.owner_id = $3::uuid
                     OR EXISTS (SELECT 1 FROM project_members pm
                                WHERE pm.project_id = pt.id AND pm.user_id = $3::uuid)))
          )
          AND mr.created_at >= $4
        GROUP BY mr.relationship_type
        ORDER BY count DESC
        LIMIT 100
      `;

      const result = await this.db.query(
        query,
        [this.tenantId, this.projectId || null, this.userId || null, since],
        this.tenantId,
      );
      
      return {
        relationship_types: result.rows,
        total_relationships: result.rows.reduce((sum: number, row: any) => sum + parseInt(row.count), 0)
      };
    } catch (error) {
      return {
        relationship_types: [],
        total_relationships: 0,
        note: 'Relationship tracking not yet available'
      };
    }
  }

  private async getUsageInsights(since: Date): Promise<any> {
    const query = `
      SELECT 
        DATE_TRUNC('day', m.created_at) as date,
        COUNT(*) as memories_created,
        COUNT(DISTINCT m.category) as categories_used
      FROM memories m
      LEFT JOIN projects p ON p.id = m.project_id AND p.tenant_id = m.tenant_id
      WHERE m.tenant_id = $1
        AND ($2::uuid IS NULL OR m.project_id = $2::uuid)
        AND (
          (COALESCE(m.visibility, 'shared') = 'personal' AND m.user_id = $3::uuid)
          OR (COALESCE(m.visibility, 'shared') = 'shared' AND m.project_id IS NULL)
          OR (COALESCE(m.visibility, 'shared') IN ('shared', 'project')
              AND p.id IS NOT NULL
              AND (p.is_personal = false OR p.owner_id = $3::uuid
                   OR EXISTS (SELECT 1 FROM project_members pm
                              WHERE pm.project_id = p.id AND pm.user_id = $3::uuid)))
        )
        AND m.created_at >= $4
      GROUP BY DATE_TRUNC('day', m.created_at)
      ORDER BY date DESC
      LIMIT 30
    `;
    
    const params = [this.tenantId, this.projectId || null, this.userId || null, since];
    const result = await this.db.query(query, params, this.tenantId);
    
    return {
      daily_usage: result.rows,
      peak_day: result.rows.length > 0 ? 
        result.rows.reduce((max: any, row: any) => 
          parseInt(row.memories_created) > parseInt(max.memories_created) ? row : max
        ) : null
    };
  }

  private async getCategoryInsights(since: Date): Promise<any> {
    const query = `
      SELECT 
        m.category,
        COUNT(*) as count,
        COUNT(*) * 100.0 / SUM(COUNT(*)) OVER () as percentage,
        AVG(m.relevance_score) as avg_relevance
      FROM memories m
      LEFT JOIN projects p ON p.id = m.project_id AND p.tenant_id = m.tenant_id
      WHERE m.tenant_id = $1
        AND ($2::uuid IS NULL OR m.project_id = $2::uuid)
        AND (
          (COALESCE(m.visibility, 'shared') = 'personal' AND m.user_id = $3::uuid)
          OR (COALESCE(m.visibility, 'shared') = 'shared' AND m.project_id IS NULL)
          OR (COALESCE(m.visibility, 'shared') IN ('shared', 'project')
              AND p.id IS NOT NULL
              AND (p.is_personal = false OR p.owner_id = $3::uuid
                   OR EXISTS (SELECT 1 FROM project_members pm
                              WHERE pm.project_id = p.id AND pm.user_id = $3::uuid)))
        )
        AND m.created_at >= $4
        AND m.category IS NOT NULL
      GROUP BY m.category
      ORDER BY count DESC
    `;
    
    const params = [this.tenantId, this.projectId || null, this.userId || null, since];
    const result = await this.db.query(query, params, this.tenantId);
    
    const categoryStats = result.rows.map((row: any) => ({
      category: row.category,
      count: parseInt(row.count),
      percentage: parseFloat(parseFloat(row.percentage).toFixed(1)),
      avg_relevance: parseFloat(parseFloat(row.avg_relevance || 0).toFixed(2))
    }));
    
    return {
      category_distribution: categoryStats,
      top_category: categoryStats[0]?.category || 'none',
      total_categories: categoryStats.length
    };
  }

  private async getDomainInsights(since: Date): Promise<any> {
    // Analyze domain patterns from content and metadata
    const query = `
      SELECT LEFT(m.content, $5::integer) AS content, m.category
      FROM memories m
      LEFT JOIN projects p ON p.id = m.project_id AND p.tenant_id = m.tenant_id
      WHERE m.tenant_id = $1
        AND ($2::uuid IS NULL OR m.project_id = $2::uuid)
        AND (
          (COALESCE(m.visibility, 'shared') = 'personal' AND m.user_id = $3::uuid)
          OR (COALESCE(m.visibility, 'shared') = 'shared' AND m.project_id IS NULL)
          OR (COALESCE(m.visibility, 'shared') IN ('shared', 'project')
              AND p.id IS NOT NULL
              AND (p.is_personal = false OR p.owner_id = $3::uuid
                   OR EXISTS (SELECT 1 FROM project_members pm
                              WHERE pm.project_id = p.id AND pm.user_id = $3::uuid)))
        )
        AND m.created_at >= $4
      ORDER BY m.created_at DESC
      LIMIT 100
    `;
    
    const params = [this.tenantId, this.projectId || null, this.userId || null, since, 2_048];
    const result = await this.db.query(query, params, this.tenantId);
    
    // Analyze content for domain indicators
    const domainKeywords = {
      software_engineering: ['api', 'database', 'code', 'deployment', 'architecture', 'framework'],
      data_science: ['model', 'analysis', 'dataset', 'visualization', 'machine learning', 'statistics'],
      business_operations: ['process', 'workflow', 'decision', 'strategy', 'optimization', 'efficiency'],
      research_development: ['research', 'experiment', 'hypothesis', 'innovation', 'discovery', 'prototype']
    };
    
    const domainCounts = {
      software_engineering: 0,
      data_science: 0,
      business_operations: 0,
      research_development: 0,
      unknown: 0
    };
    
    for (const row of result.rows) {
      const content = row.content.toLowerCase();
      let domainDetected = false;
      
      for (const [domain, keywords] of Object.entries(domainKeywords)) {
        if (keywords.some(keyword => content.includes(keyword))) {
          domainCounts[domain as keyof typeof domainCounts]++;
          domainDetected = true;
          break;
        }
      }
      
      if (!domainDetected) {
        domainCounts.unknown++;
      }
    }
    
    return {
      domain_distribution: domainCounts,
      total_analyzed: result.rows.length,
      dominant_domain: Object.entries(domainCounts)
        .sort(([,a], [,b]) => b - a)[0]?.[0] || 'unknown'
    };
  }

  /**
   * REM-249: Mark embeddings as stale when model changes.
   * Call this on server startup or after changing OLLAMA_EMBEDDING_MODEL.
   */
  async markStaleEmbeddings(): Promise<number> {
    if (!this.embeddingProvider) {
      throw new Error('Embedding provider not available');
    }

    const currentFingerprint = this.embeddingProvider.getModelFingerprint();
    return await this.db.markStaleEmbeddings(this.tenantId, currentFingerprint);
  }

  /**
   * REM-249: Get count of stale embeddings for this tenant.
   */
  async getStaleEmbeddingCount(): Promise<number> {
    return await this.db.getStaleEmbeddingCount(this.tenantId);
  }

  /**
   * REM-249: Re-embed stale vectors in batches.
   * Returns the number of embeddings successfully regenerated.
   */
  async reEmbedStale(batchSize: number = 50): Promise<number> {
    if (!this.embeddingProvider) {
      throw new Error('Embedding provider not available');
    }

    const staleEmbeddings = await this.db.getStaleEmbeddings(this.tenantId, batchSize);
    let reEmbedded = 0;

    for (const row of staleEmbeddings) {
      try {
        if (process.env.NODE_ENV !== 'production') console.log('Re-embedding stale memory data');
        
        const embedding = await this.embeddingProvider.generateEmbedding(row.content, { tenantId: this.tenantId });
        await this.db.storeEmbedding(
          row.memory_id,
          this.tenantId,
          embedding,
          this.embeddingProvider.name,
          this.embeddingProvider.model,
          this.embeddingProvider.getModelFingerprint()
        );

        reEmbedded++;
        if (process.env.NODE_ENV !== 'production') console.log('Re-embedded stale memory data');
      } catch (error) {
        console.error('Failed to re-embed stale memory data');
      }
    }

    return reEmbedded;
  }
}
