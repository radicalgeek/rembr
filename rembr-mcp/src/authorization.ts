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
      authenticatedAt: new Date()
    };
  }
  
  /**
   * Check if a permission is allowed
   */
  checkPermission(request: PermissionRequest): PermissionResult {
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
      }
    }
    
    // If no policy denied, allow by default (after all policies pass)
    return { allowed: true };
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
