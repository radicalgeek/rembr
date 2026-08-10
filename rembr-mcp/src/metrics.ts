import promClient from 'prom-client';
import { toolSchemas } from './schemas.js';

// Create a Registry to register metrics
const register = new promClient.Registry();

// Add default Node.js metrics
promClient.collectDefaultMetrics({ register });

// Custom REMBR metrics
export const httpRequestDuration = new promClient.Histogram({
  name: 'rembr_http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
});

export const memoryOperationsCounter = new promClient.Counter({
  name: 'rembr_memory_operations_total',
  help: 'Total number of memory operations',
  labelNames: ['operation', 'status'],
  registers: [register]
});

export const activeMemoriesGauge = new promClient.Gauge({
  name: 'rembr_active_memories',
  help: 'Most recently observed active-memory count (tenant identifiers deliberately omitted)',
  registers: [register]
});

export const searchDuration = new promClient.Histogram({
  name: 'rembr_search_duration_seconds',
  help: 'Duration of memory search operations',
  labelNames: ['search_mode'],
  registers: [register],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2]
});

export const embeddingGenerationDuration = new promClient.Histogram({
  name: 'rembr_embedding_generation_duration_seconds',
  help: 'Duration of embedding generation',
  labelNames: ['provider', 'model'],
  registers: [register],
  buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 20]
});

export const databaseQueryDuration = new promClient.Histogram({
  name: 'rembr_database_query_duration_seconds',
  help: 'Duration of database queries',
  labelNames: ['query_type'],
  registers: [register],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1]
});

export const authenticationCounter = new promClient.Counter({
  name: 'rembr_authentication_attempts_total',
  help: 'Total number of authentication attempts',
  labelNames: ['method', 'status'],
  registers: [register]
});

export const embeddingCacheHits = new promClient.Counter({
  name: 'rembr_embedding_cache_hits_total',
  help: 'Total number of embedding cache hits',
  labelNames: ['cache_type'],
  registers: [register]
});

export const mcpToolCalls = new promClient.Counter({
  name: 'rembr_mcp_tool_calls_total',
  help: 'Total number of MCP tool calls',
  labelNames: ['tool_name', 'status'],
  registers: [register]
});

export const mcpToolDuration = new promClient.Histogram({
  name: 'rembr_mcp_tool_duration_seconds',
  help: 'Duration of MCP tool execution',
  labelNames: ['tool_name'],
  registers: [register],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10]
});

export const mcpToolErrors = new promClient.Counter({
  name: 'rembr_mcp_tool_errors_total',
  help: 'Total number of MCP tool errors by type',
  labelNames: ['tool_name', 'error_type'],
  registers: [register]
});

// Embedding pipeline metrics
export const embeddingFailuresCounter = new promClient.Counter({
  name: 'rembr_embedding_failures_total',
  help: 'Total number of embedding generation failures',
  labelNames: ['reason'],
  registers: [register]
});

export const embeddingBacklogGauge = new promClient.Gauge({
  name: 'rembr_embedding_backlog',
  help: 'Most recently observed embedding backlog (tenant identifiers deliberately omitted)',
  registers: [register]
});

export const embeddingInflightGauge = new promClient.Gauge({
  name: 'rembr_embedding_inflight',
  help: 'Number of embedding generation jobs currently in-flight',
  registers: [register]
});

export const embeddingRetryCounter = new promClient.Counter({
  name: 'rembr_embedding_retry_total',
  help: 'Total number of embedding retry attempts',
  registers: [register]
});

export const backgroundProcessingDuration = new promClient.Histogram({
  name: 'rembr_background_processing_duration_seconds',
  help: 'Duration of full background processing pipeline',
  labelNames: ['stage', 'status'],
  registers: [register],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60]
});

export const contradictionFailuresCounter = new promClient.Counter({
  name: 'rembr_contradiction_detection_failures_total',
  help: 'Total number of contradiction detection failures',
  labelNames: ['reason'],
  registers: [register]
});

// Auto-optimization metrics
export const optimizationCyclesCounter = new promClient.Counter({
  name: 'rembr_optimization_cycles_total',
  help: 'Total number of optimization cycles run',
  labelNames: ['status'],
  registers: [register]
});

export const optimizationDuration = new promClient.Histogram({
  name: 'rembr_optimization_duration_seconds',
  help: 'Duration of optimization operations',
  labelNames: ['operation_type'],
  registers: [register],
  buckets: [0.1, 0.5, 1, 5, 10, 30, 60, 120, 300]
});

export const duplicatesFoundCounter = new promClient.Counter({
  name: 'rembr_duplicates_found_total',
  help: 'Total number of duplicate memories found',
  registers: [register]
});

export const relationshipsInferredCounter = new promClient.Counter({
  name: 'rembr_relationships_inferred_total',
  help: 'Total number of relationships inferred',
  labelNames: ['relationship_type'],
  registers: [register]
});

