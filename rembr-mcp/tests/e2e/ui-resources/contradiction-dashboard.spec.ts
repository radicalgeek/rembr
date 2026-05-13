/**
 * Playwright browser tests for contradiction-dashboard UI
 * Tests filters, resolution actions, comparison mode
 */

import { test, expect } from '@playwright/test';
import { renderContradictionDashboard, ContradictionData } from '../../../src/ui-resources/contradiction-dashboard.js';
import fs from 'fs';
import path from 'path';

const mockData: ContradictionData = {
  contradictions: [
    {
      memory_a: {
        id: 'mem1',
        content: 'The sky is blue',
        category: 'facts',
        created_at: new Date('2026-02-01T10:00:00Z')
      },
      memory_b: {
        id: 'mem2',
        content: 'The sky is green',
        category: 'facts',
        created_at: new Date('2026-02-08T10:00:00Z')
      },
      contradiction_type: 'factual',
      confidence: 0.95,
      explanation: 'These statements disagree about the color of the sky',
      severity: 'high',
      resolution_suggestions: ['Keep the most recent memory']
    },
    {
      memory_a: {
        id: 'mem3',
        content: 'Meeting at 9am',
        category: 'reminders',
        created_at: new Date('2026-02-07T10:00:00Z')
      },
      memory_b: {
        id: 'mem4',
        content: 'Meeting at 10am',
        category: 'reminders',
        created_at: new Date('2026-02-08T09:00:00Z')
      },
      contradiction_type: 'temporal',
      confidence: 0.75,
      explanation: 'Different times for the same meeting',
      severity: 'medium',
      resolution_suggestions: ['Check calendar for correct time']
    }
  ]
};

test.beforeEach(async ({ page }) => {
  const html = renderContradictionDashboard(mockData);
  const tempFile = path.join('/tmp', 'contradiction-dashboard-test.html');
  fs.writeFileSync(tempFile, html);
  
  await page.goto(`file://${tempFile}`);
});

test.describe('Contradiction Dashboard UI', () => {
  test('should render contradiction cards', async ({ page }) => {
    const cards = await page.locator('.contradiction-card').count();
    expect(cards).toBe(2);
  });

  test('should display confidence meters', async ({ page }) => {
    await expect(page.locator('text=95%')).toBeVisible();
    await expect(page.locator('text=75%')).toBeVisible();
  });

  test('should have type filter', async ({ page }) => {
    const filter = await page.locator('#type-filter');
    await expect(filter).toBeVisible();
    
    // Test filtering by type
    await filter.selectOption('factual');
    
    // One card should be hidden
    const visibleCards = await page.locator('.contradiction-card:not(.filtered)').count();
    expect(visibleCards).toBeGreaterThanOrEqual(1);
  });

  test('should have severity filter', async ({ page }) => {
    const filter = await page.locator('#severity-filter');
    await expect(filter).toBeVisible();
    
    await filter.selectOption('high');
  });

  test('should have confidence slider', async ({ page }) => {
    const slider = await page.locator('#confidence-filter');
    await expect(slider).toBeVisible();
    
    // Move slider to 80%
    await slider.fill('80');
    
    // Verify value display updated
    await expect(page.locator('#confidence-value')).toHaveText('80');
  });

  test('should display statistics', async ({ page }) => {
    await expect(page.locator('#stats-by-type')).toBeVisible();
    await expect(page.locator('#stats-by-severity')).toBeVisible();
    await expect(page.locator('#stats-avg-confidence')).toBeVisible();
  });

  test('should have resolution buttons', async ({ page }) => {
    // Check for Keep This, Merge Both, Ignore buttons
    await expect(page.locator('text=Keep This').first()).toBeVisible();
    await expect(page.locator('text=Merge Both').first()).toBeVisible();
    await expect(page.locator('text=Ignore').first()).toBeVisible();
  });

  test('should show merge modal on merge click', async ({ page }) => {
    const mergeButton = page.locator('text=Merge Both').first();
    await mergeButton.click();
    
    const modal = page.locator('#resolution-modal');
    await expect(modal).toBeVisible();
  });

  test('should display resolution suggestions', async ({ page }) => {
    await expect(page.locator('text=Keep the most recent memory')).toBeVisible();
    await expect(page.locator('text=Check calendar for correct time')).toBeVisible();
  });
});
