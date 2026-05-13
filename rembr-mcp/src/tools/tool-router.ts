/**
 * Phase 1: Tool Router
 * 
 * Routes consolidated tool operations to the appropriate handlers.
 * Maintains backward compatibility with legacy tools.
 */

import { TOOL_CONSOLIDATION_MAP, getLegacyToolMigration } from './consolidated-tools.js';
import { logger } from '../logger.js';

export interface ToolRouterContext {
  tenantId: string;
  projectId?: string;
  userId?: string;
}

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  _meta?: {
    deprecation_warning?: string;
    migrated_from?: string;
    pagination?: {
      has_more: boolean;
      suggested_filters?: string[];
    };
    execution_time_ms?: number;
    related_tools?: string[];
  };
}

/**
 * Route a legacy tool to its consolidated equivalent.
 * Returns the consolidated tool name, operation, and remapped args.
 */
export function routeLegacyTool(
  legacyToolName: string,
  args: Record<string, unknown>
): { toolName: string; operation: string; args: Record<string, unknown> } | null {
  const mapping = TOOL_CONSOLIDATION_MAP[legacyToolName];
  if (!mapping) {
    return null;
  }

  // Add the operation to args
  const remappedArgs = {
    operation: mapping.operation,
    ...args
  };

  logger.info(`Routing legacy tool '${legacyToolName}' to consolidated '${mapping.tool}.${mapping.operation}'`);

  return {
    toolName: mapping.tool,
    operation: mapping.operation,
    args: remappedArgs
  };
}

/**
 * Add pagination metadata to list/search results
 */
export function addPaginationMetadata(
  result: ToolResult,
  items: unknown[],
  limit: number,
  totalAvailable?: number
): ToolResult {
  const hasMore = totalAvailable ? items.length < totalAvailable : items.length === limit;
  
  return {
    ...result,
    _meta: {
      ...result._meta,
      pagination: {
        has_more: hasMore,
        suggested_filters: hasMore ? ['Add category filter', 'Increase min_similarity', 'Add date range'] : undefined
      }
    }
  };
}

/**
 * Wrap result with deprecation warning for legacy tools
 */
export function wrapWithDeprecationWarning(
  result: ToolResult,
  legacyToolName: string
): ToolResult {
  const migration = getLegacyToolMigration(legacyToolName);
  if (!migration.isLegacy) {
    return result;
  }

  // Parse existing result text
  let existingData: Record<string, unknown> = {};
  try {
    const textContent = result.content.find(c => c.type === 'text');
    if (textContent) {
      existingData = JSON.parse(textContent.text);
    }
  } catch {
    // Not JSON, leave as-is
    return {
      ...result,
      _meta: {
        ...result._meta,
        deprecation_warning: migration.suggestion,
        migrated_from: legacyToolName
      }
    };
  }

  // Add deprecation warning to JSON response
  const wrappedData = {
    ...existingData,
    _deprecation_warning: migration.suggestion
  };

  return {
    content: [{
      type: 'text',
      text: JSON.stringify(wrappedData, null, 2)
    }],
    _meta: {
      ...result._meta,
      deprecation_warning: migration.suggestion,
      migrated_from: legacyToolName
    }
  };
}

/**
 * Memory operation router
 */
export type MemoryOperation = 'create' | 'get' | 'update' | 'delete' | 'list' | 'list_personal' | 'set_visibility';

export function validateMemoryOperation(args: Record<string, unknown>): { valid: boolean; error?: string } {
  const operation = args.operation as MemoryOperation;
  
  switch (operation) {
    case 'create':
      if (!args.content || !args.category) {
        return { valid: false, error: 'create operation requires content and category' };
      }
      break;
    case 'get':
    case 'delete':
      if (!args.id) {
        return { valid: false, error: `${operation} operation requires id` };
      }
      break;
    case 'update':
      if (!args.id) {
        return { valid: false, error: 'update operation requires id' };
      }
      if (!args.content && !args.category && !args.metadata && args.relevance_score === undefined) {
        return { valid: false, error: 'update operation requires at least one field to update' };
      }
      break;
    case 'set_visibility':
      if (!args.id || !args.visibility) {
        return { valid: false, error: 'set_visibility operation requires id and visibility' };
      }
      break;
    case 'list':
    case 'list_personal':
      // No required params
      break;
    default:
      return { valid: false, error: `Unknown operation: ${operation}` };
  }
  
  return { valid: true };
}

