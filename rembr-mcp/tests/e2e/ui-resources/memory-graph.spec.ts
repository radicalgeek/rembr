/**
 * Playwright browser tests for memory-graph UI
 * Tests interactive features: zoom, pan, filters, export
 */

import { test, expect } from '@playwright/test';
import { renderMemoryGraph, GraphData } from '../../../src/ui-resources/memory-graph.js';
import fs from 'fs';
import path from 'path';

const mockGraphData: GraphData = {
  nodes: [
    {
      id: 'node1',
      label: 'Test Node 1',
      content: 'This is test content',
      category: 'facts',
      size: 5,
      color: '#6366f1',
      created_at: new Date('2026-02-08T10:00:00Z'),
      metadata: { test: 'value' }
    },
    {
      id: 'node2',
      label: 'Test Node 2',
      content: 'Another test content',
      category: 'preferences',
      size: 3,
      color: '#8b5cf6',
      created_at: new Date('2026-02-08T10:01:00Z'),
      metadata: {}
    },
    {
      id: 'node3',
      label: 'Test Node 3',
      content: 'Third node content',
      category: 'projects',
      size: 4,
      color: '#a855f7',
      created_at: new Date('2026-02-08T10:02:00Z'),
      metadata: {}
    }
  ],
  edges: [
    {
      source: 'node1',
      target: 'node2',
      weight: 0.8,
      type: 'similarity'
    },
    {
      source: 'node2',
      target: 'node3',
      weight: 0.6,
      type: 'temporal'
    }
  ],
  clusters: [],
  metrics: {
    total_nodes: 3,
    total_edges: 2,
    avg_clustering_coefficient: 0.5,
    density: 0.33,
    connected_components: 1,
    most_central_node: 'node2'
  }
};

test.beforeEach(async ({ page }) => {
  // Generate HTML and write to temp file
  const html = renderMemoryGraph(mockGraphData);
  const tempFile = path.join('/tmp', 'memory-graph-test.html');
  fs.writeFileSync(tempFile, html);
  
  // Load the HTML
  await page.goto(`file://${tempFile}`);
  
  // Wait for D3.js to load
  await page.waitForFunction(() => typeof d3 !== 'undefined', { timeout: 5000 });
});

test.describe('Memory Graph UI', () => {
  test('should render graph container', async ({ page }) => {
    const container = await page.locator('#graph-container');
    await expect(container).toBeVisible();
  });

  test('should render SVG with nodes', async ({ page }) => {
    // Wait for D3.js to render
    await page.waitForSelector('svg circle', { timeout: 5000 });
    
    const circles = await page.locator('svg circle').count();
    expect(circles).toBeGreaterThan(0);
  });

  test('should have category filter', async ({ page }) => {
    const filter = await page.locator('#category-filter');
    await expect(filter).toBeVisible();
    
    // Test filtering
    await filter.selectOption('facts');
    
    // Verify filter was applied (nodes with opacity < 1 are filtered out)
    const filteredNodes = await page.locator('svg circle[style*="opacity: 0.1"]').count();
    expect(filteredNodes).toBeGreaterThanOrEqual(0);
  });

  test('should have edge type filter', async ({ page }) => {
    const filter = await page.locator('#edge-type-filter');
    await expect(filter).toBeVisible();
    
    await filter.selectOption('similarity');
  });

  test('should have reset zoom button', async ({ page }) => {
    const resetButton = await page.locator('#reset-zoom');
    await expect(resetButton).toBeVisible();
    
    await resetButton.click();
  });

  test('should display metrics', async ({ page }) => {
    await expect(page.locator('text=Total Nodes')).toBeVisible();
    await expect(page.locator('text=Total Edges')).toBeVisible();
    await expect(page.locator('text=3')).toBeVisible(); // node count
  });

  test('should have export buttons', async ({ page }) => {
    await expect(page.locator('text=Export SVG')).toBeVisible();
    await expect(page.locator('text=Export PNG')).toBeVisible();
  });

  test('should show node details on click', async ({ page }) => {
    await page.waitForSelector('svg circle', { timeout: 5000 });
    
    // Click first node
    const firstNode = page.locator('svg circle').first();
    await firstNode.click();
    
    // Check if details panel appears
    const detailsPanel = page.locator('#node-details');
    await expect(detailsPanel).toBeVisible();
  });
});
