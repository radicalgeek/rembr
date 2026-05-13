import { EmbeddingProvider } from './ollama-provider.js';
import { MemoryDatabase } from './database.js';

/**
 * Contextual Embeddings Service
 * Creates domain-specific embedding spaces for improved semantic search
 * Part of Week 13 Context Intelligence implementation
 */

export interface EmbeddingSpace {
  id: string;
  name: string;
  description: string;
  domain: string;
  model_config: any;
  created_at: Date;
}

export interface ContextualEmbedding {
  memory_id: string;
  embedding_space_id: string;
  embedding: number[];
  context_weights: Record<string, number>;
  domain_features: Record<string, any>;
  created_at: Date;
}

export interface DomainContext {
  domain: string;
  keywords: string[];
  semantic_weights: Record<string, number>;
  context_enhancers: string[];
}

export class ContextualEmbeddingService {
  private database: MemoryDatabase;
  private embeddingProvider: EmbeddingProvider;

  // Predefined domain contexts for RLM optimization
  private readonly DOMAIN_CONTEXTS: Record<string, DomainContext> = {
    'software_engineering': {
      domain: 'software_engineering',
      keywords: ['api', 'database', 'frontend', 'backend', 'architecture', 'deployment', 'testing', 'security'],
      semantic_weights: {
        'technical_terms': 1.5,
        'code_patterns': 1.3,
        'architectural_concepts': 1.4,
        'best_practices': 1.2
      },
      context_enhancers: ['implementation details', 'performance considerations', 'scalability factors']
    },
    'data_science': {
      domain: 'data_science',
      keywords: ['model', 'dataset', 'analysis', 'visualization', 'machine learning', 'statistics', 'pipeline'],
      semantic_weights: {
        'analytical_methods': 1.4,
        'data_patterns': 1.3,
        'model_performance': 1.5,
        'statistical_concepts': 1.3
      },
      context_enhancers: ['data quality', 'feature engineering', 'model validation']
    },
    'business_operations': {
      domain: 'business_operations',
      keywords: ['process', 'workflow', 'decision', 'strategy', 'optimization', 'efficiency', 'cost'],
      semantic_weights: {
        'business_logic': 1.4,
        'operational_metrics': 1.3,
        'strategic_considerations': 1.5,
        'process_optimization': 1.2
      },
      context_enhancers: ['business impact', 'stakeholder considerations', 'operational efficiency']
    },
    'research_development': {
      domain: 'research_development',
      keywords: ['experiment', 'hypothesis', 'research', 'innovation', 'prototype', 'investigation', 'discovery'],
      semantic_weights: {
        'research_methods': 1.5,
        'experimental_design': 1.4,
        'innovation_patterns': 1.3,
        'knowledge_synthesis': 1.3
      },
      context_enhancers: ['research methodology', 'experimental results', 'innovation potential']
    }
  };

  constructor(database: MemoryDatabase, embeddingProvider: EmbeddingProvider) {
    this.database = database;
    this.embeddingProvider = embeddingProvider;
  }

  /**
   * Create a contextual embedding with domain-specific optimization
   */
  async createContextualEmbedding(
    memoryId: string,
    content: string,
    category: string,
    metadata: Record<string, any>,
    tenantId: string
  ): Promise<ContextualEmbedding> {
    // Detect domain from content and metadata
    const domain = this.detectDomain(content, category, metadata);
    
    // Get or create embedding space for this domain
    const embeddingSpace = await this.getOrCreateEmbeddingSpace(domain, tenantId);
    
    // Enhance content with contextual information
    const enhancedContent = this.enhanceContentForDomain(content, domain, category);
    
    // Generate embedding with domain-specific weights
    const embedding = await this.generateContextualEmbedding(enhancedContent, domain);
    
    // Calculate context weights
    const contextWeights = this.calculateContextWeights(content, domain, category);
    
    // Extract domain-specific features
    const domainFeatures = this.extractDomainFeatures(content, domain);
    
    const contextualEmbedding: ContextualEmbedding = {
      memory_id: memoryId,
      embedding_space_id: embeddingSpace.id,
      embedding,
      context_weights: contextWeights,
      domain_features: domainFeatures,
      created_at: new Date()
    };

    // Store the contextual embedding
    await this.storeContextualEmbedding(contextualEmbedding);
    
    return contextualEmbedding;
  }

