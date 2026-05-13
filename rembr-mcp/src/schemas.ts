/**
 * Zod input validation schemas for all MCP tool handlers.
 * RAD-46: Security hardening — validate, sanitise, and type-check every tool input.
 */

import { z } from 'zod';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** UUID v4 format (case-insensitive) */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Strip ALL surrounding quote layers from a string value.
 * RAD-7: mcporter may emit double-quoted strings e.g. '""uuid""' or '"value"'.
 * Loops until no more surrounding quotes remain.
 */
function stripSurroundingQuotes(value: string): string {
  let cleaned = value.trim();
  let prev: string;
  do {
    prev = cleaned;
    if (
      (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
      (cleaned.startsWith("'") && cleaned.endsWith("'"))
    ) {
      cleaned = cleaned.slice(1, -1).trim();
    }
  } while (cleaned !== prev);
  return cleaned;
}

/** Reusable UUID string validator — tolerates extra surrounding quotes from mcporter (RAD-7) */
const uuid = z
  .string()
  .transform(stripSurroundingQuotes)
  .pipe(z.string().regex(UUID_RE, 'Must be a valid UUID (e.g. 550e8400-e29b-41d4-a716-446655440000)'));

/** ISO 8601 datetime string */
const isoDatetime = z.string().refine(
  (v) => !isNaN(new Date(v).getTime()),
  { message: 'Must be a valid ISO 8601 datetime (e.g. 2026-01-15T10:30:00Z)' }
);

/**
 * Strip dangerous characters from user-supplied text to prevent
 * SQL injection fragments and stored-XSS payloads.
 * We do NOT reject the input — we sanitise it so existing flows don't break.
 */
function sanitiseText(value: string): string {
  // Strip <script> and <style> blocks entirely (tag + content)
  let cleaned = value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  cleaned = cleaned.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
  // Strip remaining HTML tags
  cleaned = cleaned.replace(/<[^>]*>/g, '');
  // Strip javascript: URI scheme (XSS vector in CSS, href, etc.)
  cleaned = cleaned.replace(/javascript\s*:/gi, '[FILTERED]:');
  // Collapse SQL-injection fragments (basic; the DB uses parameterised queries anyway)
  cleaned = cleaned.replace(/(\b(DROP|ALTER|DELETE|INSERT|EXEC)\b\s+(TABLE|FROM|INTO))/gi, '[FILTERED]');
  cleaned = cleaned.replace(/(\bUPDATE\b\s+\w+\s+SET\b)/gi, '[FILTERED]');
  cleaned = cleaned.replace(/(\bUNION\b\s+(ALL\s+)?SELECT\b)/gi, '[FILTERED]');
  // Remove null bytes
  cleaned = cleaned.replace(/\0/g, '');
  return cleaned;
}

/** Sanitised string with max length */
const safeString = (maxLen: number = 10_000, minLen: number = 1) =>
  z.string().min(minLen).max(maxLen).transform(sanitiseText);

/** Sanitised short string (names, labels) */
const safeName = safeString(500);

/** Sanitised long string (content bodies) */
const safeContent = safeString(100_000);

/** Safe description (medium length) */
const safeDescription = safeString(5_000);

/** Pagination limit (positive integer, bounded) */
const paginationLimit = (max: number = 50, def: number = 10) =>
  z.number().int().min(1).max(max).default(def);

/** Similarity / confidence score 0–1 */
const score01 = z.number().min(0).max(1);

/** Similarity / confidence score with custom min */
const scoreRange = (min: number, max: number) => z.number().min(min).max(max);

/** Safe metadata object */
const safeMetadata = z.record(z.string(), z.unknown()).optional();

// ─── Allowed Enum Values ──────────────────────────────────────────────────────

const MEMORY_CATEGORIES = [
  'facts', 'preferences', 'conversations', 'projects', 'learning',
  'goals', 'context', 'reminders', 'patterns', 'decisions',
  'workflows', 'insights'
] as const;

/**
 * Wrap a z.enum to tolerate extra surrounding quotes from mcporter (RAD-7).
 * Uses z.preprocess to strip quotes before enum validation.
 */
function quoteTolerantEnum<T extends readonly [string, ...string[]]>(values: T) {
  return z.preprocess(
    (v) => (typeof v === 'string' ? stripSurroundingQuotes(v) : v),
    z.enum(values)
  );
}

const memoryCategory = quoteTolerantEnum(MEMORY_CATEGORIES);

const SEARCH_MODES = ['hybrid', 'semantic', 'text', 'phrase'] as const;
const searchMode = quoteTolerantEnum(SEARCH_MODES);

const ANALYSIS_TYPES = ['patterns', 'relationships', 'usage', 'categories', 'domains'] as const;
const analysisType = quoteTolerantEnum(ANALYSIS_TYPES);

const DOMAIN_CONTEXTS = ['software_engineering', 'data_science', 'business_operations', 'research_development'] as const;
const domainContext = quoteTolerantEnum(DOMAIN_CONTEXTS);

const CONTRADICTION_TYPES = ['factual', 'temporal', 'logical', 'preference'] as const;

const CLUSTER_ALGORITHMS = ['category', 'semantic', 'temporal'] as const;

const INSIGHT_TYPES = ['growth', 'decay', 'cyclical', 'burst', 'steady'] as const;

const VISIBILITY_SCOPES = ['personal', 'shared', 'project'] as const;

const CAUSAL_DIRECTIONS = ['causes', 'caused_by'] as const;
const CAUSAL_DIRECTIONS_BOTH = ['causes', 'caused_by', 'both'] as const;

const AUDIT_RESULTS = ['success', 'failure', 'denied'] as const;

// ─── Tool Schemas ─────────────────────────────────────────────────────────────
// One schema per MCP tool, exported as a map keyed by tool name.

// 1. store_memory
const storeMemorySchema = z.object({
  content: safeContent,
  category: memoryCategory,
  metadata: safeMetadata,
  relevance_score: score01.optional()
});

// 2. search_memory
const searchMemorySchema = z.object({
  query: safeString(2000),
  category: memoryCategory.optional(),
  limit: paginationLimit(50, 10).optional(),
  min_similarity: score01.optional(),
  search_mode: searchMode.optional(),
  metadata_filter: safeMetadata
});

// 3. list_memories
const listMemoriesSchema = z.object({
  category: memoryCategory.optional(),
  limit: paginationLimit(50, 10).optional()
}).optional().default({});

// 4. get_memory
const getMemorySchema = z.object({
  id: uuid
});

// 5. update_memory
const updateMemorySchema = z.object({
  id: uuid,
  content: safeContent.optional(),
  category: memoryCategory.optional(),
  metadata: safeMetadata,
  relevance_score: score01.optional()
});

// 6. delete_memory
const deleteMemorySchema = z.object({
  id: uuid
});

// 7. find_similar_memories
const findSimilarMemoriesSchema = z.object({
  memory_id: uuid,
  limit: paginationLimit(50, 10).optional(),
  min_similarity: score01.optional(),
  category: memoryCategory.optional()
});

// 8. get_stats
const getStatsSchema = z.object({}).optional().default({});

// 9. get_embedding_stats
const getEmbeddingStatsSchema = z.object({}).optional().default({});

// 10. list_contexts
const listContextsSchema = z.object({
  category: memoryCategory.optional()
}).optional().default({});

// 11. create_context
const createContextSchema = z.object({
  name: safeName,
  description: safeDescription.optional(),
  category: memoryCategory.optional()
});

// 12. search_context
const searchContextSchema = z.object({
  context_id: uuid,
  query: safeString(2000),
  limit: paginationLimit(50, 10).optional(),
  min_similarity: score01.optional()
});

// 13. add_memory_to_context
const addMemoryToContextSchema = z.object({
  memory_id: uuid,
  context_id: uuid,
  relevance_score: score01.optional()
});

// 14. create_snapshot
// RAD-65: at least one of query/memory_ids/context_ids is required — make the error message
// actionable for agents so they know exactly how to fix the call.
const createSnapshotSchema = z.object({
  name: safeName.optional(),
  description: safeDescription.optional(),
  query: safeString(2000).optional(),
  context_ids: z.array(uuid).optional(),
  memory_ids: z.array(uuid).optional(),
  max_tokens: z.number().int().min(1).optional(),
  ttl_hours: z.number().min(0.1).optional()
}).refine(
  (data) => !!(data.memory_ids?.length || data.context_ids?.length || data.query),
  {
    message:
      'create_snapshot requires at least one of: query (string), memory_ids (UUID array), or context_ids (UUID array). ' +
      'Example: { "query": "recent work" } or { "memory_ids": ["<uuid>"] }',
    path: ['query']  // point to the most common field agents would use
  }
);

// 15. get_snapshot
const getSnapshotSchema = z.object({
  snapshot_id: uuid
});

// 16. list_snapshots
const listSnapshotsSchema = z.object({
  limit: paginationLimit(50, 10).optional()
}).optional().default({});

// 17. get_memory_graph
const getMemoryGraphSchema = z.object({
  context_id: uuid
});

// 18. detect_contradictions
const detectContradictionsSchema = z.object({
  context_id: uuid
});

// 19. get_context_insights
const getContextInsightsSchema = z.object({
  context_id: uuid,
  regenerate: z.boolean().optional()
});

// 20. classify_query_intent
const classifyQueryIntentSchema = z.object({
  query: safeString(2000),
  recent_categories: z.array(z.string().max(100)).optional(),
  project_domain: safeString(200).optional()
});

// 21. infer_memory_relationships
const inferMemoryRelationshipsSchema = z.object({
  memory_id: uuid,
  min_confidence: score01.optional().default(0.6)
});

// 22. enhanced_search
const enhancedSearchSchema = z.object({
  query: safeString(2000),
  enable_intent_classification: z.boolean().optional().default(true),
  enable_relationship_expansion: z.boolean().optional().default(false),
  domain_context: domainContext.optional(),
  limit: paginationLimit(50, 10).optional()
});

// 23. get_memory_insights
// RAD-66: analysis_type must be optional with a default — callers often omit it
const getMemoryInsightsSchema = z.object({
  analysis_type: analysisType.optional().default('patterns'),
  time_range_days: z.number().int().min(1).max(365).optional().default(30)
});

// 24. detect_memory_contradictions
const detectMemoryContradictionsSchema = z.object({
  context_id: uuid.optional(),
  min_confidence: scoreRange(0.5, 1.0).optional().default(0.7),
  contradiction_types: z.array(quoteTolerantEnum(CONTRADICTION_TYPES)).optional()
});

// 25. generate_context_graph
const generateContextGraphSchema = z.object({
  context_id: uuid.optional(),
  include_relationships: z.boolean().optional().default(true),
  min_edge_weight: scoreRange(0.0, 1.0).optional().default(0.3),
  cluster_algorithm: quoteTolerantEnum(CLUSTER_ALGORITHMS).optional().default('category')
});

// 26. generate_memory_insights
const generateMemoryInsightsSchema = z.object({
  time_range_days: z.number().int().min(7).max(365).optional().default(30),
  insight_types: z.array(quoteTolerantEnum(INSIGHT_TYPES)).optional(),
  min_confidence: scoreRange(0.4, 1.0).optional().default(0.6)
});

// 27. get_predictive_analytics
const getPredictiveAnalyticsSchema = z.object({
  prediction_horizon_days: z.number().int().min(7).max(365).optional(),
  include_growth_prediction: z.boolean().optional(),
  include_usage_prediction: z.boolean().optional(),
  include_quality_assessment: z.boolean().optional()
}).optional().default({});

// 28. set_memory_visibility
const setMemoryVisibilitySchema = z.object({
  memory_id: uuid,
  visibility: quoteTolerantEnum(VISIBILITY_SCOPES)
});

// 29. list_personal_memories
const listPersonalMemoriesSchema = z.object({
  limit: paginationLimit(1000, 50).optional(),
  category: memoryCategory.optional()
}).optional().default({});

// 30. trace_causality
const traceCausalitySchema = z.object({
  memory_id: uuid,
  direction: quoteTolerantEnum(CAUSAL_DIRECTIONS).optional().default('causes'),
  max_depth: z.number().int().min(1).max(20).optional().default(5)
});

// 31. infer_causality
const inferCausalitySchema = z.object({
  cause_memory_id: uuid,
  effect_memory_id: uuid
});

// 32. get_causal_links
const getCausalLinksSchema = z.object({
  memory_id: uuid,
  direction: quoteTolerantEnum(CAUSAL_DIRECTIONS_BOTH).optional()
});

// 33. validate_causal_link
const validateCausalLinkSchema = z.object({
  link_id: uuid,
  is_valid: z.boolean()
});

// 34. search_at_time
const searchAtTimeSchema = z.object({
  query: safeString(2000),
  as_of_time: isoDatetime.optional(),
  timestamp: isoDatetime.optional(),
  category: memoryCategory.optional(),
  limit: paginationLimit(50, 10).optional()
}).refine(
  (data) => data.as_of_time || data.timestamp,
  { message: 'as_of_time (or timestamp) is required' }
);

// 35. get_memory_history
const getMemoryHistorySchema = z.object({
  memory_id: uuid
});

// 36. create_temporal_snapshot
const createTemporalSnapshotSchema = z.object({
  snapshot_name: safeName.optional(),
  name: safeName.optional(),
  as_of_time: isoDatetime.optional(),
  timestamp: isoDatetime.optional()
}).refine(
  (data) => data.snapshot_name || data.name,
  { message: 'snapshot_name (or name) is required' }
);

// 37. list_temporal_snapshots
const listTemporalSnapshotsSchema = z.object({
  limit: paginationLimit(100, 50).optional()
}).optional().default({});

// 38. compare_snapshots
const compareSnapshotsSchema = z.object({
  time_a: isoDatetime,
  time_b: isoDatetime
});

// 39. query_audit_log
const queryAuditLogSchema = z.object({
  event_type: safeString(200).optional(),
  start_time: isoDatetime.optional(),
  end_time: isoDatetime.optional(),
  resource_id: uuid.optional(),
  action_result: quoteTolerantEnum(AUDIT_RESULTS).optional(),
  limit: paginationLimit(1000, 100).optional()
}).optional().default({});

// 40. generate_compliance_report
const generateComplianceReportSchema = z.object({
  start_date: isoDatetime.optional(),
  end_date: isoDatetime.optional()
}).optional().default({});

// 41. get_audit_stats
const getAuditStatsSchema = z.object({
  start_date: isoDatetime.optional(),
  end_date: isoDatetime.optional()
}).optional().default({});

// ─── File Attachments (REM-109) ──────────────────────────────────────────────

// 42. upload_attachment
const uploadAttachmentSchema = z.object({
  memory_id: uuid,
  filename: safeString(255),
  content_type: safeString(100),
  content_base64: z.string().min(1, 'File content cannot be empty'),
  is_private: z.boolean().optional().default(false),
  metadata: z.record(z.string(), z.unknown()).optional().default({})
});

// 43. list_attachments
const listAttachmentsSchema = z.object({
  memory_id: uuid
});

// 44. get_attachment_url
const getAttachmentUrlSchema = z.object({
  attachment_id: uuid,
  expires_in_seconds: z.number().int().min(60).max(86400).optional().default(3600)
});

// 45. delete_attachment
const deleteAttachmentSchema = z.object({
  attachment_id: uuid
});

// 46. get_storage_usage
const getStorageUsageSchema = z.object({}).optional().default({});

// ─── REM-248: Previously unvalidated tools ────────────────────────────────────

/** Allowed relationship type strings (free-text, bounded length) */
const safeRelationshipType = z.string().min(1).max(100);

// 47. explore_relationships
const exploreRelationshipsSchema = z.object({
  memory_id: uuid,
  depth: z.number().int().min(1).max(3).optional().default(2),
  min_confidence: score01.optional().default(0.5),
  relationship_types: z.array(safeRelationshipType).max(20).optional()
});

// 48. ingest_document
const ingestDocumentSchema = z.object({
  content: safeContent,
  title: safeName.optional().default('Untitled Document'),
  category: memoryCategory.optional(),
  source: safeString(2000).optional(),
  chunk_size: z.number().int().min(200).max(5000).optional().default(1000),
  metadata: safeMetadata
});

// 49. pii  (operation-based; text required for detect/redact)
const PII_OPERATIONS = ['detect', 'redact', 'audit', 'compliance_report', 'batch_scan'] as const;
const PII_SENSITIVITIES = ['low', 'medium', 'high'] as const;
const PII_REDACTION_MODES = ['mask', 'hash', 'remove'] as const;

const piiSchema = z.object({
  operation: quoteTolerantEnum(PII_OPERATIONS),
  // detect / redact
  text: safeContent.optional(),
  sensitivity: quoteTolerantEnum(PII_SENSITIVITIES).optional().default('medium'),
  redaction_mode: quoteTolerantEnum(PII_REDACTION_MODES).optional().default('mask'),
  // audit
  memory_id: uuid.optional(),
  limit: paginationLimit(1000, 100).optional(),
  // compliance_report
  start_date: isoDatetime.optional(),
  end_date: isoDatetime.optional()
}).superRefine((data, ctx) => {
  if ((data.operation === 'detect' || data.operation === 'redact') && !data.text) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['text'],
      message: `text is required for the '${data.operation}' operation`
    });
  }
});

