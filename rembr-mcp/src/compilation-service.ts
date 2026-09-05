/**
 * Phase 3: Context Compilation
 * 
 * Pre-compiled intelligence layer: relationship extraction, contradiction detection,
 * insight generation. This is the "moat" feature that goes beyond simple vector search.
 */

import { randomUUID } from 'crypto';
import { MemoryDatabase, AuthContext } from './database.js';

export interface MemoryRelationship {
  id: string;
  source_memory_id: string;
  target_memory_id: string;
  relationship_type: string;
  confidence: number;
  evidence: string | null;
  created_at: Date;
}

export interface CompiledInsight {
  id: string;
  context_id: string | null;
  insight_type: string;
  content: string;
  metadata: Record<string, any>;
  confidence: number;
  created_at: Date;
}

export interface MemoryTag {
  id: string;
  memory_id: string;
  tag: string;
  tag_type: string | null;
  confidence: number;
}

export interface MemoryGraph {
  memories: {
    id: string;
    content: string;
    category: string | null;
  }[];
  relationships: MemoryRelationship[];
  tags: Record<string, MemoryTag[]>; // memory_id -> tags
  truncated: boolean;
  returned_count: number;
  total_count: number;
  continuation?: string;
}

export class CompilationService {
  private static readonly GRAPH_MAX_NODES = 100;
  private static readonly GRAPH_MAX_EDGES = 500;
  private static readonly GRAPH_MAX_TAGS = 1_000;
  private static readonly GRAPH_CONTENT_CHARS = 2_048;
  private static readonly GRAPH_EVIDENCE_CHARS = 2_048;

  constructor(private db: MemoryDatabase) {}

  /**
   * Extract relationships between memories
   * 
   * Relationship types:
   * - contradicts: Memories that conflict
   * - supports: Memories that reinforce each other
   * - refines: One memory adds detail to another
   * - supersedes: Newer information replaces older
   * - relates_to: General semantic relationship
   */
  async extractRelationships(
    memoryIds: string[],
    authContext: AuthContext
  ): Promise<MemoryRelationship[]> {
    const { tenant_id } = authContext;
    

    const relationships: MemoryRelationship[] = [];

    // Fetch all memories
    const memories = await Promise.all(
      memoryIds.map(id => this.db.getMemoryById(id, tenant_id, authContext.project_id, authContext.user_id))
    );

    // Simple heuristic-based relationship extraction
    for (let i = 0; i < memories.length; i++) {
      for (let j = i + 1; j < memories.length; j++) {
        const m1 = memories[i];
        const m2 = memories[j];
        
        if (!m1 || !m2) continue;

        // Check for contradictions (simple keyword detection)
        const contradiction = this.detectContradiction(m1.content, m2.content);
        if (contradiction.isContradiction) {
          const result = await this.db.query(
            `INSERT INTO memory_relationships (
              source_memory_id, target_memory_id, relationship_type, confidence, evidence
            ) VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT DO NOTHING
            RETURNING *`,
            [m1.id, m2.id, 'contradicts', contradiction.confidence, contradiction.evidence],
            tenant_id,
          );
          if (result.rows.length > 0) {
            relationships.push(result.rows[0]);
          }
        }

        // Check for support (same category, similar content)
        if (m1.category === m2.category) {
          const similarity = this.calculateTextSimilarity(m1.content, m2.content);
          if (similarity > 0.5 && similarity < 0.9) {
            const result = await this.db.query(
              `INSERT INTO memory_relationships (
                source_memory_id, target_memory_id, relationship_type, confidence
              ) VALUES ($1, $2, $3, $4)
              ON CONFLICT DO NOTHING
              RETURNING *`,
              [m1.id, m2.id, 'relates_to', similarity],
              tenant_id,
            );
            if (result.rows.length > 0) {
              relationships.push(result.rows[0]);
            }
          }
        }

        // Check for refinement (one is longer and contains the other's key terms)
        if (m1.content.length > m2.content.length * 1.5) {
          const containsKeyTerms = this.containsKeyTerms(m1.content, m2.content);
          if (containsKeyTerms > 0.6) {
            const result = await this.db.query(
              `INSERT INTO memory_relationships (
                source_memory_id, target_memory_id, relationship_type, confidence
              ) VALUES ($1, $2, $3, $4)
              ON CONFLICT DO NOTHING
              RETURNING *`,
              [m1.id, m2.id, 'refines', containsKeyTerms],
              tenant_id,
            );
            if (result.rows.length > 0) {
              relationships.push(result.rows[0]);
            }
          }
        }
      }
    }

    return relationships;
  }

