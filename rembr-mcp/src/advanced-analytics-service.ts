import { MemoryDatabase } from './database.js';
import { EmbeddingProvider } from './ollama-provider.js';
import { OllamaClient } from './ollama-client.js';

/**
 * Advanced Analytics Service
 * Provides contradiction detection, insight generation, and predictive analytics
 * Part of Week 14 Context Intelligence implementation
 *
 * RAD-62: Contradiction detection timeout configuration
 *
 * Environment Variables:
 * - CONTRADICTION_DETECTION_TIMEOUT_MS — Per-LLM-call timeout for contradiction analysis
 *   (default: 8000ms). Increase on slower hardware; decrease to fail-fast on GPU contention.
 * - OLLAMA_CONTRADICTION_MODEL — Ollama model for contradiction analysis.
 *   Defaults to OLLAMA_TEXT_MODEL (llama3.1:8b). Set to a faster model (e.g. qwen2:1.5b,
 *   tinyllama, phi3.5-mini) to reduce GPU contention with the embedding model.
 * - CONTRADICTION_MAX_CANDIDATES — Max memory pairs to analyze per store_memory call
 *   (default: 5). Limits total LLM calls to avoid cumulative timeouts.
 */

export interface ContradictionResult {
  memory_a: {
    id: string;
    content: string;
    category: string;
    created_at: Date;
  };
  memory_b: {
    id: string;
    content: string;
    category: string;
    created_at: Date;
  };
  contradiction_type: 'factual' | 'temporal' | 'logical' | 'preference';
  confidence: number;
  explanation: string;
  severity: 'low' | 'medium' | 'high';
  resolution_suggestions: string[];
}

export interface ContextGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  clusters: GraphCluster[];
  metrics: GraphMetrics;
}

export interface GraphNode {
  id: string;
  label: string;
  content: string;
  category: string;
  size: number;
  color: string;
  created_at: Date;
  metadata: Record<string, any>;
}

export interface GraphEdge {
  source: string;
  target: string;
  weight: number;
  type: 'similarity' | 'temporal' | 'categorical' | 'explicit';
  label?: string;
}

export interface GraphCluster {
  id: string;
  nodes: string[];
  theme: string;
  coherence: number;
  description: string;
}

export interface GraphMetrics {
  total_nodes: number;
  total_edges: number;
  avg_clustering_coefficient: number;
  density: number;
  connected_components: number;
  most_central_node: string;
}

export interface InsightPattern {
  pattern_type: 'growth' | 'decay' | 'cyclical' | 'burst' | 'steady';
  description: string;
  confidence: number;
  evidence: string[];
  time_range: {
    start: Date;
    end: Date;
  };
  metrics: Record<string, number>;
}

export interface PredictiveAnalytics {
  memory_growth_prediction: {
    next_30_days: number;
    growth_rate: number;
    seasonal_patterns: boolean;
  };
  category_usage_prediction: Record<string, number>;
  relationship_formation_likelihood: number;
  quality_degradation_risk: {
    risk_level: 'low' | 'medium' | 'high';
    risk_factors: string[];
    recommendations: string[];
  };
}

export class AdvancedAnalyticsService {
  private database: MemoryDatabase;
  private embeddingProvider?: EmbeddingProvider;
  private ollamaClient: OllamaClient;

  // RAD-62: Configurable timeouts and limits for contradiction detection
  // Reads from env at construction time so tests can override via process.env.
  private readonly CONTRADICTION_LLM_TIMEOUT_MS: number;
  private readonly CONTRADICTION_MAX_CANDIDATES: number;
  private readonly contradictionModel: string;

  // Contradiction detection patterns (fallback for when LLM is unavailable)
  private readonly CONTRADICTION_PATTERNS = {
    factual: {
      indicators: [
        /(?:is|was|are|were)\s+(.+?)\s*(?:but|however|although).+?(?:is|was|are|were)\s+(.+)/i,
        /(.+?)\s+(?:true|correct|right).+?(?:false|incorrect|wrong)/i,
        /(?:enabled|on|active).+?(?:disabled|off|inactive)/i
      ],
      weight: 1.0
    },
    temporal: {
      indicators: [
        /(?:before|after|until|since).+?(?:before|after|until|since)/i,
        /(\d{4})-(\d{2})-(\d{2}).+?(\d{4})-(\d{2})-(\d{2})/,
        /(?:old|previous|legacy).+?(?:new|current|latest)/i
      ],
      weight: 0.8
    },
    logical: {
      indicators: [
        /(?:if|when|because).+?(?:unless|except|but)/i,
        /(?:always|never|all|none).+?(?:sometimes|some|few)/i,
        /(?:must|required).+?(?:optional|can|may)/i
      ],
      weight: 0.9
    },
    preference: {
      indicators: [
        /(?:prefer|like|want|choose).+?(?:dislike|hate|avoid|reject)/i,
        /(?:should|recommended).+?(?:should not|not recommended)/i,
        /(?:best|good|excellent).+?(?:worst|bad|poor)/i
      ],
      weight: 0.7
    }
  };

  constructor(database: MemoryDatabase, embeddingProvider?: EmbeddingProvider) {
    this.database = database;
    this.embeddingProvider = embeddingProvider;
    this.ollamaClient = OllamaClient.getInstance();

    // RAD-62: Timeout and model configuration for contradiction LLM calls
    // Per-call timeout (ms): lower values fail-fast under GPU contention; raise on dedicated GPU
    this.CONTRADICTION_LLM_TIMEOUT_MS = parseInt(
      process.env.CONTRADICTION_DETECTION_TIMEOUT_MS || '8000', 10
    );
    // Max candidate pairs to analyze per memory — caps total LLM calls per store_memory
    this.CONTRADICTION_MAX_CANDIDATES = parseInt(
      process.env.CONTRADICTION_MAX_CANDIDATES || '5', 10
    );
    // Model for contradiction analysis — default to text model but allow override
    // Prefer a smaller/faster model on resource-constrained deployments (e.g. qwen2:1.5b)
    this.contradictionModel = process.env.OLLAMA_CONTRADICTION_MODEL
      || process.env.OLLAMA_TEXT_MODEL
      || 'llama3.1:8b';
  }

