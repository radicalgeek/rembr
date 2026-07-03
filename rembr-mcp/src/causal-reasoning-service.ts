/**
 * Causal Reasoning Service
 * 
 * Tracks and infers cause-effect relationships between memories for RLM debugging.
 * Enables "why" questions and counterfactual analysis.
 */

import { Pool, PoolClient } from 'pg';
import { OllamaClient } from './ollama-client.js';

export interface CausalLink {
  id: string;
  cause_memory_id: string;
  effect_memory_id: string;
  causal_type: 'enables' | 'causes' | 'prevents' | 'requires' | 'invalidates';
  causal_strength: number;
  confidence_score: number;
  inferred_by: 'user' | 'llm' | 'system' | 'agent';
  inference_model?: string;
  validated_by_user: boolean;
  metadata?: any;
  created_at: Date;
}

export interface CausalChain {
  root: string;
  direction: 'causes' | 'caused_by';
  links: Array<{
    from: string;
    to: string;
    type: string;
    strength: number;
    depth: number;
    content?: string;
  }>;
  depth: number;
  total_links: number;
}

export interface MemoryPair {
  cause_id: string;
  effect_id: string;
  cause_content: string;
  effect_content: string;
  distance: number;
}

export class CausalReasoningService {
  constructor(
    private db: Pool,
    private ollama: OllamaClient
  ) {}