// ─── Schema Map ───────────────────────────────────────────────────────────────

export const toolSchemas: Record<string, z.ZodTypeAny> = {
  store_memory: storeMemorySchema,
  search_memory: searchMemorySchema,
  list_memories: listMemoriesSchema,
  get_memory: getMemorySchema,
  update_memory: updateMemorySchema,
  delete_memory: deleteMemorySchema,
  find_similar_memories: findSimilarMemoriesSchema,
  get_stats: getStatsSchema,
  get_embedding_stats: getEmbeddingStatsSchema,
  list_contexts: listContextsSchema,
  create_context: createContextSchema,
  search_context: searchContextSchema,
  add_memory_to_context: addMemoryToContextSchema,
  create_snapshot: createSnapshotSchema,
  get_snapshot: getSnapshotSchema,
  list_snapshots: listSnapshotsSchema,
  get_memory_graph: getMemoryGraphSchema,
  detect_contradictions: detectContradictionsSchema,
  get_context_insights: getContextInsightsSchema,
  classify_query_intent: classifyQueryIntentSchema,
  infer_memory_relationships: inferMemoryRelationshipsSchema,
  enhanced_search: enhancedSearchSchema,
  get_memory_insights: getMemoryInsightsSchema,
  detect_memory_contradictions: detectMemoryContradictionsSchema,
  generate_context_graph: generateContextGraphSchema,
  generate_memory_insights: generateMemoryInsightsSchema,
  get_predictive_analytics: getPredictiveAnalyticsSchema,
  set_memory_visibility: setMemoryVisibilitySchema,
  list_personal_memories: listPersonalMemoriesSchema,
  trace_causality: traceCausalitySchema,
  infer_causality: inferCausalitySchema,
  get_causal_links: getCausalLinksSchema,
  validate_causal_link: validateCausalLinkSchema,
  search_at_time: searchAtTimeSchema,
  get_memory_history: getMemoryHistorySchema,
  create_temporal_snapshot: createTemporalSnapshotSchema,
  list_temporal_snapshots: listTemporalSnapshotsSchema,
  compare_snapshots: compareSnapshotsSchema,
  query_audit_log: queryAuditLogSchema,
  generate_compliance_report: generateComplianceReportSchema,
  get_audit_stats: getAuditStatsSchema,
  // File Attachments (REM-109)
  upload_attachment: uploadAttachmentSchema,
  list_attachments: listAttachmentsSchema,
  get_attachment_url: getAttachmentUrlSchema,
  delete_attachment: deleteAttachmentSchema,
  get_storage_usage: getStorageUsageSchema,
  // REM-248: Previously unvalidated tools
  explore_relationships: exploreRelationshipsSchema,
  ingest_document: ingestDocumentSchema,
  pii: piiSchema
};

