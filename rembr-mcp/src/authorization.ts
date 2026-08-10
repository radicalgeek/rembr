/**
 * Unified Authorization Layer (REM-253)
 * 
 * Provides a consistent authorization interface across all authentication methods:
 * - OAuth tokens
 * - API keys
 * - JWT tokens
 * - Sessions
 * 
 * Separates authentication (who you are) from authorization (what you can do).
 */

import type { AuthResult } from './auth.js';

// ---------------------------------------------------------------------------
// Authorization Context
// ---------------------------------------------------------------------------

/**
 * Represents a unified view of the authenticated principal's identity
 * and capabilities, regardless of which authentication method was used.
 */
export interface AuthorizationContext {
  /** Unique identifier for this tenant */
  tenantId: string;
  
  /** Optional project scope */
  projectId?: string;
  
  /** User ID (for OAuth/JWT) or undefined (for API keys) */
  userId?: string;
  
  /** API key ID if authenticated via API key */
  apiKeyId?: string;
  
  /** Session ID if authenticated via session cookie */
  sessionId?: string;
  
  /** Authentication method used */
  authMethod: 'oauth' | 'api_key' | 'jwt' | 'session';
  
  /** Timestamp when auth was verified */
  authenticatedAt: Date;

  /** Capabilities attached to the exact credential used for this request. */
  capabilities?: string[];
  
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Permission Types
// ---------------------------------------------------------------------------

/**
 * Resource types that can be authorized
 */
export type ResourceType = 
  | 'memory'
  | 'context'
  | 'snapshot'
  | 'project'
  | 'api_key'
  | 'admin';

/**
 * Actions that can be performed on resources
 */
export type Action = 
  | 'read'
  | 'write'
  | 'delete'
  | 'create'
  | 'list';

/**
 * Permission check request
 */
export interface PermissionRequest {
  context: AuthorizationContext;
  resource: ResourceType;
  action: Action;
  resourceId?: string;
  projectId?: string;
}

/**
 * Permission check result
 */
export interface PermissionResult {
  allowed: boolean;
  reason?: string;
  /** Additional context for debugging/logging */
  debug?: Record<string, unknown>;
}

export type McpCapability =
  | 'mcp:full'
  | 'memory:read'
  | 'memory:write'
  | 'context:manage'
  | 'snapshot:manage';

/**
 * The operation router used by the consolidated MCP surface. Keeping this
 * map beside the capability policy makes routing and authorisation testable as
 * one boundary. An absent operation is invalid and must never fall through.
 */
export const CONSOLIDATED_OPERATION_TARGETS: Record<string, Record<string, string>> = {
  memory: {
    create: 'store_memory', get: 'get_memory', update: 'update_memory',
    delete: 'delete_memory', list: 'list_memories',
    list_personal: 'list_personal_memories', set_visibility: 'set_memory_visibility',
    ingest: 'ingest_document',
  },
  search: {
    query: 'search_memory', smart: 'enhanced_search', similar: 'find_similar_memories',
  },
  stats: {
    usage: 'get_stats', embeddings: 'get_embedding_stats', insights: 'get_memory_insights',
    generate_insights: 'generate_memory_insights', predictions: 'get_predictive_analytics',
  },
  context: {
    create: 'create_context', list: 'list_contexts', search: 'search_context',
    add_memory: 'add_memory_to_context',
  },
  snapshot: {
    create: 'create_snapshot', get: 'get_snapshot', list: 'list_snapshots',
    create_temporal: 'create_temporal_snapshot', list_temporal: 'list_temporal_snapshots',
  },
  graph: {
    get: 'get_memory_graph', generate: 'generate_context_graph', insights: 'get_context_insights',
    infer: 'infer_memory_relationships', compare: 'compare_snapshots', explore: 'explore_relationships',
  },
  contradictions: { detect: 'detect_memory_contradictions' },
  causality: {
    infer: 'infer_causality', trace: 'trace_causality', get: 'get_causal_links',
    validate: 'validate_causal_link',
  },
  temporal: { search: 'search_at_time', history: 'get_memory_history' },
  audit: {
    query: 'query_audit_log', report: 'generate_compliance_report', stats: 'get_audit_stats',
  },
  classify: { intent: 'classify_query_intent' },
};

const MEMORY_WRITE_TOOLS = new Set([
  'store_memory', 'update_memory', 'delete_memory', 'set_memory_visibility',
  'ingest_document', 'batch_memories', 'upload_attachment', 'delete_attachment',
  'infer_memory_relationships', 'infer_causality', 'validate_causal_link',
  'compression', 'saved_searches',
]);

const SNAPSHOT_TOOLS = new Set([
  'create_snapshot', 'get_snapshot', 'list_snapshots', 'compare_snapshots',
  'create_temporal_snapshot', 'list_temporal_snapshots', 'snapshot_category_evolution',
  'snapshot_diff', 'snapshot_nearest', 'snapshot_timeline',
]);

const CONTEXT_TOOLS = new Set([
  'create_context', 'list_contexts', 'search_context', 'add_memory_to_context',
  'get_memory_graph', 'generate_context_graph', 'get_context_insights',
  'explore_relationships', 'context_analytics', 'checkpoint', 'context_monitor',
  'budget', 'manage_acceptance_criteria',
  'work_queue', 'manage_task', 'task_dependencies', 'task_search', 'task_state',
  'task_export', 'task_handoff', 'task_analytics', 'task_iterations',
  'rlm_session', 'rlm_iteration', 'rlm_evaluate_ac', 'rlm_regenerate',
  'plan_regeneration', 'plan_compaction',
]);

const FULL_ONLY_TOOLS = new Set([
  'query_audit_log', 'generate_compliance_report', 'get_audit_stats',
  'audit_alerts', 'audit_anomaly_detect', 'audit_evaluate_thresholds',
  'audit_health', 'audit_metrics', 'audit_metrics_prometheus',
  'gdpr', 'get_pii_analytics', 'build_report',
  'get_usage_analytics', 'get_performance_metrics', 'get_memory_growth',
  'get_category_breakdown',
]);

const KNOWN_MEMORY_READ_TOOLS = new Set([
  'search_memory', 'list_memories', 'list_personal_memories', 'get_memory',
  'enhanced_search', 'find_similar_memories', 'filter_memories', 'export_memories',
  'get_stats', 'get_embedding_stats', 'get_memory_insights', 'generate_memory_insights',
  'get_predictive_analytics', 'get_memory_history', 'get_storage_usage',
  'detect_contradictions', 'detect_memory_contradictions',
  'trace_causality', 'get_causal_links', 'search_at_time', 'classify_query_intent',
  'list_attachments', 'get_attachment_url', 'pii', 'pii_nlp_detect',
  'pii_nlp_redact', 'pii_nlp_score',
]);

const OPERATION_CAPABILITIES: Record<string, Record<string, McpCapability>> = {
  pii: {
    detect: 'memory:read',
    redact: 'memory:read',
    batch_scan: 'memory:write',
    audit: 'mcp:full',
    compliance_report: 'mcp:full',
  },
};

/**
 * Features whose checked-in service schema or audience model is not safe to
 * expose in this release. Even mcp:full cannot bypass this boundary.
 */
export const DISABLED_PENDING_ISOLATION = new Set([
  'manage_task', 'task_state', 'task_dependencies', 'task_search',
  'task_export', 'task_handoff', 'task_analytics', 'task_iterations',
  'manage_acceptance_criteria', 'plan_regeneration', 'plan_compaction',
  'work_queue',
  'rlm_session', 'rlm_iteration', 'rlm_evaluate_ac', 'rlm_regenerate',
  'infer_causality', 'trace_causality', 'get_causal_links', 'validate_causal_link',
  'query_audit_log', 'generate_compliance_report', 'get_audit_stats',
  'audit_alerts', 'audit_anomaly_detect', 'audit_evaluate_thresholds',
  'audit_health', 'audit_metrics', 'audit_metrics_prometheus',
  'gdpr',
  'generate_memory_insights', 'get_predictive_analytics',
  'compare_snapshots',
  'snapshot_timeline', 'snapshot_diff', 'snapshot_nearest',
  'snapshot_category_evolution',
  // The implementation is retained for a future object-store rollout, but
  // the hosted release has no configured object store or permitted storage
  // network path. Keep every attachment entry point undiscoverable and deny
  // dispatch even to mcp:full until that deployment contract is exercised.
  'upload_attachment', 'list_attachments', 'get_attachment_url',
  'delete_attachment', 'get_storage_usage',
]);

export function isToolDisabledForDiscovery(toolName: string): boolean {
  if (DISABLED_PENDING_ISOLATION.has(toolName)) return true;
  const operations = CONSOLIDATED_OPERATION_TARGETS[toolName];
  return !!operations && Object.values(operations).length > 0
    && Object.values(operations).every(target => DISABLED_PENDING_ISOLATION.has(target));
}

/**
 * Remove unavailable operations from partially enabled consolidated schemas.
 * A denied operation must not remain in tools/list merely because another
 * operation in the same consolidated family is safe. Operation-specific
 * properties carrying a leading `[operation]` tag are pruned at the same time.
 */
export function pruneToolForDiscovery<T extends { name: string; description?: string }>(tool: T): T | null {
  if (DISABLED_PENDING_ISOLATION.has(tool.name)) return null;
  const routedOperations = CONSOLIDATED_OPERATION_TARGETS[tool.name];
  if (!routedOperations) return tool;

  const inputSchema = (tool as any).inputSchema as Record<string, any> | undefined;
  const properties = inputSchema?.properties as Record<string, any> | undefined;
  const advertised = properties?.operation?.enum;
  if (!Array.isArray(advertised)) return null;

  const allowedOperations = advertised.filter((operation): operation is string =>
    typeof operation === 'string' &&
    !!routedOperations[operation] &&
    !DISABLED_PENDING_ISOLATION.has(routedOperations[operation]),
  );
  if (allowedOperations.length === 0) return null;
  if (allowedOperations.length === advertised.length) return tool;

  const allowed = new Set(allowedOperations);
  const nextProperties: Record<string, any> = {};
  for (const [propertyName, property] of Object.entries(properties || {})) {
    if (propertyName === 'operation') {
      nextProperties[propertyName] = { ...property, enum: allowedOperations };
      continue;
    }

    const operationTag = typeof property.description === 'string'
      ? /^\[([^\]]+)\]/.exec(property.description)
      : null;
    if (operationTag) {
      const taggedOperations = operationTag[1]
        .split(/[\/,]/)
        .map(value => value.trim())
        .filter(Boolean);
      if (taggedOperations.length > 0 && taggedOperations.every(operation => !allowed.has(operation))) {
        continue;
      }
    }
    nextProperties[propertyName] = { ...property };
  }

