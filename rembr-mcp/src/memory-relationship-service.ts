import { MemoryDatabase } from './database.js';
import { EmbeddingProvider } from './ollama-provider.js';

/**
 * Memory Relationship Inference Service
 * Automatically detects connections between memories using semantic analysis
 * Part of Week 13 Context Intelligence implementation
 */

export interface MemoryRelationship {
  id: string;
  source_memory_id: string;
  target_memory_id: string;
  relationship_type: 'contradicts' | 'supports' | 'refines' | 'relates_to' | 'supersedes';
  confidence: number;
  evidence: string;
  inferred: boolean;
  created_at: Date;
}

export interface RelationshipCandidate {
  source_memory_id: string;
  target_memory_id: string;
  similarity_score: number;
  relationship_type: string;
  confidence: number;
  evidence: string;
}

export class MemoryRelationshipService {
  private database: MemoryDatabase;
  private embeddingProvider: EmbeddingProvider;

  // Thresholds for relationship detection
  private readonly SIMILARITY_THRESHOLD = 0.65; // Semantic similarity threshold (balanced)
  private readonly CONTRADICTION_KEYWORDS = [
    'contradicts', 'conflicts with', 'mutually exclusive', 'opposite of',
    'is wrong', 'is incorrect', 'no longer true'
  ];
  private readonly SUPPORT_KEYWORDS = [
    'also', 'additionally', 'furthermore', 'moreover', 'similarly', 'likewise', 'confirms',
    'validates', 'proves', 'supports', 'agrees', 'consistent', 'aligns', 'reinforces'
  ];
  private readonly REFINEMENT_KEYWORDS = [
    'specifically', 'details', 'clarifies', 'elaborates', 'expands', 'explains', 'breakdown',
    'further', 'more precisely', 'in particular', 'namely', 'i.e.', 'e.g.'
  ];

  constructor(database: MemoryDatabase, embeddingProvider: EmbeddingProvider) {
    this.database = database;
    this.embeddingProvider = embeddingProvider;
  }

