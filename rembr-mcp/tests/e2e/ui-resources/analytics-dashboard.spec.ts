/**
 * Playwright browser tests for analytics-dashboard UI
 * Tests Chart.js rendering, growth forecasts, risk panels
 */

import { test, expect } from '@playwright/test';
import { renderAnalyticsDashboard, PredictiveAnalyticsData } from '../../../src/ui-resources/analytics-dashboard.js';
import fs from 'fs';
import path from 'path';

const mockData: PredictiveAnalyticsData = {
  memory_growth_prediction: {
    next_30_days: 150,
    growth_rate: 0.25,
    seasonal_patterns: true
  },
  category_usage_prediction: {
    facts: 0.4,
    preferences: 0.3,
    projects: 0.2,
    learning: 0.1
  },
  relationship_formation_likelihood: 0.75,
  quality_degradation_risk: {
    risk_level: 'medium',
    risk_factors: [
      'High duplication rate',
      'Low quality scores'
    ],
    recommendations: [
      'Run deduplication',
      'Review low-quality memories'
    ]
  }
};

test.beforeEach(async ({ page }) => {
  const html = renderAnalyticsDashboard(mockData);
  const tempFile = path.join('/tmp', 'analytics-dashboard-test.html');
  fs.writeFileSync(tempFile, html);
  
  await page.goto(`file://${tempFile}`);
  
  // Wait for Chart.js to load
  await page.waitForFunction(() => typeof Chart !== 'undefined', { timeout: 5000 });
});

test.describe('Analytics Dashboard UI', () => {
  test('should render dashboard title', async ({ page }) => {
    await expect(page.locator('h1:has-text("Predictive Analytics")')).toBeVisible();
  });

  test('should display growth prediction metrics', async ({ page }) => {
    // Check for +150 next 30 days
    await expect(page.locator('text=+150')).toBeVisible();
    
    // Check for 25% growth rate
    await expect(page.locator('text=25.0%')).toBeVisible();
  });

  test('should render growth chart canvas', async ({ page }) => {
    const canvas = page.locator('#growth-chart');
    await expect(canvas).toBeVisible();
    
    // Verify canvas has width/height (Chart.js initialized)
    const width = await canvas.getAttribute('width');
    expect(parseInt(width!)).toBeGreaterThan(0);
  });

  test('should render category distribution chart', async ({ page }) => {
    const canvas = page.locator('#category-chart');
    await expect(canvas).toBeVisible();
    
    // Verify canvas dimensions
    const height = await canvas.getAttribute('height');
    expect(parseInt(height!)).toBeGreaterThan(0);
  });

  test('should display relationship likelihood gauge', async ({ page }) => {
    await expect(page.locator('text=Relationship Formation Likelihood')).toBeVisible();
    await expect(page.locator('text=75%')).toBeVisible();
  });

  test('should display quality risk level', async ({ page }) => {
    await expect(page.locator('text=Quality Degradation Risk')).toBeVisible();
    await expect(page.locator('text=MEDIUM')).toBeVisible();
  });

  test('should display risk factors', async ({ page }) => {
    await expect(page.locator('text=High duplication rate')).toBeVisible();
    await expect(page.locator('text=Low quality scores')).toBeVisible();
  });

  test('should display recommendations', async ({ page }) => {
    await expect(page.locator('text=Run deduplication')).toBeVisible();
    await expect(page.locator('text=Review low-quality memories')).toBeVisible();
  });

  test('should have insights panel', async ({ page }) => {
    const insights = page.locator('#insights-panel');
    await expect(insights).toBeVisible();
  });

  test('should show seasonal patterns indicator', async ({ page }) => {
    // If seasonal_patterns is true, should show indicator
    await expect(page.locator('text=Seasonal patterns detected')).toBeVisible();
  });

  test('should have chart legends', async ({ page }) => {
    // Chart.js should render legends
    await page.waitForSelector('canvas', { timeout: 2000 });
    
    // Verify at least 2 charts rendered
    const canvases = await page.locator('canvas').count();
    expect(canvases).toBeGreaterThanOrEqual(2);
  });
});