  const summary = typeof tool.description === 'string'
    ? tool.description.split(/(?<=\.)\s/, 1)[0]
    : `${tool.name} operations.`;
  return {
    ...tool,
    description: `${summary} Available operations: ${allowedOperations.join(', ')}.`,
    inputSchema: {
      ...inputSchema,
      properties: nextProperties,
    },
  } as T;
}

/**
 * Advanced agent state that still has a tenant-only storage model. It is safe
 * for the short-lived bootstrap principal in its isolated unclaimed tenant,
 * but must not be exposed to human/project credentials until the tables carry
 * explicit owner/project audience columns.
 */
export const BOOTSTRAP_ONLY_TENANT_STATE_TOOLS = new Set([
  'context_monitor', 'context_analytics', 'checkpoint', 'budget',
]);

export function canUseBootstrapOnlyTenantState(purpose?: string, userId?: string): boolean {
  return purpose === 'agent_bootstrap' && !userId;
}

/** Expand legacy aggregate OAuth scopes into the canonical capability model. */
export function canonicaliseCapabilities(values: readonly string[] | undefined): Set<string> {
  const result = new Set(values || []);
  if (result.has('mcp:read') || result.has('read:memories')) result.add('memory:read');
  if (result.has('write:memories')) {
    result.add('memory:read');
    result.add('memory:write');
  }
  if (result.has('mcp:write')) {
    result.add('memory:read');
    result.add('memory:write');
    result.add('context:manage');
    result.add('snapshot:manage');
  }
  return result;
}

