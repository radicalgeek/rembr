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
  type AuthorizationPolicy,
  type PermissionRequest,
  type PermissionResult
} from './authorization.js';
import type { AuthResult } from './auth.js';

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