  /**
   * Get memory relationship graph for a context
   */
  async getMemoryGraph(
    contextId: string,
    authContext: AuthContext
  ): Promise<MemoryGraph> {
    const { tenant_id } = authContext;
    

    const fetchedMemories = await this.db.getContextMemories(
      contextId,
      tenant_id,
      authContext.project_id,
      authContext.user_id,
      CompilationService.GRAPH_MAX_NODES,
      CompilationService.GRAPH_CONTENT_CHARS,
      false,
    );
    const memories = fetchedMemories.slice(0, CompilationService.GRAPH_MAX_NODES).map(memory => ({
      ...memory,
      content: String(memory.content || '').slice(0, CompilationService.GRAPH_CONTENT_CHARS),
      metadata: {},
    }));
    const totalCount = Number(fetchedMemories[0]?.total_count || memories.length);

    const memoryIds = memories.map(m => m.id);

    // Get relationships between these memories
    const relationshipsResult = await this.db.query(
      `SELECT id, source_memory_id, target_memory_id, relationship_type,
              confidence, LEFT(evidence, $3::integer) AS evidence, created_at
       FROM memory_relationships
       WHERE source_memory_id = ANY($1::uuid[])
         AND target_memory_id = ANY($1::uuid[])
       ORDER BY confidence DESC, id
       LIMIT $2::integer`,
      [
        memoryIds,
        CompilationService.GRAPH_MAX_EDGES,
        CompilationService.GRAPH_EVIDENCE_CHARS,
      ],
      tenant_id,
    );

    // Get tags
    const tagsResult = await this.db.query(
      `SELECT id, memory_id, tag, tag_type, confidence
       FROM (
         SELECT mt.*,
                ROW_NUMBER() OVER (
                  PARTITION BY mt.memory_id ORDER BY mt.confidence DESC, mt.id
                ) AS tag_rank
         FROM memory_tags mt
         WHERE mt.memory_id = ANY($1::uuid[])
       ) ranked
       WHERE tag_rank <= 10
       ORDER BY memory_id, tag_rank
       LIMIT $2::integer`,
      [memoryIds, CompilationService.GRAPH_MAX_TAGS],
      tenant_id,
    );

    // Group tags by memory
    const tagsByMemory: Record<string, MemoryTag[]> = {};
    for (const tag of tagsResult.rows.slice(0, CompilationService.GRAPH_MAX_TAGS)) {
      if (!tagsByMemory[tag.memory_id]) {
        tagsByMemory[tag.memory_id] = [];
      }
      tagsByMemory[tag.memory_id].push(tag);
    }

    return {
      memories: memories.map(m => ({
        id: m.id,
        content: m.content,
        category: m.category
      })),
      relationships: relationshipsResult.rows.slice(0, CompilationService.GRAPH_MAX_EDGES),
      tags: tagsByMemory,
      truncated: totalCount > memories.length,
      returned_count: memories.length,
      total_count: totalCount,
      continuation: totalCount > memories.length
        ? 'Narrow the context or page its memories before requesting another graph segment.'
        : undefined,
    };
  }

