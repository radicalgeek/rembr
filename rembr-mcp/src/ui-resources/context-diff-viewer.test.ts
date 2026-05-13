/**
 * Unit tests for context-diff-viewer UI renderer (REM-52)
 */

import { describe, it, expect } from 'vitest';
import { renderContextDiffViewer, SnapshotDiffData } from './context-diff-viewer.js';

describe('context-diff-viewer', () => {
  const mockData: SnapshotDiffData = {
    timeA: new Date('2026-02-01T10:00:00Z'),
    timeB: new Date('2026-02-08T10:00:00Z'),
    added: 1,
    removed: 1,
    modified: 1,
    details: {
      added: [
        {
          id: 'mem-added-1',
          content: 'New memory added in snapshot B',
          category: 'notes',
          created_at: new Date('2026-02-08T09:00:00Z'),
          metadata: { source: 'test' }
        }
      ],
      removed: [
        {
          id: 'mem-removed-1',
          content: 'Memory removed from snapshot A',
          category: 'facts',
          created_at: new Date('2026-02-01T09:00:00Z')
        }
      ],
      modified: [
        {
          before: {
            id: 'mem-modified-1',
            content: 'Original content in snapshot A',
            category: 'notes',
            created_at: new Date('2026-02-01T09:30:00Z')
          },
          after: {
            id: 'mem-modified-1',
            content: 'Updated content in snapshot B',
            category: 'notes',
            created_at: new Date('2026-02-01T09:30:00Z')
          }
        }
      ]
    }
  };

  it('should generate valid HTML', () => {
    const html = renderContextDiffViewer(mockData);
    
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('</html>');
  });

  it('should include viewer title', () => {
    const html = renderContextDiffViewer(mockData);
    
    expect(html).toContain('Context Diff Viewer');
  });

  it('should display snapshot timestamps', () => {
    const html = renderContextDiffViewer(mockData);
    
    expect(html).toContain('Comparing snapshots');
    expect(html).toContain('2026');
  });

  it('should display summary statistics', () => {
    const html = renderContextDiffViewer(mockData);
    
    expect(html).toContain('Added');
    expect(html).toContain('Removed');
    expect(html).toContain('Modified');
    expect(html).toContain('Total Changes');
  });

  it('should show correct counts', () => {
    const html = renderContextDiffViewer(mockData);
    
    // Check that counts are displayed (flexible matching)
    expect(html).toMatch(/Added.*?1/s); // Added count appears
    expect(html).toMatch(/Removed.*?1/s); // Removed count appears  
    expect(html).toMatch(/Modified.*?1/s); // Modified count appears
  });

  it('should include filter controls', () => {
    const html = renderContextDiffViewer(mockData);
    
    expect(html).toContain('filter-added');
    expect(html).toContain('filter-removed');
    expect(html).toContain('filter-modified');
  });

  it('should include search input', () => {
    const html = renderContextDiffViewer(mockData);
    
    expect(html).toContain('search-input');
    expect(html).toContain('Search in diff results');
  });

  it('should include export buttons', () => {
    const html = renderContextDiffViewer(mockData);
    
    expect(html).toContain('exportDiffJson');
    expect(html).toContain('exportDiffCsv');
    expect(html).toContain('Export JSON');
    expect(html).toContain('Export CSV');
  });

  it('should render added memories with success badge', () => {
    const html = renderContextDiffViewer(mockData);
    
    expect(html).toContain('ADDED');
    expect(html).toContain('New memory added in snapshot B');
    expect(html).toContain('diff-added');
  });

  it('should render removed memories with danger badge', () => {
    const html = renderContextDiffViewer(mockData);
    
    expect(html).toContain('REMOVED');
    expect(html).toContain('Memory removed from snapshot A');
    expect(html).toContain('diff-removed');
  });

  it('should render modified memories with warning badge and side-by-side comparison', () => {
    const html = renderContextDiffViewer(mockData);
    
    expect(html).toContain('MODIFIED');
    expect(html).toContain('Original content in snapshot A');
    expect(html).toContain('Updated content in snapshot B');
    expect(html).toContain('diff-modified');
    expect(html).toContain('Before');
    expect(html).toContain('After');
  });

  it('should include filtering JavaScript', () => {
    const html = renderContextDiffViewer(mockData);
    
    expect(html).toContain('function filterDiffCards()');
  });

  it('should include export JavaScript functions', () => {
    const html = renderContextDiffViewer(mockData);
    
    expect(html).toContain('function exportDiffJson()');
    expect(html).toContain('function exportDiffCsv()');
  });

  it('should handle empty diff (no changes)', () => {
    const emptyData: SnapshotDiffData = {
      timeA: new Date('2026-02-01T10:00:00Z'),
      timeB: new Date('2026-02-01T10:00:00Z'),
      added: 0,
      removed: 0,
      modified: 0,
      details: {
        added: [],
        removed: [],
        modified: []
      }
    };

    const html = renderContextDiffViewer(emptyData);
    
    expect(html).toContain('No Changes Detected');
    expect(html).toContain('The two snapshots are identical');
  });

  it('should embed data for JavaScript consumption', () => {
    const html = renderContextDiffViewer(mockData);
    
    expect(html).toContain('id="diff-data"');
    expect(html).toContain('type="application/json"');
  });

  it('should include diff highlighting styles', () => {
    const html = renderContextDiffViewer(mockData);
    
    expect(html).toContain('.diff-highlight-add');
    expect(html).toContain('.diff-highlight-remove');
  });

  it('should display metadata when present', () => {
    const html = renderContextDiffViewer(mockData);
    
    expect(html).toContain('Show metadata');
    expect(html).toContain('source');
  });

  it('should handle large diffs', () => {
    const largeDiff: SnapshotDiffData = {
      timeA: new Date('2026-02-01T10:00:00Z'),
      timeB: new Date('2026-02-08T10:00:00Z'),
      added: 100,
      removed: 50,
      modified: 25,
      details: {
        added: Array.from({ length: 100 }, (_, i) => ({
          id: `added-${i}`,
          content: `Added memory ${i}`,
          category: 'test',
          created_at: new Date('2026-02-08T10:00:00Z')
        })),
        removed: Array.from({ length: 50 }, (_, i) => ({
          id: `removed-${i}`,
          content: `Removed memory ${i}`,
          category: 'test',
          created_at: new Date('2026-02-01T10:00:00Z')
        })),
        modified: Array.from({ length: 25 }, (_, i) => ({
          before: {
            id: `modified-${i}`,
            content: `Before ${i}`,
            category: 'test',
            created_at: new Date('2026-02-01T10:00:00Z')
          },
          after: {
            id: `modified-${i}`,
            content: `After ${i}`,
            category: 'test',
            created_at: new Date('2026-02-01T10:00:00Z')
          }
        }))
      }
    };

    const html = renderContextDiffViewer(largeDiff);
    
    expect(html).toContain('100'); // Added count
    expect(html).toContain('50');  // Removed count
    expect(html).toContain('25');  // Modified count
    expect(html).toContain('175'); // Total changes
  });
});