// ─── Consolidated tool operation validators (RAD-46) ─────────────────────────
// These validate the `operation` field on consolidated tools before routing.
// After routing, the legacy tool schema validates the full payload.

const operationSchema = (ops: readonly string[]) =>
  z.object({ operation: z.enum(ops as [string, ...string[]]) }).passthrough();

Object.assign(toolSchemas, {
  memory:         operationSchema(['create','get','update','delete','list','list_personal','set_visibility','ingest']),
  search:         operationSchema(['query','smart','similar']),
  stats:          operationSchema(['usage','embeddings','insights','generate_insights','predictions']),
  context:        operationSchema(['create','list','search','add_memory']),
  snapshot:       operationSchema(['create','get','list','create_temporal','list_temporal']),
  graph:          operationSchema(['get','generate','insights','infer','compare','explore']),
  contradictions: operationSchema(['detect']),
  causality:      operationSchema(['infer','trace','get','validate']),
  temporal:       operationSchema(['search','history']),
  audit:          operationSchema(['query','report','stats']),
  classify:       operationSchema(['intent']),
});

// ─── Validation Helper ────────────────────────────────────────────────────────

export interface ValidationResult<T = Record<string, unknown>> {
  success: true;
  data: T;
}

export interface ValidationError {
  success: false;
  error: string;
  details: Array<{ field: string; message: string }>;
}