export const graphQualityScoreGauge = new promClient.Gauge({
  name: 'rembr_graph_quality_score',
  help: 'Most recently observed graph quality score (tenant identifiers deliberately omitted)',
  registers: [register]
});

export const outdatedMemoriesCounter = new promClient.Counter({
  name: 'rembr_outdated_memories_total',
  help: 'Total number of outdated memories identified',
  registers: [register]
});

export { register };

const KNOWN_TOOL_LABELS = new Set([...Object.keys(toolSchemas), 'unknown']);
const MEMORY_OPERATION_LABELS = new Set(['store', 'get', 'search', 'list', 'update', 'delete', 'unknown']);
const SEARCH_MODE_LABELS = new Set(['text', 'semantic', 'hybrid', 'phrase', 'unknown']);
const QUERY_TYPE_LABELS = new Set(['select', 'insert', 'update', 'delete', 'transaction', 'unknown']);
const AUTH_METHOD_LABELS = new Set(['api_key', 'oauth', 'session', 'jwt', 'none', 'unknown']);
const STATUS_LABELS = new Set(['success', 'error', 'unknown']);
const CACHE_TYPE_LABELS = new Set(['embedding', 'search', 'unknown']);
const ERROR_TYPE_LABELS = new Set(['validation', 'database', 'embedding', 'timeout', 'not_found', 'permission', 'unknown']);
const EMBEDDING_PROVIDER_LABELS = new Set(['ollama', 'openai-compatible', 'unknown']);
const EMBEDDING_MODEL_LABELS = new Set([
  'nomic-embed-text', 'mxbai-embed-large', 'all-minilm',
  'text-embedding-3-small', 'text-embedding-3-large', 'custom',
]);
const OPTIMIZATION_OPERATION_LABELS = new Set([
  'deduplication', 'temporal', 'relationships', 'quality', 'full_cycle', 'contradictions', 'unknown',
]);
const EMBEDDING_FAILURE_LABELS = new Set(['timeout', 'ollama_down', 'invalid_dims', 'unknown']);
const BACKGROUND_STAGE_LABELS = new Set(['embedding', 'relationship', 'contradiction', 'unknown']);
const CONTRADICTION_FAILURE_LABELS = new Set(['timeout', 'ollama_down', 'unknown']);
const RELATIONSHIP_TYPE_LABELS = new Set([
  'related_to', 'contradicts', 'supports', 'causes', 'similar_to',
  'temporal', 'dependency', 'other',
]);

function boundedLabel(value: unknown, allowed: ReadonlySet<string>): string {
  return typeof value === 'string' && allowed.has(value) ? value : 'unknown';
}

function boundedRoute(req: any): string {
  const path = typeof req?.route?.path === 'string' ? req.route.path : req?.path;
  if (path === '/mcp' || path === '/health' || path === '/health/details' || path === '/metrics') return path;
  if (typeof path === 'string' && path.startsWith('/.well-known/')) return '/.well-known/*';
  if (typeof path === 'string' && path.startsWith('/admin/')) return '/admin/*';
  return 'other';
}

// Helper function to get metrics
export async function getMetrics(): Promise<string> {
  return register.metrics();
}

// Helper to track HTTP requests
export function trackHttpRequest(req: any, res: any, startTime: number) {
  const duration = (Date.now() - startTime) / 1000;
  httpRequestDuration
    .labels(
      ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(req.method) ? req.method : 'OTHER',
      boundedRoute(req),
      `${Math.floor(Number(res.statusCode) / 100)}xx`,
    )
    .observe(duration);
}

// Helper to track memory operations
export function trackMemoryOperation(operation: string, status: 'success' | 'error', tenantId: string) {
  void tenantId;
  memoryOperationsCounter.labels(
    boundedLabel(operation, MEMORY_OPERATION_LABELS),
    boundedLabel(status, STATUS_LABELS),
  ).inc();
}

// Helper to update active memories gauge
export function updateActiveMemories(tenantId: string, projectId: string, count: number) {
  void tenantId;
  void projectId;
  activeMemoriesGauge.set(count);
}

// Helper to track search operations
export function trackSearchOperation(searchMode: string, tenantId: string, duration: number) {
  void tenantId;
  searchDuration.labels(boundedLabel(searchMode, SEARCH_MODE_LABELS)).observe(duration);
}

// Helper to track embedding generation
export function trackEmbeddingGeneration(provider: string, model: string, duration: number) {
  embeddingGenerationDuration.labels(
    boundedLabel(provider, EMBEDDING_PROVIDER_LABELS),
    boundedLabel(model, EMBEDDING_MODEL_LABELS) === 'unknown' ? 'custom' : boundedLabel(model, EMBEDDING_MODEL_LABELS),
  ).observe(duration);
}

