/**
 * Unit Tests for MCP Apps UI Resources
 * REM-119: Test HTML rendering functions for all UI components
 */

import { describe, it, expect } from 'vitest';
import { renderMemoryGraph, GraphData } from './memory-graph.js';
import { renderContradictionDashboard, ContradictionData } from './contradiction-dashboard.js';
import { renderAnalyticsDashboard, PredictiveAnalyticsData } from './analytics-dashboard.js';
import { renderSnapshotTimeline, SnapshotTimelineData } from './snapshot-timeline.js';

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

  it('should include graph data as JSON', () => {
    const html = renderMemoryGraph(mockGraphData);
    expect(html).toContain('graphData');
    expect(html).toContain('node-1');
    expect(html).toContain('node-2');
  });

  it('should include D3.js script', () => {
    const html = renderMemoryGraph(mockGraphData);
    expect(html).toContain('d3');
  });

  it('should include metrics display', () => {
    const html = renderMemoryGraph(mockGraphData);
    expect(html).toContain('total_nodes');
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

  it('should include Chart.js script', () => {
    const html = renderAnalyticsDashboard(mockAnalyticsData);
    expect(html).toContain('Chart');
  });

  it('should show memory growth predictions', () => {
    const html = renderAnalyticsDashboard(mockAnalyticsData);
    expect(html).toContain('memory_growth');
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
    expect(html).toContain('recommendations');
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

  it('should include D3.js for visualization', () => {
    const html = renderSnapshotTimeline(mockTimelineData);
    expect(html).toContain('d3');
  });

  it('should show memory counts', () => {
    const html = renderSnapshotTimeline(mockTimelineData);
    expect(html).toContain('memory_count');
  });

  it('should include compare functionality', () => {
    const html = renderSnapshotTimeline(mockTimelineData);
    expect(html).toContain('compare');
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
    // The JSON should contain the escaped quotes
    expect(html).toContain('\\"quotes\\"');
  });
});