  private async withTenantContext<T>(
    tenantId: string,
    projectId: string | undefined,
    fn: (client: PoolClient) => Promise<T>
  ): Promise<T> {
    const client = await this.db.connect();

    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('app.current_tenant', $1, true),
                set_config('app.current_project', $2, true)`,
        [tenantId, projectId || '']
      );

      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Infer potential causal relationship between two memories using LLM
   */
  async inferCausality(
    tenantId: string,
    causeMemoryId: string,
    effectMemoryId: string,
    projectId?: string
  ): Promise<CausalLink | null> {
    // 1. Fetch both memories
    const memoriesQuery = `
      SELECT id, content, created_at, category 
      FROM memories 
      WHERE id = ANY($1::uuid[]) 
        AND tenant_id = $2
        AND ($3::uuid IS NULL OR project_id = $3)
    `;
    
    const result = await this.withTenantContext(tenantId, projectId, (client) =>
      client.query(memoriesQuery, [
        [causeMemoryId, effectMemoryId],
        tenantId,
        projectId
      ])
    );

    if (result.rows.length !== 2) {
      return null;
    }

    const [cause, effect] = result.rows.sort((a, b) => 
      a.id === causeMemoryId ? -1 : 1
    );

    // 2. Check temporal ordering (cause must precede effect)
    if (new Date(cause.created_at) > new Date(effect.created_at)) {
      console.log('Causality violation: cause is after effect');
      return null;
    }

    // 3. Check if relationship already exists
    const existingQuery = `
      SELECT id FROM causal_relationships
      WHERE cause_memory_id = $1 
        AND effect_memory_id = $2
        AND tenant_id = $3
        AND (valid_until IS NULL OR valid_until > NOW())
    `;
    
    const existing = await this.db.query(existingQuery, [causeMemoryId, effectMemoryId, tenantId]);
    if (existing.rows.length > 0) {
      console.log('Causal relationship already exists');
      return existing.rows[0];
    }

    // 4. Ask LLM to assess causal relationship
    const prompt = `Analyze if there is a causal relationship between these two statements:

STATEMENT A (potential cause, occurred first): ${cause.content}
STATEMENT B (potential effect, occurred after): ${effect.content}

Determine:
1. Is there a causal relationship? (yes/no)
2. If yes, what type? Choose ONE:
   - "enables": A makes B possible
   - "causes": A directly produces B
   - "prevents": A blocks B from happening
   - "requires": B cannot exist without A
   - "invalidates": A makes B obsolete/incorrect
3. How strong is the causal link? (0.0 to 1.0, where 1.0 is certain causation)
4. Brief explanation (1 sentence)

Respond ONLY with valid JSON (no markdown):
{
  "has_causality": boolean,
  "causal_type": "enables" | "causes" | "prevents" | "requires" | "invalidates" | null,
  "strength": number,
  "explanation": string
}`;

    try {
      const response = await this.ollama.generateText(prompt, 'You are a causal reasoning expert. Analyze relationships between statements and respond ONLY with valid JSON.');
      
      // Clean up response (remove markdown code blocks if present)
      const cleanResponse = response.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const analysis = JSON.parse(cleanResponse);

      if (!analysis.has_causality || analysis.strength < 0.60) {
        const explicitFallback = this.detectExplicitCausalMarkers(cause.content, effect.content);
        if (!explicitFallback) {
          console.log('No significant causal relationship detected');
          return null;
        }

        Object.assign(analysis, explicitFallback);
      }

      // 5. Store causal relationship
      const insertQuery = `
        INSERT INTO causal_relationships 
        (tenant_id, project_id, cause_memory_id, effect_memory_id, causal_type, causal_strength, 
         inferred_by, inference_model, inference_prompt, confidence_score, metadata)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING *
      `;

      const insertResult = await this.db.query(insertQuery, [
        tenantId,
        projectId,
        causeMemoryId,
        effectMemoryId,
        analysis.causal_type,
        analysis.strength,
        'llm',
        'llama3.1:8b',
        prompt,
        analysis.strength,
        JSON.stringify({ 
          explanation: analysis.explanation,
          cause_category: cause.category,
          effect_category: effect.category
        })
      ]);

      console.log(`Created causal link: ${analysis.causal_type} (strength: ${analysis.strength})`);
      return insertResult.rows[0];
    } catch (error) {
      console.error('Error inferring causality:', error);
      const explicitFallback = this.detectExplicitCausalMarkers(cause.content, effect.content);
      if (explicitFallback) {
        const insertQuery = `
          INSERT INTO causal_relationships
          (tenant_id, project_id, cause_memory_id, effect_memory_id, causal_type, causal_strength,
           inferred_by, inference_model, inference_prompt, confidence_score, metadata)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          RETURNING *
        `;

        const insertResult = await this.db.query(insertQuery, [
          tenantId,
          projectId,
          causeMemoryId,
          effectMemoryId,
          explicitFallback.causal_type,
          explicitFallback.strength,
          'system',
          'explicit-causal-marker',
          'Explicit Cause:/Effect: markers detected after LLM inference failed',
          explicitFallback.strength,
          JSON.stringify({
            explanation: explicitFallback.explanation,
            fallback: true,
            cause_category: cause.category,
            effect_category: effect.category
          })
        ]);

        return insertResult.rows[0];
      }
      return null;
    }
  }

  private detectExplicitCausalMarkers(
    causeContent: string,
    effectContent: string
  ): { has_causality: true; causal_type: 'causes'; strength: number; explanation: string } | null {
    const hasCauseMarker = /\bcause\s*:/i.test(causeContent);
    const hasEffectMarker = /\beffect\s*:/i.test(effectContent);

    if (!hasCauseMarker || !hasEffectMarker) {
      return null;
    }

    return {
      has_causality: true,
      causal_type: 'causes',
      strength: 0.70,
      explanation: 'Explicit Cause:/Effect: markers indicate an agent-authored causal relationship.'
    };
  }

  /**
   * Trace causal chain from a memory (forward or backward)
   */
  async traceCausalChain(
    tenantId: string,
    memoryId: string,
    direction: 'causes' | 'caused_by' = 'causes',
    maxDepth: number = 5,
    projectId?: string
  ): Promise<CausalChain> {
    const chain: CausalChain = {
      root: memoryId,
      direction,
      links: [],
      depth: 0,
      total_links: 0
    };

    await this.withTenantContext(tenantId, projectId, (client) =>
      this._traceRecursive(client, tenantId, memoryId, direction, maxDepth, 0, chain, new Set([memoryId]), projectId)
    );
    
    return chain;
  }

  private async _traceRecursive(
    client: PoolClient,
    tenantId: string,
    memoryId: string,
    direction: 'causes' | 'caused_by',
    maxDepth: number,
    currentDepth: number,
    chain: CausalChain,
    visited: Set<string>,
    projectId?: string
  ): Promise<void> {
    if (currentDepth >= maxDepth) return;

    const column = direction === 'causes' ? 'cause_memory_id' : 'effect_memory_id';
    const targetColumn = direction === 'causes' ? 'effect_memory_id' : 'cause_memory_id';

    const query = `
      SELECT 
        cr.*,
        m.content as target_content,
        m.category as target_category
      FROM causal_relationships cr
      JOIN memories m ON m.id = cr.${targetColumn}
      WHERE cr.${column} = $1
        AND cr.tenant_id = $2
        AND ($3::uuid IS NULL OR cr.project_id = $3)
        AND (cr.valid_until IS NULL OR cr.valid_until > NOW())
      ORDER BY cr.causal_strength DESC
      LIMIT 10
    `;

    const result = await client.query(query, [memoryId, tenantId, projectId]);

    for (const row of result.rows) {
      const targetId = row[targetColumn];
      
      // Prevent cycles
      if (visited.has(targetId)) continue;
      visited.add(targetId);

      chain.links.push({
        from: direction === 'causes' ? memoryId : targetId,
        to: direction === 'causes' ? targetId : memoryId,
        type: row.causal_type,
        strength: parseFloat(row.causal_strength),
        depth: currentDepth + 1,
        content: row.target_content
      });

      chain.total_links++;
      chain.depth = Math.max(chain.depth, currentDepth + 1);

      // Recurse
      await this._traceRecursive(
        client,
        tenantId,
        targetId,
        direction,
        maxDepth,
        currentDepth + 1,
        chain,
        visited,
        projectId
      );
    }
  }

  /**
   * Find candidate memory pairs for causal analysis (used by optimization job)
   */
  async findCausalCandidates(
    tenantId: string,
    batchSize: number = 50,
    projectId?: string
  ): Promise<MemoryPair[]> {
    // Strategy: Find temporally ordered pairs with semantic similarity
    const query = `
      WITH recent_memories AS (
        SELECT id, content, embedding, created_at, category
        FROM memories
        WHERE tenant_id = $1
          AND ($2::uuid IS NULL OR project_id = $2)
          AND created_at > NOW() - INTERVAL '30 days'
          AND embedding IS NOT NULL
        ORDER BY created_at DESC
        LIMIT 200
      )
      SELECT 
        m1.id as cause_id,
        m2.id as effect_id,
        m1.content as cause_content,
        m2.content as effect_content,
        (m1.embedding <=> m2.embedding) as distance
      FROM recent_memories m1
      CROSS JOIN recent_memories m2
      WHERE m1.id != m2.id
        AND m1.created_at < m2.created_at
        AND (m1.embedding <=> m2.embedding) < 0.5
        AND NOT EXISTS (
          SELECT 1 FROM causal_relationships cr
          WHERE cr.cause_memory_id = m1.id
            AND cr.effect_memory_id = m2.id
            AND cr.tenant_id = $1
        )
      ORDER BY distance ASC
      LIMIT $3
    `;

    const result = await this.db.query(query, [tenantId, projectId, batchSize]);
    return result.rows;
  }

  /**
   * Validate causal link with user feedback
   */
  async validateCausalLink(
    tenantId: string,
    linkId: string,
    isValid: boolean,
    projectId?: string
  ): Promise<void> {
    const query = `
      UPDATE causal_relationships
      SET validated_by_user = $2,
          confidence_score = CASE WHEN $2 THEN 0.95 ELSE 0.30 END,
          updated_at = NOW()
      WHERE id = $1 AND tenant_id = $3
      RETURNING *
    `;

    await this.db.query(query, [linkId, isValid, tenantId]);
  }

  /**
   * Get causal links for a memory
   */
  async getCausalLinks(
    tenantId: string,
    memoryId: string,
    direction?: 'causes' | 'caused_by',
    projectId?: string
  ): Promise<CausalLink[]> {
    let query = `
      SELECT cr.*, 
             m1.content as cause_content,
             m2.content as effect_content
      FROM causal_relationships cr
      JOIN memories m1 ON m1.id = cr.cause_memory_id
      JOIN memories m2 ON m2.id = cr.effect_memory_id
      WHERE cr.tenant_id = $1
        AND ($3::uuid IS NULL OR cr.project_id = $3)
        AND (cr.valid_until IS NULL OR cr.valid_until > NOW())
    `;

    const params: any[] = [tenantId, memoryId, projectId];

    if (direction === 'causes') {
      query += ` AND cr.cause_memory_id = $2`;
    } else if (direction === 'caused_by') {
      query += ` AND cr.effect_memory_id = $2`;
    } else {
      query += ` AND (cr.cause_memory_id = $2 OR cr.effect_memory_id = $2)`;
    }

    query += ` ORDER BY cr.causal_strength DESC`;

    const result = await this.withTenantContext(tenantId, projectId, (client) =>
      client.query(query, params)
    );
    return result.rows;
  }

  /**
   * Delete causal link
   */
  async deleteCausalLink(
    tenantId: string,
    linkId: string
  ): Promise<void> {
    const query = `
      UPDATE causal_relationships
      SET valid_until = NOW()
      WHERE id = $1 AND tenant_id = $2
    `;

    await this.db.query(query, [linkId, tenantId]);
  }

  /**
   * Get statistics about causal relationships
   */
  async getCausalStats(tenantId: string, projectId?: string): Promise<any> {
    const query = `
      SELECT 
        COUNT(*) as total_links,
        COUNT(DISTINCT cause_memory_id) as memories_with_effects,
        COUNT(DISTINCT effect_memory_id) as memories_with_causes,
        AVG(causal_strength) as avg_strength,
        causal_type,
        COUNT(*) as count_by_type
      FROM causal_relationships
      WHERE tenant_id = $1
        AND ($2::uuid IS NULL OR project_id = $2)
        AND (valid_until IS NULL OR valid_until > NOW())
      GROUP BY causal_type
    `;

    const result = await this.db.query(query, [tenantId, projectId]);
    
    return {
      total_links: result.rows.reduce((sum, r) => sum + parseInt(r.count_by_type), 0),
      avg_strength: result.rows[0]?.avg_strength || 0,
      by_type: result.rows.reduce((acc, r) => {
        acc[r.causal_type] = parseInt(r.count_by_type);
        return acc;
      }, {} as Record<string, number>)
    };
  }
}
