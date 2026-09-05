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

/** Preserve source text exactly; active sinks escape it and SQL is bound. */
const safeString = (maxLen: number = 10_000, minLen: number = 1) =>
  z.string()
    .min(minLen)
    .max(maxLen)
    .refine(value => !value.includes('\0'), 'Null bytes are not allowed');

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

function metadataWithinBounds(value: unknown, depth = 0): boolean {
  if (depth > 5) return false;
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return typeof value !== 'number' || Number.isFinite(value);
  }
  if (typeof value === 'string') return value.length <= 10_000 && !value.includes('\0');
  if (Array.isArray(value)) {
    return value.length <= 100 && value.every(item => metadataWithinBounds(item, depth + 1));
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    return entries.length <= 50 && entries.every(([key, item]) =>
      key.length >= 1 && key.length <= 64 && !key.includes('\0') && metadataWithinBounds(item, depth + 1));
  }
  return false;
}

/** JSON metadata with bounded depth, fan-out and encoded size. */
const metadataObject = z.record(z.string().min(1).max(64), z.unknown()).superRefine((value, ctx) => {
  let encoded = '';
  try {
    encoded = JSON.stringify(value);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Metadata must be serialisable JSON' });
    return;
  }
  if (!metadataWithinBounds(value)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Metadata exceeds depth, item, or scalar bounds' });
  }
  if (Buffer.byteLength(encoded, 'utf8') > 32_768) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Metadata must not exceed 32 KiB' });
  }
});
const safeMetadata = metadataObject.optional();

/**
 * Search filters are deliberately narrower than stored metadata.
 *
 * Keys used to be interpolated into SQL.  The database layer now binds the
 * complete object as JSONB as well, but keeping this boundary conservative
 * prevents unbounded/deep filters and makes the public contract explicit.
 */
const metadataFilter = z
  .record(
    z.string().min(1).max(64).regex(
      /^[A-Za-z0-9_.:-]+$/,
      'Metadata filter keys may contain letters, numbers, underscore, dot, colon, or hyphen only'
    ),
    z.union([z.string().max(2_000), z.number().finite(), z.boolean(), z.null()])
  )
  .superRefine((value, ctx) => {
    if (Object.keys(value).length > 20) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'metadata_filter may contain at most 20 keys'
      });
    }
  })
  .optional();

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
  metadata_filter: metadataFilter,
  exclude_pii: z.boolean().optional(),
  max_tokens: z.number().int().min(100).max(250_000).optional(),
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
  category: memoryCategory.optional(),
  limit: paginationLimit(100, 50).optional(),
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
  context_ids: z.array(uuid).max(100).optional(),
  memory_ids: z.array(uuid).max(500).optional(),
  max_tokens: z.number().int().min(1).max(200_000).optional(),
  ttl_hours: z.number().min(0.1).max(8_760).optional()
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
  snapshot_id: uuid,
  offset: z.number().int().min(0).max(1_000_000).optional().default(0),
  limit: paginationLimit(25, 25).optional(),
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
  recent_categories: z.array(z.string().max(100)).max(20).optional(),
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
  contradiction_types: z.array(quoteTolerantEnum(CONTRADICTION_TYPES)).max(CONTRADICTION_TYPES.length).optional(),
  live_analysis: z.enum(['auto', 'always', 'never']).optional().default('auto'),
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
  insight_types: z.array(quoteTolerantEnum(INSIGHT_TYPES)).max(INSIGHT_TYPES.length).optional(),
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
  // About 1 MiB decoded. Larger files need a future authenticated streaming
  // or direct-to-object-store upload rather than base64 in JSON.
  content_base64: z.string()
    .min(1, 'File content cannot be empty')
    .max(1_398_104, 'Encoded file content is too large')
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/, 'Invalid base64 file content'),
  is_private: z.boolean().optional().default(false),
  metadata: metadataObject.optional().default({})
});

// 43. list_attachments
const listAttachmentsSchema = z.object({
  memory_id: uuid
});

