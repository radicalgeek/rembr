/**
 * Unit Tests for MCP Apps UI Resources
 * REM-119: Test HTML rendering functions for all UI components
 */

import { describe, it, expect } from 'vitest';
import { renderMemoryGraph, GraphData } from './memory-graph.js';
import { renderContradictionDashboard, ContradictionData } from './contradiction-dashboard.js';
import { renderAnalyticsDashboard, PredictiveAnalyticsData } from './analytics-dashboard.js';
import { renderSnapshotTimeline, SnapshotTimelineData } from './snapshot-timeline.js';
import { renderError, renderTemplate, safeJsonForHtml } from './index.js';

// Mock data for testing
const mockGraphData: GraphData = {
  nodes: [
    {
      id: 'node-1',
      label: 'Test Memory 1',
      content: 'This is test content',
      category: 'facts',
      size: 10,
      color: '#3b82f6',
      created_at: new Date('2026-01-01'),
      metadata: { source: 'test' }
    },
    {
      id: 'node-2',
      label: 'Test Memory 2',
      content: 'Related content',
      category: 'projects',
      size: 8,
      color: '#10b981',
      created_at: new Date('2026-01-02'),
      metadata: {}
    }
  ],
  edges: [
    {
      source: 'node-1',
      target: 'node-2',
      weight: 0.8,
      type: 'related',
      label: 'supports'
    }
  ],
  clusters: [
    {
      id: 'cluster-1',
      nodes: ['node-1', 'node-2'],
      theme: 'Test Theme',
      coherence: 0.9,
      description: 'Test cluster'
    }
  ],
  metrics: {
    total_nodes: 2,
    total_edges: 1,
    avg_clustering_coefficient: 0.5,
    density: 0.5,
    connected_components: 1,
    most_central_node: 'node-1'
  }
};

const mockContradictionData: ContradictionData = {
  contradictions: [
    {
      memory_a: {
        id: 'mem-a',
        content: 'The sky is blue',
        category: 'facts',
        created_at: new Date('2026-01-01')
      },
      memory_b: {
        id: 'mem-b',
        content: 'The sky is green',
        category: 'facts',
        created_at: new Date('2026-01-02')
      },
      contradiction_type: 'factual',
      confidence: 0.95,
      severity: 'high',
      explanation: 'Conflicting color descriptions',
      resolution_suggestions: ['Keep newer memory', 'Merge memories']
    }
  ]
};

describe('Stored active-content hardening', () => {
  const payload = '</script><script>globalThis.rembrPwned=true</script><img src=x onerror=alert(1)>';

  it('serialises embedded JSON without allowing a script-element breakout', () => {
    const serialised = safeJsonForHtml({ content: payload });

    expect(serialised).not.toContain('</script>');
    expect(serialised).not.toContain('<img');
    expect(serialised).toContain('\\u003c/script\\u003e');
  });

  it('escapes template titles and subtitles', () => {
    const html = renderTemplate({ title: payload, subtitle: payload, content: '<p>trusted</p>' });

    expect(html).not.toContain(payload);
    expect(html).toContain('&lt;/script&gt;');
  });

  it('keeps stored payloads inert across all primary UI renderers', () => {
    const graphHtml = renderMemoryGraph({
      ...mockGraphData,
      nodes: [{ ...mockGraphData.nodes[0], label: payload, content: payload, metadata: { payload } }],
    });
    const contradictionHtml = renderContradictionDashboard({
      contradictions: [{
        ...mockContradictionData.contradictions[0],
        explanation: payload,
        memory_a: { ...mockContradictionData.contradictions[0].memory_a, content: payload, category: payload },
        memory_b: { ...mockContradictionData.contradictions[0].memory_b, category: payload },
        resolution_suggestions: [payload],
      }],
    });
    const analyticsHtml = renderAnalyticsDashboard({
      ...mockAnalyticsData,
      category_usage_prediction: { [payload]: 1 },
      quality_degradation_risk: {
        ...mockAnalyticsData.quality_degradation_risk,
        risk_factors: [payload],
        recommendations: [payload],
      },
    });
    const snapshotHtml = renderSnapshotTimeline({
      snapshots: [{ ...mockTimelineData.snapshots[0], name: payload, description: payload }],
    });

    for (const html of [graphHtml, contradictionHtml, analyticsHtml, snapshotHtml]) {
      expect(html).not.toContain(payload);
      expect(html).not.toContain('<img src=x onerror=alert(1)>');
      expect(html).not.toMatch(/<script\b/i);
      expect(html).not.toMatch(/<[^>]+\son[a-z]+\s*=/i);
      expect(html).toContain("Content-Security-Policy");
    }
  });

  it('does not expose renderer errors or stack details in production', () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const error = new Error('database host and private schema detail');
      error.stack = 'PRIVATE STACK TRACE';
      const html = renderError(error);
      expect(html).toContain('The interface could not be rendered.');
      expect(html).not.toContain(error.message);
      expect(html).not.toContain('PRIVATE STACK TRACE');
    } finally {
      process.env.NODE_ENV = previous;
    }
  });
});