  /**
   * Detect the domain of content based on keywords and patterns
   */
  private detectDomain(content: string, category: string, metadata: Record<string, any>): string {
    const lowerContent = content.toLowerCase();
    
    // Check explicit domain hints in metadata
    if (metadata.domain) {
      return metadata.domain;
    }
    
    // Score content against domain contexts
    const domainScores = new Map<string, number>();
    
    for (const [domainKey, domainContext] of Object.entries(this.DOMAIN_CONTEXTS)) {
      let score = 0;
      
      // Keyword matching
      for (const keyword of domainContext.keywords) {
        if (lowerContent.includes(keyword.toLowerCase())) {
          score += 1;
        }
      }
      
      // Category-based hints
      if (category === 'patterns' && domainKey === 'software_engineering') score += 2;
      if (category === 'insights' && domainKey === 'data_science') score += 2;
      if (category === 'workflows' && domainKey === 'business_operations') score += 2;
      if (category === 'learning' && domainKey === 'research_development') score += 2;
      
      domainScores.set(domainKey, score);
    }
    
    // Return the highest scoring domain, default to software_engineering
    const topDomain = Array.from(domainScores.entries())
      .sort(([, a], [, b]) => b - a)[0];
      
    return topDomain?.[1] > 0 ? topDomain[0] : 'software_engineering';
  }

  /**
   * Get or create an embedding space for a specific domain
   */
  private async getOrCreateEmbeddingSpace(domain: string, tenantId: string): Promise<EmbeddingSpace> {
    // Check if embedding space already exists
    const existingQuery = `
      SELECT * FROM embedding_spaces 
      WHERE domain = $1 AND tenant_id = $2
      LIMIT 1
    `;
    
    try {
      const existing = await this.database.query(existingQuery, [domain, tenantId]);
      if (existing.rows.length > 0) {
        return existing.rows[0];
      }
    } catch (error) {
      // Table might not exist yet - create it
    }

    // Create new embedding space
    const domainContext = this.DOMAIN_CONTEXTS[domain] || this.DOMAIN_CONTEXTS['software_engineering'];
    
    const embeddingSpace: EmbeddingSpace = {
      id: this.generateUUID(),
      name: `${domain}_space`,
      description: `Contextual embedding space for ${domain} domain`,
      domain,
      model_config: {
        base_model: 'nomic-embed-text',
        domain_weights: domainContext.semantic_weights,
        context_enhancers: domainContext.context_enhancers
      },
      created_at: new Date()
    };

    await this.createEmbeddingSpaceTable();
    await this.storeEmbeddingSpace(embeddingSpace, tenantId);
    
    return embeddingSpace;
  }

  /**
   * Enhance content with domain-specific context
   */
  private enhanceContentForDomain(content: string, domain: string, category: string): string {
    const domainContext = this.DOMAIN_CONTEXTS[domain];
    if (!domainContext) {
      return content;
    }

    // Add domain-specific context enhancers
    const enhancers = domainContext.context_enhancers.join(', ');
    const categoryContext = this.getCategoryContext(category);
    
    return `${content}\n\nDomain: ${domain}\nCategory: ${categoryContext}\nContext: ${enhancers}`;
  }

  /**
   * Get category-specific context description
   */
  private getCategoryContext(category: string): string {
    const contextMap = {
      'facts': 'factual information and documentation',
      'patterns': 'reusable patterns and architectural designs',
      'decisions': 'technical decisions and trade-off analysis',
      'workflows': 'processes and procedural knowledge',
      'insights': 'analytical findings and optimizations',
      'projects': 'project-level information and status',
      'conversations': 'discussion context and meeting notes',
      'learning': 'knowledge acquisition and discoveries',
      'preferences': 'user preferences and configuration',
      'context': 'situational and environmental context',
      'goals': 'objectives and target outcomes',
      'reminders': 'future actions and follow-ups'
    };
    
    return (contextMap as any)[category] || category;
  }

