/**
 * Playwright browser tests for snapshot-timeline UI
 * Tests D3.js timeline rendering, snapshot cards, comparison mode
 */

import { test, expect } from '@playwright/test';
import { renderSnapshotTimeline, SnapshotTimelineData } from '../../../src/ui-resources/snapshot-timeline.js';
import fs from 'fs';
import path from 'path';

const mockData: SnapshotTimelineData = {
  snapshots: [
    {
      id: 'snap1',
      name: 'Morning Context',
      description: 'Context from morning work',
      memory_count: 50,
      token_count: 25000,
      created_at: new Date('2026-02-08T09:00:00Z'),
      expires_at: new Date('2026-02-15T09:00:00Z')
    },
    {
      id: 'snap2',
      name: 'Afternoon Context',
      description: null,
      memory_count: 75,
      token_count: 35000,
      created_at: new Date('2026-02-08T14:00:00Z'),
      expires_at: null
    },
    {
      id: 'snap3',
      name: 'Evening Context',
      description: 'End of day summary',
      memory_count: 60,
      token_count: 28000,
      created_at: new Date('2026-02-08T18:00:00Z'),
      expires_at: new Date('2026-02-22T18:00:00Z')
    }
  ]
};

test.beforeEach(async ({ page }) => {
  const html = renderSnapshotTimeline(mockData);
  const tempFile = path.join('/tmp', 'snapshot-timeline-test.html');
  fs.writeFileSync(tempFile, html);
  
  await page.goto(`file://${tempFile}`);
  
  // Wait for D3.js to load
  await page.waitForFunction(() => typeof d3 !== 'undefined', { timeout: 5000 });
});

test.describe('Snapshot Timeline UI', () => {
  test('should render timeline title', async ({ page }) => {
    await expect(page.locator('h1:has-text("Snapshot Timeline")')).toBeVisible();
  });

  test('should display snapshot count', async ({ page }) => {
    await expect(page.locator('text=3 Snapshots')).toBeVisible();
  });

  test('should render SVG timeline visualization', async ({ page }) => {
    await page.waitForSelector('#timeline-viz svg', { timeout: 5000 });
    
    const svg = page.locator('#timeline-viz svg');
    await expect(svg).toBeVisible();
  });

  test('should display snapshot cards', async ({ page }) => {
    await expect(page.locator('text=Morning Context')).toBeVisible();
    await expect(page.locator('text=Afternoon Context')).toBeVisible();
    await expect(page.locator('text=Evening Context')).toBeVisible();
  });

  test('should show total statistics', async ({ page }) => {
    await expect(page.locator('text=Total Snapshots')).toBeVisible();
    await expect(page.locator('text=Total Memories')).toBeVisible();
    await expect(page.locator('text=Total Tokens')).toBeVisible();
    
    // Verify calculated totals
    await expect(page.locator('text=185')).toBeVisible(); // 50+75+60 memories
    await expect(page.locator('text=88,000')).toBeVisible(); // 25k+35k+28k tokens
  });

  test('should show expiration badges', async ({ page }) => {
    // One snapshot has "Expires", one has "No expiration"
    await expect(page.locator('text=Expires')).toBeVisible();
    await expect(page.locator('text=No expiration')).toBeVisible();
  });

  test('should have compare buttons', async ({ page }) => {
    const compareButtons = await page.locator('button:has-text("Compare")').count();
    expect(compareButtons).toBeGreaterThan(0);
  });

  test('should open comparison modal on compare click', async ({ page }) => {
    await page.waitForSelector('button:has-text("Compare")', { timeout: 2000 });
    
    const firstCompareBtn = page.locator('button:has-text("Compare")').first();
    await firstCompareBtn.click();
    
    // Comparison modal should appear
    const modal = page.locator('#comparison-modal');
    await expect(modal).toBeVisible();
  });

  test('should display memory counts in cards', async ({ page }) => {
    await expect(page.locator('text=50 memories')).toBeVisible();
    await expect(page.locator('text=75 memories')).toBeVisible();
    await expect(page.locator('text=60 memories')).toBeVisible();
  });

  test('should display token counts in cards', async ({ page }) => {
    await expect(page.locator('text=25,000')).toBeVisible();
    await expect(page.locator('text=35,000')).toBeVisible();
    await expect(page.locator('text=28,000')).toBeVisible();
  });

  test('should render D3 timeline with nodes', async ({ page }) => {
    await page.waitForSelector('#timeline-viz svg circle', { timeout: 5000 });
    
    // Timeline should have circles for each snapshot
    const circles = await page.locator('#timeline-viz svg circle').count();
    expect(circles).toBeGreaterThanOrEqual(3);
  });

  test('should show snapshot descriptions when available', async ({ page }) => {
    await expect(page.locator('text=Context from morning work')).toBeVisible();
    await expect(page.locator('text=End of day summary')).toBeVisible();
  });
});
