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
}

export class CompilationService {
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
      memoryIds.map(id => this.db.getMemoryById(id, tenant_id, authContext.project_id))
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
            [m1.id, m2.id, 'contradicts', contradiction.confidence, contradiction.evidence]
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
              [m1.id, m2.id, 'relates_to', similarity]
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
              [m1.id, m2.id, 'refines', containsKeyTerms]
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
    

    // Get all memories in context
    const memories = await this.db.getContextMemories(contextId, tenant_id);

    const memoryIds = memories.map(m => m.id);

    // Get relationships between these memories
    const relationshipsResult = await this.db.query(
      `SELECT * FROM memory_relationships
       WHERE source_memory_id = ANY($1::uuid[])
         AND target_memory_id = ANY($1::uuid[])`,
      [memoryIds]
    );

    // Get tags
    const tagsResult = await this.db.query(
      `SELECT * FROM memory_tags
       WHERE memory_id = ANY($1::uuid[])`,
      [memoryIds]
    );

    // Group tags by memory
    const tagsByMemory: Record<string, MemoryTag[]> = {};
    for (const tag of tagsResult.rows) {
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
      relationships: relationshipsResult.rows,
      tags: tagsByMemory
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
    const memories = await this.db.getContextMemories(contextId, tenant_id);
    const memoryIds = memories.map(m => m.id);

    // Get contradiction relationships
    const result = await this.db.query(
      `SELECT * FROM memory_relationships
       WHERE relationship_type = 'contradicts'
         AND source_memory_id = ANY($1::uuid[])
       ORDER BY confidence DESC`,
      [memoryIds]
    );

    return result.rows;
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

    // Get context memories
    const memories = await this.db.getContextMemories(contextId, tenant_id);

    // Insight 1: Category distribution
    const categoryDist = this.getCategoryDistribution(memories);
    if (Object.keys(categoryDist).length > 0) {
      const result = await this.db.query(
        `INSERT INTO compiled_insights (
          id, context_id, insight_type, content, metadata, confidence, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
        RETURNING *`,
        [
          randomUUID(),
          contextId,
          'category_distribution',
          `This context contains ${memories.length} memories across ${Object.keys(categoryDist).length} categories`,
          JSON.stringify(categoryDist),
          1.0
        ]
      );
      insights.push(result.rows[0]);
    }

    // Insight 2: Temporal patterns
    const temporalPattern = this.getTemporalPattern(memories);
    if (temporalPattern) {
      const result = await this.db.query(
        `INSERT INTO compiled_insights (
          id, context_id, insight_type, content, metadata, confidence, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
        RETURNING *`,
        [
          randomUUID(),
          contextId,
          'temporal_pattern',
          temporalPattern.description,
          JSON.stringify(temporalPattern.data),
          temporalPattern.confidence
        ]
      );
      insights.push(result.rows[0]);
    }

    // Insight 3: Key entities (simple extraction)
    const entities = this.extractEntities(memories);
    if (entities.length > 0) {
      const result = await this.db.query(
        `INSERT INTO compiled_insights (
          id, context_id, insight_type, content, metadata, confidence, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
        RETURNING *`,
        [
          randomUUID(),
          contextId,
          'key_entities',
          `Identified ${entities.length} key entities`,
          JSON.stringify({ entities }),
          0.7
        ]
      );
      insights.push(result.rows[0]);
    }

    // Phase 4 Enhancement: Graph-based insights
    
    // Insight 4: Relationship statistics
    const relationshipStats = await this.getRelationshipStatistics(memories, tenant_id);
    if (relationshipStats.totalRelationships > 0) {
      const result = await this.db.query(
        `INSERT INTO compiled_insights (
          id, context_id, insight_type, content, metadata, confidence, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
        RETURNING *`,
        [
          randomUUID(),
          contextId,
          'relationship_statistics',
          `Found ${relationshipStats.totalRelationships} relationships with ${relationshipStats.avgConfidence.toFixed(2)} avg confidence`,
          JSON.stringify(relationshipStats),
          0.9
        ]
      );
      insights.push(result.rows[0]);
    }

    // Insight 5: Most connected memories (knowledge hubs)
    const knowledgeHubs = await this.getKnowledgeHubs(memories, tenant_id);
    if (knowledgeHubs.length > 0) {
      const result = await this.db.query(
        `INSERT INTO compiled_insights (
          id, context_id, insight_type, content, metadata, confidence, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
        RETURNING *`,
        [
          randomUUID(),
          contextId,
          'knowledge_hubs',
          `Identified ${knowledgeHubs.length} highly connected memories acting as knowledge hubs`,
          JSON.stringify({ hubs: knowledgeHubs }),
          0.8
        ]
      );
      insights.push(result.rows[0]);
    }

    // Insight 6: Relationship type distribution
    const relationshipTypes = await this.getRelationshipTypeDistribution(memories, tenant_id);
    if (Object.keys(relationshipTypes).length > 0) {
      const mostCommonType = Object.entries(relationshipTypes)
        .sort(([,a], [,b]) => b - a)[0]?.[0] || 'none';
        
      const result = await this.db.query(
        `INSERT INTO compiled_insights (
          id, context_id, insight_type, content, metadata, confidence, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
        RETURNING *`,
        [
          randomUUID(),
          contextId,
          'relationship_types',
          `Most common relationship type: ${mostCommonType}. Graph shows ${Object.keys(relationshipTypes).length} relationship types`,
          JSON.stringify(relationshipTypes),
          0.8
        ]
      );
      insights.push(result.rows[0]);
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

    const result = await this.db.query(
      `SELECT ci.* FROM compiled_insights ci
       INNER JOIN contexts c ON ci.context_id = c.id
       INNER JOIN projects p ON c.project_id = p.id
       WHERE ci.context_id = $1 AND p.tenant_id = $2
       ORDER BY ci.created_at DESC`,
      [contextId, tenant_id]
    );

    return result.rows;
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
    

    const createdTags: MemoryTag[] = [];

    for (const { tag, tagType, confidence } of tags) {
      const result = await this.db.query(
        `INSERT INTO memory_tags (memory_id, tag, tag_type, confidence)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [memoryId, tag, tagType || null, confidence || 1.0]
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
    const negationPairs = [
      ['yes', 'no'],
      ['true', 'false'],
      ['correct', 'incorrect'],
      ['valid', 'invalid'],
      ['is', 'is not'],
      ['was', 'was not'],
      ['will', 'will not'],
      ['can', 'cannot'],
    ];

    const t1Lower = text1.toLowerCase();
    const t2Lower = text2.toLowerCase();

    for (const [pos, neg] of negationPairs) {
      if (
        (t1Lower.includes(pos) && t2Lower.includes(neg)) ||
        (t1Lower.includes(neg) && t2Lower.includes(pos))
      ) {
        return {
          isContradiction: true,
          confidence: 0.7,
          evidence: `Contains opposing terms: "${pos}" vs "${neg}"`
        };
      }
    }

    return { isContradiction: false, confidence: 0, evidence: null };
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
      WHERE (mr.source_memory_id = ANY($1) OR mr.target_memory_id = ANY($1))
        AND m1.tenant_id = $2 AND m2.tenant_id = $2
      GROUP BY relationship_type
    `, [memoryIds, tenantId]);

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
        m.content,
        COUNT(mr.id) as connection_count,
        ARRAY_AGG(DISTINCT mr.relationship_type) as relationship_types
      FROM memories m
      LEFT JOIN memory_relationships mr ON (
        (mr.source_memory_id = m.id OR mr.target_memory_id = m.id)
        AND mr.confidence > 0.7
      )
      WHERE m.id = ANY($1) AND m.tenant_id = $2
      GROUP BY m.id, m.content
      HAVING COUNT(mr.id) >= 3  -- Must have at least 3 relationships to be a hub
      ORDER BY connection_count DESC
      LIMIT 5
    `, [memoryIds, tenantId]);

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
      WHERE (mr.source_memory_id = ANY($1) OR mr.target_memory_id = ANY($1))
        AND m1.tenant_id = $2 AND m2.tenant_id = $2
        AND mr.confidence > 0.6
      GROUP BY relationship_type
      ORDER BY count DESC
    `, [memoryIds, tenantId]);

    const distribution: Record<string, number> = {};
    for (const row of result.rows) {
      distribution[row.relationship_type] = parseInt(row.count);
    }

    return distribution;
  }
}
