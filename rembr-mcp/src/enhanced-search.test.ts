/**
 * Unit tests for EnhancedSearchService (REM-39)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EnhancedSearchService, FilteredMemory, AdvancedFilter } from './enhanced-search.js';

const TENANT = 'aaaaaaaa-0000-0000-0000-000000000039';

function makeMemory(overrides: Partial<FilteredMemory> = {}): FilteredMemory {
  return {
    id:             'mem-0001-0000-0000-000000000001',
    content:        'Test memory content about software engineering',
    category:       'notes',
    metadata:       { source: 'test' },
    pii_detected:   false,
    created_at:     '2026-02-01T00:00:00.000Z',
    updated_at:     '2026-02-01T00:00:00.000Z',
    content_length: 46,
    ...overrides,
  };
}

function makePool(rowsOrFn: Record<string, unknown>[] | ((sql: string) => Record<string, unknown>[]) = []) {
  const queryFn = typeof rowsOrFn === 'function' ? rowsOrFn : () => rowsOrFn;
  return {
    query: vi.fn().mockImplementation((sql: string) => Promise.resolve({ rows: queryFn(sql), rowCount: queryFn(sql).length })),
  } as any;
}

// ─────────────────────────────────────────────────────────
// Export Formatters
// ─────────────────────────────────────────────────────────
describe('EnhancedSearchService — exportAsJSON', () => {
  it('returns valid JSON with count and items', () => {
    const svc = new EnhancedSearchService(makePool(), TENANT);
    const items = [makeMemory()];
    const json = svc.exportAsJSON(items, { filter: 'notes' });
    const parsed = JSON.parse(json);
    expect(parsed.count).toBe(1);
    expect(parsed.items[0].id).toBe(items[0].id);
    expect(parsed.exported_at).toBeDefined();
  });

  it('handles empty items', () => {
    const svc = new EnhancedSearchService(makePool(), TENANT);
    const json = svc.exportAsJSON([]);
    expect(JSON.parse(json).count).toBe(0);
    expect(JSON.parse(json).items).toHaveLength(0);
  });
});

describe('EnhancedSearchService — exportAsCSV', () => {
  it('produces header + data rows', () => {
    const svc = new EnhancedSearchService(makePool(), TENANT);
    const csv = svc.exportAsCSV([makeMemory()]);
    const lines = csv.split('\n');
    expect(lines[0]).toContain('id,category');
    expect(lines[1]).toContain('mem-0001');
    expect(lines[1]).toContain('notes');
  });

  it('escapes commas in content', () => {
    const svc = new EnhancedSearchService(makePool(), TENANT);
    const item = makeMemory({ content: 'a, b, c' });
    const csv = svc.exportAsCSV([item]);
    expect(csv).toContain('"a, b, c"');
  });

  it('handles empty items list', () => {
    const svc = new EnhancedSearchService(makePool(), TENANT);
    const csv = svc.exportAsCSV([]);
    const lines = csv.split('\n').filter(Boolean);
    expect(lines).toHaveLength(1); // header only
  });
});

describe('EnhancedSearchService — exportAsMarkdown', () => {
  it('generates markdown with table', () => {
    const svc = new EnhancedSearchService(makePool(), TENANT);
    const md = svc.exportAsMarkdown([makeMemory()], 'My Results');
    expect(md).toContain('# My Results');
    expect(md).toContain('| id | category |');
    expect(md).toContain('notes');
    expect(md).toContain('✅'); // no PII
  });

  it('shows PII warning emoji for pii_detected memories', () => {
    const svc = new EnhancedSearchService(makePool(), TENANT);
    const md = svc.exportAsMarkdown([makeMemory({ pii_detected: true })]);
    expect(md).toContain('⚠️');
  });

  it('uses default title when none provided', () => {
    const svc = new EnhancedSearchService(makePool(), TENANT);
    const md = svc.exportAsMarkdown([]);
    expect(md).toContain('# Search Results');
  });
});

describe('EnhancedSearchService — export dispatcher', () => {
  it('routes json', () => {
    const svc = new EnhancedSearchService(makePool(), TENANT);
    expect(() => JSON.parse(svc.export([makeMemory()], 'json'))).not.toThrow();
  });

  it('routes csv', () => {
    const svc = new EnhancedSearchService(makePool(), TENANT);
    expect(svc.export([makeMemory()], 'csv')).toContain('id,category');
  });

  it('routes markdown', () => {
    const svc = new EnhancedSearchService(makePool(), TENANT);
    expect(svc.export([makeMemory()], 'markdown')).toContain('#');
  });
});

// ─────────────────────────────────────────────────────────
// Batch Safety Guards
// ─────────────────────────────────────────────────────────
describe('EnhancedSearchService — batchDelete safety', () => {
  it('returns error when no filter is provided', async () => {
    const svc = new EnhancedSearchService(makePool(), TENANT);
    const result = await svc.batchDelete({});
    expect(result.affected).toBe(0);
    expect(result.errors[0]).toMatch(/requires at least one filter/i);
  });

  it('returns 0 when filter matches nothing', async () => {
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ total: '0' }] })   // count
        .mockResolvedValueOnce({ rows: [] }),                 // data
    } as any;
    const svc = new EnhancedSearchService(pool, TENANT);
    const result = await svc.batchDelete({ category: 'nonexistent' });
    expect(result.affected).toBe(0);
    expect(result.ids).toHaveLength(0);
  });
});

describe('EnhancedSearchService — batchUpdate safety', () => {
  it('returns error when no filter provided', async () => {
    const svc = new EnhancedSearchService(makePool(), TENANT);
    const result = await svc.batchUpdate({}, { category: 'new' });
    expect(result.errors[0]).toMatch(/requires at least one filter/i);
  });

  it('returns error when no updates provided', async () => {
    const svc = new EnhancedSearchService(makePool(), TENANT);
    const result = await svc.batchUpdate({ category: 'notes' }, {});
    expect(result.errors[0]).toMatch(/requires category or metadata_merge/i);
  });
});

// ─────────────────────────────────────────────────────────
// Saved Searches
// ─────────────────────────────────────────────────────────
describe('EnhancedSearchService — saveSearch', () => {
  it('calls INSERT and returns saved search', async () => {
    const fakeRow = {
      id: 'search-uuid-001',
      name: 'my-notes',
      description: 'All notes',
      filter: JSON.stringify({ category: 'notes' }),
      tenant_id: TENANT,
      created_at: new Date('2026-02-27'),
      last_used_at: null,
      use_count: 0,
    };
    const pool = { query: vi.fn().mockResolvedValue({ rows: [fakeRow] }) } as any;
    const svc = new EnhancedSearchService(pool, TENANT);
    const result = await svc.saveSearch('my-notes', { category: 'notes' }, 'All notes');
    expect(result.name).toBe('my-notes');
    expect(result.filter).toEqual({ category: 'notes' });
    expect(result.use_count).toBe(0);
  });
});

describe('EnhancedSearchService — deleteSavedSearch', () => {
  it('returns true when row deleted', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rowCount: 1, rows: [] }) } as any;
    const svc = new EnhancedSearchService(pool, TENANT);
    expect(await svc.deleteSavedSearch('my-notes')).toBe(true);
  });

  it('returns false when not found', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rowCount: 0, rows: [] }) } as any;
    const svc = new EnhancedSearchService(pool, TENANT);
    expect(await svc.deleteSavedSearch('ghost')).toBe(false);
  });
});

describe('EnhancedSearchService — executeSavedSearch', () => {
  it('throws when saved search not found', async () => {
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // ensure table
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }), // UPDATE returns nothing
    } as any;
    const svc = new EnhancedSearchService(pool, TENANT);
    await expect(svc.executeSavedSearch('ghost')).rejects.toThrow(/not found/i);
  });
});

// ─────────────────────────────────────────────────────────
// filterMemories
// ─────────────────────────────────────────────────────────
describe('EnhancedSearchService — filterMemories', () => {
  it('returns items with content_length', async () => {
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ total: '1' }] })
        .mockResolvedValueOnce({ rows: [{
          id: 'mem-0001', content: 'Hello world', category: 'notes',
          metadata: {}, pii_detected: false,
          created_at: new Date('2026-02-01'), updated_at: new Date('2026-02-01'),
        }] }),
    } as any;
    const svc = new EnhancedSearchService(pool, TENANT);
    const { items, total } = await svc.filterMemories({ category: 'notes' });
    expect(total).toBe(1);
    expect(items[0].content_length).toBe('Hello world'.length);
  });

  it('caps limit at 500', async () => {
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ total: '0' }] })  // COUNT query
        .mockResolvedValueOnce({ rows: [] }),                // data query — empty, no rows to map
    } as any;
    const svc = new EnhancedSearchService(pool, TENANT);
    const result = await svc.filterMemories({ limit: 9999 });
    // limit should be capped at 500
    expect(result.limit).toBe(500);
    // The data query params should include 500 as the limit argument
    const calls = (pool.query as any).mock.calls;
    const dataCallParams = calls[1][1] as unknown[];
    expect(dataCallParams).toContain(500);
  });
});