// Helper to track database queries
export function trackDatabaseQuery(queryType: string, tenantId: string, duration: number) {
  void tenantId;
  databaseQueryDuration.labels(boundedLabel(queryType, QUERY_TYPE_LABELS)).observe(duration);
}

// Helper to track authentication
export function trackAuthentication(method: 'api_key' | 'oauth' | 'session' | 'jwt' | 'none' | string, status: 'success' | 'error') {
  authenticationCounter.labels(
    boundedLabel(method, AUTH_METHOD_LABELS),
    boundedLabel(status, STATUS_LABELS),
  ).inc();
}

// Helper to track cache hits
export function trackCacheHit(cacheType: 'embedding' | 'search') {
  embeddingCacheHits.labels(boundedLabel(cacheType, CACHE_TYPE_LABELS)).inc();
}

// Helper to track MCP tool calls
export function trackMcpToolCall(
  toolName: string, 
  status: 'success' | 'error', 
  tenantId?: string,
  durationSeconds?: number
) {
  void tenantId;
  const safeTool = boundedLabel(toolName, KNOWN_TOOL_LABELS);
  mcpToolCalls.labels(safeTool, boundedLabel(status, STATUS_LABELS)).inc();
  
  if (durationSeconds !== undefined) {
    mcpToolDuration.labels(safeTool).observe(durationSeconds);
  }
}

// Helper to track MCP tool errors by type
export function trackMcpToolError(
  toolName: string,
  errorType: 'validation' | 'database' | 'embedding' | 'timeout' | 'not_found' | 'permission' | 'unknown',
  tenantId?: string
) {
  void tenantId;
  mcpToolErrors.labels(
    boundedLabel(toolName, KNOWN_TOOL_LABELS),
    boundedLabel(errorType, ERROR_TYPE_LABELS),
  ).inc();
}

// Helper to track optimization operations
export function trackOptimization(
  operationType: 'deduplication' | 'temporal' | 'relationships' | 'quality' | 'full_cycle' | 'contradictions',
  tenantId: string,
  durationSeconds: number,
  metrics?: {
    duplicatesFound?: number;
    relationshipsInferred?: number;
    relationshipType?: string;
    graphQualityScore?: number;
    outdatedMemories?: number;
    contradictionsDetected?: number;
    memoriesScanned?: number;
  }
) {
  void tenantId;
  optimizationDuration.labels(boundedLabel(operationType, OPTIMIZATION_OPERATION_LABELS)).observe(durationSeconds);
  
  if (metrics) {
    if (metrics.duplicatesFound !== undefined) {
      duplicatesFoundCounter.inc(metrics.duplicatesFound);
    }
    if (metrics.relationshipsInferred !== undefined && metrics.relationshipType) {
      relationshipsInferredCounter.labels(boundedLabel(metrics.relationshipType, RELATIONSHIP_TYPE_LABELS)).inc(metrics.relationshipsInferred);
    }
    if (metrics.graphQualityScore !== undefined) {
      graphQualityScoreGauge.set(metrics.graphQualityScore);
    }
    if (metrics.outdatedMemories !== undefined) {
      outdatedMemoriesCounter.inc(metrics.outdatedMemories);
    }
    if (metrics.contradictionsDetected !== undefined) {
      relationshipsInferredCounter.labels('contradicts').inc(metrics.contradictionsDetected);
    }
  }
}

// Helper to track optimization cycles
export function trackOptimizationCycle(status: 'success' | 'error') {
  optimizationCyclesCounter.labels(boundedLabel(status, STATUS_LABELS)).inc();
}

// Helper to track embedding failures
export function trackEmbeddingFailure(
  reason: 'timeout' | 'ollama_down' | 'invalid_dims' | 'unknown',
  tenantId: string
) {
  void tenantId;
  embeddingFailuresCounter.labels(boundedLabel(reason, EMBEDDING_FAILURE_LABELS)).inc();
}

// Helper to track embedding backlog
export function updateEmbeddingBacklog(tenantId: string, count: number) {
  void tenantId;
  embeddingBacklogGauge.set(count);
}

// Helper to track in-flight embeddings
export function trackEmbeddingInflight(delta: number) {
  embeddingInflightGauge.inc(delta);
}

// Helper to track background processing stages
export function trackBackgroundProcessing(
  stage: 'embedding' | 'relationship' | 'contradiction',
  status: 'success' | 'error',
  tenantId: string,
  durationSeconds: number
) {
  void tenantId;
  backgroundProcessingDuration.labels(
    boundedLabel(stage, BACKGROUND_STAGE_LABELS),
    boundedLabel(status, STATUS_LABELS),
  ).observe(durationSeconds);
}

// Helper to track contradiction detection failures
export function trackContradictionFailure(
  reason: 'timeout' | 'ollama_down' | 'unknown',
  tenantId: string
) {
  void tenantId;
  contradictionFailuresCounter.labels(boundedLabel(reason, CONTRADICTION_FAILURE_LABELS)).inc();
}
