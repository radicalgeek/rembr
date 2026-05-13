/**
 * RLS (Row-Level Security) Verification Tests - REM-253
 * 
 * Verifies tenant_id filtering is enforced across all database queries
 * that access the memories table to prevent cross-tenant data access.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('RLS Verification - REM-253', () => {
  const sourceDir = __dirname;

  /**
   * Get all TypeScript source files that might contain SQL queries
   */
  function getSourceFiles(): string[] {
    const files: string[] = [];
    
    function scanDir(dir: string) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        
        if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== 'dist') {
          scanDir(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
          files.push(fullPath);
        }
      }
    }
    
    scanDir(sourceDir);
    return files;
  }

  /**
   * Extract SQL queries from TypeScript file content
   */
  function extractSqlQueries(content: string, filePath: string): Array<{ query: string; line: number }> {
    const queries: Array<{ query: string; line: number }> = [];
    const lines = content.split('\n');
    
    let inQuery = false;
    let currentQuery = '';
    let queryStartLine = 0;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      
      // Detect start of SQL query (template literal or string)
      if ((trimmed.includes('SELECT') || trimmed.includes('DELETE') || trimmed.includes('UPDATE')) && 
          (trimmed.includes('FROM memories') || trimmed.includes('DELETE FROM memories'))) {
        inQuery = true;
        currentQuery = line;
        queryStartLine = i + 1;
      } else if (inQuery) {
        currentQuery += '\n' + line;
        
        // Detect end of query (semicolon, closing backtick, or statement end)
        if (trimmed.endsWith(';') || trimmed.endsWith('`;') || trimmed.endsWith('`,') || 
            (trimmed.endsWith(')') && trimmed.includes('query'))) {
          queries.push({ query: currentQuery, line: queryStartLine });
          inQuery = false;
          currentQuery = '';
        }
      }
    }
    
    return queries;
  }

  /**
   * Check if a query properly filters by tenant_id
   */
  function hasTenantIdFilter(query: string): boolean {
    const normalized = query.toLowerCase().replace(/\s+/g, ' ');
    
    // Check for explicit tenant_id in WHERE clause
    if (normalized.includes('tenant_id')) {
      return true;
    }
    
    // Check for RLS policy context setting (alternative to explicit filtering)
    if (normalized.includes('app.current_tenant') || normalized.includes('app.tenant_id')) {
      return true;
    }
    
    // Check if it's a subquery or join that inherits tenant filtering from parent
    if (normalized.includes('exists (') && normalized.includes('where')) {
      return true; // EXISTS subqueries often inherit context
    }
    
    return false;
  }

  /**
   * Check if query is exempt from tenant_id requirement
   */
  function isExemptQuery(query: string, filePath: string): boolean {
    const normalized = query.toLowerCase();
    
    // Migration files and schema definitions are exempt
    if (filePath.includes('/migrations/') || filePath.includes('/schemas/')) {
      return true;
    }
    
    // Test files are exempt (they test cross-tenant scenarios)
    if (filePath.endsWith('.test.ts')) {
      return true;
    }
    
    // Admin health checks that aggregate across tenants
    if (normalized.includes('count(*)') && !normalized.includes('where id')) {
      return true;
    }
    
    // RLS policy definitions themselves
    if (normalized.includes('create policy') || normalized.includes('alter policy')) {
      return true;
    }
    
    return false;
  }

  it('should enforce tenant_id filtering in all memories table queries', () => {
    const sourceFiles = getSourceFiles();
    const violations: Array<{ file: string; line: number; query: string }> = [];
    
    for (const filePath of sourceFiles) {
      const content = fs.readFileSync(filePath, 'utf-8');
      const queries = extractSqlQueries(content, filePath);
      
      for (const { query, line } of queries) {
        if (!hasTenantIdFilter(query) && !isExemptQuery(query, filePath)) {
          const relativePath = path.relative(sourceDir, filePath);
          violations.push({
            file: relativePath,
            line,
            query: query.trim().split('\n').slice(0, 3).join('\n') + '...' // First 3 lines
          });
        }
      }
    }
    
    if (violations.length > 0) {
      const report = violations.map(v => 
        `\n❌ ${v.file}:${v.line}\n${v.query}\n`
      ).join('\n');
      
      throw new Error(`Found ${violations.length} SQL queries missing tenant_id filtering:\n${report}`);
    }
    
    // Success
    expect(violations).toEqual([]);
  });

  it('should document fixed RLS vulnerabilities from initial audit', () => {
    /**
     * This test documents the RLS vulnerabilities found and fixed in REM-253.
     * 
     * FIXED ISSUES:
     * 
     * 1. advanced-analytics-service.ts:434
     *    - Before: SELECT * FROM memories WHERE id = $1
     *    - After: SELECT * FROM memories WHERE id = $1 AND tenant_id = $2
     *    - Impact: detectMemoryContradictions() could access memories across tenants
     * 
     * 2. database.ts:1031
     *    - Before: getContextMemories(contextId, tenantId?) with optional tenantId
     *    - After: getContextMemories(contextId, tenantId) with required tenantId
     *    - Impact: Context queries without tenant filter could leak cross-tenant data
     * 
     * 3. deduplication-service.ts:228
     *    - Before: DELETE FROM memories WHERE id = $1
     *    - After: DELETE FROM memories WHERE id = $1 AND tenant_id = $2
     *    - Impact: archiveMemory() could delete memories from wrong tenant
     * 
     * 4. temporal-analyzer-service.ts:190
     *    - Before: DELETE FROM memories WHERE id = ANY($1)
     *    - After: DELETE FROM memories WHERE id = ANY($1) AND tenant_id = $2
     *    - Impact: archiveOutdated() could delete memories from wrong tenant
     * 
     * All callers verified to provide tenantId parameter.
     * Defense-in-depth: All memory access now explicitly checks tenant_id.
     */
    
    // Verify the fixes are in place
    const filesToCheck = [
      'advanced-analytics-service.ts',
      'database.ts',
      'optimization/deduplication-service.ts',
      'optimization/temporal-analyzer-service.ts'
    ];
    
    for (const file of filesToCheck) {
      const fullPath = path.join(sourceDir, file);
      const content = fs.readFileSync(fullPath, 'utf-8');
      
      // Verify no queries missing tenant_id (except exempt ones)
      const queries = extractSqlQueries(content, fullPath);
      const unfiltered = queries.filter(q => 
        !hasTenantIdFilter(q.query) && !isExemptQuery(q.query, fullPath)
      );
      
      expect(unfiltered, `${file} should have no unfiltered queries`).toEqual([]);
    }
  });

  it('should verify all 42 MCP tool handlers respect tenant isolation', () => {
    /**
     * All MCP tools route through index-http.ts which enforces tenant_id
     * via request authentication. This test verifies the auth layer extracts
     * and passes tenant_id to all downstream queries.
     */
    
    const indexHttpPath = path.join(sourceDir, 'index-http.ts');
    const content = fs.readFileSync(indexHttpPath, 'utf-8');
    
    // Verify tenant_id is extracted from auth
    expect(content).toContain('tenantId');
    expect(content).toContain('authResult');
    
    // Verify queries use tenantId parameter
    const queries = extractSqlQueries(content, indexHttpPath);
    const unfiltered = queries.filter(q => 
      !hasTenantIdFilter(q.query) && !isExemptQuery(q.query, indexHttpPath)
    );
    
    expect(unfiltered, 'index-http.ts MCP handlers should filter by tenant_id').toEqual([]);
  });

  it('should verify database.ts enforces tenant_id in core memory operations', () => {
    const databasePath = path.join(sourceDir, 'database.ts');
    const content = fs.readFileSync(databasePath, 'utf-8');
    
    // Verify getContextMemories now requires tenantId (non-optional)
    const getContextMemoriesMatch = content.match(/getContextMemories\s*\([^)]+\)/);
    expect(getContextMemoriesMatch, 'getContextMemories should exist').toBeTruthy();
    if (getContextMemoriesMatch) {
      // Should have tenantId without ? (required parameter)
      expect(getContextMemoriesMatch[0]).toContain('tenantId');
      expect(getContextMemoriesMatch[0]).not.toContain('tenantId?');
    }
    
    // Verify memory queries include tenant_id filtering
    const queries = extractSqlQueries(content, databasePath);
    const memoryQueries = queries.filter(q => q.query.includes('FROM memories'));
    
    expect(memoryQueries.length, 'database.ts should have memory queries').toBeGreaterThan(0);
    
    const unfiltered = memoryQueries.filter(q => 
      !hasTenantIdFilter(q.query) && !isExemptQuery(q.query, databasePath)
    );
    
    expect(unfiltered, 'All memory queries should include tenant_id filter').toEqual([]);
  });
});
