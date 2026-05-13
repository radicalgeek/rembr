/**
 * Phase 1: Consolidated MCP Tools
 * 
 * Reduces 83 legacy tools to 18 operation-based tools for better agent UX.
 * Each tool uses an 'operation' parameter to route to specific functionality.
 * 
 * Backward compatibility: Old tool names still work with deprecation warnings.
 * 
 * Phase 2: Multi-Server Split (REM-38)
 * 
 * Tools are organized into specialized servers for better discoverability:
 * - rembr-core: Core memory operations (memory, search, stats, context, snapshot)
 * - rembr-rlm: RLM features (causality, temporal, classify, audit)
 * - rembr-analytics: Analytics (graph, contradictions, context_analytics)
 * - rembr-contextpilot: ContextPilot features (budget, checkpoint, context_monitor)
 * - rembr-all: All tools (backward compatibility)
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { MEMORY_CATEGORIES } from '../memory-service.js';

// Server types for multi-server architecture (Phase 2)
export type ServerType = 'core' | 'rlm' | 'analytics' | 'contextpilot' | 'all';

// Tool-to-server mapping for multi-server architecture
export const TOOL_SERVER_MAP: Record<string, ServerType[]> = {
  // Core server (5 tools)
  'memory': ['core', 'all'],
  'search': ['core', 'all'],
  'stats': ['core', 'all'],
  'context': ['core', 'all'],
  'snapshot': ['core', 'all'],
  
  // RLM server (6 tools)
  'causality': ['rlm', 'all'],
  'temporal': ['rlm', 'all'],
  'classify': ['rlm', 'all'],
  'audit': ['rlm', 'all'],
  'task_export': ['rlm', 'all'],
  'task_analytics': ['rlm', 'all'],
  'task_handoff': ['rlm', 'all'],
  
  // Analytics server (3 tools)
  'graph': ['analytics', 'all'],
  'contradictions': ['analytics', 'all'],
  'context_analytics': ['analytics', 'all'],
  'compression': ['analytics', 'all'],
  
  // ContextPilot server (3 tools)
  'budget': ['contextpilot', 'all'],
  'checkpoint': ['contextpilot', 'all'],
  'context_monitor': ['contextpilot', 'all'],
};

// Consolidation mapping for backward compatibility
export const TOOL_CONSOLIDATION_MAP: Record<string, { tool: string; operation: string }> = {
  // memory tool (7 legacy tools)
  'store_memory': { tool: 'memory', operation: 'create' },
  'get_memory': { tool: 'memory', operation: 'get' },
  'update_memory': { tool: 'memory', operation: 'update' },
  'delete_memory': { tool: 'memory', operation: 'delete' },
  'list_memories': { tool: 'memory', operation: 'list' },
  'list_personal_memories': { tool: 'memory', operation: 'list_personal' },
  'set_memory_visibility': { tool: 'memory', operation: 'set_visibility' },
  
  // search tool (3 legacy tools)
  'search_memory': { tool: 'search', operation: 'query' },
  'enhanced_search': { tool: 'search', operation: 'smart' },
  'find_similar_memories': { tool: 'search', operation: 'similar' },
  
  // stats tool (5 legacy tools)
  'get_stats': { tool: 'stats', operation: 'usage' },
  'get_embedding_stats': { tool: 'stats', operation: 'embeddings' },
  'get_memory_insights': { tool: 'stats', operation: 'insights' },
  'generate_memory_insights': { tool: 'stats', operation: 'generate_insights' },
  'get_predictive_analytics': { tool: 'stats', operation: 'predictions' },
  
  // context tool (4 legacy tools)
  'list_contexts': { tool: 'context', operation: 'list' },
  'create_context': { tool: 'context', operation: 'create' },
  'search_context': { tool: 'context', operation: 'search' },
  'add_memory_to_context': { tool: 'context', operation: 'add_memory' },
  
  // snapshot tool (5 legacy tools)
  'create_snapshot': { tool: 'snapshot', operation: 'create' },
  'get_snapshot': { tool: 'snapshot', operation: 'get' },
  'list_snapshots': { tool: 'snapshot', operation: 'list' },
  'create_temporal_snapshot': { tool: 'snapshot', operation: 'create_temporal' },
  'list_temporal_snapshots': { tool: 'snapshot', operation: 'list_temporal' },
  
  // graph tool (5 legacy tools)
  'get_memory_graph': { tool: 'graph', operation: 'get' },
  'generate_context_graph': { tool: 'graph', operation: 'generate' },
  'get_context_insights': { tool: 'graph', operation: 'insights' },
  'infer_memory_relationships': { tool: 'graph', operation: 'infer' },
  'compare_snapshots': { tool: 'graph', operation: 'compare' },
  
  // contradictions tool (2 legacy tools)
  'detect_contradictions': { tool: 'contradictions', operation: 'detect' },
  'detect_memory_contradictions': { tool: 'contradictions', operation: 'detect' },
  
  // causality tool (4 legacy tools)
  'infer_causality': { tool: 'causality', operation: 'infer' },
  'trace_causality': { tool: 'causality', operation: 'trace' },
  'get_causal_links': { tool: 'causality', operation: 'get' },
  'validate_causal_link': { tool: 'causality', operation: 'validate' },
  
  // temporal tool (2 legacy tools)
  'search_at_time': { tool: 'temporal', operation: 'search' },
  'get_memory_history': { tool: 'temporal', operation: 'history' },
  
  // audit tool (3 legacy tools)
  'query_audit_log': { tool: 'audit', operation: 'query' },
  'generate_compliance_report': { tool: 'audit', operation: 'report' },
  'get_audit_stats': { tool: 'audit', operation: 'stats' },
  
  // classify tool (1 legacy tool)
  'classify_query_intent': { tool: 'classify', operation: 'intent' },

  // memory tool: ingest (RAD-51 — was missing from map)
  'ingest_document': { tool: 'memory', operation: 'ingest' },
};

/**
 * Consolidated tools definitions (11 tools)
 */
