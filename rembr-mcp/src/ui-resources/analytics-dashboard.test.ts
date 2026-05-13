/**
 * Unit tests for analytics-dashboard UI renderer
 */

import { describe, it, expect } from 'vitest';
import { renderAnalyticsDashboard, PredictiveAnalyticsData } from './analytics-dashboard.js';

describe('analytics-dashboard', () => {
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

  it('should generate valid HTML', () => {
    const html = renderAnalyticsDashboard(mockData);
    
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('</html>');
  });

  it('should include dashboard title', () => {
    const html = renderAnalyticsDashboard(mockData);
    
    expect(html).toContain('Predictive Analytics');
  });

  it('should include Chart.js script', () => {
    const html = renderAnalyticsDashboard(mockData);
    
    expect(html).toContain('chart.js');
  });

  it('should display growth prediction', () => {
    const html = renderAnalyticsDashboard(mockData);
    
    expect(html).toContain('+150'); // next_30_days
    expect(html).toContain('25.0%'); // growth_rate
  });

  it('should display relationship likelihood', () => {
    const html = renderAnalyticsDashboard(mockData);
    
    expect(html).toContain('75%');
  });

  it('should display quality risk level', () => {
    const html = renderAnalyticsDashboard(mockData);
    
    expect(html).toContain('MEDIUM');
  });

  it('should include chart canvases', () => {
    const html = renderAnalyticsDashboard(mockData);
    
    expect(html).toContain('growth-chart');
    expect(html).toContain('category-chart');
  });

  it('should display risk factors', () => {
    const html = renderAnalyticsDashboard(mockData);
    
    expect(html).toContain('High duplication rate');
    expect(html).toContain('Low quality scores');
  });

  it('should display recommendations', () => {
    const html = renderAnalyticsDashboard(mockData);
    
    expect(html).toContain('Run deduplication');
    expect(html).toContain('Review low-quality memories');
  });
});