/**
 * Tenant-wide counters are broader than ordinary memory visibility. They are
 * available only to an unscoped full credential or to the userless bootstrap
 * principal of its own isolated tenant.
 */
export function canReadTenantAggregates(
  capabilities: readonly string[] | undefined,
  purpose: string | undefined,
  userId: string | undefined,
  projectId: string | undefined,
): boolean {
  if (projectId) return false;
  return canonicaliseCapabilities(capabilities).has('mcp:full') ||
    (purpose === 'agent_bootstrap' && !userId);
}

/**
 * Determine the one capability needed for an MCP tool call.
 * Unknown tools are deliberately full-only so newly added operations cannot
 * silently bypass the policy matrix.
 */
export function requiredCapabilityForTool(toolName: string): McpCapability {
  if (FULL_ONLY_TOOLS.has(toolName)) return 'mcp:full';
  if (MEMORY_WRITE_TOOLS.has(toolName)) return 'memory:write';
  if (SNAPSHOT_TOOLS.has(toolName)) return 'snapshot:manage';
  if (CONTEXT_TOOLS.has(toolName)) return 'context:manage';
  if (KNOWN_MEMORY_READ_TOOLS.has(toolName)) return 'memory:read';
  return 'mcp:full';
}

function isExplicitlyClassifiedTool(toolName: string): boolean {
  return FULL_ONLY_TOOLS.has(toolName) ||
    MEMORY_WRITE_TOOLS.has(toolName) ||
    SNAPSHOT_TOOLS.has(toolName) ||
    CONTEXT_TOOLS.has(toolName) ||
    KNOWN_MEMORY_READ_TOOLS.has(toolName);
}