// 44. get_attachment_url
const getAttachmentUrlSchema = z.object({
  attachment_id: uuid,
  expires_in_seconds: z.number().int().min(60).max(3600).optional().default(3600)
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
  limit: paginationLimit(100, 100).optional(),
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

const advancedMetadataConditionSchema = z.object({
  key: z.string().min(1).max(64).regex(/^[A-Za-z0-9_.:-]+$/),
  operator: z.enum(['eq', 'neq', 'contains', 'exists', 'gt', 'lt']),
  value: z.union([z.string().max(2_000), z.number().finite(), z.boolean(), z.null()]).optional(),
});

const advancedFilterSchema = z.object({
  query: safeString(2_000).optional(),
  categories: z.array(z.string().min(1).max(100)).max(20).optional(),
  category: z.string().min(1).max(100).optional(),
  created_after: isoDatetime.optional(),
  created_before: isoDatetime.optional(),
  updated_after: isoDatetime.optional(),
  updated_before: isoDatetime.optional(),
  min_content_length: z.number().int().min(0).max(10_000_000).optional(),
  max_content_length: z.number().int().min(0).max(10_000_000).optional(),
  pii_only: z.boolean().optional(),
  exclude_pii: z.boolean().optional(),
  metadata_conditions: z.array(advancedMetadataConditionSchema).max(20).optional(),
  metadata_filter: metadataFilter,
  sort_by: z.enum(['created_at', 'updated_at', 'content_length', 'category']).optional(),
  sort_order: z.enum(['asc', 'desc']).optional(),
  limit: z.number().int().min(1).max(500).optional(),
  offset: z.number().int().min(0).max(10_000).optional(),
});

const filterMemoriesSchema = advancedFilterSchema;
const batchMemoriesSchema = z.object({
  operation: z.enum(['delete', 'update']),
  filter: advancedFilterSchema,
  updates: z.object({
    category: z.string().min(1).max(100).optional(),
    metadata_merge: metadataObject.optional(),
  }).optional(),
});
const savedSearchesSchema = z.object({
  operation: z.enum(['save', 'list', 'execute', 'delete']),
  name: z.string().min(1).max(100).optional(),
  description: safeString(1_000).optional(),
  filter: advancedFilterSchema.optional(),
}).superRefine((value, ctx) => {
  if (value.operation !== 'list' && !value.name) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['name'], message: 'name is required' });
  }
  if (value.operation === 'save' && !value.filter) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['filter'], message: 'filter is required' });
  }
});
const exportMemoriesSchema = z.object({
  filter: advancedFilterSchema.optional().default({}),
  format: z.enum(['json', 'csv', 'markdown']).optional().default('json'),
  title: safeName.optional(),
});

const ANALYTICS_WINDOW_MS: Record<'hour' | 'day' | 'week' | 'month', number> = {
  hour: 31 * 86_400_000,
  day: 366 * 86_400_000,
  week: 5 * 366 * 86_400_000,
  month: 10 * 366 * 86_400_000,
};

function validateAnalyticsWindow(
  value: { from?: string; to?: string; granularity?: 'hour' | 'day' | 'week' | 'month' },
  ctx: z.RefinementCtx,
): void {
  const to = value.to ? new Date(value.to).getTime() : Date.now();
  const from = value.from ? new Date(value.from).getTime() : to - 30 * 86_400_000;
  if (from > to) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['from'], message: 'from must not be after to' });
    return;
  }
  const granularity = value.granularity || 'day';
  if (to - from > ANALYTICS_WINDOW_MS[granularity]) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['from'],
      message: `Time range is too large for ${granularity} granularity`,
    });
  }
}

const dateRangeSchema = z.object({
  from: isoDatetime.optional(),
  to: isoDatetime.optional(),
  granularity: z.enum(['hour', 'day', 'week', 'month']).optional(),
}).superRefine(validateAnalyticsWindow).optional().default({});
const buildReportSchema = z.object({
  title: safeName.optional(),
  metrics: z.array(z.enum(['usage', 'performance', 'growth', 'categories', 'pii_summary'])).min(1).max(5),
  granularity: z.enum(['hour', 'day', 'week', 'month']).optional(),
  from: isoDatetime.optional(),
  to: isoDatetime.optional(),
  format: z.enum(['json', 'csv', 'markdown']).optional(),
}).superRefine(validateAnalyticsWindow);

const memoryGrowthSchema = z.object({
  from: isoDatetime.optional(),
  to: isoDatetime.optional(),
}).superRefine((value, ctx) => validateAnalyticsWindow(
  { ...value, granularity: 'day' },
  ctx,
)).optional().default({});

const piiNlpSensitivity = z.enum(['low', 'medium', 'high', 'maximum']);
const piiNlpDetectSchema = z.object({
  content: safeContent,
  sensitivity: piiNlpSensitivity.optional(),
});
const piiNlpRedactSchema = piiNlpDetectSchema.extend({
  mode: z.enum(['mask', 'hash', 'label', 'remove']).optional(),
  min_confidence: score01.optional(),
});