  /**
   * Detect contradictions in a context
   */
  async detectContradictions(
    contextId: string,
    authContext: AuthContext
  ): Promise<MemoryRelationship[]> {
    const { tenant_id } = authContext;
    

    // Get all memories in context
    const memories = await this.db.getContextMemories(
      contextId,
      tenant_id,
      authContext.project_id,
      authContext.user_id,
      100,
      16_000,
      false,
    );
    const memoryIds = memories.map(m => m.id);

    // Get contradiction relationships
    const result = await this.db.query(
      `SELECT * FROM memory_relationships
       WHERE relationship_type = 'contradicts'
         AND source_memory_id = ANY($1::uuid[])
         AND target_memory_id = ANY($1::uuid[])
       ORDER BY confidence DESC, id
       LIMIT $2::integer`,
      [memoryIds, CompilationService.GRAPH_MAX_EDGES],
      tenant_id,
    );

    return result.rows.slice(0, CompilationService.GRAPH_MAX_EDGES);
  }

  /**
   * Generate insights for a context
   */
  async generateInsights(
    contextId: string,
    authContext: AuthContext
  ): Promise<CompiledInsight[]> {
    const { tenant_id } = authContext;
    

    const insights: CompiledInsight[] = [];
    const addInsight = (
      insightType: string,
      content: string,
      metadata: Record<string, any>,
      confidence: number,
    ) => {
      insights.push({
        id: randomUUID(),
        context_id: contextId,
        insight_type: insightType,
        content,
        metadata,
        confidence,
        created_at: new Date(),
      });
    };

    // Get context memories
    const memories = await this.db.getContextMemories(
      contextId,
      tenant_id,
      authContext.project_id,
      authContext.user_id,
      100,
      16_000,
      false,
    );

    // Insight 1: Category distribution
    const categoryDist = this.getCategoryDistribution(memories);
    if (Object.keys(categoryDist).length > 0) {
      addInsight(
        'category_distribution',
        `This context contains ${memories.length} memories across ${Object.keys(categoryDist).length} categories`,
        categoryDist,
        1.0,
      );
    }

    // Insight 2: Temporal patterns
    const temporalPattern = this.getTemporalPattern(memories);
    if (temporalPattern) {
      addInsight(
        'temporal_pattern',
        temporalPattern.description,
        temporalPattern.data,
        temporalPattern.confidence,
      );
    }

    // Insight 3: Key entities (simple extraction)
    const entities = this.extractEntities(memories);
    if (entities.length > 0) {
      addInsight(
        'key_entities',
        `Identified ${entities.length} key entities`,
        { entities },
        0.7,
      );
    }

    // Phase 4 Enhancement: Graph-based insights
    
    // Insight 4: Relationship statistics
    const relationshipStats = await this.getRelationshipStatistics(memories, tenant_id);
    if (relationshipStats.totalRelationships > 0) {
      addInsight(
        'relationship_statistics',
        `Found ${relationshipStats.totalRelationships} relationships with ${relationshipStats.avgConfidence.toFixed(2)} avg confidence`,
        relationshipStats,
        0.9,
      );
    }

    // Insight 5: Most connected memories (knowledge hubs)
    const knowledgeHubs = await this.getKnowledgeHubs(memories, tenant_id);
    if (knowledgeHubs.length > 0) {
      addInsight(
        'knowledge_hubs',
        `Identified ${knowledgeHubs.length} highly connected memories acting as knowledge hubs`,
        { hubs: knowledgeHubs },
        0.8,
      );
    }

    // Insight 6: Relationship type distribution
    const relationshipTypes = await this.getRelationshipTypeDistribution(memories, tenant_id);
    if (Object.keys(relationshipTypes).length > 0) {
      const mostCommonType = Object.entries(relationshipTypes)
        .sort(([,a], [,b]) => b - a)[0]?.[0] || 'none';
        
      addInsight(
        'relationship_types',
        `Most common relationship type: ${mostCommonType}. Graph shows ${Object.keys(relationshipTypes).length} relationship types`,
        relationshipTypes,
        0.8,
      );
    }

    return insights;
  }

