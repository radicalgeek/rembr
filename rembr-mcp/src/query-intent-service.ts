import { MemoryDatabase } from './database.js';

/**
 * Query Intent Classification Service
 * Analyzes query patterns to route searches to appropriate memory categories
 * Part of Week 13 Context Intelligence implementation
 */

export interface QueryIntent {
  primary_category: string;
  confidence: number;
  suggested_categories: string[];
  intent_type: 'search' | 'store' | 'analyze';
  reasoning: string;
}

export interface QueryContext {
  query: string;
  user_context?: Record<string, any>;
  recent_categories?: string[];
  project_domain?: string;
}

export class QueryIntentService {
  private database: MemoryDatabase;

  // Intent patterns for different memory categories
  private readonly INTENT_PATTERNS = {
    facts: {
      keywords: ['what', 'how', 'when', 'where', 'documentation', 'spec', 'api', 'reference'],
      patterns: [/what (?:is|are)/i, /how (?:does|to|do)/i, /documentation for/i, /api for/i]
    },
    patterns: {
      keywords: ['pattern', 'architecture', 'design', 'template', 'example', 'best practice', 'approach'],
      patterns: [/pattern for/i, /architecture of/i, /design pattern/i, /best practice/i, /how to implement/i]
    },
    decisions: {
      keywords: ['decision', 'choice', 'trade-off', 'comparison', 'versus', 'pros', 'cons', 'why'],
      patterns: [/why (?:did|do|use)/i, /decision (?:to|about)/i, /trade-off/i, /versus/i, /vs\./i]
    },
    workflows: {
      keywords: ['process', 'steps', 'procedure', 'workflow', 'deploy', 'build', 'setup', 'install'],
      patterns: [/steps (?:to|for)/i, /process for/i, /how to deploy/i, /build process/i, /setup/i]
    },
    insights: {
      keywords: ['performance', 'optimization', 'analysis', 'metrics', 'finding', 'insight', 'discovered'],
      patterns: [/performance (?:of|analysis)/i, /optimization/i, /discovered that/i, /finding/i, /insight/i]
    },
    projects: {
      keywords: ['project', 'feature', 'milestone', 'release', 'version', 'roadmap'],
      patterns: [/project (?:status|update)/i, /feature (?:for|in)/i, /milestone/i, /release/i]
    },
    conversations: {
      keywords: ['discussed', 'mentioned', 'talked', 'conversation', 'meeting', 'said'],
      patterns: [/(?:we|they|someone) (?:discussed|mentioned|said)/i, /in (?:the|our) meeting/i, /conversation about/i]
    },
    learning: {
      keywords: ['learned', 'discovered', 'found', 'realized', 'understand', 'knowledge'],
      patterns: [/learned (?:that|how)/i, /discovered/i, /found out/i, /realized/i, /now understand/i]
    }
  };

  constructor(database: MemoryDatabase) {
    this.database = database;
  }

  /**
   * Classify the intent of a query and suggest appropriate categories
   */
  async classifyIntent(context: QueryContext): Promise<QueryIntent> {
    const { query, recent_categories = [], project_domain } = context;
    
    // Score each category based on keyword and pattern matching
    const categoryScores = new Map<string, number>();
    
    for (const [category, config] of Object.entries(this.INTENT_PATTERNS)) {
      let score = 0;
      
      // Keyword matching (case insensitive)
      const lowerQuery = query.toLowerCase();
      for (const keyword of config.keywords) {
        if (lowerQuery.includes(keyword.toLowerCase())) {
          score += 1;
        }
      }
      
      // Pattern matching
      for (const pattern of config.patterns) {
        if (pattern.test(query)) {
          score += 2; // Patterns are more specific, weight higher
        }
      }
      
      // Boost recently used categories
      if (recent_categories.includes(category)) {
        score += 0.5;
      }
      
      categoryScores.set(category, score);
    }
    
    // Find the highest scoring category
    let topCategory = 'facts'; // Default fallback
    let maxScore = 0;
    
    for (const [category, score] of categoryScores.entries()) {
      if (score > maxScore) {
        maxScore = score;
        topCategory = category;
      }
    }
    
    // Generate confidence based on score and query characteristics
    const confidence = Math.min(maxScore / 3, 1.0); // Normalize to 0-1
    
    // Get top 3 suggested categories
    const sortedCategories = Array.from(categoryScores.entries())
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .filter(([, score]) => score > 0)
      .map(([category]) => category);
    
    // Determine intent type
    const intentType = this.determineIntentType(query);
    
    // Generate reasoning
    const reasoning = this.generateReasoning(query, topCategory, maxScore, intentType);
    
    return {
      primary_category: topCategory,
      confidence,
      suggested_categories: sortedCategories,
      intent_type: intentType,
      reasoning
    };
  }

  /**
   * Determine if the query is for searching, storing, or analyzing
   */
  private determineIntentType(query: string): 'search' | 'store' | 'analyze' {
    const lowerQuery = query.toLowerCase();
    
    // Store intent keywords
    if (/(remember|store|save|record|note|document) /i.test(query)) {
      return 'store';
    }
    
    // Analyze intent keywords  
    if (/(analyze|compare|summarize|review|insights?) /i.test(query)) {
      return 'analyze';
    }
    
    // Default to search
    return 'search';
  }

  /**
   * Generate human-readable reasoning for the classification
   */
  private generateReasoning(query: string, category: string, score: number, intentType: string): string {
    if (score === 0) {
      return `No specific intent patterns detected. Defaulting to '${category}' category.`;
    }
    
    const intentMap = {
      search: 'searching for information',
      store: 'storing new information', 
      analyze: 'analyzing existing information'
    };
    
    const categoryDescriptions = {
      facts: 'factual information or documentation',
      patterns: 'code patterns or architectural designs',
      decisions: 'technical decisions or trade-offs',
      workflows: 'processes or procedures',
      insights: 'performance analysis or optimizations',
      projects: 'project-related information',
      conversations: 'discussion or meeting content',
      learning: 'knowledge or discoveries'
    };
    
    return `Query appears to be ${(intentMap as any)[intentType]} about ${(categoryDescriptions as any)[category] || category}. Confidence based on keyword and pattern matching.`;
  }

  /**
   * Get memory distribution statistics to help with intent classification
   */
  async getMemoryDistribution(tenantId: string, projectId?: string): Promise<Record<string, number>> {
    const query = `
      SELECT category, COUNT(*) as count
      FROM memories 
      WHERE tenant_id = $1 
      ${projectId ? 'AND project_id = $2' : ''}
      AND category IS NOT NULL
      GROUP BY category
      ORDER BY count DESC
    `;
    
    const params = projectId ? [tenantId, projectId] : [tenantId];
    const result = await this.database.query(query, params);
    
    const distribution: Record<string, number> = {};
    for (const row of result.rows) {
      distribution[row.category] = parseInt(row.count);
    }
    
    return distribution;
  }

  /**
   * Update intent classification based on user feedback
   */
  async updateIntentFeedback(
    query: string, 
    predictedCategory: string, 
    actualCategory: string, 
    tenantId: string
  ): Promise<void> {
    // Store feedback for future model improvements
    // This could be expanded to use machine learning in the future
    
    const feedbackQuery = `
      INSERT INTO query_intent_feedback (
        tenant_id, query, predicted_category, actual_category, created_at
      ) VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT DO NOTHING
    `;
    
    try {
      await this.database.query(feedbackQuery, [tenantId, query, predictedCategory, actualCategory]);
    } catch (error) {
      // Table may not exist yet - this is for future enhancement
      console.log('Intent feedback storage not available yet:', (error as Error).message);
    }
  }
}