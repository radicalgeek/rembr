/**
 * Tests for Phase 1: Consolidated MCP Tools
 */

import { describe, it, expect } from 'vitest';
import {
  getConsolidatedTools,
  TOOL_CONSOLIDATION_MAP,
  getLegacyToolMigration
} from './consolidated-tools.js';
import {
  routeLegacyTool,
  wrapWithDeprecationWarning,
  validateMemoryOperation,
  validateSearchOperation,
  validateStatsOperation,
  validateContextOperation,
  validateSnapshotOperation,
  validateGraphOperation,
  validateContradictionsOperation,
  validateCausalityOperation,
  validateTemporalOperation,
  validateAuditOperation,
  validateClassifyOperation,
  validateCompressionOperation,
  getOperationValidator
} from './tool-router.js';

describe('Consolidated Tools Definitions', () => {
  it('should have exactly 20 consolidated tools', () => {
    const tools = getConsolidatedTools();
    expect(tools).toHaveLength(20);
  });

  it('should have all expected tool names', () => {
    const tools = getConsolidatedTools();
    const names = tools.map(t => t.name);
    expect(names).toContain('memory');
    expect(names).toContain('search');
    expect(names).toContain('stats');
    expect(names).toContain('context');
    expect(names).toContain('snapshot');
    expect(names).toContain('graph');
    expect(names).toContain('contradictions');
    expect(names).toContain('context_analytics');
    expect(names).toContain('budget');
    expect(names).toContain('causality');
    expect(names).toContain('temporal');
    expect(names).toContain('audit');
    expect(names).toContain('classify');
    expect(names).toContain('checkpoint');
    // Added by RAD-13 and RAD-59 merges
    expect(names).toContain('task_analytics');
    expect(names).toContain('task_iterations');
  });

  it('should have operation parameter in all tools', () => {
    const tools = getConsolidatedTools();
    for (const tool of tools) {
      expect(tool.inputSchema.properties).toHaveProperty('operation');
      expect(tool.inputSchema.required).toContain('operation');
    }
  });
});

describe('Legacy Tool Consolidation Map', () => {
  it('should map all 42 legacy tools (including ingest_document, RAD-51)', () => {
    const legacyTools = Object.keys(TOOL_CONSOLIDATION_MAP);
    expect(legacyTools.length).toBe(42);
  });

  it('should map ingest_document to memory.ingest', () => {
    expect(TOOL_CONSOLIDATION_MAP['ingest_document']).toEqual({
      tool: 'memory',
      operation: 'ingest'
    });
  });

  it('should map store_memory to memory.create', () => {
    expect(TOOL_CONSOLIDATION_MAP['store_memory']).toEqual({
      tool: 'memory',
      operation: 'create'
    });
  });

  it('should map search_memory to search.query', () => {
    expect(TOOL_CONSOLIDATION_MAP['search_memory']).toEqual({
      tool: 'search',
      operation: 'query'
    });
  });

  it('should map get_stats to stats.usage', () => {
    expect(TOOL_CONSOLIDATION_MAP['get_stats']).toEqual({
      tool: 'stats',
      operation: 'usage'
    });
  });
});

describe('Legacy Tool Migration', () => {
  it('should detect legacy tools', () => {
    const migration = getLegacyToolMigration('store_memory');
    expect(migration.isLegacy).toBe(true);
    expect(migration.suggestion).toContain("Use 'memory' with operation='create'");
  });

  it('should not flag consolidated tools as legacy', () => {
    const migration = getLegacyToolMigration('memory');
    expect(migration.isLegacy).toBe(false);
    expect(migration.suggestion).toBeUndefined();
  });
});

describe('Legacy Tool Routing', () => {
  it('should route store_memory to memory.create', () => {
    const result = routeLegacyTool('store_memory', { content: 'test', category: 'facts' });
    expect(result).not.toBeNull();
    expect(result!.toolName).toBe('memory');
    expect(result!.operation).toBe('create');
    expect(result!.args.operation).toBe('create');
    expect(result!.args.content).toBe('test');
  });

  it('should return null for non-legacy tools', () => {
    const result = routeLegacyTool('memory', { operation: 'create' });
    expect(result).toBeNull();
  });
});