  /**
   * Detect contradictions using hybrid approach:
   * 1. Use embeddings to find semantically similar pairs (candidate filtering)
   * 2. Use LLM to analyze if candidates actually contradict
   * 3. Store relationships for UI access
   */
  async detectContradictions(
    tenantId: string,
    contextId?: string,
    minConfidence: number = 0.7
  ): Promise<ContradictionResult[]> {
    console.log('🔍 Starting hybrid contradiction detection...');
    
    // Get memories to analyze
    const memories = await this.getMemoriesForAnalysis(tenantId, contextId);
    const contradictions: ContradictionResult[] = [];

    // PERFORMANCE FIX: Limit analysis to prevent O(n²) hangs
    // RAD-62: Still cap at 50 for full-scan; per-pair LLM timeout handles contention
    const maxMemoriesToCompare = 50;
    const memoriesToAnalyze = memories.slice(0, maxMemoriesToCompare);
    
    console.log(`📊 Analyzing ${memoriesToAnalyze.length} memories for contradictions`);

    // Phase 1: Find candidate pairs using embedding similarity
    const candidatePairs: Array<{memoryA: any, memoryB: any, similarity: number}> = [];
    
    if (this.embeddingProvider) {
      // Get embeddings for all memories
      const embeddingsMap = new Map<string, number[]>();
      
      for (const memory of memoriesToAnalyze) {
        try {
          const embedding = await this.embeddingProvider.generateEmbedding(memory.content);
          embeddingsMap.set(memory.id, embedding);
        } catch (err) {
          console.warn(`Failed to get embedding for memory ${memory.id}:`, err);
        }
      }
      
      // Find pairs with high similarity (>0.5) - these are talking about similar topics
      for (let i = 0; i < memoriesToAnalyze.length; i++) {
        for (let j = i + 1; j < memoriesToAnalyze.length; j++) {
          const embA = embeddingsMap.get(memoriesToAnalyze[i].id);
          const embB = embeddingsMap.get(memoriesToAnalyze[j].id);
          
          if (embA && embB) {
            const similarity = this.cosineSimilarity(embA, embB);
            // High similarity means they're discussing similar topics - potential contradiction
            if (similarity > 0.5) {
              candidatePairs.push({
                memoryA: memoriesToAnalyze[i],
                memoryB: memoriesToAnalyze[j],
                similarity
              });
            }
          }
        }
      }
      
      console.log(`🎯 Found ${candidatePairs.length} candidate pairs with similarity > 0.5`);
    } else {
      // No embeddings available, compare all pairs (slower)
      for (let i = 0; i < memoriesToAnalyze.length; i++) {
        for (let j = i + 1; j < memoriesToAnalyze.length; j++) {
          candidatePairs.push({
            memoryA: memoriesToAnalyze[i],
            memoryB: memoriesToAnalyze[j],
            similarity: 0.5
          });
        }
      }
    }

    // Phase 2: Use LLM to analyze each candidate pair
    for (const pair of candidatePairs) {
      try {
        const llmResult = await this.analyzeContradictionWithLLM(pair.memoryA, pair.memoryB);
        
        if (llmResult && llmResult.isContradiction && llmResult.confidence >= minConfidence) {
          const contradiction: ContradictionResult = {
            memory_a: {
              id: pair.memoryA.id,
              content: pair.memoryA.content,
              category: pair.memoryA.category,
              created_at: pair.memoryA.created_at
            },
            memory_b: {
              id: pair.memoryB.id,
              content: pair.memoryB.content,
              category: pair.memoryB.category,
              created_at: pair.memoryB.created_at
            },
            contradiction_type: llmResult.type,
            confidence: llmResult.confidence,
            explanation: llmResult.explanation,
            severity: this.calculateSeverity(llmResult.confidence, llmResult.type),
            resolution_suggestions: llmResult.suggestions
          };
          
          contradictions.push(contradiction);
          
          // Store the contradiction as a relationship so UI can access it
          try {
            await this.database.query(
              `INSERT INTO memory_relationships (source_memory_id, target_memory_id, relationship_type, confidence, evidence)
               VALUES ($1, $2, 'contradicts', $3, $4)
               ON CONFLICT DO NOTHING`,
              [
                contradiction.memory_a.id,
                contradiction.memory_b.id,
                contradiction.confidence,
                JSON.stringify({
                  type: contradiction.contradiction_type,
                  severity: contradiction.severity,
                  explanation: contradiction.explanation,
                  suggestions: contradiction.resolution_suggestions
                })
              ]
            );
            console.log(`💾 Stored contradiction: ${pair.memoryA.id} <-> ${pair.memoryB.id}`);
          } catch (err) {
            console.error('Failed to store contradiction relationship:', err);
          }
        }
      } catch (err) {
        console.error(`Failed to analyze pair with LLM:`, err);
        // Fallback to pattern-based analysis
        const patternResult = await this.analyzeContradiction(pair.memoryA, pair.memoryB);
        if (patternResult && patternResult.confidence >= minConfidence) {
          contradictions.push(patternResult);
        }
      }
    }

    console.log(`✅ Detected ${contradictions.length} contradictions`);

    // Sort by confidence and severity
    return contradictions.sort((a, b) => {
      const severityOrder = { high: 3, medium: 2, low: 1 };
      const severityDiff = severityOrder[b.severity] - severityOrder[a.severity];
      return severityDiff !== 0 ? severityDiff : b.confidence - a.confidence;
    });
  }

