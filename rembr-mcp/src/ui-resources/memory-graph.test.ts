/**
 * Unit tests for memory-graph UI renderer
 */

import { describe, it, expect } from 'vitest';
import { renderMemoryGraph, GraphData } from './memory-graph.js';

describe('memory-graph', () => {
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
      }
    ],
    edges: [
      {
        source: 'node1',
        target: 'node2',
        weight: 0.8,
        type: 'similarity',
        label: 'related'
      }
    ],
    clusters: [
      {
        id: 'cluster1',
        nodes: ['node1', 'node2'],
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
      most_central_node: 'node1'
    }
  };

  it('should generate valid HTML', () => {
    const html = renderMemoryGraph(mockGraphData);
    
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<html');
    expect(html).toContain('</html>');
  });

  it('should include graph title', () => {
    const html = renderMemoryGraph(mockGraphData);
    
    expect(html).toContain('Memory Graph');
  });

  it('should omit remote executable graph dependencies', () => {
    const html = renderMemoryGraph(mockGraphData);

    expect(html).not.toContain('d3js.org');
    expect(html).not.toContain('d3.v7');
    expect(html).toContain("script-src 'none'");
  });

  it('should not embed graph data into executable HTML', () => {
    const html = renderMemoryGraph(mockGraphData);

    expect(html).not.toContain('const graphData =');
    expect(html).not.toContain('<script');
  });

  it('should include metrics display', () => {
    const html = renderMemoryGraph(mockGraphData);
    
    expect(html).toContain('Total Nodes');
    expect(html).toContain('Total Edges');
    expect(html).toContain('Density');
    expect(html).toContain('Components');
  });

  it('should include filter controls', () => {
    const html = renderMemoryGraph(mockGraphData);
    
    expect(html).toContain('category-filter');
    expect(html).toContain('edge-type-filter');
    expect(html).toContain('Reset Zoom');
  });

  it('should not place raw memory content in the static overview', () => {
    const html = renderMemoryGraph(mockGraphData);

    expect(html).not.toContain('This is test content');
    expect(html).not.toContain('Another test content');
  });

  it('should include export buttons', () => {
    const html = renderMemoryGraph(mockGraphData);
    
    expect(html).toContain('Export SVG');
    expect(html).toContain('Export PNG');
  });

  it('should render metrics with correct values', () => {
    const html = renderMemoryGraph(mockGraphData);
    
    expect(html).toContain('2'); // total_nodes
    expect(html).toContain('1'); // total_edges
    expect(html).toContain('50.0%'); // density
  });
});