/**
 * Validate tool input against its Zod schema.
 * Returns parsed + sanitised data on success, or a structured error.
 */
export function validateToolInput(
  toolName: string,
  rawArgs: Record<string, unknown> | undefined
): ValidationResult | ValidationError {
  const schema = toolSchemas[toolName];
  if (!schema) {
    // No schema registered — pass through (shouldn't happen for known tools)
    return { success: true, data: rawArgs ?? {} };
  }

  const result = schema.safeParse(rawArgs ?? {});

  if (result.success) {
    return { success: true, data: result.data as Record<string, unknown> };
  }

  // Format Zod errors into human-readable messages
  const details = result.error.issues.map((issue: any) => ({
    field: issue.path.join('.') || '(root)',
    message: issue.message
  }));

  const summary = details
    .map((d: any) => `${d.field}: ${d.message}`)
    .join('; ');

  return {
    success: false,
    error: `Validation failed: ${summary}`,
    details
  };
}

// ─── REM-71: Task MCP Tools ───────────────────────────────────────────────────

const manageTaskSchema = z.object({
  operation:         z.enum(['create','get','update','delete','list','assign']),
  board_id:          z.string().optional(),
  task_id:           z.string().optional(),
  title:             z.string().max(500).optional(),
  description:       z.string().optional(),
  status:            z.enum(['pending','in_progress','blocked','completed','failed']).optional(),
  priority:          z.enum(['critical','high','medium','low']).optional(),
  assigned_agent_id: z.string().optional(),
  agent_id:          z.string().nullable().optional(),
  due_at:            z.string().optional(),
  depends_on_task_ids: z.array(z.string()).optional(),
  tag_ids:           z.array(z.string()).optional(),
  include_deleted:   z.boolean().optional(),
  limit:             z.number().int().min(1).max(200).optional(),
  offset:            z.number().int().min(0).optional(),
});