export function resolveToolForAuthorization(toolName: string, operation?: string): string | null {
  const operations = CONSOLIDATED_OPERATION_TARGETS[toolName];
  if (!operations) {
    const operationCapabilities = OPERATION_CAPABILITIES[toolName];
    if (!operationCapabilities) return isExplicitlyClassifiedTool(toolName) ? toolName : null;
    if (!operation || !operationCapabilities[operation]) return null;
    return toolName;
  }
  if (!operation) return null;
  return operations[operation] || null;
}

export function authorizeToolCall(
  capabilities: readonly string[] | undefined,
  toolName: string,
  operation?: string,
): PermissionResult & { requiredCapability: McpCapability } {
  const resolvedTool = resolveToolForAuthorization(toolName, operation);
  if (!resolvedTool) {
    return {
      allowed: false,
      requiredCapability: 'mcp:full',
      reason: `Unknown or missing operation for consolidated tool: ${toolName}`,
    };
  }
  if (DISABLED_PENDING_ISOLATION.has(resolvedTool)) {
    return {
      allowed: false,
      requiredCapability: 'mcp:full',
      reason: `Tool is unavailable pending tenant and audience isolation: ${resolvedTool}`,
    };
  }
  const granted = canonicaliseCapabilities(capabilities);
  const requiredCapability = OPERATION_CAPABILITIES[resolvedTool]?.[operation || ''] ||
    requiredCapabilityForTool(resolvedTool);
  const allowed = granted.has('mcp:full') || granted.has(requiredCapability);
  return {
    allowed,
    requiredCapability,
    reason: allowed ? undefined : `Credential lacks required capability: ${requiredCapability}`,
  };
}

// ---------------------------------------------------------------------------
// Authorization Policy Interface
// ---------------------------------------------------------------------------

/**
 * Interface for authorization policies.
 * Implement this to add custom authorization logic.
 */
export interface AuthorizationPolicy {
  name: string;
  priority: number; // Lower = evaluated first
  
  /**
   * Check if this policy applies to the given request.
   */
  appliesTo(request: PermissionRequest): boolean;
  
  /**
   * Evaluate the permission request.
   * Return undefined to pass through to next policy.
   */
  evaluate(request: PermissionRequest): PermissionResult | undefined;
}

// ---------------------------------------------------------------------------
// Built-in Policies
// ---------------------------------------------------------------------------

/**
 * Base policy: All authenticated users can read/write their own tenant's data
 */
export class TenantIsolationPolicy implements AuthorizationPolicy {
  name = 'TenantIsolation';
  priority = 100; // High priority (evaluated early)
  
  appliesTo(request: PermissionRequest): boolean {
    return true; // Applies to all requests
  }
  
  evaluate(request: PermissionRequest): PermissionResult {
    const { context, resource, action } = request;
    
    // Admin operations require explicit admin role (handled by AdminPolicy)
    if (resource === 'admin') {
      return { allowed: false, reason: 'Admin operations require admin role' };
    }
    
    // All authenticated users can perform actions on their tenant's resources
    // (specific project scoping is handled by ProjectScopePolicy)
    return { allowed: true };
  }
}

/**
 * Project scope policy: Enforce project-level isolation when projectId is present
 */
export class ProjectScopePolicy implements AuthorizationPolicy {
  name = 'ProjectScope';
  priority = 90;
  
  appliesTo(request: PermissionRequest): boolean {
    // Only applies when both auth context and request specify project
    return !!(request.context.projectId && request.projectId);
  }
  
  evaluate(request: PermissionRequest): PermissionResult {
    const { context, projectId } = request;
    
    // If auth context has a project scope, can only access that project
    if (context.projectId && projectId && context.projectId !== projectId) {
      return {
        allowed: false,
        reason: `Access denied: authenticated project ${context.projectId} cannot access project ${projectId}`
      };
    }
    
    return { allowed: true };
  }
}

/**
 * API Key restrictions policy: API keys may have restricted permissions
 * (Future: can be extended to support scoped API keys)
 */
export class ApiKeyPolicy implements AuthorizationPolicy {
  name = 'ApiKeyRestrictions';
  priority = 80;
  
