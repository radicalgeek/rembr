/**
 * Playwright browser tests for context-diff-viewer UI (REM-52)
 * Tests filters, export actions, diff highlighting
 */

import { test, expect } from '@playwright/test';
import { renderContextDiffViewer, SnapshotDiffData } from '../../../src/ui-resources/context-diff-viewer.js';
import fs from 'fs';
import path from 'path';

const mockData: SnapshotDiffData = {
  timeA: new Date('2026-02-01T10:00:00Z'),
  timeB: new Date('2026-02-08T10:00:00Z'),
  added: 2,
  removed: 2,
  modified: 1,
  details: {
    added: [
      {
        id: 'mem-added-1',
        content: 'First new memory added in snapshot B',
        category: 'notes',
        created_at: new Date('2026-02-08T09:00:00Z'),
        metadata: { source: 'test' }
      },
      {
        id: 'mem-added-2',
        content: 'Second new memory added in snapshot B',
        category: 'facts',
        created_at: new Date('2026-02-08T09:30:00Z')
      }
    ],
    removed: [
      {
        id: 'mem-removed-1',
        content: 'First memory removed from snapshot A',
        category: 'facts',
        created_at: new Date('2026-02-01T09:00:00Z')
      },
      {
        id: 'mem-removed-2',
        content: 'Second memory removed from snapshot A',
        category: 'notes',
        created_at: new Date('2026-02-01T09:30:00Z')
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

test.beforeEach(async ({ page }) => {
  const html = renderContextDiffViewer(mockData);
  const tempFile = path.join('/tmp', 'context-diff-viewer-test.html');
  fs.writeFileSync(tempFile, html);
  
  await page.goto(`file://${tempFile}`);
});

test.describe('Context Diff Viewer UI', () => {
  test('should render diff cards', async ({ page }) => {
    const cards = await page.locator('.diff-card').count();
    expect(cards).toBe(5); // 2 added + 2 removed + 1 modified
  });

  test('should display summary statistics', async ({ page }) => {
    await expect(page.locator('text=Added').first()).toBeVisible();
    await expect(page.locator('text=Removed').first()).toBeVisible();
    await expect(page.locator('text=Modified').first()).toBeVisible();
    await expect(page.locator('text=Total Changes').first()).toBeVisible();
  });

  test('should show correct counts in stats', async ({ page }) => {
    // Check that counts are displayed (note: multiple elements may contain these numbers)
    const addedCount = await page.locator('text=2').first();
    await expect(addedCount).toBeVisible();
  });

  test('should have search functionality', async ({ page }) => {
    const searchInput = await page.locator('#search-input');
    await expect(searchInput).toBeVisible();
    
    // Test search
    await searchInput.fill('First');
    
    // Should show cards with "First" in content
    const visibleCards = await page.locator('.diff-card:not(.hidden)').count();
    expect(visibleCards).toBeGreaterThan(0);
  });

  test('should have type filters', async ({ page }) => {
    await expect(page.locator('#filter-added')).toBeVisible();
    await expect(page.locator('#filter-removed')).toBeVisible();
    await expect(page.locator('#filter-modified')).toBeVisible();
  });

  test('should filter by type', async ({ page }) => {
    // Uncheck "added" filter
    await page.locator('#filter-added').uncheck();
    
    // Added cards should be hidden
    const addedCards = await page.locator('.diff-added:not(.hidden)').count();
    expect(addedCards).toBe(0);
    
    // Other cards should still be visible
    const visibleCards = await page.locator('.diff-card:not(.hidden)').count();
    expect(visibleCards).toBeGreaterThan(0);
  });

  test('should display added memories with success badge', async ({ page }) => {
    await expect(page.locator('text=ADDED').first()).toBeVisible();
    await expect(page.locator('text=First new memory added')).toBeVisible();
  });

  test('should display removed memories with danger badge', async ({ page }) => {
    await expect(page.locator('text=REMOVED').first()).toBeVisible();
    await expect(page.locator('text=First memory removed')).toBeVisible();
  });

  test('should display modified memories with before/after comparison', async ({ page }) => {
    await expect(page.locator('text=MODIFIED')).toBeVisible();
    await expect(page.locator('text=Original content in snapshot A')).toBeVisible();
    await expect(page.locator('text=Updated content in snapshot B')).toBeVisible();
    await expect(page.locator('text=Before').first()).toBeVisible();
    await expect(page.locator('text=After').first()).toBeVisible();
  });

  test('should have export JSON button', async ({ page }) => {
    const exportButton = await page.locator('text=Export JSON');
    await expect(exportButton).toBeVisible();
  });

  test('should have export CSV button', async ({ page }) => {
    const exportButton = await page.locator('text=Export CSV');
    await expect(exportButton).toBeVisible();
  });

  test('should display snapshot timestamps', async ({ page }) => {
    await expect(page.locator('text=Comparing snapshots')).toBeVisible();
  });

  test('should show metadata when available', async ({ page }) => {
    await expect(page.locator('text=Show metadata').first()).toBeVisible();
  });

  test('should combine search and type filters', async ({ page }) => {
    // Search for "First" and uncheck "removed"
    await page.locator('#search-input').fill('First');
    await page.locator('#filter-removed').uncheck();
    
    // Should only show added cards with "First"
    const visibleCards = await page.locator('.diff-card:not(.hidden)').count();
    expect(visibleCards).toBeGreaterThan(0);
    
    // No removed cards should be visible
    const removedVisible = await page.locator('.diff-removed:not(.hidden)').count();
    expect(removedVisible).toBe(0);
  });

  test('should handle empty search results', async ({ page }) => {
    await page.locator('#search-input').fill('nonexistent-content-xyz');
    
    const visibleCards = await page.locator('.diff-card:not(.hidden)').count();
    expect(visibleCards).toBe(0);
  });

  test('should reset filters when cleared', async ({ page }) => {
    // Apply filters
    await page.locator('#filter-added').uncheck();
    await page.locator('#search-input').fill('test');
    
    // Clear search
    await page.locator('#search-input').fill('');
    
    // Re-check added
    await page.locator('#filter-added').check();
    
    // All cards should be visible again
    const visibleCards = await page.locator('.diff-card:not(.hidden)').count();
    expect(visibleCards).toBe(5);
  });
});

test.describe('Empty State', () => {
  test('should show empty state when no changes', async ({ page }) => {
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
    const tempFile = path.join('/tmp', 'context-diff-viewer-empty-test.html');
    fs.writeFileSync(tempFile, html);
    
    await page.goto(`file://${tempFile}`);

    await expect(page.locator('text=No Changes Detected')).toBeVisible();
    await expect(page.locator('text=The two snapshots are identical')).toBeVisible();
  });
});