  /**
   * Generate contextual embedding with domain weights
   */
  private async generateContextualEmbedding(enhancedContent: string, domain: string): Promise<number[]> {
    // Generate base embedding
    const baseEmbedding = await this.embeddingProvider.generateEmbedding(enhancedContent);
    
    // Apply domain-specific transformations
    const domainContext = this.DOMAIN_CONTEXTS[domain];
    if (!domainContext) {
      return baseEmbedding;
    }
    
    // For now, return the base embedding
    // In future iterations, this could apply learned domain transformations
    return baseEmbedding;
  }

  /**
   * Calculate context weights for different aspects of the content
   */
  private calculateContextWeights(content: string, domain: string, category: string): Record<string, number> {
    const domainContext = this.DOMAIN_CONTEXTS[domain];
    const weights: Record<string, number> = {};
    
    // Apply domain-specific semantic weights
    if (domainContext) {
      Object.assign(weights, domainContext.semantic_weights);
    }
    
    // Add category-specific weights
    weights.category_relevance = this.calculateCategoryRelevance(content, category);
    weights.content_length = Math.min(content.length / 1000, 2.0); // Length-based weight
    weights.keyword_density = this.calculateKeywordDensity(content, domain);
    
    return weights;
  }

  /**
   * Calculate how relevant the content is to its category
   */
  private calculateCategoryRelevance(content: string, category: string): number {
    // Simple relevance calculation based on category-specific keywords
    const categoryKeywords = {
      'facts': ['documentation', 'specification', 'definition', 'reference'],
      'patterns': ['pattern', 'template', 'example', 'approach', 'design'],
      'decisions': ['decision', 'choice', 'trade-off', 'because', 'rationale'],
      'workflows': ['step', 'process', 'procedure', 'workflow', 'sequence'],
      'insights': ['analysis', 'finding', 'discovery', 'insight', 'conclusion']
    };
    
    const keywords = categoryKeywords[category as keyof typeof categoryKeywords] || [];
    const lowerContent = content.toLowerCase();
    
    const matchCount = keywords.filter(keyword => lowerContent.includes(keyword)).length;
    return Math.min(matchCount / keywords.length, 1.0);
  }

  /**
   * Calculate domain-specific keyword density
   */
  private calculateKeywordDensity(content: string, domain: string): number {
    const domainContext = this.DOMAIN_CONTEXTS[domain];
    if (!domainContext) return 0.5;
    
    const lowerContent = content.toLowerCase();
    const matchCount = domainContext.keywords.filter(keyword => 
      lowerContent.includes(keyword.toLowerCase())
    ).length;
    
    return Math.min(matchCount / domainContext.keywords.length, 1.0);
  }

  /**
   * Extract domain-specific features from content
   */
  private extractDomainFeatures(content: string, domain: string): Record<string, any> {
    const features: Record<string, any> = {
      domain,
      content_type: this.detectContentType(content),
      complexity_score: this.calculateComplexityScore(content),
      technical_depth: this.calculateTechnicalDepth(content)
    };
    
    // Add domain-specific feature extraction
    switch (domain) {
      case 'software_engineering':
        features.code_references = this.extractCodeReferences(content);
        features.architecture_level = this.detectArchitectureLevel(content);
        break;
      case 'data_science':
        features.data_references = this.extractDataReferences(content);
        features.methodology_type = this.detectMethodologyType(content);
        break;
      case 'business_operations':
        features.process_indicators = this.extractProcessIndicators(content);
        features.stakeholder_mentions = this.extractStakeholderMentions(content);
        break;
    }
    
    return features;
  }

  /**
   * Helper methods for feature extraction
   */
  private detectContentType(content: string): string {
    if (/```|`/.test(content)) return 'code';
    if (/\d+\.\s|\*\s|-\s/.test(content)) return 'list';
    if (/\?/.test(content)) return 'question';
    if (/steps?|process|workflow/.test(content.toLowerCase())) return 'procedure';
    return 'text';
  }

