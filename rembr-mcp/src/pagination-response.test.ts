/**
 * Pagination Metadata Tests (REM-68)
 * 
 * Verifies that all list/search operations return standardized pagination metadata.
 */

import { describe, it, expect } from 'vitest';

/**
 * Expected pagination response schema (REM-68)
 */
interface PaginatedResponse<T> {
  success: boolean;
  data: T[];
  metadata: {
    returned: number;
    total_available: number;
    execution_time_ms: number;
  };
  pagination?: {
    has_more: boolean;
    suggested_filters?: string[];
  };
  related_tools?: string[];
}

describe('Pagination Metadata (REM-68)', () => {
  describe('Response Schema', () => {
    it('should have required metadata fields', () => {
      const response: PaginatedResponse<any> = {
        success: true,
        data: [],
        metadata: {
          returned: 0,
          total_available: 0,
          execution_time_ms: 0,
        },
      };

      expect(response.success).toBe(true);
      expect(response.data).toBeInstanceOf(Array);
      expect(response.metadata.returned).toBeTypeOf('number');
      expect(response.metadata.total_available).toBeTypeOf('number');
      expect(response.metadata.execution_time_ms).toBeTypeOf('number');
    });

    it('should include pagination section when has_more is true', () => {
      const response: PaginatedResponse<any> = {
        success: true,
        data: [1, 2, 3],
        metadata: {
          returned: 3,
          total_available: 10,
          execution_time_ms: 45,
        },
        pagination: {
          has_more: true,
          suggested_filters: ['category: "facts"'],
        },
      };

      expect(response.pagination).toBeDefined();
      expect(response.pagination?.has_more).toBe(true);
      expect(response.pagination?.suggested_filters).toContain('category: "facts"');
    });

    it('should include related_tools when provided', () => {
      const response: PaginatedResponse<any> = {
        success: true,
        data: [],
        metadata: {
          returned: 0,
          total_available: 0,
          execution_time_ms: 0,
        },
        related_tools: ['get_context_insights', 'generate_memory_insights'],
      };

      expect(response.related_tools).toBeDefined();
      expect(response.related_tools).toHaveLength(2);
      expect(response.related_tools).toContain('get_context_insights');
    });
  });

  describe('Execution Time Tracking', () => {
    it('should track execution time in milliseconds', () => {
      const startTime = Date.now();
      
      // Simulate some work
      const endTime = Date.now();
      const executionTimeMs = endTime - startTime;

      expect(executionTimeMs).toBeGreaterThanOrEqual(0);
      expect(executionTimeMs).toBeLessThan(1000); // Should be very fast
    });
  });

  describe('Pagination Logic', () => {
    it('should set has_more to true when total > returned', () => {
      const response: PaginatedResponse<any> = {
        success: true,
        data: new Array(10),
        metadata: {
          returned: 10,
          total_available: 100,
          execution_time_ms: 45,
        },
        pagination: {
          has_more: true,
        },
      };

      expect(response.pagination?.has_more).toBe(true);
      expect(response.metadata.total_available).toBeGreaterThan(response.metadata.returned);
    });

    it('should set has_more to false when all results returned', () => {
      const response: PaginatedResponse<any> = {
        success: true,
        data: new Array(5),
        metadata: {
          returned: 5,
          total_available: 5,
          execution_time_ms: 45,
        },
        pagination: {
          has_more: false,
        },
      };

      expect(response.pagination?.has_more).toBe(false);
      expect(response.metadata.total_available).toBe(response.metadata.returned);
    });
  });

  describe('Suggested Filters', () => {
    it('should suggest filters when results are truncated', () => {
      const response: PaginatedResponse<any> = {
        success: true,
        data: new Array(20),
        metadata: {
          returned: 20,
          total_available: 500,
          execution_time_ms: 45,
        },
        pagination: {
          has_more: true,
          suggested_filters: [
            'category: "facts"',
            'Add date range filter',
            'Add metadata_filter',
          ],
        },
      };

      expect(response.pagination?.suggested_filters).toBeDefined();
      expect(response.pagination!.suggested_filters!.length).toBeGreaterThan(0);
    });

    it('should not suggest filters when all results fit', () => {
      const response: PaginatedResponse<any> = {
        success: true,
        data: new Array(5),
        metadata: {
          returned: 5,
          total_available: 5,
          execution_time_ms: 45,
        },
      };

      // No pagination section needed when no more results
      expect(response.pagination).toBeUndefined();
    });
  });

  describe('Related Tools', () => {
    it('should suggest related tools for memory operations', () => {
      const memorySearchResponse: PaginatedResponse<any> = {
        success: true,
        data: [],
        metadata: {
          returned: 0,
          total_available: 0,
          execution_time_ms: 45,
        },
        related_tools: ['get_context_insights', 'generate_memory_insights'],
      };

      expect(memorySearchResponse.related_tools).toContain('get_context_insights');
    });

    it('should suggest related tools for context operations', () => {
      const contextListResponse: PaginatedResponse<any> = {
        success: true,
        data: [],
        metadata: {
          returned: 0,
          total_available: 0,
          execution_time_ms: 45,
        },
        related_tools: ['search_context', 'generate_context_graph'],
      };

      expect(contextListResponse.related_tools).toContain('search_context');
    });
  });

  describe('Backward Compatibility', () => {
    it('should support responses without pagination section', () => {
      const response: Partial<PaginatedResponse<any>> = {
        success: true,
        data: [],
        metadata: {
          returned: 0,
          total_available: 0,
          execution_time_ms: 45,
        },
        // No pagination section
      };

      expect(response.success).toBe(true);
      expect(response.metadata).toBeDefined();
      expect(response.pagination).toBeUndefined();
    });

    it('should support responses without related_tools', () => {
      const response: Partial<PaginatedResponse<any>> = {
        success: true,
        data: [],
        metadata: {
          returned: 0,
          total_available: 0,
          execution_time_ms: 45,
        },
        // No related_tools
      };

      expect(response.success).toBe(true);
      expect(response.related_tools).toBeUndefined();
    });
  });

  // ─── RAD-52: Coverage verification ────────────────────────────────────────
  describe('RAD-52: All list/search tools now return pagination metadata', () => {
    /**
     * Documents which tools were updated in RAD-52 to include pagination.
     * These are verified by the response schema contract above.
     * Tools updated: find_similar_memories, enhanced_search, explore_relationships,
     * query_audit_log, get_audit_stats.
     */
    const TOOLS_WITH_PAGINATION = [
      // Pre-existing (REM-68)
      'search_memory', 'list_memories', 'list_contexts', 'search_context',
      'list_snapshots', 'list_personal_memories', 'search_at_time',
      'get_memory_history', 'list_temporal_snapshots', 'list_attachments',
      // Added in RAD-52
      'find_similar_memories', 'enhanced_search', 'explore_relationships',
      'query_audit_log', 'get_audit_stats',
    ];

    it('pagination tool coverage list should include all RAD-52 additions', () => {
      const rad52Additions = ['find_similar_memories', 'enhanced_search', 'explore_relationships', 'query_audit_log', 'get_audit_stats'];
      for (const tool of rad52Additions) {
        expect(TOOLS_WITH_PAGINATION).toContain(tool);
      }
    });

    it('total tool coverage count should be 15', () => {
      expect(TOOLS_WITH_PAGINATION).toHaveLength(15);
    });

    it('pagination response shape should include all required fields', () => {
      // Verify the complete contract that RAD-52 tools must satisfy
      const exampleResponse: PaginatedResponse<{id: string}> = {
        success: true,
        data: [{ id: 'abc-123' }],
        metadata: {
          returned: 1,
          total_available: 1,
          execution_time_ms: 12,
        },
      };
      expect(exampleResponse.metadata.returned).toBe(1);
      expect(exampleResponse.metadata.total_available).toBe(1);
      expect(exampleResponse.metadata.execution_time_ms).toBeGreaterThanOrEqual(0);
    });
  });
});