const taskStateSchema = z.object({
  operation: z.enum(['transition','valid_next','history']),
  task_id:   z.string().optional(),
  to_status: z.enum(['pending','in_progress','blocked','completed','failed']).optional(),
});

const taskDependenciesSchema = z.object({
  operation:      z.enum(['add','remove','blocked_by','blocking','cycles','critical_path']),
  task_id:        z.string().optional(),
  depends_on_id:  z.string().optional(),
  board_id:       z.string().optional(),
});

const taskSearchSchema = z.object({
  operation:         z.enum(['search','filter','aggregate']),
  query:             z.string().optional(),
  board_id:          z.string().optional(),
  status:            z.enum(['pending','in_progress','blocked','completed','failed']).optional(),
  priority:          z.enum(['critical','high','medium','low']).optional(),
  assigned_agent_id: z.string().optional(),
  include_deleted:   z.boolean().optional(),
  limit:             z.number().int().min(1).max(200).optional(),
  offset:            z.number().int().min(0).optional(),
});

// Register in toolSchemas
Object.assign(toolSchemas, {
  manage_task:       manageTaskSchema,
  task_state:        taskStateSchema,
  task_dependencies: taskDependenciesSchema,
  task_search:       taskSearchSchema,
});

// ─── RAD-60: Plan Regeneration MCP Tool ──────────────────────────────────────