describe('Memory Operation Validation', () => {
  it('should validate create operation', () => {
    const result = validateMemoryOperation({ operation: 'create', content: 'test', category: 'facts' });
    expect(result.valid).toBe(true);
  });

  it('should reject create without content', () => {
    const result = validateMemoryOperation({ operation: 'create', category: 'facts' });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('content');
  });

  it('should validate get operation', () => {
    const result = validateMemoryOperation({ operation: 'get', id: 'test-id' });
    expect(result.valid).toBe(true);
  });

  it('should reject get without id', () => {
    const result = validateMemoryOperation({ operation: 'get' });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('id');
  });

  it('should validate list operation without required params', () => {
    const result = validateMemoryOperation({ operation: 'list' });
    expect(result.valid).toBe(true);
  });
});

describe('Search Operation Validation', () => {
  it('should validate query operation', () => {
    const result = validateSearchOperation({ operation: 'query', query: 'test' });
    expect(result.valid).toBe(true);
  });

  it('should reject query without query param', () => {
    const result = validateSearchOperation({ operation: 'query' });
    expect(result.valid).toBe(false);
  });

  it('should validate similar operation with memory_id', () => {
    const result = validateSearchOperation({ operation: 'similar', memory_id: 'test-id' });
    expect(result.valid).toBe(true);
  });
});

describe('Stats Operation Validation', () => {
  it('should validate all stats operations without required params', () => {
    const operations = ['usage', 'embeddings', 'insights', 'generate_insights', 'predictions'];
    for (const op of operations) {
      const result = validateStatsOperation({ operation: op });
      expect(result.valid).toBe(true);
    }
  });
});

describe('Context Operation Validation', () => {
  it('should validate create operation', () => {
    const result = validateContextOperation({ operation: 'create', name: 'Test Context' });
    expect(result.valid).toBe(true);
  });

  it('should reject create without name', () => {
    const result = validateContextOperation({ operation: 'create' });
    expect(result.valid).toBe(false);
  });

  it('should validate add_memory with context_id and memory_id', () => {
    const result = validateContextOperation({
      operation: 'add_memory',
      context_id: 'ctx-id',
      memory_id: 'mem-id'
    });
    expect(result.valid).toBe(true);
  });
});

describe('Snapshot Operation Validation', () => {
  it('should validate create operation', () => {
    const result = validateSnapshotOperation({ operation: 'create', context_id: 'ctx-id' });
    expect(result.valid).toBe(true);
  });

  it('should validate create_temporal with name', () => {
    const result = validateSnapshotOperation({ operation: 'create_temporal', snapshot_name: 'Test' });
    expect(result.valid).toBe(true);
  });
});

describe('Graph Operation Validation', () => {
  it('should validate get operation with context_id', () => {
    const result = validateGraphOperation({ operation: 'get', context_id: 'ctx-id' });
    expect(result.valid).toBe(true);
  });

  it('should validate compare operation', () => {
    const result = validateGraphOperation({
      operation: 'compare',
      snapshot_id_1: 'snap-1',
      snapshot_id_2: 'snap-2'
    });
    expect(result.valid).toBe(true);
  });
});

describe('Contradictions Operation Validation', () => {
  it('should validate detect operation', () => {
    const result = validateContradictionsOperation({ operation: 'detect' });
    expect(result.valid).toBe(true);
  });
});

describe('Causality Operation Validation', () => {
  it('should validate infer operation', () => {
    const result = validateCausalityOperation({
      operation: 'infer',
      cause_memory_id: 'cause-id',
      effect_memory_id: 'effect-id'
    });
    expect(result.valid).toBe(true);
  });

  it('should validate trace operation', () => {
    const result = validateCausalityOperation({ operation: 'trace', memory_id: 'mem-id' });
    expect(result.valid).toBe(true);
  });
});

describe('Temporal Operation Validation', () => {
  it('should validate search operation', () => {
    const result = validateTemporalOperation({ operation: 'search', query: 'test' });
    expect(result.valid).toBe(true);
  });

  it('should validate history operation', () => {
    const result = validateTemporalOperation({ operation: 'history', memory_id: 'mem-id' });
    expect(result.valid).toBe(true);
  });
});