  /**
   * Get insights for a context
   */
  async getContextInsights(
    contextId: string,
    authContext: AuthContext
  ): Promise<CompiledInsight[]> {
    const { tenant_id } = authContext;
    
    // Handle undefined/null contextId - return empty array instead of querying
    if (!contextId) {
      return [];
    }

    // Legacy cached insights have no audience column and may have been derived
    // from another user's personal memories. Validate context access, then
    // force a caller-scoped recomputation in the handler.
    await this.db.getContextMemories(
      contextId,
      tenant_id,
      authContext.project_id,
      authContext.user_id,
      1,
      1,
      false,
    );
    return [];
  }

  /**
   * Add tags to a memory
   */
  async tagMemory(
    memoryId: string,
    tags: Array<{ tag: string; tagType?: string; confidence?: number }>,
    authContext: AuthContext
  ): Promise<MemoryTag[]> {
    const { tenant_id } = authContext;
    const memory = await this.db.getMemoryById(
      memoryId,
      tenant_id,
      authContext.project_id,
      authContext.user_id,
    );
    if (!memory) {
      throw new Error('Memory not found or access denied');
    }

    const createdTags: MemoryTag[] = [];

    for (const { tag, tagType, confidence } of tags) {
      const result = await this.db.query(
        `INSERT INTO memory_tags (memory_id, tag, tag_type, confidence)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [memoryId, tag, tagType || null, confidence || 1.0],
        tenant_id,
      );
      createdTags.push(result.rows[0]);
    }

    return createdTags;
  }

  // Private helper methods

  private detectContradiction(text1: string, text2: string): {
    isContradiction: boolean;
    confidence: number;
    evidence: string | null;
  } {
    const t1Lower = this.normalizeForContradiction(text1);
    const t2Lower = this.normalizeForContradiction(text2);
    const sharedTerms = this.sharedContradictionTerms(t1Lower, t2Lower);

    if (sharedTerms.size < 2 && this.calculateTextSimilarity(t1Lower, t2Lower) < 0.35) {
      return { isContradiction: false, confidence: 0, evidence: null };
    }

    const valuePairs = [
      ['yes', 'no'],
      ['true', 'false'],
      ['correct', 'incorrect'],
      ['valid', 'invalid'],
      ['enabled', 'disabled'],
      ['available', 'unavailable'],
      ['allowed', 'forbidden'],
      ['supported', 'unsupported'],
    ];

    for (const [pos, neg] of valuePairs) {
      if (
        (this.hasWord(t1Lower, pos) && this.hasWord(t2Lower, neg)) ||
        (this.hasWord(t1Lower, neg) && this.hasWord(t2Lower, pos))
      ) {
        return {
          isContradiction: true,
          confidence: Math.min(0.85, 0.65 + sharedTerms.size * 0.05),
          evidence: `Shared subject with opposing values: "${pos}" vs "${neg}"`
        };
      }
    }

    const negation = this.detectPredicateNegation(t1Lower, t2Lower) ||
      this.detectPredicateNegation(t2Lower, t1Lower);

    if (negation) {
      return {
        isContradiction: true,
        confidence: Math.min(0.9, 0.7 + sharedTerms.size * 0.04),
        evidence: `Shared subject with negated predicate: "${negation}"`
      };
    }

    return { isContradiction: false, confidence: 0, evidence: null };
  }

  private normalizeForContradiction(text: string): string {
    return text
      .toLowerCase()
      .replace(/cannot/g, 'can not')
      .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private hasWord(text: string, word: string): boolean {
    return new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text);
  }

  private sharedContradictionTerms(text1: string, text2: string): Set<string> {
    const stopWords = new Set([
      'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'onto', 'was', 'were',
      'will', 'would', 'should', 'could', 'can', 'not', 'are', 'is', 'been', 'being',
      'have', 'has', 'had', 'yes', 'no', 'true', 'false', 'valid', 'invalid', 'correct',
      'incorrect', 'enabled', 'disabled', 'available', 'unavailable', 'allowed', 'forbidden',
      'supported', 'unsupported'
    ]);

    const words = (text: string) => new Set(
      text.split(/\s+/).filter(word => word.length > 3 && !stopWords.has(word))
    );

    const words1 = words(text1);
    const words2 = words(text2);
    return new Set([...words1].filter(word => words2.has(word)));
  }

  private detectPredicateNegation(positiveText: string, negatedText: string): string | null {
    const patterns = [
      /\b(is|are|was|were|can|should|will)\s+not\s+([a-z0-9-]+(?:\s+[a-z0-9-]+){0,2})\b/g,
      /\b(can)\s+not\s+([a-z0-9-]+(?:\s+[a-z0-9-]+){0,2})\b/g,
      /\b(no longer)\s+([a-z0-9-]+(?:\s+[a-z0-9-]+){0,2})\b/g
    ];

    for (const pattern of patterns) {
      for (const match of negatedText.matchAll(pattern)) {
        const predicate = match[2].trim();
        const positivePhrase = match[1] === 'no longer'
          ? predicate
          : `${match[1]} ${predicate}`;

        if (predicate.length > 2 && positiveText.includes(positivePhrase)) {
          return predicate;
        }
      }
    }

    return null;
  }

  private calculateTextSimilarity(text1: string, text2: string): number {
    const words1 = new Set(text1.toLowerCase().split(/\s+/));
    const words2 = new Set(text2.toLowerCase().split(/\s+/));

    const intersection = new Set([...words1].filter(w => words2.has(w)));
    const union = new Set([...words1, ...words2]);

    return intersection.size / union.size;
  }

  private containsKeyTerms(longerText: string, shorterText: string): number {
    const keyWords = shorterText.toLowerCase().split(/\s+/).filter(w => w.length > 4);
    const longerLower = longerText.toLowerCase();

    const matchCount = keyWords.filter(word => longerLower.includes(word)).length;
    return keyWords.length > 0 ? matchCount / keyWords.length : 0;
  }

  private getCategoryDistribution(memories: any[]): Record<string, number> {
    const dist: Record<string, number> = {};
    for (const memory of memories) {
      const cat = memory.category || 'uncategorized';
      dist[cat] = (dist[cat] || 0) + 1;
    }
    return dist;
  }

  private getTemporalPattern(memories: any[]): {
    description: string;
    data: any;
    confidence: number;
  } | null {
    if (memories.length < 2) return null;

    const sorted = memories.sort((a, b) =>
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );

    const first = new Date(sorted[0].created_at);
    const last = new Date(sorted[sorted.length - 1].created_at);
    const spanDays = (last.getTime() - first.getTime()) / (1000 * 60 * 60 * 24);

    const rate = memories.length / Math.max(spanDays, 1);

    let description = '';
    if (spanDays < 1) {
      description = `All memories created within 1 day`;
    } else if (spanDays < 7) {
      description = `Memories span ${Math.round(spanDays)} days with ${rate.toFixed(1)} memories/day`;
    } else {
      description = `Memories span ${Math.round(spanDays)} days`;
    }

    return {
      description,
      data: { spanDays, rate, count: memories.length },
      confidence: 0.8
    };
  }

  private extractEntities(memories: any[]): string[] {
    const entities = new Set<string>();

    // Simple capitalized word extraction
    const allText = memories.map(m => m.content).join(' ');
    const capitalizedWords = allText.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g) || [];

    for (const word of capitalizedWords) {
      if (word.length > 3) {
        entities.add(word);
      }
    }

    return Array.from(entities).slice(0, 20); // Top 20
  }
  
  // Phase 4 Enhancement: Graph-based insight methods
  
  /**
   * Get relationship statistics for memories in a context
   */
  private async getRelationshipStatistics(memories: any[], tenantId: string): Promise<{
    totalRelationships: number;
    avgConfidence: number;
    relationshipsByType: Record<string, number>;
  }> {
    if (memories.length === 0) {
      return { totalRelationships: 0, avgConfidence: 0, relationshipsByType: {} };
    }

    const memoryIds = memories.map(m => m.id);
    
    const result = await this.db.query(`
      SELECT 
        relationship_type,
        COUNT(*) as count,
        AVG(confidence) as avg_confidence
      FROM memory_relationships mr
      JOIN memories m1 ON m1.id = mr.source_memory_id
      JOIN memories m2 ON m2.id = mr.target_memory_id
      WHERE mr.source_memory_id = ANY($1)
        AND mr.target_memory_id = ANY($1)
        AND m1.tenant_id = $2 AND m2.tenant_id = $2
      GROUP BY relationship_type
      ORDER BY count DESC
      LIMIT 100
    `, [memoryIds, tenantId], tenantId);

    const relationshipsByType: Record<string, number> = {};
    let totalRelationships = 0;
    let totalConfidence = 0;

    for (const row of result.rows) {
      relationshipsByType[row.relationship_type] = parseInt(row.count);
      totalRelationships += parseInt(row.count);
      totalConfidence += parseFloat(row.avg_confidence) * parseInt(row.count);
    }

    const avgConfidence = totalRelationships > 0 ? totalConfidence / totalRelationships : 0;

    return {
      totalRelationships,
      avgConfidence,
      relationshipsByType
    };
  }

  /**
   * Find memories that act as knowledge hubs (highly connected)
   */
  private async getKnowledgeHubs(memories: any[], tenantId: string): Promise<Array<{
    memoryId: string;
    content: string;
    connectionCount: number;
    relationshipTypes: string[];
  }>> {
    if (memories.length === 0) return [];

    const memoryIds = memories.map(m => m.id);
    
    const result = await this.db.query(`
      SELECT 
        m.id,
        LEFT(m.content, $3::integer) AS content,
        COUNT(mr.id) as connection_count,
        ARRAY_AGG(DISTINCT mr.relationship_type) as relationship_types
      FROM memories m
      LEFT JOIN memory_relationships mr ON (
        (mr.source_memory_id = m.id OR mr.target_memory_id = m.id)
        AND mr.source_memory_id = ANY($1)
        AND mr.target_memory_id = ANY($1)
        AND mr.confidence > 0.7
      )
      WHERE m.id = ANY($1) AND m.tenant_id = $2
      GROUP BY m.id
      HAVING COUNT(mr.id) >= 3  -- Must have at least 3 relationships to be a hub
      ORDER BY connection_count DESC
      LIMIT 5
    `, [memoryIds, tenantId, CompilationService.GRAPH_CONTENT_CHARS], tenantId);

    return result.rows.map((row: any) => ({
      memoryId: row.id,
      content: row.content.substring(0, 100) + '...',
      connectionCount: parseInt(row.connection_count),
      relationshipTypes: row.relationship_types.filter(Boolean)
    }));
  }

  /**
   * Get distribution of relationship types
   */
  private async getRelationshipTypeDistribution(memories: any[], tenantId: string): Promise<Record<string, number>> {
    if (memories.length === 0) return {};

    const memoryIds = memories.map(m => m.id);
    
    const result = await this.db.query(`
      SELECT 
        relationship_type,
        COUNT(*) as count
      FROM memory_relationships mr
      JOIN memories m1 ON m1.id = mr.source_memory_id
      JOIN memories m2 ON m2.id = mr.target_memory_id
      WHERE mr.source_memory_id = ANY($1)
        AND mr.target_memory_id = ANY($1)
        AND m1.tenant_id = $2 AND m2.tenant_id = $2
        AND mr.confidence > 0.6
      GROUP BY relationship_type
      ORDER BY count DESC
      LIMIT 100
    `, [memoryIds, tenantId], tenantId);

    const distribution: Record<string, number> = {};
    for (const row of result.rows) {
      distribution[row.relationship_type] = parseInt(row.count);
    }

    return distribution;
  }
}