const rlmSessionSchema = z.object({
  operation: z.enum(['create', 'get', 'list', 'update_status', 'export_state', 'import_state']),
  session_id: z.string().min(1).max(100).optional(),
  task_id: z.string().min(1).max(200).optional(),
  task_title: safeName.optional(),
  acceptance_criteria: z.array(safeString(1_000)).max(100).optional(),
  initial_plan: safeString(20_000).optional(),
  status: z.enum(['active', 'complete', 'abandoned', 'regenerating']).optional(),
  plan: safeString(20_000).optional(),
  state_json: z.string().max(256_000).optional(),
  metadata: safeMetadata,
});
const rlmEvaluateSchema = z.object({
  session_id: z.string().min(1).max(100),
  evaluations: z.array(z.object({
    id: z.string().min(1).max(100),
    status: z.enum(['met', 'failed', 'skipped', 'pending']),
    evidence: safeString(2_000).optional(),
  })).max(100),
});
const rlmIterationSchema = z.object({
  operation: z.enum(['start', 'complete']),
  session_id: z.string().min(1).max(100).optional(),
  iteration_id: uuid.optional(),
  plan_summary: safeString(10_000).optional(),
  approach: safeString(10_000).optional(),
  outcome: z.enum(['success', 'partial', 'failed', 'blocked']).optional(),
  evidence: z.array(safeString(2_000)).max(100).optional(),
  ac_met: z.array(z.string().min(1).max(100)).max(100).optional(),
  ac_failed: z.array(z.string().min(1).max(100)).max(100).optional(),
  error: safeString(5_000).optional(),
  duration_ms: z.number().int().min(0).max(86_400_000).optional(),
});
const rlmRegenerateSchema = z.object({
  session_id: z.string().min(1).max(100),
  reason: safeString(5_000),
  stuck_evidence: z.array(safeString(2_000)).max(100).optional(),
  failed_approaches: z.array(safeString(2_000)).max(100).optional(),
  constraints: z.array(safeString(2_000)).max(100).optional(),
});

const queueName = safeString(100);
const queueIdentifier = safeString(200);
const queuePayload = metadataObject;
const queueHandoff = z.object({
  summary: safeString(5_000),
  context: queuePayload,
  memory_ids: z.array(uuid).max(100).optional(),
  instructions: safeString(10_000).optional(),
  target_agent_type: queueIdentifier.optional(),
  metadata: queuePayload.optional(),
});
const queuePriority = z.enum(['critical', 'high', 'normal', 'low']);
const queueEnqueueItem = z.object({
  queue_name: queueName.optional(),
  task_type: queueIdentifier,
  priority: queuePriority.optional(),
  payload: queuePayload.optional().default({}),
  handoff: queueHandoff.optional(),
  lease_seconds: z.number().int().min(30).max(3_600).optional(),
  max_attempts: z.number().int().min(1).max(20).optional(),
  scheduled_after: isoDatetime.optional(),
  idempotency_key: queueIdentifier.optional(),
});
const workQueueSchema = z.object({
  operation: z.enum([
    'enqueue', 'bulk_enqueue', 'claim', 'complete', 'bulk_complete', 'fail',
    'retry', 'renew_lease', 'list', 'get', 'stats', 'purge',
  ]),
  queue_name: queueName.optional(),
  item_id: uuid.optional(),
  agent_id: queueIdentifier.optional(),
  task_type: queueIdentifier.optional(),
  priority: queuePriority.optional(),
  payload: queuePayload.optional(),
  handoff: queueHandoff.optional(),
  failure_reason: safeString(5_000).optional(),
  lease_seconds: z.number().int().min(30).max(3_600).optional(),
  max_attempts: z.number().int().min(1).max(20).optional(),
  scheduled_after: isoDatetime.optional(),
  idempotency_key: queueIdentifier.optional(),
  status_filter: z.array(z.enum(['pending', 'claimed', 'completed', 'failed', 'dead_letter'])).max(5).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).max(10_000).optional(),
  older_than_days: z.number().int().min(1).max(365).optional(),
  items: z.array(queueEnqueueItem).min(1).max(100).optional(),
  completions: z.array(z.object({
    item_id: uuid,
    agent_id: queueIdentifier.optional(),
    handoff: queueHandoff.optional(),
  })).min(1).max(100).optional(),
}).superRefine((value, ctx) => {
  const requiredByOperation: Partial<Record<typeof value.operation, Array<keyof typeof value>>> = {
    enqueue: ['task_type'],
    bulk_enqueue: ['items'],
    complete: ['item_id'],
    bulk_complete: ['completions'],
    fail: ['item_id'],
    retry: ['item_id'],
    renew_lease: ['item_id'],
    get: ['item_id'],
  };
  for (const field of requiredByOperation[value.operation] ?? []) {
    if (value[field] === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `${String(field)} is required for ${value.operation}` });
    }
  }
});

const boundedTokenMap = z.record(
  z.string().min(1).max(64).regex(/^[A-Za-z0-9_.:-]+$/),
  z.number().int().min(0).max(10_000_000),
).refine(value => Object.keys(value).length <= 50, 'At most 50 token categories are allowed');