  appliesTo(request: PermissionRequest): boolean {
    return request.context.authMethod === 'api_key';
  }
  
  evaluate(request: PermissionRequest): PermissionResult {
    const { resource, action } = request;
    
    // API keys cannot perform admin operations
    if (resource === 'admin') {
      return {
        allowed: false,
        reason: 'API keys cannot perform admin operations'
      };
    }
    
    // API keys cannot create other API keys (prevent key proliferation)
    if (resource === 'api_key' && action === 'create') {
      return {
        allowed: false,
        reason: 'API keys cannot create other API keys'
      };
    }
    
    // All other operations allowed
    return { allowed: true };
  }
}

// ---------------------------------------------------------------------------
// Authorization Service
// ---------------------------------------------------------------------------

export class AuthorizationService {
  private policies: AuthorizationPolicy[] = [];
  
  constructor(policies?: AuthorizationPolicy[]) {
    // Register default policies
    this.registerPolicy(new TenantIsolationPolicy());
    this.registerPolicy(new ProjectScopePolicy());
    this.registerPolicy(new ApiKeyPolicy());
    
    // Register custom policies
    if (policies) {
      policies.forEach(p => this.registerPolicy(p));
    }
  }
  
  /**
   * Register a custom authorization policy
   */
  registerPolicy(policy: AuthorizationPolicy): void {
    this.policies.push(policy);
    // Sort by priority (lower first)
    this.policies.sort((a, b) => a.priority - b.priority);
  }
  
  /**
   * Create authorization context from authentication result
   */
  createContext(
    authResult: AuthResult,
    authMethod: AuthorizationContext['authMethod']
  ): AuthorizationContext {
    if (!authResult.success || !authResult.tenantId) {
      throw new Error('Cannot create authorization context from failed auth result');
    }
    
    return {
      tenantId: authResult.tenantId,
      projectId: authResult.projectId,
      userId: authResult.userId,
      apiKeyId: authResult.apiKeyId,
      sessionId: authResult.sessionId,
      authMethod,
      authenticatedAt: new Date(),
      capabilities: authResult.capabilities || []
    };
  }
  
  /**
   * Check if a permission is allowed
   */
  checkPermission(request: PermissionRequest): PermissionResult {
    let explicitlyAllowed = false;

    // Evaluate policies in priority order
    for (const policy of this.policies) {
      if (!policy.appliesTo(request)) {
        continue;
      }
      
      const result = policy.evaluate(request);
      if (result !== undefined) {
        // Policy made a decision
        if (!result.allowed) {
          // First deny wins (fail-closed)
          return result;
        }
        explicitlyAllowed = true;
      }
    }

    return explicitlyAllowed
      ? { allowed: true }
      : { allowed: false, reason: 'No authorization policy explicitly allowed this request' };
  }
  
  /**
   * Convenience method: Check read permission
   */
  canRead(
    context: AuthorizationContext,
    resource: ResourceType,
    resourceId?: string,
    projectId?: string
  ): PermissionResult {
    return this.checkPermission({
      context,
      resource,
      action: 'read',
      resourceId,
      projectId
    });
  }
  
  /**
   * Convenience method: Check write permission
   */
  canWrite(
    context: AuthorizationContext,
    resource: ResourceType,
    resourceId?: string,
    projectId?: string
  ): PermissionResult {
    return this.checkPermission({
      context,
      resource,
      action: 'write',
      resourceId,
      projectId
    });
  }
  
  /**
   * Convenience method: Check delete permission
   */
  canDelete(
    context: AuthorizationContext,
    resource: ResourceType,
    resourceId?: string,
    projectId?: string
  ): PermissionResult {
    return this.checkPermission({
      context,
      resource,
      action: 'delete',
      resourceId,
      projectId
    });
  }
  
  /**
   * Convenience method: Check create permission
   */
  canCreate(
    context: AuthorizationContext,
    resource: ResourceType,
    projectId?: string
  ): PermissionResult {
    return this.checkPermission({
      context,
      resource,
      action: 'create',
      projectId
    });
  }
  
  /**
   * Convenience method: Check list permission
   */
  canList(
    context: AuthorizationContext,
    resource: ResourceType,
    projectId?: string
  ): PermissionResult {
    return this.checkPermission({
      context,
      resource,
      action: 'list',
      projectId
    });
  }
}

// ---------------------------------------------------------------------------
// Export default instance
// ---------------------------------------------------------------------------

export const defaultAuthorizationService = new AuthorizationService();