/**
 * Search operation router
 */
export type SearchOperation = 'query' | 'smart' | 'similar';

export function validateSearchOperation(args: Record<string, unknown>): { valid: boolean; error?: string } {
  const operation = args.operation as SearchOperation;
  
  switch (operation) {
    case 'query':
    case 'smart':
      if (!args.query) {
        return { valid: false, error: `${operation} operation requires query` };
      }
      break;
    case 'similar':
      if (!args.memory_id) {
        return { valid: false, error: 'similar operation requires memory_id' };
      }
      break;
    default:
      return { valid: false, error: `Unknown operation: ${operation}` };
  }
  
  return { valid: true };
}

/**
 * Stats operation router
 */
export type StatsOperation = 'usage' | 'embeddings' | 'insights' | 'generate_insights' | 'predictions';

export function validateStatsOperation(args: Record<string, unknown>): { valid: boolean; error?: string } {
  const operation = args.operation as StatsOperation;
  
  switch (operation) {
    case 'usage':
    case 'embeddings':
    case 'insights':
    case 'generate_insights':
    case 'predictions':
      // No required params for most stats operations
      break;
    default:
      return { valid: false, error: `Unknown operation: ${operation}` };
  }
  
  return { valid: true };
}

/**
 * Context operation router
 */
export type ContextOperation = 'create' | 'get' | 'list' | 'search' | 'add_memory' | 'delete';

export function validateContextOperation(args: Record<string, unknown>): { valid: boolean; error?: string } {
  const operation = args.operation as ContextOperation;
  
  switch (operation) {
    case 'create':
      if (!args.name) {
        return { valid: false, error: 'create operation requires name' };
      }
      break;
    case 'get':
    case 'delete':
      if (!args.id && !args.context_id) {
        return { valid: false, error: `${operation} operation requires id or context_id` };
      }
      break;
    case 'search':
      if (!args.query) {
        return { valid: false, error: 'search operation requires query' };
      }
      break;
    case 'add_memory':
      if ((!args.id && !args.context_id) || (!args.memory_id && !args.memory_ids)) {
        return { valid: false, error: 'add_memory operation requires context_id and memory_id or memory_ids' };
      }
      break;
    case 'list':
      // No required params
      break;
    default:
      return { valid: false, error: `Unknown operation: ${operation}` };
  }
  
  return { valid: true };
}

/**
 * Snapshot operation router
 */
export type SnapshotOperation = 'create' | 'get' | 'list' | 'create_temporal' | 'list_temporal';

export function validateSnapshotOperation(args: Record<string, unknown>): { valid: boolean; error?: string } {
  const operation = args.operation as SnapshotOperation;
  
  switch (operation) {
    case 'create':
      if (!args.context_id) {
        return { valid: false, error: 'create operation requires context_id' };
      }
      break;
    case 'get':
      if (!args.id && !args.snapshot_id) {
        return { valid: false, error: 'get operation requires id or snapshot_id' };
      }
      break;
    case 'create_temporal':
      if (!args.name && !args.snapshot_name) {
        return { valid: false, error: 'create_temporal operation requires name or snapshot_name' };
      }
      break;
    case 'list':
    case 'list_temporal':
      // No required params
      break;
    default:
      return { valid: false, error: `Unknown operation: ${operation}` };
  }
  
  return { valid: true };
}

/**
 * Graph operation router
 */
export type GraphOperation = 'get' | 'generate' | 'insights' | 'infer' | 'compare';

export function validateGraphOperation(args: Record<string, unknown>): { valid: boolean; error?: string } {
  const operation = args.operation as GraphOperation;
  
  switch (operation) {
    case 'get':
    case 'generate':
    case 'insights':
      if (!args.context_id) {
        return { valid: false, error: `${operation} operation requires context_id` };
      }
      break;
    case 'infer':
      if (!args.memory_id) {
        return { valid: false, error: 'infer operation requires memory_id' };
      }
      break;
    case 'compare':
      if (!args.snapshot_id_1 || !args.snapshot_id_2) {
        return { valid: false, error: 'compare operation requires snapshot_id_1 and snapshot_id_2' };
      }
      break;
    default:
      return { valid: false, error: `Unknown operation: ${operation}` };
  }
  
  return { valid: true };
}

/**
 * Contradictions operation router
 */
export type ContradictionsOperation = 'detect';

