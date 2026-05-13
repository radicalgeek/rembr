import promClient from 'prom-client';

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
  labelNames: ['operation', 'status', 'tenant_id'],
  registers: [register]
});

export const activeMemoriesGauge = new promClient.Gauge({
  name: 'rembr_active_memories',
  help: 'Current number of active memories by tenant',
  labelNames: ['tenant_id', 'project_id'],
  registers: [register]
});

export const searchDuration = new promClient.Histogram({
  name: 'rembr_search_duration_seconds',
  help: 'Duration of memory search operations',
  labelNames: ['search_mode', 'tenant_id'],
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
  labelNames: ['query_type', 'tenant_id'],
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
  labelNames: ['tool_name', 'status', 'tenant_id'],
  registers: [register]
});

export const mcpToolDuration = new promClient.Histogram({
  name: 'rembr_mcp_tool_duration_seconds',
  help: 'Duration of MCP tool execution',
  labelNames: ['tool_name', 'tenant_id'],
  registers: [register],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10]
});

export const mcpToolErrors = new promClient.Counter({
  name: 'rembr_mcp_tool_errors_total',
  help: 'Total number of MCP tool errors by type',
  labelNames: ['tool_name', 'error_type', 'tenant_id'],
  registers: [register]
});

// Embedding pipeline metrics
export const embeddingFailuresCounter = new promClient.Counter({
  name: 'rembr_embedding_failures_total',
  help: 'Total number of embedding generation failures',
  labelNames: ['reason', 'tenant_id'],
  registers: [register]
});

export const embeddingBacklogGauge = new promClient.Gauge({
  name: 'rembr_embedding_backlog',
  help: 'Number of memories without embeddings per tenant',
  labelNames: ['tenant_id'],
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
  labelNames: ['tenant_id'],
  registers: [register]
});

export const backgroundProcessingDuration = new promClient.Histogram({
  name: 'rembr_background_processing_duration_seconds',
  help: 'Duration of full background processing pipeline',
  labelNames: ['stage', 'status', 'tenant_id'],
  registers: [register],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60]
});

export const contradictionFailuresCounter = new promClient.Counter({
  name: 'rembr_contradiction_detection_failures_total',
  help: 'Total number of contradiction detection failures',
  labelNames: ['reason', 'tenant_id'],
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
  labelNames: ['operation_type', 'tenant_id'],
  registers: [register],
  buckets: [0.1, 0.5, 1, 5, 10, 30, 60, 120, 300]
});

export const duplicatesFoundCounter = new promClient.Counter({
  name: 'rembr_duplicates_found_total',
  help: 'Total number of duplicate memories found',
  labelNames: ['tenant_id'],
  registers: [register]
});

export const relationshipsInferredCounter = new promClient.Counter({
  name: 'rembr_relationships_inferred_total',
  help: 'Total number of relationships inferred',
  labelNames: ['tenant_id', 'relationship_type'],
  registers: [register]
});

export const graphQualityScoreGauge = new promClient.Gauge({
  name: 'rembr_graph_quality_score',
  help: 'Current graph quality score by tenant',
  labelNames: ['tenant_id'],
  registers: [register]
});

export const outdatedMemoriesCounter = new promClient.Counter({
  name: 'rembr_outdated_memories_total',
  help: 'Total number of outdated memories identified',
  labelNames: ['tenant_id'],
  registers: [register]
});

export { register };

// Helper function to get metrics
export async function getMetrics(): Promise<string> {
  return register.metrics();
}

// Helper to track HTTP requests
export function trackHttpRequest(req: any, res: any, startTime: number) {
  const duration = (Date.now() - startTime) / 1000;
  httpRequestDuration
    .labels(req.method, req.route?.path || req.path, res.statusCode.toString())
    .observe(duration);
}

// Helper to track memory operations
export function trackMemoryOperation(operation: string, status: 'success' | 'error', tenantId: string) {
  memoryOperationsCounter.labels(operation, status, tenantId).inc();
}