export function getConsolidatedTools(): Tool[] {
  return [
    // 1. MEMORY - Unified memory CRUD operations
    {
      name: 'memory',
      description: 'Unified memory operations. Use operation parameter to: create (store new memory), get (retrieve by ID), update (modify existing), delete, list (recent memories), list_personal (private memories), set_visibility (public/private), ingest (bulk-ingest a document by chunking into multiple memories).',
      inputSchema: {
        type: 'object',
        properties: {
          operation: {
            type: 'string',
            enum: ['create', 'get', 'update', 'delete', 'list', 'list_personal', 'set_visibility', 'ingest'],
            description: 'Operation to perform'
          },
          // create/update params
          content: {
            type: 'string',
            description: '[create/update/ingest] The content to remember (ingest: full document text)'
          },
          category: {
            type: 'string',
            enum: [...MEMORY_CATEGORIES],
            description: '[create/update/list/ingest] Category for organizing memories'
          },
          metadata: {
            type: 'object',
            description: '[create/update/ingest] Additional metadata as key-value pairs',
            additionalProperties: true
          },
          relevance_score: {
            type: 'number',
            description: '[create/update] Relevance score (0.0 to 1.0)',
            minimum: 0,
            maximum: 1
          },
          // get/update/delete/set_visibility params
          id: {
            type: 'string',
            description: '[get/update/delete/set_visibility] Memory ID'
          },
          // list params
          limit: {
            type: 'number',
            description: '[list] Maximum number of results (default 10)',
            minimum: 1,
            maximum: 50
          },
          // set_visibility params
          visibility: {
            type: 'string',
            enum: ['public', 'private'],
            description: '[set_visibility] New visibility setting'
          },
          // ingest params
          title: {
            type: 'string',
            description: '[ingest] Document title (stored in each chunk\'s metadata)'
          },
          source: {
            type: 'string',
            description: '[ingest] Source URL or file path (stored in metadata)'
          },
          chunk_size: {
            type: 'number',
            description: '[ingest] Target chunk size in characters (default 1000, max 5000)',
            minimum: 200,
            maximum: 5000
          }
        },
        required: ['operation']
      }
    },

    // 2. SEARCH - Unified search operations
    {
      name: 'search',
      description: 'Unified search operations. Use operation parameter to: query (hybrid text+semantic search), smart (enhanced multi-strategy search), similar (find similar memories by ID).',
      inputSchema: {
        type: 'object',
        properties: {
          operation: {
            type: 'string',
            enum: ['query', 'smart', 'similar'],
            description: 'Search operation to perform'
          },
          // query/smart params
          query: {
            type: 'string',
            description: '[query/smart] Search query text'
          },
          category: {
            type: 'string',
            enum: [...MEMORY_CATEGORIES],
            description: '[query/smart] Optional category filter'
          },
          limit: {
            type: 'number',
            description: '[all] Maximum number of results (default 10)',
            minimum: 1,
            maximum: 50
          },
          min_similarity: {
            type: 'number',
            description: '[query/similar] Minimum similarity score (default 0.7)',
            minimum: 0,
            maximum: 1
          },
          search_mode: {
            type: 'string',
            enum: ['hybrid', 'semantic', 'text', 'phrase'],
            description: '[query] Search mode: hybrid, semantic, text, or phrase'
          },
          metadata_filter: {
            type: 'object',
            description: '[query/smart] Filter by metadata fields',
            additionalProperties: true
          },
          // PII filter (REM-50)
          exclude_pii: {
            type: 'boolean',
            description: '[query/smart] Exclude memories flagged with PII (default: false)'
          },
          // smart-specific params
          strategies: {
            type: 'array',
            items: { type: 'string', enum: ['semantic', 'keyword', 'recent', 'related'] },
            description: '[smart] Search strategies to use'
          },
          // similar params
          memory_id: {
            type: 'string',
            description: '[similar] Memory ID to find similar memories for'
          },
          // Budget-aware search params (REM-103)
          max_tokens: {
            type: 'number',
            description: '[all] Maximum tokens to return (truncates results to fit budget)',
            minimum: 100
          },
          token_budget_category: {
            type: 'string',
            description: '[all] Budget category name to check against context_budgets table'
          }
        },
        required: ['operation']
      }
    },

    // 3. STATS - Unified statistics and analytics
    {
      name: 'stats',
      description: 'Unified statistics operations. Use operation parameter to: usage (memory counts), embeddings (embedding stats), insights (memory quality insights), generate_insights (create new insights), predictions (predictive analytics).',
      inputSchema: {
        type: 'object',
        properties: {
          operation: {
            type: 'string',
            enum: ['usage', 'embeddings', 'insights', 'generate_insights', 'predictions'],
            description: 'Statistics operation to perform'
          },
          // insights/predictions params
          category: {
            type: 'string',
            enum: [...MEMORY_CATEGORIES],
            description: '[insights/predictions] Category filter'
          },
          days: {
            type: 'number',
            description: '[predictions] Days for forecast horizon',
            minimum: 1,
            maximum: 365
          }
        },
        required: ['operation']
      }
    },

    // 4. CONTEXT - Unified context operations
    {
      name: 'context',
      description: 'Unified context operations. Use operation parameter to: create (new context), get (retrieve by ID), list (all contexts), search (find contexts), add_memory (add memory to context), delete.',
      inputSchema: {
        type: 'object',
        properties: {
          operation: {
            type: 'string',
            enum: ['create', 'get', 'list', 'search', 'add_memory', 'delete'],
            description: 'Context operation to perform'
          },
          // create params
          name: {
            type: 'string',
            description: '[create] Context name'
          },
          description: {
            type: 'string',
            description: '[create] Context description'
          },
          // get/delete params
          id: {
            type: 'string',
            description: '[get/delete/add_memory] Context ID'
          },
          context_id: {
            type: 'string',
            description: '[add_memory] Context ID (alias for id)'
          },
          // list params
          limit: {
            type: 'number',
            description: '[list] Maximum number of results',
            minimum: 1,
            maximum: 100
          },
          // search params
          query: {
            type: 'string',
            description: '[search] Search query'
          },
          // add_memory params
          memory_id: {
            type: 'string',
            description: '[add_memory] Memory ID to add'
          },
          memory_ids: {
            type: 'array',
            items: { type: 'string' },
            description: '[add_memory] Multiple memory IDs to add'
          }
        },
        required: ['operation']
      }
    },

    // 5. SNAPSHOT - Unified snapshot operations
    {
      name: 'snapshot',
      description: 'Unified snapshot operations. Use operation parameter to: create (new snapshot — requires at least one of: query, memory_ids, context_ids), get (retrieve by ID), list (all snapshots), create_temporal (point-in-time snapshot), list_temporal.',
      inputSchema: {
        type: 'object',
        properties: {
          operation: {
            type: 'string',
            enum: ['create', 'get', 'list', 'create_temporal', 'list_temporal'],
            description: 'Snapshot operation to perform'
          },
          // create params
          name: {
            type: 'string',
            description: '[create/create_temporal] Snapshot name'
          },
          query: {
            type: 'string',
            description: '[create] ⚑ At least one required (with memory_ids/context_ids). Search query to find memories to snapshot.'
          },
          memory_ids: {
            type: 'array',
            items: { type: 'string' },
            description: '[create] ⚑ At least one required (with query/context_ids). Specific memory IDs to include.'
          },
          context_ids: {
            type: 'array',
            items: { type: 'string' },
            description: '[create] ⚑ At least one required (with query/memory_ids). Context IDs to snapshot.'
          },
          context_id: {
            type: 'string',
            description: '[create] Single context ID shorthand (maps to context_ids)'
          },
          // get params
          id: {
            type: 'string',
            description: '[get] Snapshot ID'
          },
          snapshot_id: {
            type: 'string',
            description: '[get] Snapshot ID (alias for id)'
          },
          // list params
          limit: {
            type: 'number',
            description: '[list/list_temporal] Maximum number of results',
            minimum: 1,
            maximum: 100
          },
          // create_temporal params
          as_of_time: {
            type: 'string',
            description: '[create_temporal] ISO timestamp for point-in-time snapshot'
          },
          snapshot_name: {
            type: 'string',
            description: '[create_temporal] Snapshot name (alias for name)'
          }
        },
        required: ['operation']
      }
    },

    // 6. GRAPH - Unified graph operations
    {
      name: 'graph',
      description: 'Unified graph operations. Use operation parameter to: get (memory relationship graph), generate (context graph), insights (context insights), infer (infer relationships), compare (compare snapshots), explore (traverse relationship graph from a specific memory).',
      inputSchema: {
        type: 'object',
        properties: {
          operation: {
            type: 'string',
            enum: ['get', 'generate', 'insights', 'infer', 'compare', 'explore'],
            description: 'Graph operation to perform'
          },
          // get/generate/insights params
          context_id: {
            type: 'string',
            description: '[get/generate/insights] Context ID'
          },
          // get/explore params
          depth: {
            type: 'number',
            description: '[get/explore] Maximum relationship depth (explore: 1-3)',
            minimum: 1,
            maximum: 5
          },
          // infer/explore params
          memory_id: {
            type: 'string',
            description: '[infer/explore] Memory ID (explore: starting node for traversal)'
          },
          // explore params
          relationship_types: {
            type: 'array',
            items: { type: 'string' },
            description: '[explore] Filter by relationship type(s), e.g. ["supports","refines"]. Omit for all types.'
          },
          min_confidence: {
            type: 'number',
            description: '[explore] Minimum relationship confidence to follow (0.0–1.0, default 0.5)',
            minimum: 0,
            maximum: 1
          },
          // compare params
          snapshot_id_1: {
            type: 'string',
            description: '[compare] First snapshot ID'
          },
          snapshot_id_2: {
            type: 'string',
            description: '[compare] Second snapshot ID'
          }
        },
        required: ['operation']
      }
    },

    // 7. CONTRADICTIONS - Contradiction detection
    {
      name: 'contradictions',
      description: 'Detect contradictions in memories. Use operation: detect to find conflicting information across memories.',
      inputSchema: {
        type: 'object',
        properties: {
          operation: {
            type: 'string',
            enum: ['detect'],
            description: 'Contradiction operation to perform'
          },
          context_id: {
            type: 'string',
            description: '[detect] Context ID to check for contradictions'
          },
          category: {
            type: 'string',
            enum: [...MEMORY_CATEGORIES],
            description: '[detect] Category filter'
          },
          threshold: {
            type: 'number',
            description: '[detect] Confidence threshold (0.0-1.0)',
            minimum: 0,
            maximum: 1
          }
        },
        required: ['operation']
      }
    },

    // 8. CONTEXT_ANALYTICS - Context usage analytics (REM-101)
    // 8. CONTEXT_ANALYTICS - Context usage analytics (REM-101)
    {
      name: 'context_analytics',
      description: 'Get context usage analytics, waste detection, and efficiency insights. Use operation: get to analyze context patterns, identify waste (repeated info, stale context), calculate efficiency scores, and receive recommendations for optimization.',
      inputSchema: {
        type: 'object',
        properties: {
          operation: {
            type: 'string',
            enum: ['get'],
            description: 'Analytics operation to perform'
          },
          session_id: {
            type: 'string',
            description: '[get] Session ID to analyze (required)'
          },
          period_start: {
            type: 'string',
            description: '[get] Analysis period start (ISO format, optional - defaults to 7 days ago)'
          },
          period_end: {
            type: 'string',
            description: '[get] Analysis period end (ISO format, optional - defaults to now)'
          }
        },
        required: ['operation', 'session_id']
      }
    },

    // 9. CHECKPOINT - Pre-compression checkpoint operations (REM-98)
    {
      name: 'checkpoint',
      description: 'Create and retrieve pre-compression checkpoints. Use operation: create to save critical state before context compression, get to retrieve latest checkpoint, history to view checkpoint timeline. Checkpoints preserve decisions, pending items, and generate NOW.md-style lifeboats for quick recovery.',
      inputSchema: {
        type: 'object',
        properties: {
          operation: {
            type: 'string',
            enum: ['create', 'get', 'history'],
            description: 'Checkpoint operation to perform'
          },
          // create params
          session_id: {
            type: 'string',
            description: '[create/get/history] Session ID (required for all operations)'
          },
          checkpoint_type: {
            type: 'string',
            enum: ['compression', 'manual', 'scheduled'],
            description: '[create] Checkpoint type (default: manual)'
          },
          token_count_before: {
            type: 'number',
            description: '[create] Current token count before checkpoint (required for create)',
            minimum: 0
          },
          current_task: {
            type: 'string',
            description: '[create] Current task description'
          },
          objective: {
            type: 'string',
            description: '[create] Session objective or goal'
          },
          decisions: {
            type: 'array',
            description: '[create] Critical decisions made (array of {timestamp, decision, rationale?, impact?})',
            items: {
              type: 'object',
              properties: {
                timestamp: { type: 'string' },
                decision: { type: 'string' },
                rationale: { type: 'string' },
                impact: { type: 'string' }
              },
              required: ['timestamp', 'decision']
            }
          },
          pending_items: {
            type: 'array',
            description: '[create] Pending tasks/actions (array of {type, description, priority?, due_by?})',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['task', 'action', 'question', 'file'] },
                description: { type: 'string' },
                priority: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
                due_by: { type: 'string' }
              },
              required: ['type', 'description']
            }
          },
          file_paths: {
            type: 'array',
            description: '[create] Key file paths to preserve',
            items: { type: 'string' }
          },
          success_signal: {
            type: 'string',
            description: '[create] Success criteria or completion signal'
          },
          compression_strategy: {
            type: 'string',
            description: '[create] Compression strategy used (if checkpoint_type=compression)'
          },
          // history params
          limit: {
            type: 'number',
            description: '[history] Maximum number of checkpoints to return (default: 10)',
            minimum: 1,
            maximum: 100
          }
        },
        required: ['operation', 'session_id']
      }
    },

    // 10. CONTEXT_MONITOR - Context usage tracking and alerts (REM-97)
    {
      name: 'context_monitor',
      description: 'Monitor context window usage and generate alerts. Reports total usage, category breakdown, identifies top consumers, tracks trends, and provides checkpoint/compression recommendations at configurable thresholds.',
      inputSchema: {
        type: 'object',
        properties: {
          operation: {
            type: 'string',
            enum: ['monitor', 'state'],
            description: 'Monitor operation to perform'
          },
          // monitor params
          session_id: {
            type: 'string',
            description: '[monitor/state] Session ID to monitor (required)'
          },
          current_usage: {
            type: 'object',
            description: '[monitor] Current token usage by category (required for monitor)',
            additionalProperties: { type: 'number' }
          },
          max_tokens: {
            type: 'number',
            description: '[monitor] Maximum token limit (default: 200000)',
            minimum: 1000
          },
          thresholds: {
            type: 'array',
            description: '[monitor] Alert thresholds as percentages (default: [70, 85, 95])',
            items: { type: 'number', minimum: 0, maximum: 100 }
          },
          top_n: {
            type: 'number',
            description: '[monitor] Number of top consumers to identify (default: 5)',
            minimum: 1,
            maximum: 20
          },
          trend_window_hours: {
            type: 'number',
            description: '[monitor] Usage trend window in hours (default: 24)',
            minimum: 1,
            maximum: 168
          }
        },
        required: ['operation', 'session_id']
      }
    },

    // 10. BUDGET - Token budget management (REM-100)
    {
      name: 'budget',
      description: 'Manage context token budgets. Use operation: set to create/update budgets, check to verify usage, list to view all budgets, apply_template to use built-in templates (coding, research, conversation, automation).',
      inputSchema: {
        type: 'object',
        properties: {
          operation: {
            type: 'string',
            enum: ['set', 'check', 'list', 'apply_template'],
            description: 'Budget operation to perform'
          },
          // set params
          budget_name: {
            type: 'string',
            description: '[set/check/apply_template] Budget name (required for set, check, apply_template)'
          },
          total_tokens: {
            type: 'number',
            description: '[set] Total token budget',
            minimum: 1000
          },
          allocations: {
            type: 'object',
            description: '[set] Category allocations (e.g., {"conversation": 30000, "tools": 20000, "memory": 40000})',
            additionalProperties: { type: 'number' }
          },
          thresholds: {
            type: 'object',
            description: '[set/apply_template] Warning/critical thresholds (e.g., {"warning_percent": 75, "critical_percent": 90})',
            properties: {
              warning_percent: { type: 'number', minimum: 0, maximum: 100 },
              critical_percent: { type: 'number', minimum: 0, maximum: 100 }
            }
          },
          compression_trigger_percent: {
            type: 'number',
            description: '[set] Compression trigger percentage (default: 80)',
            minimum: 0,
            maximum: 100
          },
          // check params
          current_usage: {
            type: 'object',
            description: '[check] Current token usage by category (required for check)',
            additionalProperties: { type: 'number' }
          },
          // list params
          active_only: {
            type: 'boolean',
            description: '[list] Show only active budgets (default: true)'
          },
          // apply_template params
          template: {
            type: 'string',
            enum: ['coding', 'research', 'conversation', 'automation'],
            description: '[apply_template] Template name (required for apply_template)'
          },
          custom_total_tokens: {
            type: 'number',
            description: '[apply_template] Custom total tokens (optional, scales template allocations)',
            minimum: 1000
          },
          allocation_adjustments: {
            type: 'object',
            description: '[apply_template] Override specific allocations (optional)',
            additionalProperties: { type: 'number' }
          }
        },
        required: ['operation']
      }
    },

    // 11. CAUSALITY - Causal reasoning operations
    {
      name: 'causality',
      description: 'Unified causal reasoning operations. Use operation parameter to: infer (find causal relationships), trace (trace causality chain), get (get causal links), validate (validate a causal link).',
      inputSchema: {
        type: 'object',
        properties: {
          operation: {
            type: 'string',
            enum: ['infer', 'trace', 'get', 'validate'],
            description: 'Causality operation to perform'
          },
          // infer params
          cause_memory_id: {
            type: 'string',
            description: '[infer/validate] Cause memory ID'
          },
          effect_memory_id: {
            type: 'string',
            description: '[infer/validate] Effect memory ID'
          },
          // trace params
          memory_id: {
            type: 'string',
            description: '[trace/get] Memory ID to trace causality for'
          },
          direction: {
            type: 'string',
            enum: ['forward', 'backward', 'both'],
            description: '[trace] Direction to trace (default: both)'
          },
          max_depth: {
            type: 'number',
            description: '[trace] Maximum trace depth',
            minimum: 1,
            maximum: 10
          },
          // validate params
          link_id: {
            type: 'string',
            description: '[validate] Causal link ID to validate'
          }
        },
        required: ['operation']
      }
    },

    // 12. TEMPORAL - Temporal query operations
    {
      name: 'temporal',
      description: 'Unified temporal operations. Use operation parameter to: search (search memories at a specific time), history (get memory change history).',
      inputSchema: {
        type: 'object',
        properties: {
          operation: {
            type: 'string',
            enum: ['search', 'history'],
            description: 'Temporal operation to perform'
          },
          // search params
          query: {
            type: 'string',
            description: '[search] Search query'
          },
          as_of_time: {
            type: 'string',
            description: '[search] ISO timestamp for point-in-time search'
          },
          // history params
          memory_id: {
            type: 'string',
            description: '[history] Memory ID to get history for'
          },
          // shared params
          limit: {
            type: 'number',
            description: '[search/history] Maximum number of results',
            minimum: 1,
            maximum: 100
          }
        },
        required: ['operation']
      }
    },

    // 13. AUDIT - Audit and compliance operations
    {
      name: 'audit',
      description: 'Unified audit operations. Use operation parameter to: query (query audit logs), report (generate compliance report), stats (audit statistics).',
      inputSchema: {
        type: 'object',
        properties: {
          operation: {
            type: 'string',
            enum: ['query', 'report', 'stats'],
            description: 'Audit operation to perform'
          },
          // query params
          action: {
            type: 'string',
            description: '[query] Filter by action type'
          },
          resource_type: {
            type: 'string',
            description: '[query] Filter by resource type'
          },
          resource_id: {
            type: 'string',
            description: '[query] Filter by resource ID'
          },
          start_date: {
            type: 'string',
            description: '[query/report] Start date (ISO format)'
          },
          end_date: {
            type: 'string',
            description: '[query/report] End date (ISO format)'
          },
          limit: {
            type: 'number',
            description: '[query] Maximum number of results',
            minimum: 1,
            maximum: 1000
          },
          // report params
          report_type: {
            type: 'string',
            enum: ['gdpr', 'soc2', 'summary'],
            description: '[report] Report type'
          }
        },
        required: ['operation']
      }
    },

    // 14. CLASSIFY - Query classification
    {
      name: 'classify',
      description: 'Classify queries for optimal routing. Use operation: intent to determine query intent and suggest best search strategy.',
      inputSchema: {
        type: 'object',
        properties: {
          operation: {
            type: 'string',
            enum: ['intent'],
            description: 'Classification operation to perform'
          },
          query: {
            type: 'string',
            description: '[intent] Query to classify'
          }
        },
        required: ['operation']
      }
    },

    // 12. COMPRESSION - Smart content compression (ContextPilot Phase 4)
    {
      name: 'compression',
      description: 'Smart hierarchical compression preserving decisions. Use operation parameter to: compress (compress content), preview (preview compression impact).',
      inputSchema: {
        type: 'object',
        properties: {
          operation: {
            type: 'string',
            enum: ['compress', 'preview'],
            description: 'Compression operation to perform'
          },
          // compress params
          content: {
            type: 'string',
            description: '[compress/preview] Content to compress'
          },
          source: {
            type: 'string',
            enum: ['user', 'agent'],
            description: '[compress/preview] Content source (user or agent)'
          },
          compression_ratios: {
            type: 'object',
            description: '[compress/preview] Optional custom compression ratios per importance level',
            properties: {
              decision: { type: 'number', minimum: 0, maximum: 1 },
              user_request: { type: 'number', minimum: 0, maximum: 1 },
              technical_detail: { type: 'number', minimum: 0, maximum: 1 },
              acknowledgment: { type: 'number', minimum: 0, maximum: 1 },
              filler: { type: 'number', minimum: 0, maximum: 1 }
            }
          },
          agent_compression_multiplier: {
            type: 'number',
            description: '[compress/preview] Multiplier for agent content compression (default 1.5)',
            minimum: 1.0,
            maximum: 3.0
          },
          target_ratio: {
            type: 'number',
            description: '[compress/preview] Target compression ratio (default 0.5)',
            minimum: 0.1,
            maximum: 1.0
          }
        },
        required: ['operation', 'content', 'source']
      }
    },

    // 16. TASK_EXPORT - Task import/export for RLM portability (REM-57)
    {
      name: 'task_export',
      description: 'Export and import tasks with dependencies and acceptance criteria for RLM portability. Use operation parameter to: export (export tasks as structured JSON), import (import tasks from export data), validate (validate export data structure).',
      inputSchema: {
        type: 'object',
        properties: {
          operation: {
            type: 'string',
            enum: ['export', 'import', 'validate'],
            description: 'Task export/import operation to perform'
          },
          // export params
          task_ids: {
            type: 'array',
            items: { type: 'string' },
            description: '[export] Array of task IDs to export'
          },
          // import params
          export_data: {
            type: 'object',
            description: '[import/validate] Export data structure with version, exported_at, and tasks array',
            properties: {
              version: { type: 'string' },
              exported_at: { type: 'string' },
              tasks: { type: 'array' }
            }
          },
          board_id: {
            type: 'string',
            description: '[import] Target board ID (optional, defaults to original board_id from export)'
          }
        },
        required: ['operation']
      }
    },

    // 17. TASK_HANDOFF - Inter-agent task handoff (RAD-57)
    {
      name: 'task_handoff',
      description: 'Inter-agent task handoff service for RLM portability. Transfer tasks between agents with context preservation. Operations: create (initiate handoff), accept (accept pending handoff), reject (decline handoff), list_pending (list pending handoffs for an agent), get (retrieve handoff by ID), history (handoff history for a task).',
      inputSchema: {
        type: 'object',
        properties: {
          operation: {
            type: 'string',
            enum: ['create', 'accept', 'reject', 'list_pending', 'get', 'history'],
            description: 'Handoff operation to perform'
          },
          // create params
          task_id: {
            type: 'string',
            description: '[create/history] Task ID'
          },
          from_agent: {
            type: 'string',
            description: '[create] Agent initiating the handoff'
          },
          to_agent: {
            type: 'string',
            description: '[create/accept/reject] Target agent for the handoff'
          },
          reason: {
            type: 'string',
            description: '[create/reject] Reason for handoff or rejection'
          },
          context: {
            type: 'object',
            description: '[create] Context to preserve during handoff (current_state, progress, blockers, notes, artifacts)',
            properties: {
              current_state: { type: 'string', description: 'Current task state summary' },
              progress: { type: 'string', description: 'Progress percentage or description' },
              blockers: { type: 'array', items: { type: 'string' }, description: 'Current blockers' },
              notes: { type: 'string', description: 'Important notes for the receiving agent' },
              artifacts: { type: 'array', items: { type: 'string' }, description: 'Relevant file paths or artifact references' }
            },
            additionalProperties: true
          },
          // accept/reject/get params
          handoff_id: {
            type: 'string',
            description: '[accept/reject/get] Handoff ID'
          },
          // list_pending params
          agent_id: {
            type: 'string',
            description: '[list_pending] Agent ID to list pending handoffs for'
          },
          include_from: {
            type: 'boolean',
            description: '[list_pending] Include handoffs initiated by this agent (default: false)'
          },
          include_to: {
            type: 'boolean',
            description: '[list_pending] Include handoffs targeted at this agent (default: true)'
          },
          // history params
          limit: {
            type: 'number',
            description: '[history] Maximum number of history records (default: 10)',
            minimum: 1,
            maximum: 100
          }
        },
        required: ['operation']
      }
    },

    // 18. TASK_ANALYTICS - Task analytics for velocity, burndown, bottlenecks (REM-56)
    {
      name: 'task_analytics',
      description: 'Task management analytics for team productivity insights and Ralph-RLM stuck detection. Supports velocity (tasks completed per time period with trend analysis), burndown (remaining work vs time with projection), and bottlenecks (blocked tasks, overloaded agents, slow transitions).',
      inputSchema: {
        type: 'object',
        properties: {
          operation: {
            type: 'string',
            enum: ['velocity', 'burndown', 'bottlenecks'],
            description: 'Analytics operation to perform'
          },
          project_id: {
            type: 'string',
            description: 'Optional project ID to filter analytics (omit for tenant-wide)'
          },
          // velocity params
          period: {
            type: 'string',
            enum: ['day', 'week', 'month'],
            description: '[velocity] Time period for velocity calculation (default: week)'
          },
          periods: {
            type: 'number',
            description: '[velocity] Number of periods to analyze (default: 8)'
          },
          // burndown params
          start_date: {
            type: 'string',
            description: '[burndown] Start date for burndown chart (ISO 8601 format, default: 30 days ago)'
          },
          target_date: {
            type: 'string',
            description: '[burndown] Target completion date (ISO 8601 format, optional)'
          },
          // bottlenecks params
          thresholds: {
            type: 'object',
            description: '[bottlenecks] Custom thresholds for bottleneck detection',
            properties: {
              blocked_hours: {
                type: 'number',
                description: 'Hours before flagging blocked task (default: 24)'
              },
              cycle_time_hours: {
                type: 'number',
                description: 'Hours before flagging long cycle time (default: 168)'
              },
              agent_task_limit: {
                type: 'number',
                description: 'Active tasks before flagging overloaded agent (default: 5)'
              },
              transition_hours: {
                type: 'number',
                description: 'Hours in state before flagging slow transition (default: 48)'
              }
            }
          }
        },
        required: ['operation']
      }
    },

    // 18. TASK_ITERATIONS - Iteration tracking & stuck detection (RAD-59)
    {
      name: 'task_iterations',
      description: 'Iteration tracking and stuck detection for RLM workflows. Records task execution attempts and identifies stuck loops. Operations: record (log an iteration attempt), history (get all iterations for a task), stuck_score (calculate stuck probability 0-100 for a task), detect_stuck (list all stuck tasks for tenant).',
      inputSchema: {
        type: 'object',
        properties: {
          operation: {
            type: 'string',
            enum: ['record', 'history', 'stuck_score', 'detect_stuck'],
            description: 'Operation to perform'
          },
          task_id: {
            type: 'string',
            description: '[record/history/stuck_score] Task ID'
          },
          approach: {
            type: 'string',
            description: '[record] Description of the approach attempted in this iteration'
          },
          outcome: {
            type: 'string',
            description: '[record] Result of this iteration (e.g. "failed", "partial", "success")'
          },
          error: {
            type: 'string',
            description: '[record] Error message if the iteration failed (optional)'
          },
          duration_seconds: {
            type: 'number',
            description: '[record] Duration of this iteration in seconds (optional)'
          },
          metadata: {
            type: 'object',
            description: '[record] Additional metadata JSONB (optional)',
            additionalProperties: true
          },
          limit: {
            type: 'number',
            description: '[history] Maximum records to return (default: 50)',
            minimum: 1,
            maximum: 200
          },
          criteria: {
            type: 'object',
            description: '[stuck_score/detect_stuck] Stuck detection tuning parameters',
            properties: {
              min_iterations:        { type: 'number', description: 'Min iterations before checking (default: 3)' },
              plateau_threshold:     { type: 'number', description: 'Consecutive same-outcome count for plateau (default: 3)' },
              error_repeat_threshold:{ type: 'number', description: 'Repeated identical errors before flagging (default: 2)' },
              idle_minutes:          { type: 'number', description: 'Idle minutes before flagging (default: 60)' },
              score_threshold:       { type: 'number', description: 'Score at which task is stuck (default: 70)' }
            }
          }
        },
        required: ['operation']
      }
    }
  ];
}

