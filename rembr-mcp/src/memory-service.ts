import { MemoryDatabase, Memory, TenantPlan } from './database.js';
import { EmbeddingProvider, OllamaEmbeddingProvider } from './ollama-provider.js';
import { QueryIntentService, QueryIntent } from './query-intent-service.js';
import { MemoryRelationshipService } from './memory-relationship-service.js';
import { ContextualEmbeddingService } from './contextual-embedding-service.js';
import { AdvancedAnalyticsService } from './advanced-analytics-service.js';
import { piiDetector } from './pii-detector.js';
import { 
  trackEmbeddingFailure, 
  trackEmbeddingInflight, 
  trackBackgroundProcessing,
  trackContradictionFailure,
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

export interface MemoryStats {
  total_memories: number;
  by_category: Record<string, number>;
  plan: string;
  memory_limit: number;
  searches_today: number;
  search_limit_daily: number;
  usage_percentage: number;
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

  // Check rate limits before operations
  private async checkRateLimits(operation: 'memory' | 'search'): Promise<void> {
    const plan = await this.db.getTenantPlan(this.tenantId);
    if (!plan) {
      throw new Error('Tenant plan not found');
    }

    if (operation === 'memory') {
      const count = await this.db.getMemoryCount(this.tenantId);
      if (count >= plan.memory_limit) {
        throw new Error(`Memory limit reached (${plan.memory_limit} memories). Please upgrade your plan.`);
      }
    }

    if (operation === 'search') {
      const searchCount = await this.db.getTodaySearchCount(this.tenantId);
      if (plan.search_limit_daily > 0 && searchCount >= plan.search_limit_daily) {
        throw new Error(`Daily search limit reached (${plan.search_limit_daily} searches). Resets at midnight UTC.`);
      }
    }
  }

  // Store a new memory
  async storeMemory(input: CreateMemoryInput): Promise<Memory> {
    await this.checkRateLimits('memory');

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
      piiData
    );

    // Schedule background processing (embedding, relationships, contradictions)
    // This runs asynchronously and does NOT block the API response
    this.scheduleBackgroundProcessing(id, projectId, input.content);

    return memory;
  }

  /** Max concurrent embedding generation jobs */
  private static readonly MAX_INFLIGHT_EMBEDDINGS = 3;
  private static inflightEmbeddings = 0;
  private static missingEmbeddingBackfills = new Set<string>();
  /** Max concurrent contradiction detection jobs (uses LLM — exclusive GPU time) */
  private static readonly MAX_INFLIGHT_CONTRADICTIONS = 1;
  private static inflightContradictions = 0;
  /** Total in-flight background jobs across all types */
  static get totalInflight(): number {
    return MemoryService.inflightEmbeddings + MemoryService.inflightContradictions;
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
      console.warn(`⚠️  No embedding provider available for memory ${memoryId} - semantic search will not work for this memory`);
    }

    // Background contradiction detection (independent of embeddings)
    // Concurrency-limited: uses LLM (GPU), serialised to 1 concurrent job
    if (this.advancedAnalyticsService) {
      if (MemoryService.inflightContradictions >= MemoryService.MAX_INFLIGHT_CONTRADICTIONS) {
        console.log(`⏳ Contradiction queue full, skipping detection for memory ${memoryId} (will be caught by next backfill run)`);
      } else {
        MemoryService.inflightContradictions++;
        const contradictionStart = Date.now();
        this.advancedAnalyticsService.detectContradictionsForMemory(
          memoryId,
          content,
          this.tenantId,
          0.7 // minConfidence
        ).then(contradictions => {
          const durationSec = (Date.now() - contradictionStart) / 1000;
          trackBackgroundProcessing('contradiction', 'success', this.tenantId, durationSec);
          if (contradictions.length > 0) {
            console.log(`⚠️  Detected ${contradictions.length} contradiction(s) for memory ${memoryId}`);
          }
        }).catch(error => {
          const durationSec = (Date.now() - contradictionStart) / 1000;
          trackBackgroundProcessing('contradiction', 'error', this.tenantId, durationSec);
          const reason = error?.message?.includes('timeout') ? 'timeout' : 
                         error?.message?.includes('ECONNREFUSED') ? 'ollama_down' : 'unknown';
          trackContradictionFailure(reason, this.tenantId);
          console.error(`❌ Background contradiction detection failed for memory ${memoryId}:`, error?.message || error);
        }).finally(() => {
          MemoryService.inflightContradictions--;
        });
      }
    }
  }

  /**
   * Attempt embedding generation with retry and exponential backoff.
   * Respects concurrency limit to prevent Ollama overload.
   */
  private scheduleEmbeddingWithRetry(memoryId: string, projectId: string, content: string, attempt: number): void {
    // Concurrency gate: if too many in-flight, delay and retry
    if (MemoryService.inflightEmbeddings >= MemoryService.MAX_INFLIGHT_EMBEDDINGS) {
      const delayMs = 1000 * (attempt + 1); // Back off on concurrency pressure
      console.log(`⏳ Embedding queue full (${MemoryService.inflightEmbeddings}/${MemoryService.MAX_INFLIGHT_EMBEDDINGS}), delaying ${memoryId} by ${delayMs}ms`);
      setTimeout(() => this.scheduleEmbeddingWithRetry(memoryId, projectId, content, attempt), delayMs);
      return;
    }

    MemoryService.inflightEmbeddings++;
    trackEmbeddingInflight(1);
    const startTime = Date.now();

    console.log(`🔮 Generating embedding for memory ${memoryId} (attempt ${attempt + 1}/${MemoryService.MAX_EMBEDDING_RETRIES}, content: ${content.length} chars, inflight: ${MemoryService.inflightEmbeddings})`);

    this.embeddingProvider!.generateEmbedding(content)
      .then(async (embedding) => {
        const durationSec = (Date.now() - startTime) / 1000;
        console.log(`✅ Generated embedding for ${memoryId} in ${durationSec.toFixed(2)}s (dims: ${embedding.length})`);
        
        await this.db.storeEmbedding(
          memoryId,
          this.tenantId,
          embedding,
          this.embeddingProvider!.name,
          this.embeddingProvider!.model,
          this.embeddingProvider!.getModelFingerprint()  // REM-249
        );
        
        trackBackgroundProcessing('embedding', 'success', this.tenantId, durationSec);
        console.log(`💾 Stored embedding for memory ${memoryId}`);
        
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
          embeddingRetryCounter.labels(this.tenantId).inc();
          console.warn(`⚠️  Embedding failed for ${memoryId} (attempt ${attempt + 1}/${MemoryService.MAX_EMBEDDING_RETRIES}, reason: ${reason}). Retrying in ${backoffMs}ms...`);
          setTimeout(() => this.scheduleEmbeddingWithRetry(memoryId, projectId, content, attempt + 1), backoffMs);
        } else {
          console.error(`❌ Embedding generation permanently failed for memory ${memoryId} after ${MemoryService.MAX_EMBEDDING_RETRIES} attempts (reason: ${reason}):`, error?.message || error);
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
        console.log(`💾 Auto-storing ${qualityRelationships.length} background inferred relationships for memory ${memoryId}`);
        
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
      console.error('Background relationship inference failed:', error);
    }
  }

  // Hybrid search: combine semantic and text search with graph-aware ranking
  async searchMemory(input: SearchMemoryInput): Promise<ExpandedSearchResult[]> {
    await this.checkRateLimits('search');

    const limit = input.limit || 10;
    // Default 0.5 for nomic-embed-text (768-dim); OpenAI text-embedding-3
    // models can use 0.7. Agents can override via min_similarity param.
    const minSimilarity = input.min_similarity || 0.5;
    const searchMode = input.search_mode || 'hybrid';

    // Weights for hybrid search
    const SEMANTIC_WEIGHT = 0.7;
    const TEXT_WEIGHT = 0.3;

    const results: HybridSearchResult[] = [];

    // Semantic search if embedding provider is available
    if ((searchMode === 'semantic' || searchMode === 'hybrid') && this.embeddingProvider) {
      try {
        console.log(`🔍 Generating embedding for query: "${input.query}"`);
        const queryEmbedding = await this.embeddingProvider.generateEmbedding(input.query);
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
          console.log(`  - Memory ${result.id}: similarity=${result.similarity.toFixed(3)} (threshold=${minSimilarity})`);
          if (result.similarity >= minSimilarity) {
            results.push({
              ...result,
              score: searchMode === 'semantic' ? result.similarity : result.similarity * SEMANTIC_WEIGHT,
              semantic_similarity: result.similarity
            });
          }
        }
        console.log(`✅ ${results.length} results passed similarity threshold`);
      } catch (error) {
        console.error('❌ Semantic search failed:', error);
        if (searchMode === 'semantic') {
          throw new Error('Semantic search unavailable');
        }
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
        this.userId
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
          console.log(`📊 Using budget limit ${budgetLimit} tokens for category "${input.token_budget_category}"`);
        } else {
          console.warn(`⚠️  Budget category "${input.token_budget_category}" not found or inactive`);
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
      
      return budgetResult.results;
    }
    
    // Return top N without budget truncation
    return filteredResults.slice(0, limit);
  }

  // List recent memories
  async listMemories(limit: number = 10, category?: string): Promise<Memory[]> {
    console.log(`🔍 MemoryService.listMemories called with limit=${limit}, category=${category}, tenantId=${this.tenantId}`);
    try {
      const memories = await this.db.getRecentMemories(this.tenantId, limit, category);
      console.log(`✅ MemoryService.listMemories completed, retrieved ${memories.length} memories`);
      return memories;
    } catch (error) {
      console.error('❌ MemoryService.listMemories failed:', error);
      throw error;
    }
  }

  // Get specific memory by ID
  async getMemory(id: string): Promise<Memory | null> {
    return await this.db.getMemoryById(id, this.tenantId);
  }

  // Update memory
  async updateMemory(id: string, updates: UpdateMemoryInput): Promise<Memory | null> {
    const updated = await this.db.updateMemory(id, this.tenantId, updates);
    
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
        const embedding = await this.embeddingProvider.generateEmbedding(updates.content);
        await this.db.storeEmbedding(
          id,
          this.tenantId,
          embedding,
          this.embeddingProvider.name,
          this.embeddingProvider.model,
          this.embeddingProvider.getModelFingerprint()  // REM-249
        );
        
        // Re-check for contradictions with updated content
        if (this.advancedAnalyticsService) {
          this.advancedAnalyticsService.detectContradictionsForMemory(
            id,
            updates.content,
            this.tenantId,
            0.7
          ).then(contradictions => {
            if (contradictions.length > 0) {
              console.log(`⚠️  Detected ${contradictions.length} contradiction(s) for updated memory ${id}`);
            }
          }).catch(error => {
            console.error('Automatic contradiction detection failed:', error);
          });
        }
      } catch (error) {
        console.error('Failed to regenerate embedding:', error);
      }
    }

    return updated;
  }

  // Delete memory
  async deleteMemory(id: string): Promise<boolean> {
    return await this.db.deleteMemory(id, this.tenantId);
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
          mr.evidence,
          m.id,
          m.content,
          m.category,
          m.created_at
        FROM memory_relationships mr
        JOIN memories m ON (m.id = mr.source_memory_id OR m.id = mr.target_memory_id)
        WHERE (mr.source_memory_id = ANY($1) OR mr.target_memory_id = ANY($1))
          AND mr.confidence > 0.6  -- Only high-confidence relationships
          AND m.tenant_id = $2
          AND m.id != ALL($1)  -- Exclude original results
        ORDER BY mr.confidence DESC
        LIMIT 50  -- Cap connected memories to avoid explosion
      `;

      const result = await this.db.query(query, [memoryIds, this.tenantId], this.tenantId);
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
  async getStats(): Promise<MemoryStats> {
    const plan = await this.db.getTenantPlan(this.tenantId);
    if (!plan) {
      throw new Error('Tenant plan not found');
    }

    const totalMemories = await this.db.getMemoryCount(this.tenantId);
    const searchesToday = await this.db.getTodaySearchCount(this.tenantId);

    // Get category breakdown
    const byCategory: Record<string, number> = {};
    for (const category of MEMORY_CATEGORIES) {
      const memories = await this.db.getRecentMemories(this.tenantId, 1000, category);
      byCategory[category] = memories.length;
    }

    return {
      total_memories: totalMemories,
      by_category: byCategory,
      plan: plan.plan,
      memory_limit: plan.memory_limit,
      searches_today: searchesToday,
      search_limit_daily: plan.search_limit_daily,
      usage_percentage: Math.round((totalMemories / plan.memory_limit) * 100)
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

    // Get the source memory's embedding
    const embedding = await this.db.getEmbedding(memoryId, this.tenantId);
    if (!embedding) {
      throw new Error('Memory has no embedding');
    }

    console.log('Retrieved embedding object:', embedding);
    console.log('Embedding field type:', typeof embedding.embedding);
    console.log('Is embedding field an array?', Array.isArray(embedding.embedding));
    if (Array.isArray(embedding.embedding)) {
      console.log('Embedding array length:', embedding.embedding.length);
    }

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
      category
    );

    // Filter out the source memory and apply similarity threshold
    return results
      .filter(r => r.id !== memoryId && r.similarity >= minSimilarity)
      .slice(0, limit);
  }

  // Get embedding statistics
  async getEmbeddingStats(): Promise<EmbeddingStats> {
    const totalMemories = await this.db.getMemoryCount(this.tenantId);
    const embeddingCount = await this.db.getEmbeddingCount(this.tenantId);
    const backlog = totalMemories - embeddingCount;

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

    if (backlog > 0) {
      this.scheduleMissingEmbeddingBackfill(backlog);
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
    const total = await this.db.getMemoryCount(this.tenantId);
    const indexed = await this.db.getEmbeddingCount(this.tenantId);
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
      WHERE m.tenant_id = $1 AND me.memory_id IS NULL
      ORDER BY m.created_at DESC
      LIMIT $2
    `, [this.tenantId, batchSize], this.tenantId);

    let generated = 0;
    let failed = 0;

    for (const row of result.rows) {
      try {
        trackEmbeddingInflight(1);
        const startTime = Date.now();
        
        const embedding = await this.embeddingProvider.generateEmbedding(row.content);
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
        console.log(`✅ Backfill: generated embedding for ${row.id} in ${durationSec.toFixed(2)}s`);
      } catch (error: any) {
        const reason = error?.message?.includes('timeout') ? 'timeout' :
                       error?.message?.includes('ECONNREFUSED') ? 'ollama_down' : 'unknown';
        trackEmbeddingFailure(reason, this.tenantId);
        failed++;
        console.error(`❌ Backfill: failed for ${row.id} (${reason}):`, error?.message || error);
        
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
    const totalMemories = await this.db.getMemoryCount(this.tenantId);
    const embeddingCount = await this.db.getEmbeddingCount(this.tenantId);
    const remaining = Math.max(0, totalMemories - embeddingCount);
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
        console.error(`Tenant embedding backfill failed for ${this.tenantId}:`, error);
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
      this.projectId
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
          console.log('Relationship expansion failed for memory:', result.id);
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
    
    const placeholders = ids.map((_, index) => `$${index + 3}`).join(',');
    const query = `
      SELECT id, content, category, metadata, created_at, updated_at, relevance_score
      FROM memories 
      WHERE tenant_id = $1 
      ${this.projectId ? 'AND project_id = $2' : 'AND project_id IS NULL'}
      AND id IN (${placeholders})
      ORDER BY created_at DESC
    `;
    
    const params = this.projectId ? [this.tenantId, this.projectId, ...ids] : [this.tenantId, null, ...ids];
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
      SELECT category, COUNT(*) as count, 
             AVG(LENGTH(content)) as avg_length,
             COUNT(CASE WHEN metadata IS NOT NULL AND metadata != '{}' THEN 1 END) as with_metadata
      FROM memories 
      WHERE tenant_id = $1 
      ${this.projectId ? 'AND project_id = $2' : ''}
      AND created_at >= $${this.projectId ? '3' : '2'}
      GROUP BY category
      ORDER BY count DESC
    `;
    
    const params = this.projectId ? [this.tenantId, this.projectId, since] : [this.tenantId, since];
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
        JOIN memories m ON m.id = mr.source_memory_id
        WHERE m.tenant_id = $1
          AND mr.created_at >= $2
        GROUP BY mr.relationship_type
        ORDER BY count DESC
      `;
      
      const result = await this.db.query(query, [this.tenantId, since], this.tenantId);
      
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
        DATE_TRUNC('day', created_at) as date,
        COUNT(*) as memories_created,
        COUNT(DISTINCT category) as categories_used
      FROM memories 
      WHERE tenant_id = $1 
      ${this.projectId ? 'AND project_id = $2' : ''}
      AND created_at >= $${this.projectId ? '3' : '2'}
      GROUP BY DATE_TRUNC('day', created_at)
      ORDER BY date DESC
      LIMIT 30
    `;
    
    const params = this.projectId ? [this.tenantId, this.projectId, since] : [this.tenantId, since];
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
        category,
        COUNT(*) as count,
        COUNT(*) * 100.0 / SUM(COUNT(*)) OVER () as percentage,
        AVG(relevance_score) as avg_relevance
      FROM memories 
      WHERE tenant_id = $1 
      ${this.projectId ? 'AND project_id = $2' : ''}
      AND created_at >= $${this.projectId ? '3' : '2'}
      AND category IS NOT NULL
      GROUP BY category
      ORDER BY count DESC
    `;
    
    const params = this.projectId ? [this.tenantId, this.projectId, since] : [this.tenantId, since];
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
      SELECT content, metadata, category
      FROM memories 
      WHERE tenant_id = $1 
      ${this.projectId ? 'AND project_id = $2' : ''}
      AND created_at >= $${this.projectId ? '3' : '2'}
      ORDER BY created_at DESC
      LIMIT 100
    `;
    
    const params = this.projectId ? [this.tenantId, this.projectId, since] : [this.tenantId, since];
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
        console.log(`♻️  Re-embedding stale memory ${row.memory_id} (old model: ${row.old_model})`);
        
        const embedding = await this.embeddingProvider.generateEmbedding(row.content);
        await this.db.storeEmbedding(
          row.memory_id,
          this.tenantId,
          embedding,
          this.embeddingProvider.name,
          this.embeddingProvider.model,
          this.embeddingProvider.getModelFingerprint()
        );

        reEmbedded++;
        console.log(`✅ Re-embedded ${row.memory_id}`);
      } catch (error) {
        console.error(`❌ Failed to re-embed ${row.memory_id}:`, error);
      }
    }

    return reEmbedded;
  }
}