const mockAnalyticsData: PredictiveAnalyticsData = {
  memory_growth_prediction: {
    next_30_days: 150,
    growth_rate: 1.5,
    seasonal_patterns: true
  },
  category_usage_prediction: {
    facts: 50,
    projects: 30,
    preferences: 20
  },
  relationship_formation_likelihood: 0.75,
  quality_degradation_risk: {
    risk_level: 'low',
    risk_factors: ['aging memories', 'low access rate'],
    recommendations: ['Review old memories', 'Archive unused content']
  }
};

const mockTimelineData: SnapshotTimelineData = {
  snapshots: [
    {
      id: 'snap-1',
      name: 'Initial State',
      description: 'First snapshot',
      created_at: new Date('2026-01-01'),
      memory_count: 10,
      token_count: 1000,
      expires_at: null,
      memories: [
        { id: 'mem-1', content: 'Test memory', category: 'facts', relevance_score: 0.9, position: 1 }
      ]
    },
    {
      id: 'snap-2',
      name: 'After Updates',
      description: 'After adding memories',
      created_at: new Date('2026-01-15'),
      memory_count: 25,
      token_count: 2500,
      expires_at: null
    }
  ]
};

describe('Memory Graph UI', () => {
  it('should render valid HTML', () => {
    const html = renderMemoryGraph(mockGraphData);
    expect(html).toBeDefined();
    expect(typeof html).toBe('string');
    expect(html.length).toBeGreaterThan(0);
  });

  it('should include graph container', () => {
    const html = renderMemoryGraph(mockGraphData);
    expect(html).toContain('id="graph-container"');
  });

  it('should include category filter', () => {
    const html = renderMemoryGraph(mockGraphData);
    expect(html).toContain('id="category-filter"');
    expect(html).toContain('All Categories');
  });

  it('should not embed executable graph data', () => {
    const html = renderMemoryGraph(mockGraphData);
    expect(html).not.toContain('<script');
  });

  it('should not include remote executable dependencies', () => {
    const html = renderMemoryGraph(mockGraphData);
    expect(html).not.toContain('d3js.org');
    expect(html).not.toContain('cdn.jsdelivr.net');
  });

  it('should include metrics display', () => {
    const html = renderMemoryGraph(mockGraphData);
    expect(html).toContain('Total Nodes');
    expect(html).toContain('Total Edges');
  });

  it('should include export buttons', () => {
    const html = renderMemoryGraph(mockGraphData);
    expect(html).toContain('Export');
  });
});

describe('Contradiction Dashboard UI', () => {
  it('should render valid HTML', () => {
    const html = renderContradictionDashboard(mockContradictionData);
    expect(html).toBeDefined();
    expect(typeof html).toBe('string');
    expect(html.length).toBeGreaterThan(0);
  });

  it('should include contradiction card', () => {
    const html = renderContradictionDashboard(mockContradictionData);
    expect(html).toContain('contradiction-card');
  });

  it('should show memory content', () => {
    const html = renderContradictionDashboard(mockContradictionData);
    expect(html).toContain('The sky is blue');
    expect(html).toContain('The sky is green');
  });

  it('should include severity indicators', () => {
    const html = renderContradictionDashboard(mockContradictionData);
    expect(html).toContain('high');
  });

  it('should include resolution suggestions', () => {
    const html = renderContradictionDashboard(mockContradictionData);
    expect(html).toContain('resolution');
  });

  it('should show confidence score', () => {
    const html = renderContradictionDashboard(mockContradictionData);
    expect(html).toContain('confidence');
  });
});