  /**
   * Analyze and infer relationships for a specific memory
   */
  async inferRelationshipsForMemory(memoryId: string, tenantId: string, projectId?: string): Promise<RelationshipCandidate[]> {
    // Get the target memory
    const targetMemory = await this.getMemory(memoryId, tenantId);
    if (!targetMemory) {
      throw new Error('Memory not found');
    }

    // Get candidate memories for comparison
    const candidates = await this.getCandidateMemories(memoryId, tenantId, projectId);
    
    const relationships: RelationshipCandidate[] = [];

    // 1. Find tag-based relationships (shared metadata tags)
    const tagRelationships = await this.findTagBasedRelationships(targetMemory, candidates);
    relationships.push(...tagRelationships);

    // 2. Semantic similarity (strict threshold 0.65, top 100 candidates)
    const semanticCandidates = candidates.slice(0, 100);
    for (const candidate of semanticCandidates) {
      const relationship = await this.analyzeRelationship(targetMemory, candidate);
      if (relationship) {
        relationships.push(relationship);
      }
    }

    // Remove duplicates and sort by confidence, limit to 8 per memory
    const uniqueRelationships = this.deduplicateRelationships(relationships);
    return uniqueRelationships
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 8);
  }

  /**
   * Get candidate memories for relationship analysis
   * Returns ALL memories in the tenant (no limits)
   */
  private async getCandidateMemories(excludeId: string, tenantId: string, projectId?: string): Promise<any[]> {
    const query = `
      SELECT m.*, me.embedding::text as embedding_text
      FROM memories m
      LEFT JOIN memory_embeddings me ON m.id = me.memory_id
      WHERE m.tenant_id = $1
      ${projectId ? 'AND m.project_id = $2' : ''}
      AND m.id != $${projectId ? '3' : '2'}
      ORDER BY m.created_at DESC
    `;

    const params = projectId ? [tenantId, projectId, excludeId] : [tenantId, excludeId];
    const result = await this.database.query(query, params, tenantId);
    
    // Parse embeddings from PostgreSQL vector format "[1,2,3]" to JavaScript arrays
    return result.rows.map((row: any) => ({
      ...row,
      embedding: row.embedding_text ? JSON.parse(row.embedding_text) : null
    }));
  }

  /**
   * Analyze the relationship between two memories
   */
  private async analyzeRelationship(memoryA: any, memoryB: any): Promise<RelationshipCandidate | null> {
    // Calculate semantic similarity
    const similarity = await this.calculateSimilarity(memoryA, memoryB);
    
    if (similarity < this.SIMILARITY_THRESHOLD) {
      return null; // Not similar enough to be related
    }

    // Analyze content for relationship type
    const relationshipType = this.detectRelationshipType(memoryA.content, memoryB.content);
    
    // Calculate confidence based on similarity and content analysis
    const confidence = this.calculateRelationshipConfidence(similarity, relationshipType, memoryA, memoryB);
    
    if (confidence < 0.5) {
      return null; // Not confident enough
    }

    // Generate evidence explanation
    const evidence = this.generateEvidence(memoryA.content, memoryB.content, relationshipType, similarity);

    return {
      source_memory_id: memoryA.id,
      target_memory_id: memoryB.id,
      similarity_score: similarity,
      relationship_type: relationshipType,
      confidence,
      evidence
    };
  }

  /**
   * Calculate semantic similarity between two memories
   */
  private async calculateSimilarity(memoryA: any, memoryB: any): Promise<number> {
    // If embeddings exist, use vector similarity
    if (memoryA.embedding && memoryB.embedding) {
      return this.cosineSimilarity(memoryA.embedding, memoryB.embedding);
    }

    // Fallback to text-based similarity
    return this.textSimilarity(memoryA.content, memoryB.content);
  }

  /**
   * Detect the type of relationship between two memory contents
   */
  private detectRelationshipType(contentA: string, contentB: string): string {
    // This service maintains semantic graph relationships. Contradiction rows are
    // produced by AdvancedAnalyticsService, where an LLM can verify same-topic
    // incompatibility. Treat keyword-level opposition as a normal relation here
    // so graph optimization cannot pollute the contradiction review queue.
    
    // Check for support patterns
    if (this.hasSupportPattern(contentA, contentB)) {
      return 'supports';
    }
    
    // Check for refinement patterns
    if (this.hasRefinementPattern(contentA, contentB)) {
      return 'refines';
    }
    
    // Check for superseding (newer information)
    if (this.hasSupersedingPattern(contentA, contentB)) {
      return 'supersedes';
    }
    
    // Default to general relation
    return 'relates_to';
  }

  /**
   * Check for contradiction patterns between two texts
   */
  private hasContradictionPattern(textA: string, textB: string): boolean {
    const lowerA = this.normalizeForContradiction(textA);
    const lowerB = this.normalizeForContradiction(textB);
    const sharedTerms = this.sharedContradictionTerms(lowerA, lowerB);
    const similarity = this.textSimilarity(lowerA, lowerB);

    if (sharedTerms.size < 2 && similarity < 0.35) {
      return false;
    }
    
    // Look for explicit contradiction keywords
    const hasContradictionWords = this.CONTRADICTION_KEYWORDS.some(keyword => 
      lowerA.includes(keyword) || lowerB.includes(keyword)
    );
    
    // Look for opposing values or statements
    const hasOpposingValues = this.detectOpposingValues(lowerA, lowerB);
    
    return hasContradictionWords || hasOpposingValues;
  }

  /**
   * Detect opposing values like "true/false", "enabled/disabled", etc.
   */
  private detectOpposingValues(textA: string, textB: string): boolean {
    const opposingPairs = [
      ['true', 'false'],
      ['enabled', 'disabled'],
      ['yes', 'no'],
      ['should', 'should not'],
      ['will', 'will not'],
      ['can', 'can not'],
      ['recommended', 'not recommended'],
      ['supported', 'unsupported'],
      ['available', 'unavailable']
    ];
    
    return opposingPairs.some(([positive, negative]) => {
      const positiveWord = new RegExp(`\\b${positive.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      const negativeWord = new RegExp(`\\b${negative.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      return (positiveWord.test(textA) && negativeWord.test(textB)) ||
        (negativeWord.test(textA) && positiveWord.test(textB));
    }) || !!this.detectPredicateNegation(textA, textB) || !!this.detectPredicateNegation(textB, textA);
  }

  private normalizeForContradiction(text: string): string {
    return text
      .toLowerCase()
      .replace(/cannot/g, 'can not')
      .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private sharedContradictionTerms(textA: string, textB: string): Set<string> {
    const stopWords = new Set([
      'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'onto', 'was', 'were',
      'will', 'would', 'should', 'could', 'can', 'not', 'are', 'is', 'been', 'being',
      'have', 'has', 'had', 'yes', 'no', 'true', 'false', 'valid', 'invalid', 'correct',
      'incorrect', 'enabled', 'disabled', 'available', 'unavailable', 'recommended',
      'supported', 'unsupported'
    ]);

    const wordsA = new Set(textA.split(/\s+/).filter(word => word.length > 3 && !stopWords.has(word)));
    const wordsB = new Set(textB.split(/\s+/).filter(word => word.length > 3 && !stopWords.has(word)));
    return new Set([...wordsA].filter(word => wordsB.has(word)));
  }

  private detectPredicateNegation(positiveText: string, negatedText: string): string | null {
    const patterns = [
      /\b(is|are|was|were|can|should|will)\s+not\s+([a-z0-9-]+(?:\s+[a-z0-9-]+){0,2})\b/g,
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

  /**
   * Check for support patterns
   */
  private hasSupportPattern(textA: string, textB: string): boolean {
    const combined = `${textA} ${textB}`.toLowerCase();
    return this.SUPPORT_KEYWORDS.some(keyword => combined.includes(keyword));
  }

  /**
   * Check for refinement patterns
   */
  private hasRefinementPattern(textA: string, textB: string): boolean {
    const combined = `${textA} ${textB}`.toLowerCase();
    return this.REFINEMENT_KEYWORDS.some(keyword => combined.includes(keyword));
  }

  /**
   * Check for superseding patterns (newer replacing older)
   */
  private hasSupersedingPattern(textA: string, textB: string): boolean {
    const combined = `${textA} ${textB}`.toLowerCase();
    const supersedingKeywords = [
      'updated', 'replaced', 'new version', 'latest', 'current', 'now', 'changed to'
    ];
    return supersedingKeywords.some(keyword => combined.includes(keyword));
  }

  /**
   * Calculate relationship confidence
   */
  private calculateRelationshipConfidence(
    similarity: number, 
    relationshipType: string, 
    memoryA: any, 
    memoryB: any
  ): number {
    let confidence = similarity; // Start with similarity score
    
    // Boost confidence for explicit relationship indicators
    if (relationshipType !== 'relates_to') {
      confidence += 0.1;
    }
    
    // Same category memories are more likely to be related
    if (memoryA.category === memoryB.category) {
      confidence += 0.05;
    }
    
    // Recent memories are more likely to be relevant
    const daysDiff = Math.abs(
      new Date(memoryA.created_at).getTime() - new Date(memoryB.created_at).getTime()
    ) / (1000 * 60 * 60 * 24);
    
    if (daysDiff < 7) {
      confidence += 0.1;
    } else if (daysDiff < 30) {
      confidence += 0.05;
    }
    
    return Math.min(confidence, 1.0);
  }

  /**
   * Generate evidence explanation for the relationship
   */
  private generateEvidence(
    contentA: string, 
    contentB: string, 
    relationshipType: string, 
    similarity: number
  ): string {
    const similarityPercent = Math.round(similarity * 100);
    
    const typeExplanations = {
      supports: 'Contains supporting information or confirms details',
      refines: 'Provides additional detail or clarification',
      supersedes: 'Contains updated or newer information',
      relates_to: 'Shares similar topics or concepts'
    };
    
    const explanation = typeExplanations[relationshipType as keyof typeof typeExplanations] || 'Related content';
    
    return `${explanation}. Semantic similarity: ${similarityPercent}%`;
  }

  /**
   * Store inferred relationships in the database
   */
  async storeRelationships(relationships: RelationshipCandidate[], tenantId: string): Promise<void> {
    for (const rel of relationships) {
      // Check if relationship exists in either direction (bidirectional check)
      const existingCheck = await this.database.query(
        `SELECT id FROM memory_relationships 
         WHERE ((source_memory_id = $1 AND target_memory_id = $2) OR (source_memory_id = $2 AND target_memory_id = $1))
           AND relationship_type = $3`,
        [rel.source_memory_id, rel.target_memory_id, rel.relationship_type],
        tenantId
      );
      
      if (existingCheck.rows.length === 0) {
        const query = `
          INSERT INTO memory_relationships (
            id, source_memory_id, target_memory_id, relationship_type, 
            confidence, evidence, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
        `;
        
        try {
          await this.database.query(query, [
            this.generateUUID(),
            rel.source_memory_id,
            rel.target_memory_id,
            rel.relationship_type,
            rel.confidence,
            rel.evidence
          ], tenantId);
          console.log(`💾 Stored new ${rel.relationship_type} relationship: ${rel.source_memory_id} -> ${rel.target_memory_id}`);
        } catch (error) {
          console.error('Error storing relationship:', error);
        }
      } else {
        console.log(`⏭️  Skipping duplicate ${rel.relationship_type}: ${rel.source_memory_id} <-> ${rel.target_memory_id}`);
      }
    }
  }

  /**
   * Idempotent backfill: infer relationships for orphaned memories.
   *
   * An orphaned memory has zero entries in memory_relationships (neither as
   * source nor target). This method processes them in creation-order batches
   * using a cursor so the operation is resumable.
   *
   * Idempotency guarantees:
   *   - Queries only memories with NO relationships → already-processed memories
   *     are silently skipped on re-run (once they gain a relationship they leave
   *     the orphan set).
   *   - storeRelationships() checks for existing relationships before inserting.
   *
   * REM-270
   */
  async backfillRelationships(
    tenantId: string,
    options: {
      batchSize?: number;
      minConfidence?: number;
      cursor?: string;  // ISO timestamp — process memories created after this
      dryRun?: boolean; // If true, infer but do not write to DB
    } = {}
  ): Promise<{
    processed: number;
    added: number;
    skipped_no_embedding: number;
    next_cursor: string | null;
    done: boolean;
  }> {
    const batchSize = Math.min(options.batchSize ?? 20, 100);
    const minConfidence = options.minConfidence ?? 0.65;
    const dryRun = options.dryRun ?? false;
    const cursor = options.cursor ?? '1970-01-01T00:00:00Z';

    // Find orphaned memories: no entry in memory_relationships as source or target.
    // Require an embedding so inference can run.
    // Process in ascending created_at order for a stable, resumable cursor.
    const orphanQuery = `
      SELECT m.id, m.created_at
      FROM memories m
      WHERE m.tenant_id = $1
        AND m.created_at > $2
        AND EXISTS (
          SELECT 1 FROM memory_embeddings me WHERE me.memory_id = m.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM memory_relationships mr
          WHERE mr.source_memory_id = m.id OR mr.target_memory_id = m.id
        )
      ORDER BY m.created_at ASC
      LIMIT $3
    `;

    const orphanResult = await this.database.query(orphanQuery, [
      tenantId,
      cursor,
      batchSize,
    ], tenantId);

    const orphans = orphanResult.rows;

    let processed = 0;
    let added = 0;
    let skipped_no_embedding = 0;

    for (const orphan of orphans) {
      try {
        const candidates = await this.inferRelationshipsForMemory(
          orphan.id,
          tenantId
        );

        const qualifying = candidates.filter(c => c.confidence >= minConfidence);

        if (!dryRun && qualifying.length > 0) {
          await this.storeRelationships(qualifying, tenantId);
          added += qualifying.length;
        } else if (dryRun && qualifying.length > 0) {
          added += qualifying.length; // count what would be written
        }

        processed++;
      } catch (error) {
        // Log per-memory errors but continue the batch
        if ((error as Error).message?.includes('embedding')) {
          skipped_no_embedding++;
        } else {
          console.error(`[Backfill] Error processing memory ${orphan.id}:`, error);
        }
        processed++;
      }
    }

    const done = orphans.length < batchSize;
    const next_cursor = done || orphans.length === 0
      ? null
      : orphans[orphans.length - 1].created_at.toISOString();

    return { processed, added, skipped_no_embedding, next_cursor, done };
  }

  /**
   * Helper methods
   */
  private async getMemory(id: string, tenantId: string): Promise<any> {
    const query = `
      SELECT m.*, me.embedding::text as embedding_text
      FROM memories m
      LEFT JOIN memory_embeddings me ON m.id = me.memory_id
      WHERE m.id = $1 AND m.tenant_id = $2
    `;
    const result = await this.database.query(query, [id, tenantId], tenantId);
    const row = result.rows[0];
    
    // Parse embedding from PostgreSQL vector format to JavaScript array
    if (row && row.embedding_text) {
      row.embedding = JSON.parse(row.embedding_text);
    }
    
    return row;
  }

  private cosineSimilarity(vectorA: number[], vectorB: number[]): number {
    if (!vectorA || !vectorB || vectorA.length !== vectorB.length) {
      return 0;
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    
    for (let i = 0; i < vectorA.length; i++) {
      dotProduct += vectorA[i] * vectorB[i];
      normA += vectorA[i] * vectorA[i];
      normB += vectorB[i] * vectorB[i];
    }
    
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  private textSimilarity(textA: string, textB: string): number {
    // Simple text similarity based on common words
    const wordsA = textA.toLowerCase().split(/\W+/).filter(w => w.length > 3);
    const wordsB = textB.toLowerCase().split(/\W+/).filter(w => w.length > 3);
    
    const setA = new Set(wordsA);
    const setB = new Set(wordsB);
    
    const intersection = new Set([...setA].filter(word => setB.has(word)));
    const union = new Set([...setA, ...setB]);
    
    return intersection.size / union.size;
  }

  private generateUUID(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  /**
   * Find relationships based on shared tags from metadata
   * Matches memories that have common tags in their metadata
   */
  private async findTagBasedRelationships(targetMemory: any, candidates: any[]): Promise<RelationshipCandidate[]> {
    const relationships: RelationshipCandidate[] = [];
    
    // Extract tags from target memory metadata
    const targetTags = this.extractTags(targetMemory.metadata);
    if (targetTags.length === 0) {
      return relationships; // No tags, no tag-based relationships
    }

    for (const candidate of candidates) {
      if (candidate.id === targetMemory.id) continue;

      const candidateTags = this.extractTags(candidate.metadata);
      if (candidateTags.length === 0) continue;

      // Find shared tags
      const sharedTags = targetTags.filter(tag => candidateTags.includes(tag));
      
      if (sharedTags.length > 0) {
        // Confidence based on proportion of shared tags
        const tagSimilarity = sharedTags.length / Math.max(targetTags.length, candidateTags.length);
        const confidence = 0.7 + (tagSimilarity * 0.25); // 0.7-0.95 range
        
        relationships.push({
          source_memory_id: targetMemory.id,
          target_memory_id: candidate.id,
          similarity_score: tagSimilarity,
          relationship_type: 'relates_to',
          confidence: Math.min(confidence, 0.95),
          evidence: `tags:${sharedTags.slice(0, 3).join(',')}`
        });
      }
    }

    return relationships;
  }

  /**
   * Extract tags from metadata object
   * Looks for common tag field names: tags, tag, labels, label, topics, topic
   */
  private extractTags(metadata: any): string[] {
    if (!metadata || typeof metadata !== 'object') {
      return [];
    }

    const tags: string[] = [];
    const tagFields = ['tags', 'tag', 'labels', 'label', 'topics', 'topic', 'keywords', 'keyword'];

    for (const field of tagFields) {
      const value = metadata[field];
      if (Array.isArray(value)) {
        tags.push(...value.filter(t => typeof t === 'string').map(t => t.toLowerCase()));
      } else if (typeof value === 'string') {
        // Split comma-separated tags
        tags.push(...value.split(',').map(t => t.trim().toLowerCase()).filter(t => t.length > 0));
      }
    }

    // Remove duplicates
    return [...new Set(tags)];
  }

  /**
   * Extract concepts from text (same as UI tags.ts)
   */
  private extractConcepts(text: string): string[] {
    const stopWords = new Set([
      'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
      'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been',
      'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
      'should', 'may', 'might', 'can', 'this', 'that', 'these', 'those', 'i',
      'you', 'he', 'she', 'it', 'we', 'they', 'what', 'which', 'who', 'when',
      'where', 'why', 'how', 'all', 'each', 'every', 'both', 'few', 'more',
      'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own',
      'same', 'so', 'than', 'too', 'very', 'just', 'am', 'about', 'after',
      'also', 'any', 'because', 'before', 'being', 'between', 'both', 'during',
      'into', 'through', 'until', 'up', 'down', 'out', 'over', 'under', 'again',
      'then', 'once', 'here', 'there', 'all', 'your', 'my', 'their', 'his', 'her'
    ]);

    const words = text.toLowerCase().match(/\b[\w-]+\b/g) || [];
    
    const concepts = words.filter(word => 
      word.length > 2 && 
      !stopWords.has(word) &&
      !/^\d+$/.test(word)
    );

    return [...new Set(concepts)];
  }

  /**
   * Jaccard similarity between concept sets (same as UI tags.ts)
   */
  private jaccardSimilarity(concepts1: string[], concepts2: string[]): number {
    const set1 = new Set(concepts1);
    const set2 = new Set(concepts2);
    
    const intersection = new Set([...set1].filter(x => set2.has(x)));
    const union = new Set([...set1, ...set2]);
    
    return union.size > 0 ? intersection.size / union.size : 0;
  }

  /**
   * Find shared keys in metadata objects
   */
  private findSharedMetadataKeys(metadataA: any, metadataB: any): string[] {
    const keysA = Object.keys(metadataA || {});
    const keysB = Object.keys(metadataB || {});
    
    const shared: string[] = [];
    for (const key of keysA) {
      if (keysB.includes(key) && metadataA[key] === metadataB[key]) {
        shared.push(key);
      }
    }
    
    return shared;
  }

  /**
   * Remove duplicate relationships (bidirectional deduplication)
   * A->B and B->A are treated as the same relationship
   */
  private deduplicateRelationships(relationships: RelationshipCandidate[]): RelationshipCandidate[] {
    const seen = new Set<string>();
    const unique: RelationshipCandidate[] = [];

    for (const rel of relationships) {
      const key = `${rel.source_memory_id}-${rel.target_memory_id}`;
      const reverseKey = `${rel.target_memory_id}-${rel.source_memory_id}`;
      
      if (!seen.has(key) && !seen.has(reverseKey)) {
        seen.add(key);
        unique.push(rel);
      }
    }

    return unique;
  }
}