describe('Audit Operation Validation', () => {
  it('should validate all audit operations', () => {
    const operations = ['query', 'report', 'stats'];
    for (const op of operations) {
      const result = validateAuditOperation({ operation: op });
      expect(result.valid).toBe(true);
    }
  });
});

describe('Classify Operation Validation', () => {
  it('should validate intent operation', () => {
    const result = validateClassifyOperation({ operation: 'intent', query: 'test' });
    expect(result.valid).toBe(true);
  });

  it('should reject intent without query', () => {
    const result = validateClassifyOperation({ operation: 'intent' });
    expect(result.valid).toBe(false);
  });
});

describe('Operation Validator Registry', () => {
  it('should return correct validator for each tool', () => {
    const tools = ['memory', 'search', 'stats', 'context', 'snapshot', 
                   'graph', 'contradictions', 'causality', 'temporal', 'audit', 'classify'];
    
    for (const tool of tools) {
      const validator = getOperationValidator(tool);
      expect(validator).not.toBeNull();
    }
  });

  it('should return null for unknown tools', () => {
    const validator = getOperationValidator('unknown_tool');
    expect(validator).toBeNull();
  });
});

// ─── RAD-51: Deprecation Warning Injection ────────────────────────────────────
describe('RAD-51: Deprecation warnings on direct legacy tool calls', () => {
  it('wrapWithDeprecationWarning should inject _deprecation_warning into JSON response', () => {
    const result = {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ success: true, memory: { id: 'abc' } })
      }]
    };
    const wrapped = wrapWithDeprecationWarning(result, 'store_memory');
    expect(wrapped.content).toHaveLength(1);
    const parsed = JSON.parse(wrapped.content[0].text);
    expect(parsed._deprecation_warning).toBeDefined();
    expect(parsed._deprecation_warning).toContain("memory");
    expect(parsed._deprecation_warning).toContain("create");
  });

  it('should NOT wrap results for consolidated tool names', () => {
    const result = {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ success: true })
      }]
    };
    const wrapped = wrapWithDeprecationWarning(result, 'memory');
    // No deprecation for consolidated tool names
    const parsed = JSON.parse(wrapped.content[0].text);
    expect(parsed._deprecation_warning).toBeUndefined();
  });

  it('should populate _meta.deprecation_warning for all mapped legacy tools', () => {
    const legacyTools = Object.keys(TOOL_CONSOLIDATION_MAP);
    for (const tool of legacyTools) {
      const migration = getLegacyToolMigration(tool);
      expect(migration.isLegacy).toBe(true);
      expect(migration.suggestion).toBeTruthy();
    }
  });

  it('getLegacyToolMigration should produce correct suggestions for all 11 consolidated tools', () => {
    const expectedMappings = [
      { legacy: 'store_memory', consolidated: 'memory', op: 'create' },
      { legacy: 'search_memory', consolidated: 'search', op: 'query' },
      { legacy: 'get_stats', consolidated: 'stats', op: 'usage' },
      { legacy: 'create_context', consolidated: 'context', op: 'create' },
      { legacy: 'create_snapshot', consolidated: 'snapshot', op: 'create' },
      { legacy: 'get_memory_graph', consolidated: 'graph', op: 'get' },
      { legacy: 'detect_memory_contradictions', consolidated: 'contradictions', op: 'detect' },
      { legacy: 'infer_causality', consolidated: 'causality', op: 'infer' },
      { legacy: 'search_at_time', consolidated: 'temporal', op: 'search' },
      { legacy: 'query_audit_log', consolidated: 'audit', op: 'query' },
      { legacy: 'classify_query_intent', consolidated: 'classify', op: 'intent' },
      { legacy: 'ingest_document', consolidated: 'memory', op: 'ingest' },
    ];
    for (const { legacy, consolidated, op } of expectedMappings) {
      const migration = getLegacyToolMigration(legacy);
      expect(migration.isLegacy).toBe(true);
      expect(migration.suggestion).toContain(`'${consolidated}'`);
      expect(migration.suggestion).toContain(`operation='${op}'`);
    }
  });
});