describe('Analytics Dashboard UI', () => {
  it('should render valid HTML', () => {
    const html = renderAnalyticsDashboard(mockAnalyticsData);
    expect(html).toBeDefined();
    expect(typeof html).toBe('string');
    expect(html.length).toBeGreaterThan(0);
  });

  it('should remain static without Chart.js or executable scripts', () => {
    const html = renderAnalyticsDashboard(mockAnalyticsData);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('cdn.jsdelivr.net');
  });

  it('should show memory growth predictions', () => {
    const html = renderAnalyticsDashboard(mockAnalyticsData);
    expect(html).toContain('PREDICTED GROWTH');
    expect(html).toContain('+150');
  });

  it('should include quality risk information', () => {
    const html = renderAnalyticsDashboard(mockAnalyticsData);
    expect(html).toContain('risk');
  });

  it('should show category usage', () => {
    const html = renderAnalyticsDashboard(mockAnalyticsData);
    expect(html).toContain('category');
  });

  it('should include recommendations', () => {
    const html = renderAnalyticsDashboard(mockAnalyticsData);
    expect(html).toContain('Recommendations:');
    expect(html).toContain('Review old memories');
  });
});

describe('Snapshot Timeline UI', () => {
  it('should render valid HTML', () => {
    const html = renderSnapshotTimeline(mockTimelineData);
    expect(html).toBeDefined();
    expect(typeof html).toBe('string');
    expect(html.length).toBeGreaterThan(0);
  });

  it('should include timeline container', () => {
    const html = renderSnapshotTimeline(mockTimelineData);
    expect(html).toContain('timeline');
  });

  it('should show snapshot names', () => {
    const html = renderSnapshotTimeline(mockTimelineData);
    expect(html).toContain('Initial State');
    expect(html).toContain('After Updates');
  });

  it('should not load D3 or any executable script', () => {
    const html = renderSnapshotTimeline(mockTimelineData);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('d3js.org');
  });

  it('should show memory counts', () => {
    const html = renderSnapshotTimeline(mockTimelineData);
    expect(html).toContain('Total Memories');
    expect(html).toContain('35');
  });

  it('should include compare functionality', () => {
    const html = renderSnapshotTimeline(mockTimelineData);
    expect(html).toContain('Compare');
  });
});

describe('UI Rendering Edge Cases', () => {
  it('should handle empty graph data', () => {
    const emptyGraph: GraphData = {
      nodes: [],
      edges: [],
      clusters: [],
      metrics: {
        total_nodes: 0,
        total_edges: 0,
        avg_clustering_coefficient: 0,
        density: 0,
        connected_components: 0,
        most_central_node: ''
      }
    };
    const html = renderMemoryGraph(emptyGraph);
    expect(html).toBeDefined();
    expect(html).toContain('id="graph-container"');
  });

  it('should handle empty contradictions', () => {
    const emptyContradictions: ContradictionData = {
      contradictions: []
    };
    const html = renderContradictionDashboard(emptyContradictions);
    expect(html).toBeDefined();
  });

  it('should handle empty snapshots', () => {
    const emptyTimeline: SnapshotTimelineData = {
      snapshots: []
    };
    const html = renderSnapshotTimeline(emptyTimeline);
    expect(html).toBeDefined();
  });

  it('should handle special characters in content', () => {
    const specialGraph: GraphData = {
      ...mockGraphData,
      nodes: [{
        ...mockGraphData.nodes[0],
        content: 'Test with "quotes" and special chars',
        label: "Memory's label"
      }]
    };
    const html = renderMemoryGraph(specialGraph);
    expect(html).toBeDefined();
    // Should render without errors
    expect(html.length).toBeGreaterThan(0);
    // Static release resources do not embed stored graph content or JSON.
    expect(html).not.toContain('<script');
    expect(html).not.toContain('Test with "quotes"');
  });
});