const contextAnalyticsSchema = z.object({
  operation: z.literal('get'),
  session_id: queueIdentifier,
  period_start: isoDatetime.optional(),
  period_end: isoDatetime.optional(),
}).superRefine((value, ctx) => {
  const end = value.period_end ? new Date(value.period_end).getTime() : Date.now();
  const start = value.period_start ? new Date(value.period_start).getTime() : end - 7 * 86_400_000;
  if (start > end) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['period_start'], message: 'period_start must not be after period_end' });
  } else if (end - start > 31 * 86_400_000) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['period_start'], message: 'Context analytics period cannot exceed 31 days' });
  }
});

const checkpointSchema = z.object({
  operation: z.enum(['create', 'get', 'history']),
  session_id: queueIdentifier,
  checkpoint_type: z.enum(['compression', 'manual', 'scheduled']).optional(),
  token_count_before: z.number().int().min(0).max(10_000_000).optional(),
  current_task: safeString(10_000).optional(),
  objective: safeString(10_000).optional(),
  decisions: z.array(z.object({
    timestamp: isoDatetime,
    decision: safeString(5_000),
    rationale: safeString(5_000).optional(),
    impact: safeString(5_000).optional(),
  })).max(100).optional(),
  pending_items: z.array(z.object({
    type: z.enum(['task', 'action', 'question', 'file']),
    description: safeString(5_000),
    priority: z.enum(['critical', 'high', 'medium', 'low']).optional(),
    due_by: isoDatetime.optional(),
  })).max(100).optional(),
  file_paths: z.array(safeString(1_000)).max(100).optional(),
  success_signal: safeString(5_000).optional(),
  compression_strategy: safeString(5_000).optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).superRefine((value, ctx) => {
  if (value.operation === 'create' && value.token_count_before === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['token_count_before'], message: 'token_count_before is required for create' });
  }
});

const contextMonitorSchema = z.object({
  operation: z.enum(['monitor', 'state']),
  session_id: queueIdentifier,
  current_usage: boundedTokenMap.optional(),
  max_tokens: z.number().int().min(1_000).max(10_000_000).optional(),
  thresholds: z.array(z.number().min(0).max(100)).max(10).optional(),
  top_n: z.number().int().min(1).max(20).optional(),
  trend_window_hours: z.number().int().min(1).max(720).optional(),
}).superRefine((value, ctx) => {
  if (value.operation === 'monitor' && value.current_usage === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['current_usage'], message: 'current_usage is required for monitor' });
  }
});

const budgetThresholds = z.object({
  warning_percent: z.number().min(0).max(100).optional(),
  critical_percent: z.number().min(0).max(100).optional(),
});
const budgetSchema = z.object({
  operation: z.enum(['set', 'check', 'list', 'apply_template']),
  budget_name: queueName.optional(),
  total_tokens: z.number().int().min(1_000).max(10_000_000).optional(),
  allocations: boundedTokenMap.optional(),
  thresholds: budgetThresholds.optional(),
  compression_trigger_percent: z.number().min(0).max(100).optional(),
  current_usage: boundedTokenMap.optional(),
  active_only: z.boolean().optional(),
  template: z.enum(['coding', 'research', 'conversation', 'automation']).optional(),
  custom_total_tokens: z.number().int().min(1_000).max(10_000_000).optional(),
  allocation_adjustments: boundedTokenMap.optional(),
}).superRefine((value, ctx) => {
  const required: Record<string, Array<keyof typeof value>> = {
    set: ['budget_name', 'total_tokens', 'allocations'],
    check: ['budget_name', 'current_usage'],
    apply_template: ['budget_name', 'template'],
  };
  for (const field of required[value.operation] || []) {
    if (value[field] === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `${String(field)} is required for ${value.operation}` });
    }
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
  pii: piiSchema,
  filter_memories: filterMemoriesSchema,
  batch_memories: batchMemoriesSchema,
  saved_searches: savedSearchesSchema,
  export_memories: exportMemoriesSchema,
  get_usage_analytics: dateRangeSchema,
  get_performance_metrics: dateRangeSchema,
  get_memory_growth: memoryGrowthSchema,
  get_category_breakdown: z.object({}).optional().default({}),
  get_pii_analytics: z.object({}).optional().default({}),
  build_report: buildReportSchema,
  pii_nlp_detect: piiNlpDetectSchema,
  pii_nlp_redact: piiNlpRedactSchema,
  pii_nlp_score: piiNlpDetectSchema,
  rlm_session: rlmSessionSchema,
  rlm_evaluate_ac: rlmEvaluateSchema,
  rlm_iteration: rlmIterationSchema,
  rlm_regenerate: rlmRegenerateSchema,
  work_queue: workQueueSchema,
  context_analytics: contextAnalyticsSchema,
  checkpoint: checkpointSchema,
  context_monitor: contextMonitorSchema,
  budget: budgetSchema,
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
    return {
      success: false,
      error: 'Validation failed: tool has no audited input schema',
      details: [{ field: '(root)', message: 'Tool input schema is unavailable' }],
    };
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
  evidence:    z.array(safeString(500)).max(50).optional(),
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