export function validateContradictionsOperation(args: Record<string, unknown>): { valid: boolean; error?: string } {
  const operation = args.operation as ContradictionsOperation;
  
  switch (operation) {
    case 'detect':
      // No required params - can detect across all memories or filtered
      break;
    default:
      return { valid: false, error: `Unknown operation: ${operation}` };
  }
  
  return { valid: true };
}

/**
 * Causality operation router
 */
export type CausalityOperation = 'infer' | 'trace' | 'get' | 'validate';

export function validateCausalityOperation(args: Record<string, unknown>): { valid: boolean; error?: string } {
  const operation = args.operation as CausalityOperation;
  
  switch (operation) {
    case 'infer':
      if (!args.cause_memory_id || !args.effect_memory_id) {
        return { valid: false, error: 'infer operation requires cause_memory_id and effect_memory_id' };
      }
      break;
    case 'trace':
    case 'get':
      if (!args.memory_id) {
        return { valid: false, error: `${operation} operation requires memory_id` };
      }
      break;
    case 'validate':
      if (!args.link_id) {
        return { valid: false, error: 'validate operation requires link_id' };
      }
      break;
    default:
      return { valid: false, error: `Unknown operation: ${operation}` };
  }
  
  return { valid: true };
}

/**
 * Temporal operation router
 */
export type TemporalOperation = 'search' | 'history';

export function validateTemporalOperation(args: Record<string, unknown>): { valid: boolean; error?: string } {
  const operation = args.operation as TemporalOperation;
  
  switch (operation) {
    case 'search':
      if (!args.query) {
        return { valid: false, error: 'search operation requires query' };
      }
      break;
    case 'history':
      if (!args.memory_id) {
        return { valid: false, error: 'history operation requires memory_id' };
      }
      break;
    default:
      return { valid: false, error: `Unknown operation: ${operation}` };
  }
  
  return { valid: true };
}

/**
 * Audit operation router
 */
export type AuditOperation = 'query' | 'report' | 'stats';

export function validateAuditOperation(args: Record<string, unknown>): { valid: boolean; error?: string } {
  const operation = args.operation as AuditOperation;
  
  switch (operation) {
    case 'query':
    case 'report':
    case 'stats':
      // No strictly required params
      break;
    default:
      return { valid: false, error: `Unknown operation: ${operation}` };
  }
  
  return { valid: true };
}

/**
 * Classify operation router
 */
export type ClassifyOperation = 'intent';

export function validateClassifyOperation(args: Record<string, unknown>): { valid: boolean; error?: string } {
  const operation = args.operation as ClassifyOperation;
  
  switch (operation) {
    case 'intent':
      if (!args.query) {
        return { valid: false, error: 'intent operation requires query' };
      }
      break;
    default:
      return { valid: false, error: `Unknown operation: ${operation}` };
  }
  
  return { valid: true };
}

/**
 * Compression operation types (REM-99 ContextPilot Phase 4)
 */
export type CompressionOperation = 'compress' | 'preview';

export function validateCompressionOperation(args: Record<string, unknown>): { valid: boolean; error?: string } {
  const operation = args.operation as CompressionOperation;
  
  switch (operation) {
    case 'compress':
    case 'preview':
      if (!args.content) {
        return { valid: false, error: `${operation} operation requires content` };
      }
      if (!args.source || !['user', 'agent'].includes(args.source as string)) {
        return { valid: false, error: `${operation} operation requires source (user or agent)` };
      }
      break;
    default:
      return { valid: false, error: `Unknown operation: ${operation}` };
  }
  
  return { valid: true };
}

/**
 * Get validator for a consolidated tool
 */
export function getOperationValidator(toolName: string): ((args: Record<string, unknown>) => { valid: boolean; error?: string }) | null {
  switch (toolName) {
    case 'memory': return validateMemoryOperation;
    case 'search': return validateSearchOperation;
    case 'stats': return validateStatsOperation;
    case 'context': return validateContextOperation;
    case 'snapshot': return validateSnapshotOperation;
    case 'graph': return validateGraphOperation;
    case 'contradictions': return validateContradictionsOperation;
    case 'causality': return validateCausalityOperation;
    case 'temporal': return validateTemporalOperation;
    case 'audit': return validateAuditOperation;
    case 'classify': return validateClassifyOperation;
    case 'compression': return validateCompressionOperation;
    default: return null;
  }
}
