/**
 * Authorization Layer Tests (REM-253)
 * 
 * Tests unified authorization across OAuth, API Key, JWT, and Session auth methods.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  AuthorizationService,
  AuthorizationContext,
  TenantIsolationPolicy,
  ProjectScopePolicy,
  ApiKeyPolicy,
  authorizeToolCall,
  BOOTSTRAP_ONLY_TENANT_STATE_TOOLS,
  canReadTenantAggregates,
  canUseBootstrapOnlyTenantState,
  CONSOLIDATED_OPERATION_TARGETS,
  DISABLED_PENDING_ISOLATION,
  isToolDisabledForDiscovery,
  pruneToolForDiscovery,
  requiredCapabilityForTool,
  resolveToolForAuthorization,
  type AuthorizationPolicy,
  type PermissionRequest,
  type PermissionResult
} from './authorization.js';
import type { AuthResult } from './auth.js';
import { getConsolidatedTools } from './tools/consolidated-tools.js';

describe('AuthorizationService', () => {
  let authService: AuthorizationService;
  
  beforeEach(() => {
    authService = new AuthorizationService();
  });
  
  describe('createContext', () => {
    it('should create context from OAuth auth result', () => {
      const authResult: AuthResult = {
        success: true,
        tenantId: 'tenant-123',
        projectId: 'project-456',
        userId: 'user-789'
      };
      
      const context = authService.createContext(authResult, 'oauth');
      
      expect(context.tenantId).toBe('tenant-123');
      expect(context.projectId).toBe('project-456');
      expect(context.userId).toBe('user-789');
      expect(context.authMethod).toBe('oauth');
      expect(context.authenticatedAt).toBeInstanceOf(Date);
    });
    
    it('should create context from API key auth result', () => {
      const authResult: AuthResult = {
        success: true,
        tenantId: 'tenant-123',
        apiKeyId: 'key-abc'
      };
      
      const context = authService.createContext(authResult, 'api_key');
      
      expect(context.tenantId).toBe('tenant-123');
      expect(context.apiKeyId).toBe('key-abc');
      expect(context.authMethod).toBe('api_key');
      expect(context.userId).toBeUndefined();
    });
    
    it('should throw error for failed auth result', () => {
      const authResult: AuthResult = {
        success: false,
        error: 'Authentication failed'
      };
      
      expect(() => authService.createContext(authResult, 'oauth'))
        .toThrow('Cannot create authorization context from failed auth result');
    });
  });
  
  describe('TenantIsolationPolicy', () => {
    it('should allow operations within same tenant', () => {
      const context: AuthorizationContext = {
        tenantId: 'tenant-123',
        authMethod: 'oauth',
        authenticatedAt: new Date()
      };
      
      const result = authService.canRead(context, 'memory');
      expect(result.allowed).toBe(true);
    });
    
    it('should deny admin operations without admin role', () => {
      const context: AuthorizationContext = {
        tenantId: 'tenant-123',
        authMethod: 'oauth',
        authenticatedAt: new Date()
      };
      
      const result = authService.canRead(context, 'admin');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('admin role');
    });
  });
  
  describe('ProjectScopePolicy', () => {
    it('should allow access when auth project matches resource project', () => {
      const context: AuthorizationContext = {
        tenantId: 'tenant-123',
        projectId: 'project-456',
        authMethod: 'oauth',
        authenticatedAt: new Date()
      };
      
      const result = authService.canRead(context, 'memory', 'memory-id', 'project-456');
      expect(result.allowed).toBe(true);
    });
    
    it('should deny access when auth project differs from resource project', () => {
      const context: AuthorizationContext = {
        tenantId: 'tenant-123',
        projectId: 'project-456',
        authMethod: 'oauth',
        authenticatedAt: new Date()
      };
      
      const result = authService.canRead(context, 'memory', 'memory-id', 'project-999');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('cannot access project');
    });
    
    it('should allow access when no project scope in auth context', () => {
      const context: AuthorizationContext = {
        tenantId: 'tenant-123',
        authMethod: 'oauth',
        authenticatedAt: new Date()
      };
      
      const result = authService.canRead(context, 'memory', 'memory-id', 'project-456');
      expect(result.allowed).toBe(true);
    });
  });
  
  describe('ApiKeyPolicy', () => {
    it('should deny admin operations for API keys', () => {
      const context: AuthorizationContext = {
        tenantId: 'tenant-123',
        apiKeyId: 'key-abc',
        authMethod: 'api_key',
        authenticatedAt: new Date()
      };
      
      const result = authService.canRead(context, 'admin');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('API keys cannot perform admin operations');
    });
    
    it('should deny API key creation by API keys', () => {
      const context: AuthorizationContext = {
        tenantId: 'tenant-123',
        apiKeyId: 'key-abc',
        authMethod: 'api_key',
        authenticatedAt: new Date()
      };
      
      const result = authService.canCreate(context, 'api_key');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('cannot create other API keys');
    });
    
    it('should allow memory operations for API keys', () => {
      const context: AuthorizationContext = {
        tenantId: 'tenant-123',
        apiKeyId: 'key-abc',
        authMethod: 'api_key',
        authenticatedAt: new Date()
      };
      
      const result = authService.canWrite(context, 'memory');
      expect(result.allowed).toBe(true);
    });
  });
  
  describe('Custom policies', () => {
    it('should register and evaluate custom policy', () => {
      class ReadOnlyPolicy implements AuthorizationPolicy {
        name = 'ReadOnly';
        priority = 50;
        
        appliesTo(request: PermissionRequest): boolean {
          return request.action === 'write' || request.action === 'delete';
        }
        
        evaluate(request: PermissionRequest): PermissionResult {
          return {
            allowed: false,
            reason: 'Read-only mode enforced'
          };
        }
      }
      
      const service = new AuthorizationService([new ReadOnlyPolicy()]);
      
      const context: AuthorizationContext = {
        tenantId: 'tenant-123',
        authMethod: 'oauth',
        authenticatedAt: new Date()
      };
      
      // Read should be allowed
      expect(service.canRead(context, 'memory').allowed).toBe(true);
      
      // Write should be denied by custom policy
      const writeResult = service.canWrite(context, 'memory');
      expect(writeResult.allowed).toBe(false);
      expect(writeResult.reason).toBe('Read-only mode enforced');
    });
    
    it('should respect policy priority order', () => {
      class HighPriorityPolicy implements AuthorizationPolicy {
        name = 'HighPriority';
        priority = 1; // Very high priority
        
        appliesTo(): boolean {
          return true;
        }
        
        evaluate(): PermissionResult {
          return {
            allowed: false,
            reason: 'Denied by high priority policy'
          };
        }
      }
      
      const service = new AuthorizationService([new HighPriorityPolicy()]);
      
      const context: AuthorizationContext = {
        tenantId: 'tenant-123',
        authMethod: 'oauth',
        authenticatedAt: new Date()
      };
      
      // Should be denied by high priority policy before other policies run
      const result = service.canRead(context, 'memory');
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('Denied by high priority policy');
    });
  });
  
  describe('Convenience methods', () => {
    let context: AuthorizationContext;
    
    beforeEach(() => {
      context = {
        tenantId: 'tenant-123',
        authMethod: 'oauth',
        authenticatedAt: new Date()
      };
    });
    
    it('should provide canRead convenience method', () => {
      const result = authService.canRead(context, 'memory', 'mem-123', 'proj-456');
      expect(result).toHaveProperty('allowed');
    });
    
    it('should provide canWrite convenience method', () => {
      const result = authService.canWrite(context, 'memory', 'mem-123', 'proj-456');
      expect(result).toHaveProperty('allowed');
    });
    
    it('should provide canDelete convenience method', () => {
      const result = authService.canDelete(context, 'memory', 'mem-123', 'proj-456');
      expect(result).toHaveProperty('allowed');
    });
    
    it('should provide canCreate convenience method', () => {
      const result = authService.canCreate(context, 'memory', 'proj-456');
      expect(result).toHaveProperty('allowed');
    });
    
    it('should provide canList convenience method', () => {
      const result = authService.canList(context, 'memory', 'proj-456');
      expect(result).toHaveProperty('allowed');
    });
  });
  
  describe('Multi-auth method consistency', () => {
    it('should enforce same rules for OAuth and JWT', () => {
      const oauthContext: AuthorizationContext = {
        tenantId: 'tenant-123',
        userId: 'user-789',
        authMethod: 'oauth',
        authenticatedAt: new Date()
      };
      
      const jwtContext: AuthorizationContext = {
        tenantId: 'tenant-123',
        userId: 'user-789',
        authMethod: 'jwt',
        authenticatedAt: new Date()
      };
      
      const oauthResult = authService.canWrite(oauthContext, 'memory');
      const jwtResult = authService.canWrite(jwtContext, 'memory');
      
      expect(oauthResult.allowed).toBe(jwtResult.allowed);
    });
    
    it('should enforce same rules for API key and Session', () => {
      const apiKeyContext: AuthorizationContext = {
        tenantId: 'tenant-123',
        apiKeyId: 'key-abc',
        authMethod: 'api_key',
        authenticatedAt: new Date()
      };
      
      const sessionContext: AuthorizationContext = {
        tenantId: 'tenant-123',
        sessionId: 'sess-xyz',
        authMethod: 'session',
        authenticatedAt: new Date()
      };
      
      // Both should be able to read memories
      expect(authService.canRead(apiKeyContext, 'memory').allowed).toBe(true);
      expect(authService.canRead(sessionContext, 'memory').allowed).toBe(true);
      
      // But API keys have additional restrictions
      expect(authService.canCreate(apiKeyContext, 'api_key').allowed).toBe(false);
      expect(authService.canCreate(sessionContext, 'api_key').allowed).toBe(true);
    });
  });
  
  describe('Edge cases', () => {
    it('fails closed when no policy makes an explicit decision', () => {
      const service = new AuthorizationService();
      (service as any).policies = [];

      const result = service.canRead({
        tenantId: 'tenant-123',
        authMethod: 'oauth',
        authenticatedAt: new Date(),
      }, 'memory');

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('explicitly allowed');
    });

    it('should handle undefined projectId gracefully', () => {
      const context: AuthorizationContext = {
        tenantId: 'tenant-123',
        authMethod: 'oauth',
        authenticatedAt: new Date()
      };
      
      const result = authService.canRead(context, 'memory');
      expect(result.allowed).toBe(true);
    });
    
    it('should handle empty metadata gracefully', () => {
      const context: AuthorizationContext = {
        tenantId: 'tenant-123',
        authMethod: 'oauth',
        authenticatedAt: new Date(),
        metadata: {}
      };
      
      const result = authService.canRead(context, 'memory');
      expect(result.allowed).toBe(true);
    });
  });
});

describe('tenant-only advanced state release gate', () => {
  it('preserves autonomous bootstrap agents but denies human and standard credentials', () => {
    expect(BOOTSTRAP_ONLY_TENANT_STATE_TOOLS.size).toBe(4);
    expect(canUseBootstrapOnlyTenantState('agent_bootstrap', undefined)).toBe(true);
    expect(canUseBootstrapOnlyTenantState('agent_bootstrap', 'human-user')).toBe(false);
    expect(canUseBootstrapOnlyTenantState('standard', undefined)).toBe(false);
    expect(canUseBootstrapOnlyTenantState(undefined, undefined)).toBe(false);
  });

  it('denies work-queue and RLM state machines for every credential, including full and bootstrap', () => {
    for (const tool of ['work_queue', 'rlm_session', 'rlm_iteration', 'rlm_evaluate_ac', 'rlm_regenerate']) {
      expect(DISABLED_PENDING_ISOLATION.has(tool), tool).toBe(true);
      expect(authorizeToolCall(['mcp:full'], tool).allowed, `${tool} full`).toBe(false);
      expect(authorizeToolCall(['context:manage'], tool).allowed, `${tool} bootstrap capabilities`).toBe(false);
      expect(BOOTSTRAP_ONLY_TENANT_STATE_TOOLS.has(tool), tool).toBe(false);
    }
  });

  it('omits disabled direct tools and consolidated tools whose operations are all disabled', () => {
    for (const tool of ['work_queue', 'rlm_session', 'rlm_iteration', 'rlm_evaluate_ac', 'rlm_regenerate']) {
      expect(isToolDisabledForDiscovery(tool), tool).toBe(true);
    }
    expect(isToolDisabledForDiscovery('audit')).toBe(true);
    expect(isToolDisabledForDiscovery('memory')).toBe(false);
    expect(isToolDisabledForDiscovery('snapshot')).toBe(false);
  });

  it('denies and hides unbounded causality and snapshot-comparison operations on every route', () => {
    const disabledDirectTools = [
      'infer_causality',
      'trace_causality',
      'get_causal_links',
      'validate_causal_link',
      'compare_snapshots',
    ];

    for (const tool of disabledDirectTools) {
      expect(DISABLED_PENDING_ISOLATION.has(tool), tool).toBe(true);
      expect(isToolDisabledForDiscovery(tool), tool).toBe(true);
      expect(authorizeToolCall(['mcp:full'], tool).allowed, `${tool} full`).toBe(false);
    }

    expect(isToolDisabledForDiscovery('causality')).toBe(true);
    expect(authorizeToolCall(['mcp:full'], 'causality', 'infer').allowed).toBe(false);
    expect(authorizeToolCall(['mcp:full'], 'causality', 'trace').allowed).toBe(false);
    expect(authorizeToolCall(['mcp:full'], 'causality', 'get').allowed).toBe(false);
    expect(authorizeToolCall(['mcp:full'], 'causality', 'validate').allowed).toBe(false);

    // The graph family remains discoverable because its bounded operations are
    // still enabled, while the compare operation is denied before dispatch.
    expect(isToolDisabledForDiscovery('graph')).toBe(false);
    expect(authorizeToolCall(['mcp:full'], 'graph', 'compare').allowed).toBe(false);
  });

  it('denies and hides attachment tools while no production object-store contract exists', () => {
    for (const tool of [
      'upload_attachment',
      'list_attachments',
      'get_attachment_url',
      'delete_attachment',
      'get_storage_usage',
    ]) {
      expect(DISABLED_PENDING_ISOLATION.has(tool), tool).toBe(true);
      expect(isToolDisabledForDiscovery(tool), tool).toBe(true);
      expect(authorizeToolCall(['mcp:full'], tool).allowed, `${tool} full`).toBe(false);
      expect(authorizeToolCall(['memory:read', 'memory:write'], tool).allowed, `${tool} memory caps`).toBe(false);
    }
  });

  it('prunes disabled operations and their exclusive fields from partially enabled discovery schemas', () => {
    const graph = getConsolidatedTools().find(tool => tool.name === 'graph')!;
    const advertised = pruneToolForDiscovery(graph)!;
    const properties = (advertised.inputSchema as any).properties;

    expect(properties.operation.enum).toEqual(['get', 'generate', 'insights', 'infer', 'explore']);
    expect(properties.snapshot_id_1).toBeUndefined();
    expect(properties.snapshot_id_2).toBeUndefined();
    expect(advertised.description).not.toContain('compare');
    expect(pruneToolForDiscovery(getConsolidatedTools().find(tool => tool.name === 'causality')!)).toBeNull();
    expect(pruneToolForDiscovery({ name: 'compare_snapshots', inputSchema: {} })).toBeNull();

    const stats = pruneToolForDiscovery(getConsolidatedTools().find(tool => tool.name === 'stats')!)!;
    const statsProperties = (stats.inputSchema as any).properties;
    expect(statsProperties.operation.enum).toEqual(['usage', 'embeddings', 'insights']);
    expect(statsProperties.days).toBeUndefined();
    expect(stats.description).not.toContain('predictions');
    for (const unavailable of ['generate_memory_insights', 'get_predictive_analytics']) {
      expect(DISABLED_PENDING_ISOLATION.has(unavailable)).toBe(true);
      expect(isToolDisabledForDiscovery(unavailable)).toBe(true);
      expect(authorizeToolCall(['mcp:full'], unavailable).allowed).toBe(false);
    }
  });
});

describe('MCP credential capability matrix', () => {
  const agentBootstrap = ['memory:read', 'memory:write', 'context:manage', 'snapshot:manage'];
  const standardKey = [...agentBootstrap];
  const readOnly = ['memory:read'];
  const full = ['mcp:full'];

  it('covers every advertised consolidated operation with a fail-closed decision', () => {
    const tools = getConsolidatedTools();

    for (const tool of tools) {
      const operations = ((tool.inputSchema as any).properties?.operation?.enum || []) as string[];
      expect(operations.length, `${tool.name} must advertise at least one operation`).toBeGreaterThan(0);

      for (const operation of operations) {
        const resolved = resolveToolForAuthorization(tool.name, operation);
        const routedOperations = CONSOLIDATED_OPERATION_TARGETS[tool.name];

        if (routedOperations && !routedOperations[operation]) {
          // context.get/delete are currently advertised but have no handler.
          // They remain unavailable even to mcp:full until implemented.
          expect(resolved, `${tool.name}.${operation}`).toBeNull();
          expect(authorizeToolCall(full, tool.name, operation).allowed).toBe(false);
          continue;
        }

        expect(resolved, `${tool.name}.${operation}`).toBeTruthy();
        const required = requiredCapabilityForTool(resolved!);

        if (DISABLED_PENDING_ISOLATION.has(resolved!)) {
          expect(authorizeToolCall(full, tool.name, operation).allowed, `${tool.name}.${operation} disabled`)
            .toBe(false);
          expect(authorizeToolCall(agentBootstrap, tool.name, operation).allowed).toBe(false);
          expect(authorizeToolCall(standardKey, tool.name, operation).allowed).toBe(false);
          expect(authorizeToolCall(readOnly, tool.name, operation).allowed).toBe(false);
          continue;
        }

        expect(authorizeToolCall(full, tool.name, operation).allowed, `${tool.name}.${operation} full`).toBe(true);
        expect(authorizeToolCall(agentBootstrap, tool.name, operation).allowed, `${tool.name}.${operation} bootstrap`)
          .toBe(required !== 'mcp:full');
        expect(authorizeToolCall(standardKey, tool.name, operation).allowed, `${tool.name}.${operation} standard`)
          .toBe(required !== 'mcp:full');
        expect(authorizeToolCall(readOnly, tool.name, operation).allowed, `${tool.name}.${operation} read-only`)
          .toBe(required === 'memory:read');
      }
    }
  });

  it('fails closed for unknown tools and unknown consolidated operations', () => {
    expect(authorizeToolCall(readOnly, 'future_destructive_tool')).toMatchObject({
      allowed: false,
      requiredCapability: 'mcp:full',
    });
    expect(authorizeToolCall(full, 'future_destructive_tool').allowed).toBe(false);
    expect(authorizeToolCall(full, 'memory', 'future_operation').allowed).toBe(false);
    expect(authorizeToolCall(agentBootstrap, 'memory').allowed).toBe(false);
  });

  it('applies the same matrix to HTTP fast paths and consolidated routes', () => {
    const pairs = [
      ['store_memory', 'memory', 'create'],
      ['search_memory', 'search', 'query'],
      ['detect_memory_contradictions', 'contradictions', 'detect'],
    ] as const;

    for (const [legacy, consolidated, operation] of pairs) {
      for (const capabilities of [readOnly, agentBootstrap, standardKey, full]) {
        expect(authorizeToolCall(capabilities, legacy).allowed)
          .toBe(authorizeToolCall(capabilities, consolidated, operation).allowed);
      }
    }
  });

  it('retains legacy aggregate OAuth scope semantics without broadening read-only tokens', () => {
    expect(authorizeToolCall(['mcp:read'], 'search_memory').allowed).toBe(true);
    expect(authorizeToolCall(['mcp:read'], 'store_memory').allowed).toBe(false);
    expect(authorizeToolCall(['mcp:write'], 'store_memory').allowed).toBe(true);
    expect(authorizeToolCall(['mcp:write'], 'create_snapshot').allowed).toBe(true);
    expect(authorizeToolCall(['read:memories'], 'search_memory').allowed).toBe(true);
    expect(authorizeToolCall(['read:memories'], 'store_memory').allowed).toBe(false);
    expect(authorizeToolCall(['write:memories'], 'store_memory').allowed).toBe(true);
    expect(authorizeToolCall(['write:memories'], 'create_context').allowed).toBe(false);
    expect(authorizeToolCall(['write:memories'], 'create_snapshot').allowed).toBe(false);
  });

  it('reserves tenant-wide aggregate counters for unscoped full or isolated bootstrap principals', () => {
    expect(canReadTenantAggregates(['memory:read'], 'standard', 'user-1', undefined)).toBe(false);
    expect(canReadTenantAggregates(['mcp:full'], 'standard', 'user-1', 'project-1')).toBe(false);
    expect(canReadTenantAggregates(['mcp:full'], 'standard', 'user-1', undefined)).toBe(true);
    expect(canReadTenantAggregates(['memory:read'], 'agent_bootstrap', undefined, undefined)).toBe(true);
    expect(canReadTenantAggregates(['memory:read'], 'agent_bootstrap', 'claimed-user', undefined)).toBe(false);
  });

  it('uses operation-aware authority for the overloaded PII tool', () => {
    expect(authorizeToolCall(readOnly, 'pii', 'detect').allowed).toBe(true);
    expect(authorizeToolCall(readOnly, 'pii', 'redact').allowed).toBe(true);
    expect(authorizeToolCall(readOnly, 'pii', 'batch_scan')).toMatchObject({
      allowed: false,
      requiredCapability: 'memory:write',
    });
    expect(authorizeToolCall(agentBootstrap, 'pii', 'batch_scan').allowed).toBe(true);
    expect(authorizeToolCall(agentBootstrap, 'pii', 'audit')).toMatchObject({
      allowed: false,
      requiredCapability: 'mcp:full',
    });
    expect(authorizeToolCall(full, 'pii', 'audit').allowed).toBe(true);
    expect(authorizeToolCall(full, 'pii', 'compliance_report').allowed).toBe(true);
    expect(authorizeToolCall(full, 'pii').allowed).toBe(false);
    expect(authorizeToolCall(full, 'pii', 'future_operation').allowed).toBe(false);
  });

  it('does not let mcp:full bypass release-blocked isolation boundaries', () => {
    for (const tool of [
      'manage_task', 'task_state', 'task_dependencies', 'task_search',
      'task_export', 'task_handoff', 'task_analytics', 'task_iterations',
      'manage_acceptance_criteria', 'plan_regeneration', 'plan_compaction',
      'gdpr', 'snapshot_timeline', 'snapshot_diff', 'snapshot_nearest',
      'snapshot_category_evolution',
    ]) {
      expect(authorizeToolCall(full, tool).allowed, tool).toBe(false);
    }
  });
});