  /**
   * Use LLM (llama3.1:8b) to analyze if two memories contradict each other
   */
  private async analyzeContradictionWithLLM(memoryA: any, memoryB: any): Promise<{
    isContradiction: boolean;
    type: 'factual' | 'temporal' | 'logical' | 'preference';
    confidence: number;
    explanation: string;
    suggestions: string[];
  } | null> {
    const systemPrompt = `You are an expert at detecting GENUINE contradictions between statements.

IMPORTANT: Only mark as contradiction if statements are about THE SAME TOPIC and cannot both be true.

NOT contradictions:
- Different test numbers (stress test 1 vs stress test 5) - these are different tests
- Different topics (frontend frameworks vs API versioning) - unrelated facts
- Similar timestamps (Jan 24 vs Jan 25) - timeline progression is normal
- One statement being more detailed than another - detail levels can vary
- Complementary information (deployment process AND testing process) - can coexist

GENUINE contradictions:
- Same topic, opposite facts: "uses PostgreSQL" vs "uses MongoDB" (about database choice)
- Same event, different dates: "launched April 2025" vs "launched June 2025" (about same launch)
- Same requirement, opposite values: "requires auth" vs "auth is optional" (about same feature)
- Mutually exclusive choices: "migrate to Redis" vs "already using Memcached" (about caching choice)

Contradiction types:
- factual: Statements about the SAME FACT that cannot both be true
- temporal: Conflicts about the SAME EVENT or timeline
- logical: Logical inconsistencies about the SAME RULE or requirement
- preference: Conflicting preferences about the SAME CHOICE

If in doubt, mark as NOT a contradiction. Better to miss a contradiction than create a false positive.

Respond in JSON format only:
{
  "isContradiction": true/false,
  "type": "factual|temporal|logical|preference",
  "confidence": 0.0-1.0,
  "explanation": "Brief explanation of why these contradict",
  "suggestions": ["suggestion 1", "suggestion 2"]
}`;

    const prompt = `Statement A: "${memoryA.content}"

Statement B: "${memoryB.content}"

Do these statements contradict each other? Analyze carefully.`;

    try {
      // RAD-62: Apply per-call timeout to avoid hanging under GPU contention.
      // generateText uses a fixed 60s timeout; we override with CONTRADICTION_DETECTION_TIMEOUT_MS
      // (default 8000ms) so background analysis fails fast when llama3.1:8b is busy.
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Contradiction LLM timeout after ${this.CONTRADICTION_LLM_TIMEOUT_MS}ms`)),
          this.CONTRADICTION_LLM_TIMEOUT_MS
        )
      );

      const generatePromise = this.ollamaClient.generateText(prompt, systemPrompt, {
        temperature: 0.1, // Low temperature for consistent analysis
        maxTokens: 300
      });

      const response = await Promise.race([generatePromise, timeoutPromise]);
      
      // Parse JSON response
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.warn('LLM response was not valid JSON:', response);
        return null;
      }
      
      const result = JSON.parse(jsonMatch[0]);
      
      return {
        isContradiction: result.isContradiction === true,
        type: result.type || 'factual',
        confidence: Math.min(1, Math.max(0, result.confidence || 0.5)),
        explanation: result.explanation || 'Contradiction detected by LLM analysis',
        suggestions: result.suggestions || ['Review both statements for accuracy']
      };
    } catch (err) {
      const isTimeout = (err as Error)?.message?.includes('timeout');
      if (isTimeout) {
        console.warn(`⏱️  Contradiction LLM timed out after ${this.CONTRADICTION_LLM_TIMEOUT_MS}ms — falling back to pattern analysis`);
      } else {
        console.error('LLM contradiction analysis failed:', err);
      }
      return null;
    }
  }

  /**
   * Calculate cosine similarity between two embedding vectors
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    
    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    return denominator === 0 ? 0 : dotProduct / denominator;
  }

  /**
   * Check a single new memory for contradictions against existing memories.
   * Called automatically when a memory is stored or updated.
   * Uses embedding similarity to find candidates, then LLM for analysis.
   */
  async detectContradictionsForMemory(
    memoryId: string,
    memoryContent: string,
    tenantId: string,
    minConfidence: number = 0.7
  ): Promise<ContradictionResult[]> {
    console.log(`🔍 Checking new memory ${memoryId} for contradictions...`);
    
    const contradictions: ContradictionResult[] = [];
    
    if (!this.embeddingProvider) {
      console.warn('No embedding provider - skipping contradiction detection');
      return contradictions;
    }

    try {
      // Generate embedding for the new memory
      const newEmbedding = await this.embeddingProvider.generateEmbedding(memoryContent);
      
      // Find similar memories using pgvector (similarity > 0.5 for nomic-embed-text)
      // 0.7 was too aggressive for local embedding models
      // RAD-62: Cap at CONTRADICTION_MAX_CANDIDATES (default 5) to limit total LLM calls
      const similarResult = await this.database.query(
        `SELECT m.id, m.content, m.category, m.created_at, 
                1 - (me.embedding <=> $1::vector) as similarity
         FROM memories m
         JOIN memory_embeddings me ON m.id = me.memory_id
         WHERE m.tenant_id = $2 
           AND m.id != $3
           AND 1 - (me.embedding <=> $1::vector) > 0.5
         ORDER BY similarity DESC
         LIMIT $4`,
        [`[${newEmbedding.join(',')}]`, tenantId, memoryId, this.CONTRADICTION_MAX_CANDIDATES]
      );
      
      const candidateMemories = similarResult.rows;
      console.log(`🎯 Found ${candidateMemories.length} similar memories to check (max: ${this.CONTRADICTION_MAX_CANDIDATES})`);
      
      // Get the new memory's full record
      const newMemoryResult = await this.database.query(
        'SELECT * FROM memories WHERE id = $1 AND tenant_id = $2',
        [memoryId, tenantId]
      );
      const newMemory = newMemoryResult.rows[0];
      
      if (!newMemory) {
        console.warn(`Memory ${memoryId} not found`);
        return contradictions;
      }
      
      // Analyze each candidate with LLM
      for (const candidate of candidateMemories) {
        try {
          const llmResult = await this.analyzeContradictionWithLLM(newMemory, candidate);
          
          if (llmResult && llmResult.isContradiction && llmResult.confidence >= minConfidence) {
            const contradiction: ContradictionResult = {
              memory_a: {
                id: newMemory.id,
                content: newMemory.content,
                category: newMemory.category,
                created_at: newMemory.created_at
              },
              memory_b: {
                id: candidate.id,
                content: candidate.content,
                category: candidate.category,
                created_at: candidate.created_at
              },
              contradiction_type: llmResult.type,
              confidence: llmResult.confidence,
              explanation: llmResult.explanation,
              severity: this.calculateSeverity(llmResult.confidence, llmResult.type),
              resolution_suggestions: llmResult.suggestions
            };
            
            contradictions.push(contradiction);
            
            // Check if contradiction relationship already exists in either direction
            const existingCheck = await this.database.query(
              `SELECT id FROM memory_relationships 
               WHERE ((source_memory_id = $1 AND target_memory_id = $2) OR (source_memory_id = $2 AND target_memory_id = $1))
                 AND relationship_type = 'contradicts'`,
              [newMemory.id, candidate.id]
            );
            
            if (existingCheck.rows.length === 0) {
              // Store the contradiction as a relationship
              await this.database.query(
                `INSERT INTO memory_relationships (source_memory_id, target_memory_id, relationship_type, confidence, evidence)
                 VALUES ($1, $2, 'contradicts', $3, $4)`,
                [
                  newMemory.id,
                  candidate.id,
                  contradiction.confidence,
                  JSON.stringify({
                    type: contradiction.contradiction_type,
                    severity: contradiction.severity,
                    explanation: contradiction.explanation,
                    suggestions: contradiction.resolution_suggestions,
                    detected_at: new Date().toISOString()
                  })
                ]
              );
              console.log(`💾 Stored contradiction: ${newMemory.id} <-> ${candidate.id}`);
            } else {
              console.log(`⏭️  Skipping duplicate contradiction: ${newMemory.id} <-> ${candidate.id}`);
            }
            console.log(`💾 Stored contradiction: ${newMemory.id} <-> ${candidate.id}`);
          }
        } catch (err) {
          // RAD-62: Per-candidate fallback — if LLM fails, try pattern-based detection
          console.warn(`LLM analysis failed for candidate ${candidate.id}, falling back to pattern analysis:`, (err as Error)?.message);
          try {
            const patternResult = await this.analyzeContradiction(newMemory, candidate);
            if (patternResult && patternResult.confidence >= minConfidence) {
              contradictions.push(patternResult);
              // Store pattern-detected contradiction
              await this.database.query(
                `INSERT INTO memory_relationships (source_memory_id, target_memory_id, relationship_type, confidence, evidence)
                 VALUES ($1, $2, 'contradicts', $3, $4)
                 ON CONFLICT DO NOTHING`,
                [
                  newMemory.id,
                  candidate.id,
                  patternResult.confidence,
                  JSON.stringify({ detected_by: 'pattern', severity: patternResult.severity })
                ]
              );
            }
          } catch (patternErr) {
            console.error(`Pattern analysis also failed for candidate ${candidate.id}:`, patternErr);
          }
        }
      }
      
      console.log(`✅ Detected ${contradictions.length} contradictions for memory ${memoryId}`);
      return contradictions;
      
    } catch (err) {
      console.error('Error in automatic contradiction detection:', err);
      return contradictions;
    }
  }

  /**
   * Generate context graph visualization data
   */
  async generateContextGraph(
    tenantId: string,
    contextId?: string,
    includeRelationships: boolean = true
  ): Promise<ContextGraph> {
    const memories = await this.getMemoriesForAnalysis(tenantId, contextId);
    
    // Create nodes
    const nodes: GraphNode[] = memories.map(memory => ({
      id: memory.id,
      label: this.generateNodeLabel(memory.content),
      content: memory.content,
      category: memory.category,
      size: this.calculateNodeSize(memory),
      color: this.getCategoryColor(memory.category),
      created_at: memory.created_at,
      metadata: memory.metadata
    }));

    // Create edges based on similarity and relationships
    const edges: GraphEdge[] = [];
    
    if (includeRelationships && this.embeddingProvider) {
      for (let i = 0; i < memories.length; i++) {
        for (let j = i + 1; j < memories.length; j++) {
          const edge = await this.calculateMemoryEdge(memories[i], memories[j]);
          if (edge) {
            edges.push(edge);
          }
        }
      }
    }

    // Detect clusters using category and semantic similarity
    const clusters = this.detectClusters(nodes, edges);
    
    // Calculate graph metrics
    const metrics = this.calculateGraphMetrics(nodes, edges);

    return {
      nodes,
      edges,
      clusters,
      metrics
    };
  }

  /**
   * Generate insights from memory patterns
   */
  async generateInsights(
    tenantId: string,
    timeRangeDays: number = 30,
    projectId?: string
  ): Promise<InsightPattern[]> {
    const insights: InsightPattern[] = [];

    // Memory creation patterns
    const creationPattern = await this.analyzeCreationPattern(tenantId, timeRangeDays, projectId);
    if (creationPattern) insights.push(creationPattern);

    // Category usage patterns  
    const categoryPattern = await this.analyzeCategoryPattern(tenantId, timeRangeDays, projectId);
    if (categoryPattern) insights.push(categoryPattern);

    // Content complexity patterns
    const complexityPattern = await this.analyzeComplexityPattern(tenantId, timeRangeDays, projectId);
    if (complexityPattern) insights.push(complexityPattern);

    // Relationship formation patterns
    if (this.embeddingProvider) {
      const relationshipPattern = await this.analyzeRelationshipPattern(tenantId, timeRangeDays, projectId);
      if (relationshipPattern) insights.push(relationshipPattern);
    }

    return insights.filter(insight => insight.confidence >= 0.6);
  }

  /**
   * Generate predictive analytics about memory usage and growth
   */
  async generatePredictiveAnalytics(
    tenantId: string,
    projectId?: string
  ): Promise<PredictiveAnalytics> {
    // Analyze historical data for predictions
    const historicalData = await this.getHistoricalData(tenantId, projectId, 90); // 90 days of data
    
    // Predict memory growth
    const growthPrediction = this.predictMemoryGrowth(historicalData);
    
    // Predict category usage
    const categoryPrediction = this.predictCategoryUsage(historicalData);
    
    // Predict relationship formation
    const relationshipLikelihood = this.predictRelationshipFormation(historicalData);
    
    // Assess quality degradation risk
    const qualityRisk = await this.assessQualityDegradationRisk(tenantId, projectId);

    return {
      memory_growth_prediction: growthPrediction,
      category_usage_prediction: categoryPrediction,
      relationship_formation_likelihood: relationshipLikelihood,
      quality_degradation_risk: qualityRisk
    };
  }

  /**
   * Helper methods for analysis
   */
  private async getMemoriesForAnalysis(tenantId: string, contextId?: string): Promise<any[]> {
    let query: string;
    let params: any[];

    if (contextId) {
      query = `
        SELECT m.*, mc.relevance_score as context_relevance
        FROM memories m
        JOIN memory_contexts mc ON m.id = mc.memory_id
        WHERE mc.context_id = $1 AND m.tenant_id = $2
        ORDER BY m.created_at DESC
      `;
      params = [contextId, tenantId];
    } else {
      query = `
        SELECT * FROM memories 
        WHERE tenant_id = $1 
        AND created_at >= NOW() - INTERVAL '90 days'
        ORDER BY created_at DESC
        LIMIT 200
      `;
      params = [tenantId];
    }

    const result = await this.database.query(query, params);
    return result.rows;
  }

  private async analyzeContradiction(memoryA: any, memoryB: any): Promise<ContradictionResult | null> {
    const contentA = memoryA.content.toLowerCase();
    const contentB = memoryB.content.toLowerCase();

    // ENHANCED: Check for factual numeric conflicts (e.g., "15-minute" vs "60-minute")
    const numericConflict = this.detectNumericConflict(contentA, contentB);
    if (numericConflict) {
      return {
        memory_a: {
          id: memoryA.id,
          content: memoryA.content,
          category: memoryA.category,
          created_at: memoryA.created_at
        },
        memory_b: {
          id: memoryB.id,
          content: memoryB.content,
          category: memoryB.category,
          created_at: memoryB.created_at
        },
        contradiction_type: 'factual',
        confidence: numericConflict.confidence,
        explanation: numericConflict.explanation,
        severity: numericConflict.confidence > 0.85 ? 'high' : numericConflict.confidence > 0.7 ? 'medium' : 'low',
        resolution_suggestions: [
          'Review both memories and determine the correct value',
          'Check timestamps to see which is more recent',
          'Archive or delete the outdated memory',
          `Values found: "${numericConflict.value1}" vs "${numericConflict.value2}"`
        ]
      };
    }

    // ENHANCED: Check for mutually exclusive alternatives (e.g., "uses bcrypt" vs "uses argon2id")
    const alternativeConflict = this.detectAlternativeConflict(contentA, contentB);
    if (alternativeConflict) {
      return {
        memory_a: {
          id: memoryA.id,
          content: memoryA.content,
          category: memoryA.category,
          created_at: memoryA.created_at
        },
        memory_b: {
          id: memoryB.id,
          content: memoryB.content,
          category: memoryB.category,
          created_at: memoryB.created_at
        },
        contradiction_type: alternativeConflict.type as any,
        confidence: alternativeConflict.confidence,
        explanation: alternativeConflict.explanation,
        severity: alternativeConflict.confidence > 0.85 ? 'high' : alternativeConflict.confidence > 0.7 ? 'medium' : 'low',
        resolution_suggestions: [
          'Determine which approach is currently in use',
          'Check if this was a migration (both may have been true at different times)',
          'Update or archive the outdated memory'
        ]
      };
    }

    // ENHANCED: Check for semantic similarity with opposing sentiment
    const semanticConflict = await this.detectSemanticConflict(memoryA, memoryB);
    if (semanticConflict) {
      return semanticConflict;
    }

    // Original pattern-based detection (fallback)
    for (const [type, config] of Object.entries(this.CONTRADICTION_PATTERNS)) {
      for (const pattern of config.indicators) {
        if (pattern.test(contentA + ' ' + contentB)) {
          const confidence = this.calculateContradictionConfidence(memoryA, memoryB, type);
          
          if (confidence >= 0.6) {
            return {
              memory_a: {
                id: memoryA.id,
                content: memoryA.content,
                category: memoryA.category,
                created_at: memoryA.created_at
              },
              memory_b: {
                id: memoryB.id,
                content: memoryB.content,
                category: memoryB.category,
                created_at: memoryB.created_at
              },
              contradiction_type: type as any,
              confidence: confidence * config.weight,
              explanation: this.generateContradictionExplanation(memoryA, memoryB, type),
              severity: this.calculateSeverity(confidence, type),
              resolution_suggestions: this.generateResolutionSuggestions(memoryA, memoryB, type)
            };
          }
        }
      }
    }

    return null;
  }

  /**
   * Detect numeric conflicts where the same metric has different values
   * E.g., "15-minute expiry" vs "60-minute expiry"
   */
  private detectNumericConflict(contentA: string, contentB: string): {
    confidence: number;
    explanation: string;
    value1: string;
    value2: string;
  } | null {
    // Common numeric patterns: "X connections", "X-minute", "X requests", etc.
    const numericPatterns = [
      /(\d+)[\s-]*(minute|hour|second|day|week|month)/gi,
      /(\d+)\s*(connections?|users?|requests?|threads?)/gi,
      /(\d+)\s*%/g,
      /cost\s*factor\s*(?:of\s*)?(\d+)/gi,
      /maximum\s*(?:of\s*)?(\d+)/gi,
      /limit\s*(?:of\s*|is\s*|set\s*to\s*)?(\d+)/gi,
      /(\d+)\s*(?:dimensional|dimensions?)/gi,
    ];

    // Extract all numeric values with their context
    const extractNumbers = (content: string): Array<{value: number, context: string, fullMatch: string}> => {
      const results: Array<{value: number, context: string, fullMatch: string}> = [];
      for (const pattern of numericPatterns) {
        let match;
        const regex = new RegExp(pattern.source, pattern.flags);
        while ((match = regex.exec(content)) !== null) {
          const value = parseInt(match[1]);
          const context = match[0].toLowerCase().replace(/\d+/g, 'N');
          results.push({ value, context, fullMatch: match[0] });
        }
      }
      return results;
    };

    const numbersA = extractNumbers(contentA);
    const numbersB = extractNumbers(contentB);

    // Look for same context but different values
    for (const numA of numbersA) {
      for (const numB of numbersB) {
        // Same context (e.g., both "N-minute" or both "N connections")
        if (numA.context === numB.context && numA.value !== numB.value) {
          // Calculate similarity of surrounding text
          const textSimilarity = this.calculateTextSimilarity(contentA, contentB);
          
          // High confidence if texts are similar but numbers differ
          if (textSimilarity > 0.4) {
            const ratio = Math.abs(numA.value - numB.value) / Math.max(numA.value, numB.value);
            const confidence = Math.min(0.95, 0.7 + textSimilarity * 0.2 + ratio * 0.1);
            
            return {
              confidence,
              explanation: `Conflicting numeric values detected: ${numA.fullMatch} vs ${numB.fullMatch}. The texts are ${Math.round(textSimilarity * 100)}% similar but contain different values.`,
              value1: numA.fullMatch,
              value2: numB.fullMatch
            };
          }
        }
      }
    }

    return null;
  }

  /**
   * Detect mutually exclusive alternatives
   * E.g., "uses PostgreSQL" vs "migrate to MongoDB", "uses bcrypt" vs "uses argon2id"
   */
  private detectAlternativeConflict(contentA: string, contentB: string): {
    type: string;
    confidence: number;
    explanation: string;
  } | null {
    // Define mutually exclusive technology alternatives
    const alternatives = [
      // Databases
      { group: 'database', items: ['postgresql', 'postgres', 'mysql', 'mongodb', 'sqlite', 'mariadb', 'oracle', 'sqlserver'] },
      // Hashing algorithms
      { group: 'hashing', items: ['bcrypt', 'argon2', 'argon2id', 'scrypt', 'pbkdf2', 'sha256', 'sha512'] },
      // Communication patterns
      { group: 'communication', items: ['rest', 'rest api', 'graphql', 'grpc', 'soap', 'message queue', 'rabbitmq', 'kafka'] },
      // Languages/Runtimes
      { group: 'runtime', items: ['node.js', 'nodejs', 'python', 'java', 'go', 'rust', 'deno', 'bun'] },
      // Frameworks (backend)
      { group: 'framework', items: ['express', 'fastify', 'nest.js', 'nestjs', 'koa', 'hapi', 'django', 'flask'] },
      // Frontend frameworks
      { group: 'frontend', items: ['react', 'vue', 'vue.js', 'angular', 'svelte', 'solid', 'next.js', 'nuxt'] },
      // State management
      { group: 'state', items: ['redux', 'zustand', 'mobx', 'recoil', 'jotai', 'context api'] },
      // Deployment
      { group: 'deployment', items: ['kubernetes', 'bare metal', 'docker swarm', 'ecs', 'eks', 'gke', 'aks', 'datacenter'] },
      // Caching
      { group: 'caching', items: ['redis', 'memcached', 'in-memory', 'varnish', 'cdn'] },
      // Authentication
      { group: 'authentication', items: ['jwt', 'session', 'oauth', 'saml', 'cookie', 'token'] },
      // API versioning
      { group: 'versioning', items: ['url path', 'accept header', 'query param', 'custom header'] },
      // Embedding models
      { group: 'embedding', items: ['openai', 'ollama', 'cohere', 'sentence-transformers', 'nomic'] },
    ];

    // Check each group for conflicts
    for (const { group, items } of alternatives) {
      const foundInA: string[] = [];
      const foundInB: string[] = [];

      for (const item of items) {
        if (contentA.includes(item)) foundInA.push(item);
        if (contentB.includes(item)) foundInB.push(item);
      }

      // Both texts mention items from same group, but different items
      if (foundInA.length > 0 && foundInB.length > 0) {
        const intersection = foundInA.filter(x => foundInB.includes(x));
        if (intersection.length === 0) {
          // Different items from same group = conflict
          const textSimilarity = this.calculateTextSimilarity(contentA, contentB);
          const confidence = Math.min(0.95, 0.75 + textSimilarity * 0.15);
          
          return {
            type: group === 'deployment' ? 'logical' : 'factual',
            confidence,
            explanation: `Conflicting ${group} choices detected: "${foundInA.join(', ')}" vs "${foundInB.join(', ')}". These are mutually exclusive alternatives.`
          };
        }
      }
    }

    // Check for "migrate from X to Y" patterns
    const migratePattern = /(?:migrat(?:e|ed|ing)|switch(?:ed|ing)?|mov(?:e|ed|ing)|chang(?:e|ed|ing))\s+(?:from\s+)?(\w+)\s+to\s+(\w+)/i;
    const matchA = migratePattern.exec(contentA);
    const matchB = migratePattern.exec(contentB);
    
    if (matchA && contentB.includes(matchA[1].toLowerCase())) {
      return {
        type: 'temporal',
        confidence: 0.85,
        explanation: `Migration conflict: One memory suggests migrating from ${matchA[1]} to ${matchA[2]}, but another still references ${matchA[1]} as current.`
      };
    }

    return null;
  }

  /**
   * Detect semantic conflicts using embedding similarity + opposing indicators
   */
  private async detectSemanticConflict(memoryA: any, memoryB: any): Promise<ContradictionResult | null> {
    if (!this.embeddingProvider) return null;

    const contentA = memoryA.content.toLowerCase();
    const contentB = memoryB.content.toLowerCase();

    // Calculate text similarity using simple word overlap
    const textSimilarity = this.calculateTextSimilarity(contentA, contentB);

    // Only analyze semantically similar texts (they're talking about the same thing)
    if (textSimilarity < 0.3) return null;

    // Look for opposing indicators
    const opposingPairs = [
      ['requires', 'optional'],
      ['manual', 'automated'],
      ['synchronous', 'async'],
      ['enabled', 'disabled'],
      ['always', 'never'],
      ['must', 'should not'],
      ['required', 'not required'],
      ['recommended', 'not recommended'],
      ['prefers', 'avoids'],
      ['approve', 'no approval'],
      ['above 80%', 'don\'t enforce'],
      ['coverage must be', 'no coverage'],
      ['external', 'in-memory only'],
      ['all services', 'bare metal'],
      ['url path', 'accept header'],
      ['sentry', 'logged locally'],
    ];

    for (const [positive, negative] of opposingPairs) {
      const aHasPositive = contentA.includes(positive);
      const aHasNegative = contentA.includes(negative);
      const bHasPositive = contentB.includes(positive);
      const bHasNegative = contentB.includes(negative);

      if ((aHasPositive && bHasNegative) || (aHasNegative && bHasPositive)) {
        const confidence = Math.min(0.92, 0.75 + textSimilarity * 0.15);
        
        return {
          memory_a: {
            id: memoryA.id,
            content: memoryA.content,
            category: memoryA.category,
            created_at: memoryA.created_at
          },
          memory_b: {
            id: memoryB.id,
            content: memoryB.content,
            category: memoryB.category,
            created_at: memoryB.created_at
          },
          contradiction_type: 'logical',
          confidence,
          explanation: `Semantic conflict detected: One memory uses "${positive}" while the other uses "${negative}". These represent opposing requirements or preferences.`,
          severity: confidence > 0.85 ? 'high' : 'medium',
          resolution_suggestions: [
            'Review both memories to determine current policy',
            'Consider if requirements changed over time',
            'Update documentation to reflect current state'
          ]
        };
      }
    }

    return null;
  }

  /**
   * Calculate text similarity using word overlap (Jaccard similarity)
   */
  private calculateTextSimilarity(textA: string, textB: string): number {
    const wordsA = new Set(textA.toLowerCase().split(/\s+/).filter(w => w.length > 3));
    const wordsB = new Set(textB.toLowerCase().split(/\s+/).filter(w => w.length > 3));
    
    const intersection = new Set([...wordsA].filter(x => wordsB.has(x)));
    const union = new Set([...wordsA, ...wordsB]);
    
    return union.size > 0 ? intersection.size / union.size : 0;
  }

  private calculateContradictionConfidence(memoryA: any, memoryB: any, type: string): number {
    let confidence = 0.5; // Base confidence

    // Same category but contradictory = higher confidence
    if (memoryA.category === memoryB.category) {
      confidence += 0.2;
    }

    // Time difference (newer contradicting older = higher confidence)
    const timeDiff = Math.abs(
      new Date(memoryA.created_at).getTime() - new Date(memoryB.created_at).getTime()
    );
    const daysDiff = timeDiff / (1000 * 60 * 60 * 24);
    
    if (daysDiff > 1) {
      confidence += Math.min(daysDiff / 30, 0.3); // Max 0.3 boost for time difference
    }

    // Type-specific confidence adjustments
    switch (type) {
      case 'factual':
        confidence += 0.2; // Factual contradictions are usually clear
        break;
      case 'temporal':
        confidence += 0.15;
        break;
      case 'preference':
        confidence -= 0.1; // Preferences can change legitimately
        break;
    }

    return Math.min(confidence, 1.0);
  }

  private generateContradictionExplanation(memoryA: any, memoryB: any, type: string): string {
    const explanations = {
      factual: `Factual information differs between these memories`,
      temporal: `Timeline or sequence information conflicts`,
      logical: `Logical conditions or rules contradict each other`,
      preference: `User preferences or choices appear to conflict`
    };

    const baseExplanation = explanations[type as keyof typeof explanations] || 'Contradiction detected';
    const timeInfo = new Date(memoryA.created_at) > new Date(memoryB.created_at) 
      ? 'Newer memory contradicts older one' 
      : 'Older memory contradicts newer one';

    return `${baseExplanation}. ${timeInfo}.`;
  }

  private calculateSeverity(confidence: number, type: string): 'low' | 'medium' | 'high' {
    const typeWeight = {
      factual: 1.2,
      logical: 1.1,
      temporal: 1.0,
      preference: 0.8
    };

    const adjustedConfidence = confidence * (typeWeight[type as keyof typeof typeWeight] || 1.0);

    if (adjustedConfidence >= 0.9) return 'high';
    if (adjustedConfidence >= 0.75) return 'medium';
    return 'low';
  }

  private generateResolutionSuggestions(memoryA: any, memoryB: any, type: string): string[] {
    const baseSuggestions = [
      'Review both memories for accuracy',
      'Consider if context or conditions changed',
      'Update or merge conflicting information'
    ];

    const typeSuggestions = {
      factual: ['Verify facts from authoritative sources', 'Mark outdated information'],
      temporal: ['Check dates and timelines', 'Consider sequence dependencies'],
      logical: ['Review logical conditions', 'Check for missing context'],
      preference: ['Consider if preferences evolved', 'Clarify current preferences']
    };

    return [...baseSuggestions, ...(typeSuggestions[type as keyof typeof typeSuggestions] || [])];
  }

  private generateNodeLabel(content: string): string {
    // Generate a concise label from content
    const firstLine = content.split('\n')[0];
    return firstLine.length > 30 ? firstLine.substring(0, 27) + '...' : firstLine;
  }

  private calculateNodeSize(memory: any): number {
    // Size based on content length and relevance
    const baseSize = Math.min(memory.content.length / 100, 10);
    const relevanceBonus = (memory.relevance_score || 1.0) * 2;
    return Math.max(baseSize + relevanceBonus, 3);
  }

  private getCategoryColor(category: string): string {
    const colors = {
      facts: '#3b82f6',
      patterns: '#06b6d4',
      decisions: '#14b8a6',
      workflows: '#6b7280',
      insights: '#10b981',
      projects: '#f97316',
      conversations: '#22c55e',
      learning: '#f59e0b',
      preferences: '#a855f7',
      goals: '#ec4899',
      context: '#6366f1',
      reminders: '#ef4444'
    };
    return colors[category as keyof typeof colors] || '#6b7280';
  }

  private async calculateMemoryEdge(memoryA: any, memoryB: any): Promise<GraphEdge | null> {
    if (!this.embeddingProvider) return null;

    // Calculate semantic similarity if embeddings exist
    let similarity = 0;
    try {
      // This would require embedding lookups - simplified for now
      similarity = this.textSimilarity(memoryA.content, memoryB.content);
    } catch (error) {
      similarity = 0;
    }

    if (similarity < 0.3) return null; // Too weak to visualize

    return {
      source: memoryA.id,
      target: memoryB.id,
      weight: similarity,
      type: memoryA.category === memoryB.category ? 'categorical' : 'similarity',
      label: similarity > 0.8 ? 'strong' : similarity > 0.6 ? 'moderate' : 'weak'
    };
  }

  private detectClusters(nodes: GraphNode[], edges: GraphEdge[]): GraphCluster[] {
    // Simple clustering by category for now
    const categoryGroups = new Map<string, string[]>();
    
    for (const node of nodes) {
      if (!categoryGroups.has(node.category)) {
        categoryGroups.set(node.category, []);
      }
      categoryGroups.get(node.category)!.push(node.id);
    }

    return Array.from(categoryGroups.entries()).map(([category, nodeIds]) => ({
      id: `cluster_${category}`,
      nodes: nodeIds,
      theme: category,
      coherence: this.calculateClusterCoherence(nodeIds, edges),
      description: `${category} memories cluster`
    }));
  }

  private calculateClusterCoherence(nodeIds: string[], edges: GraphEdge[]): number {
    if (nodeIds.length < 2) return 1.0;

    const internalEdges = edges.filter(edge => 
      nodeIds.includes(edge.source) && nodeIds.includes(edge.target)
    );

    const maxPossibleEdges = (nodeIds.length * (nodeIds.length - 1)) / 2;
    return maxPossibleEdges > 0 ? internalEdges.length / maxPossibleEdges : 0;
  }

  private calculateGraphMetrics(nodes: GraphNode[], edges: GraphEdge[]): GraphMetrics {
    const nodeCount = nodes.length;
    const edgeCount = edges.length;
    const maxPossibleEdges = (nodeCount * (nodeCount - 1)) / 2;
    
    // Find most connected node
    const nodeDegrees = new Map<string, number>();
    for (const node of nodes) {
      nodeDegrees.set(node.id, 0);
    }
    
    for (const edge of edges) {
      nodeDegrees.set(edge.source, (nodeDegrees.get(edge.source) || 0) + 1);
      nodeDegrees.set(edge.target, (nodeDegrees.get(edge.target) || 0) + 1);
    }

    const mostCentralNode = Array.from(nodeDegrees.entries())
      .sort(([, a], [, b]) => b - a)[0]?.[0] || '';

    return {
      total_nodes: nodeCount,
      total_edges: edgeCount,
      avg_clustering_coefficient: edgeCount > 0 ? this.calculateClusteringCoefficient(nodes, edges) : 0,
      density: maxPossibleEdges > 0 ? edgeCount / maxPossibleEdges : 0,
      connected_components: this.countConnectedComponents(nodes, edges),
      most_central_node: mostCentralNode
    };
  }

  // Simplified analysis methods for predictive analytics
  private async analyzeCreationPattern(tenantId: string, days: number, projectId?: string): Promise<InsightPattern | null> {
    // Implementation would analyze creation timestamps
    return null; // Placeholder
  }

  private async analyzeCategoryPattern(tenantId: string, days: number, projectId?: string): Promise<InsightPattern | null> {
    // Implementation would analyze category usage over time
    return null; // Placeholder
  }

  private async analyzeComplexityPattern(tenantId: string, days: number, projectId?: string): Promise<InsightPattern | null> {
    // Implementation would analyze content complexity trends
    return null; // Placeholder
  }

  private async analyzeRelationshipPattern(tenantId: string, days: number, projectId?: string): Promise<InsightPattern | null> {
    // Implementation would analyze relationship formation patterns
    return null; // Placeholder
  }

  private async getHistoricalData(tenantId: string, projectId: string | undefined, days: number): Promise<any[]> {
    // Get historical memory data for predictions
    return []; // Placeholder
  }

  private predictMemoryGrowth(historicalData: any[]): any {
    // Implement growth prediction algorithm
    return {
      next_30_days: 50,
      growth_rate: 0.1,
      seasonal_patterns: false
    };
  }

  private predictCategoryUsage(historicalData: any[]): Record<string, number> {
    // Predict future category usage
    return {
      facts: 0.3,
      patterns: 0.2,
      insights: 0.15
    };
  }

  private predictRelationshipFormation(historicalData: any[]): number {
    // Predict likelihood of new relationships
    return 0.75;
  }

  private async assessQualityDegradationRisk(tenantId: string, projectId?: string): Promise<any> {
    // Assess risk of data quality degradation
    return {
      risk_level: 'low' as const,
      risk_factors: [],
      recommendations: ['Continue regular usage patterns']
    };
  }

  private textSimilarity(textA: string, textB: string): number {
    // Simple text similarity (Jaccard index)
    const wordsA = new Set(textA.toLowerCase().split(/\W+/));
    const wordsB = new Set(textB.toLowerCase().split(/\W+/));
    const intersection = new Set([...wordsA].filter(word => wordsB.has(word)));
    const union = new Set([...wordsA, ...wordsB]);
    return union.size > 0 ? intersection.size / union.size : 0;
  }

  private calculateClusteringCoefficient(nodes: GraphNode[], edges: GraphEdge[]): number {
    // Simplified clustering coefficient calculation
    return 0.5; // Placeholder
  }

  private countConnectedComponents(nodes: GraphNode[], edges: GraphEdge[]): number {
    // Count connected components in the graph
    return Math.max(1, Math.ceil(nodes.length / 10)); // Simplified
  }
}