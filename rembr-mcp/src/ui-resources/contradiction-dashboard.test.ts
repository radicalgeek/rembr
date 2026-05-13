/**
 * Unit tests for contradiction-dashboard UI renderer
 */

import { describe, it, expect } from 'vitest';
import { renderContradictionDashboard, ContradictionData } from './contradiction-dashboard.js';

describe('contradiction-dashboard', () => {
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
        resolution_suggestions: [
          'Keep the most recent memory',
          'Verify with external source'
        ]
      }
    ]
  };

  it('should generate valid HTML', () => {
    const html = renderContradictionDashboard(mockData);
    
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('</html>');
  });

  it('should include dashboard title', () => {
    const html = renderContradictionDashboard(mockData);
    
    expect(html).toContain('Contradiction Detection');
  });

  it('should display contradiction count', () => {
    const html = renderContradictionDashboard(mockData);
    
    expect(html).toContain('1 Contradiction');
  });

  it('should include filter controls', () => {
    const html = renderContradictionDashboard(mockData);
    
    expect(html).toContain('type-filter');
    expect(html).toContain('severity-filter');
    expect(html).toContain('confidence-filter');
  });

  it('should display confidence meter', () => {
    const html = renderContradictionDashboard(mockData);
    
    expect(html).toContain('Confidence:');
    expect(html).toContain('95%');
  });

  it('should include resolution actions', () => {
    const html = renderContradictionDashboard(mockData);
    
    expect(html).toContain('Keep This'); // Keep A button
    expect(html).toContain('Merge Both');
    expect(html).toContain('Ignore');
  });

  it('should render memory content safely', () => {
    const html = renderContradictionDashboard(mockData);
    
    // Should contain memory content
    expect(html).toContain('The sky is blue');
    expect(html).toContain('The sky is green');
  });

  it('should show empty state when no contradictions', () => {
    const emptyData: ContradictionData = { contradictions: [] };
    const html = renderContradictionDashboard(emptyData);
    
    expect(html).toContain('No Contradictions Detected');
  });
});