const REGENERATION_REASON_TYPES = ['stuck_detection', 'manual', 'failure_threshold', 'timeout'] as const;

const planRegenerationSchema = z.object({
  operation: z.enum(['trigger', 'history', 'analyze_stuck', 'resolve']),
  // trigger + analyze_stuck
  task_id:   z.string().optional(),
  // trigger
  reason_type: quoteTolerantEnum(REGENERATION_REASON_TYPES).optional().default('manual'),
  reason:      safeString(2000).optional(),
  evidence:    z.array(safeString(500)).optional(),
  iteration_count: z.number().int().min(0).optional(),
  failure_count:   z.number().int().min(0).optional(),
  elapsed_minutes: z.number().min(0).optional(),
  // history
  limit: z.number().int().min(1).max(50).optional().default(10),
  // resolve
  regeneration_id: z.string().optional(),
  new_plan:        safeString(10000).optional(),
});

Object.assign(toolSchemas, {
  plan_regeneration: planRegenerationSchema,
});

// ─── RAD-73: Plan Compaction MCP Tool ─────────────────────────────────────────

const planCompactionSchema = z.object({
  operation: z.enum(['check', 'schedule', 'consent', 'preview', 'execute', 'history', 'cancel']),
  // schedule / check context
  old_plan:             z.string().optional(),
  new_plan:             z.string().optional(),
  old_memory_limit:     z.number().int().min(0).optional(),
  new_memory_limit:     z.number().int().min(0).optional(),
  grace_period_days:    z.number().int().min(0).max(30).optional().default(7),
  // RAD-73 refinement: explicit execute_after (ISO 8601) — uses subscription_end_date if omitted
  execute_after:        isoDatetime.optional(),
  // consent / preview / execute / cancel
  schedule_id:          z.string().optional(),
  project_id:           z.string().optional(),
  similarity_threshold: z.number().min(0).max(1).optional().default(0.7),
  max_group_size:       z.number().int().min(2).max(10).optional().default(5),
  // history
  limit: z.number().int().min(1).max(50).optional().default(10),
});

Object.assign(toolSchemas, {
  plan_compaction: planCompactionSchema,
});