// Helper to update active memories gauge
export function updateActiveMemories(tenantId: string, projectId: string, count: number) {
  activeMemoriesGauge.labels(tenantId, projectId).set(count);
}

// Helper to track search operations
export function trackSearchOperation(searchMode: string, tenantId: string, duration: number) {
  searchDuration.labels(searchMode, tenantId).observe(duration);
}

// Helper to track embedding generation
export function trackEmbeddingGeneration(provider: string, model: string, duration: number) {
  embeddingGenerationDuration.labels(provider, model).observe(duration);
}

// Helper to track database queries
export function trackDatabaseQuery(queryType: string, tenantId: string, duration: number) {
  databaseQueryDuration.labels(queryType, tenantId).observe(duration);
}

// Helper to track authentication
export function trackAuthentication(method: 'api_key' | 'oauth' | 'session' | 'jwt' | 'none' | string, status: 'success' | 'error') {
  authenticationCounter.labels(method, status).inc();
}

// Helper to track cache hits
export function trackCacheHit(cacheType: 'embedding' | 'search') {
  embeddingCacheHits.labels(cacheType).inc();
}

// Helper to track MCP tool calls
export function trackMcpToolCall(
  toolName: string, 
  status: 'success' | 'error', 
  tenantId?: string,
  durationSeconds?: number
) {
  mcpToolCalls.labels(toolName, status, tenantId || 'unknown').inc();
  
  if (durationSeconds !== undefined && tenantId) {
    mcpToolDuration.labels(toolName, tenantId).observe(durationSeconds);
  }
}

// Helper to track MCP tool errors by type
export function trackMcpToolError(
  toolName: string,
  errorType: 'validation' | 'database' | 'embedding' | 'timeout' | 'not_found' | 'permission' | 'unknown',
  tenantId?: string
) {
  mcpToolErrors.labels(toolName, errorType, tenantId || 'unknown').inc();
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
  optimizationDuration.labels(operationType, tenantId).observe(durationSeconds);
  
  if (metrics) {
    if (metrics.duplicatesFound !== undefined) {
      duplicatesFoundCounter.labels(tenantId).inc(metrics.duplicatesFound);
    }
    if (metrics.relationshipsInferred !== undefined && metrics.relationshipType) {
      relationshipsInferredCounter.labels(tenantId, metrics.relationshipType).inc(metrics.relationshipsInferred);
    }
    if (metrics.graphQualityScore !== undefined) {
      graphQualityScoreGauge.labels(tenantId).set(metrics.graphQualityScore);
    }
    if (metrics.outdatedMemories !== undefined) {
      outdatedMemoriesCounter.labels(tenantId).inc(metrics.outdatedMemories);
    }
    if (metrics.contradictionsDetected !== undefined) {
      relationshipsInferredCounter.labels(tenantId, 'contradicts').inc(metrics.contradictionsDetected);
    }
  }
}

// Helper to track optimization cycles
export function trackOptimizationCycle(status: 'success' | 'error') {
  optimizationCyclesCounter.labels(status).inc();
}

// Helper to track embedding failures
export function trackEmbeddingFailure(
  reason: 'timeout' | 'ollama_down' | 'invalid_dims' | 'unknown',
  tenantId: string
) {
  embeddingFailuresCounter.labels(reason, tenantId).inc();
}

// Helper to track embedding backlog
export function updateEmbeddingBacklog(tenantId: string, count: number) {
  embeddingBacklogGauge.labels(tenantId).set(count);
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
  backgroundProcessingDuration.labels(stage, status, tenantId).observe(durationSeconds);
}

// Helper to track contradiction detection failures
export function trackContradictionFailure(
  reason: 'timeout' | 'ollama_down' | 'unknown',
  tenantId: string
) {
  contradictionFailuresCounter.labels(reason, tenantId).inc();
}