  private calculateComplexityScore(content: string): number {
    const factors = [
      content.length / 100, // Length factor
      (content.match(/[{}()[\]]/g) || []).length / 10, // Structure complexity
      (content.match(/\b(?:if|when|because|however|therefore)\b/gi) || []).length / 5 // Logic complexity
    ];
    
    return Math.min(factors.reduce((a, b) => a + b, 0) / factors.length, 10);
  }

  private calculateTechnicalDepth(content: string): number {
    const technicalIndicators = [
      /\b(?:api|database|server|client|framework|library|algorithm|architecture)\b/gi,
      /\b(?:implementation|configuration|deployment|optimization|performance)\b/gi,
      /\b(?:security|authentication|authorization|encryption|protocol)\b/gi
    ];
    
    const matches = technicalIndicators.reduce((total, pattern) => 
      total + (content.match(pattern) || []).length, 0
    );
    
    return Math.min(matches / 3, 5);
  }

  private extractCodeReferences(content: string): string[] {
    const codePattern = /```[\s\S]*?```|`[^`]+`/g;
    return (content.match(codePattern) || []).map(match => match.replace(/```|`/g, '').trim());
  }

  private detectArchitectureLevel(content: string): string {
    if (/system|infrastructure|deployment/.test(content.toLowerCase())) return 'system';
    if (/service|api|microservice/.test(content.toLowerCase())) return 'service';
    if (/component|module|class/.test(content.toLowerCase())) return 'component';
    return 'code';
  }

  private extractDataReferences(content: string): string[] {
    const dataPattern = /\b(?:dataset|csv|json|database|table|column|row|record)\b/gi;
    return (content.match(dataPattern) || []).map(match => match.toLowerCase());
  }

  private detectMethodologyType(content: string): string {
    if (/machine learning|ml|model|algorithm/.test(content.toLowerCase())) return 'ml';
    if (/analysis|analytics|statistics|statistical/.test(content.toLowerCase())) return 'analytics';
    if (/visualization|chart|graph|plot/.test(content.toLowerCase())) return 'visualization';
    return 'general';
  }

  private extractProcessIndicators(content: string): string[] {
    const processPattern = /\b(?:step|phase|stage|workflow|procedure|process)\b/gi;
    return (content.match(processPattern) || []).map(match => match.toLowerCase());
  }

  private extractStakeholderMentions(content: string): string[] {
    const stakeholderPattern = /\b(?:team|manager|client|customer|user|stakeholder|department)\b/gi;
    return (content.match(stakeholderPattern) || []).map(match => match.toLowerCase());
  }

  /**
   * Database operations
   */
  private async createEmbeddingSpaceTable(): Promise<void> {
    const query = `
      CREATE TABLE IF NOT EXISTS embedding_spaces (
        id UUID PRIMARY KEY,
        tenant_id UUID NOT NULL,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        domain VARCHAR(100) NOT NULL,
        model_config JSONB NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    
    try {
      await this.database.query(query);
    } catch (error) {
      console.log('Embedding spaces table creation skipped:', (error as Error).message);
    }
  }

  private async storeEmbeddingSpace(space: EmbeddingSpace, tenantId: string): Promise<void> {
    const query = `
      INSERT INTO embedding_spaces (id, tenant_id, name, description, domain, model_config, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (id) DO NOTHING
    `;
    
    await this.database.query(query, [
      space.id,
      tenantId,
      space.name,
      space.description,
      space.domain,
      JSON.stringify(space.model_config),
      space.created_at
    ]);
  }

  private async storeContextualEmbedding(embedding: ContextualEmbedding): Promise<void> {
    // Store in enhanced memory_embeddings table or separate table
    // For now, this would require database schema updates
    console.log('Contextual embedding created:', {
      memory_id: embedding.memory_id,
      space: embedding.embedding_space_id,
      features: Object.keys(embedding.domain_features).length
    });
  }

  private generateUUID(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }
}