/**
 * Get all tools (consolidated + legacy with deprecation + pii)
 * Legacy tools route to consolidated tools with deprecation warnings.
 */
export function getAllToolsWithLegacy(consolidatedTools: Tool[], legacyTools: Tool[], piiTool: Tool): Tool[] {
  // Add deprecation notice to legacy tool descriptions
  const deprecatedLegacyTools = legacyTools.map(tool => {
    const mapping = TOOL_CONSOLIDATION_MAP[tool.name];
    if (mapping) {
      return {
        ...tool,
        description: `⚠️ DEPRECATED: Use '${mapping.tool}' tool with operation='${mapping.operation}' instead. ${tool.description}`
      };
    }
    return tool;
  });

  return [...consolidatedTools, ...deprecatedLegacyTools, piiTool];
}

/**
 * Check if a tool name is a legacy tool and return migration info
 */
export function getLegacyToolMigration(toolName: string): { isLegacy: boolean; suggestion?: string } {
  const mapping = TOOL_CONSOLIDATION_MAP[toolName];
  if (mapping) {
    return {
      isLegacy: true,
      suggestion: `This tool is deprecated. Use '${mapping.tool}' with operation='${mapping.operation}' instead.`
    };
  }
  return { isLegacy: false };
}

/**
 * Get tools filtered by server type (Phase 2: Multi-Server Split)
 * 
 * @param serverType - Server type to filter by ('core', 'rlm', 'analytics', 'all')
 * @returns Array of tools available on the specified server type
 */
export function getToolsByServerType(serverType: ServerType): Tool[] {
  const allTools = getConsolidatedTools();
  return allTools.filter(tool => {
    const serverTypes = TOOL_SERVER_MAP[tool.name];
    return serverTypes && serverTypes.includes(serverType);
  });
}

/**
 * Get tool count by server type
 */
export function getToolCountByServerType(): Record<ServerType, number> {
  return {
    core: getToolsByServerType('core').length,
    rlm: getToolsByServerType('rlm').length,
    analytics: getToolsByServerType('analytics').length,
    contextpilot: getToolsByServerType('contextpilot').length,
    all: getToolsByServerType('all').length
  };
}
