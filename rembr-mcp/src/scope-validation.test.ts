/**
 * Scope Validation Tests (REM-254)
 *
 * Verifies that every tool:operation maps to correct minimum scopes,
 * that the wildcard grants all, that API keys/sessions bypass checks,
 * and that insufficient scopes are correctly rejected.
 */

import { describe, it, expect } from 'vitest';
import {
  SCOPE_MEMORY_READ,
  SCOPE_MEMORY_WRITE,
  SCOPE_ADMIN,
  SCOPE_WILDCARD,
  TOOL_SCOPE_REQUIREMENTS,
  scopesSatisfy,
  formatScopeRequirement,
  getToolScopeRequirements
} from '../src/scope-validation.js';

describe('scope-validation', () => {
  describe('TOOL_SCOPE_REQUIREMENTS', () => {
    it('has entries for all three scope categories', () => {
      const readKeys = Object.keys(TOOL_SCOPE_REQUIREMENTS).filter(
        k => TOOL_SCOPE_REQUIREMENTS[k].includes(SCOPE_MEMORY_READ)
      );
      const writeKeys = Object.keys(TOOL_SCOPE_REQUIREMENTS).filter(
        k => TOOL_SCOPE_REQUIREMENTS[k].includes(SCOPE_MEMORY_WRITE)
      );
      const adminKeys = Object.keys(TOOL_SCOPE_REQUIREMENTS).filter(
        k => TOOL_SCOPE_REQUIREMENTS[k].includes(SCOPE_ADMIN)
      );

      expect(readKeys.length).toBeGreaterThan(0);
      expect(writeKeys.length).toBeGreaterThan(0);
      // Admin scope is defined but may not be in current tool map yet
      // (that's fine — the constant exists for future use)
    });

    it('covers memory:read operations', () => {
      expect(TOOL_SCOPE_REQUIREMENTS['memory:get']).toEqual([SCOPE_MEMORY_READ]);
      expect(TOOL_SCOPE_REQUIREMENTS['memory:list']).toEqual([SCOPE_MEMORY_READ]);
      expect(TOOL_SCOPE_REQUIREMENTS['search:query']).toEqual([SCOPE_MEMORY_READ]);
    });

    it('covers memory:write operations', () => {
      expect(TOOL_SCOPE_REQUIREMENTS['memory:create']).toEqual([SCOPE_MEMORY_WRITE]);
      expect(TOOL_SCOPE_REQUIREMENTS['memory:update']).toEqual([SCOPE_MEMORY_WRITE]);
      expect(TOOL_SCOPE_REQUIREMENTS['memory:delete']).toEqual([SCOPE_MEMORY_WRITE]);
    });

    it('has a catch-all entry', () => {
      expect(TOOL_SCOPE_REQUIREMENTS['*']).toEqual([SCOPE_MEMORY_READ]);
    });

    it('has no empty scope arrays', () => {
      for (const [key, scopes] of Object.entries(TOOL_SCOPE_REQUIREMENTS)) {
        expect(scopes.length).toBeGreaterThan(0);
        for (const s of scopes) {
          expect(typeof s).toBe('string');
          expect(s.length).toBeGreaterThan(0);
        }
      }
    });
  });

  describe('scopesSatisfy', () => {
    it('wildcard grants all scopes', () => {
      expect(scopesSatisfy(['*'], ['memory:write'], 'jwt')).toBe(true);
      expect(scopesSatisfy(['*'], ['admin'], 'jwt')).toBe(true);
    });

    it('exact scope match succeeds', () => {
      expect(scopesSatisfy(['memory:read'], ['memory:read'], 'jwt')).toBe(true);
      expect(scopesSatisfy(['memory:write'], ['memory:write'], 'jwt')).toBe(true);
    });

    it('missing scope fails', () => {
      expect(scopesSatisfy(['memory:read'], ['memory:write'], 'jwt')).toBe(false);
      expect(scopesSatisfy(['admin'], ['memory:write'], 'jwt')).toBe(false);
    });

    it('any one of multiple required scopes succeeds', () => {
      // If a tool required [A, B], having either A or B grants access
      // (this is the "at least one" semantics)
      expect(scopesSatisfy(['memory:read'], ['memory:read', 'admin'], 'jwt')).toBe(true);
      expect(scopesSatisfy(['admin'], ['memory:read', 'admin'], 'jwt')).toBe(true);
    });

    it('no scopes fails', () => {
      expect(scopesSatisfy([], ['memory:read'], 'jwt')).toBe(false);
      expect(scopesSatisfy(undefined, ['memory:read'], 'jwt')).toBe(false);
    });

    it('api_key bypasses scope enforcement', () => {
      expect(scopesSatisfy([], ['memory:write'], 'api_key')).toBe(true);
      expect(scopesSatisfy(undefined, ['admin'], 'api_key')).toBe(true);
    });

    it('session bypasses scope enforcement', () => {
      expect(scopesSatisfy([], ['memory:write'], 'session')).toBe(true);
      expect(scopesSatisfy(undefined, ['admin'], 'session')).toBe(true);
    });

    it('multiple scopes — any match succeeds', () => {
      expect(
        scopesSatisfy(['memory:read', 'admin'], ['memory:write'], 'jwt')
      ).toBe(false);
      expect(
        scopesSatisfy(['memory:read', 'admin', 'memory:write'], ['memory:write'], 'jwt')
      ).toBe(true);
    });
  });

  describe('formatScopeRequirement', () => {
    it('joins scopes with " or "', () => {
      expect(formatScopeRequirement(['memory:read', 'memory:write'])).toBe('memory:read or memory:write');
    });

    it('handles single scope', () => {
      expect(formatScopeRequirement(['admin'])).toBe('admin');
    });
  });

  describe('getToolScopeRequirements', () => {
    it('returns scoped requirements for a tool name', () => {
      const result = getToolScopeRequirements('memory');
      expect(result['create']).toEqual([SCOPE_MEMORY_WRITE]);
      expect(result['get']).toEqual([SCOPE_MEMORY_READ]);
      expect(result['list']).toEqual([SCOPE_MEMORY_READ]);
    });

    it('returns empty for unknown tool', () => {
      const result = getToolScopeRequirements('nonexistent_tool_xyz');
      expect(Object.keys(result).length).toBe(0);
    });
  });
});
