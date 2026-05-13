/**
 * Interactive Memory Graph UI
 * Force-directed visualization of memory relationships
 * 
 * Features:
 * - Force-directed physics layout
 * - Zoom/pan controls
 * - Click node to see details
 * - Filter by category
 * - Export to PNG/SVG
 */

import { renderTemplate, SCRIPT_INCLUDES } from './index.js';

export interface GraphData {
  nodes: Array<{
    id: string;
    label: string;
    content: string;
    category: string;
    size: number;
    color: string;
    created_at: Date;
    metadata: Record<string, any>;
  }>;
  edges: Array<{
    source: string;
    target: string;
    weight: number;
    type: string;
    label?: string;
  }>;
  clusters: Array<{
    id: string;
    nodes: string[];
    theme: string;
    coherence: number;
    description: string;
  }>;
  metrics: {
    total_nodes: number;
    total_edges: number;
    avg_clustering_coefficient: number;
    density: number;
    connected_components: number;
    most_central_node: string;
  };
}

/**
 * Render the memory graph UI
 */
export function renderMemoryGraph(graphData: GraphData): string {
  const graphDataJson = JSON.stringify(graphData, null, 2);
  
  return renderTemplate({
    title: 'Memory Graph',
    subtitle: 'Interactive Force-Directed Visualization',
    content: `
      <div class="rembr-card">
        <div class="rembr-card-title">
          <span class="rembr-badge rembr-badge-primary">🎨 Interactive UI</span>
          Memory Relationship Graph
        </div>
        
        <div style="display: flex; gap: 1rem; margin-bottom: 1rem; flex-wrap: wrap;">
          <div style="flex: 1; min-width: 200px;">
            <label style="display: block; font-size: 0.875rem; margin-bottom: 0.5rem; color: var(--rembr-text-secondary);">
              Filter by Category
            </label>
            <select id="category-filter" class="rembr-button rembr-button-secondary" style="width: 100%;">
              <option value="all">All Categories</option>
              <option value="facts">Facts</option>
              <option value="preferences">Preferences</option>
              <option value="conversations">Conversations</option>
              <option value="projects">Projects</option>
              <option value="learning">Learning</option>
              <option value="goals">Goals</option>
              <option value="context">Context</option>
              <option value="reminders">Reminders</option>
              <option value="patterns">Patterns</option>
              <option value="decisions">Decisions</option>
              <option value="workflows">Workflows</option>
              <option value="insights">Insights</option>
            </select>
          </div>
          
          <div style="flex: 1; min-width: 200px;">
            <label style="display: block; font-size: 0.875rem; margin-bottom: 0.5rem; color: var(--rembr-text-secondary);">
              Edge Type
            </label>
            <select id="edge-type-filter" class="rembr-button rembr-button-secondary" style="width: 100%;">
              <option value="all">All Relationships</option>
              <option value="similarity">Similarity</option>
              <option value="temporal">Temporal</option>
              <option value="categorical">Categorical</option>
              <option value="explicit">Explicit</option>
            </select>
          </div>
          
          <div style="display: flex; gap: 0.5rem; align-items: flex-end;">
            <button id="reset-zoom" class="rembr-button">Reset Zoom</button>
            <button id="export-svg" class="rembr-button rembr-button-secondary">Export SVG</button>
            <button id="export-png" class="rembr-button rembr-button-secondary">Export PNG</button>
          </div>
        </div>

        <div style="background: var(--rembr-bg); border: 1px solid var(--rembr-border); border-radius: 8px; position: relative;">
          <div id="graph-container" style="width: 100%; height: 600px;"></div>
          <div id="node-tooltip" style="
            position: absolute;
            display: none;
            background: var(--rembr-bg-secondary);
            border: 1px solid var(--rembr-border);
            padding: 0.75rem;
            border-radius: 6px;
            max-width: 300px;
            z-index: 1000;
            pointer-events: none;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.3);
          "></div>
        </div>

        <div style="margin-top: 1rem; padding: 1rem; background: var(--rembr-bg); border-radius: 6px;">
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 1rem;">
            <div>
              <div style="font-size: 0.75rem; color: var(--rembr-text-secondary);">Total Nodes</div>
              <div style="font-size: 1.5rem; font-weight: 600;">${graphData.metrics.total_nodes}</div>
            </div>
            <div>
              <div style="font-size: 0.75rem; color: var(--rembr-text-secondary);">Total Edges</div>
              <div style="font-size: 1.5rem; font-weight: 600;">${graphData.metrics.total_edges}</div>
            </div>
            <div>
              <div style="font-size: 0.75rem; color: var(--rembr-text-secondary);">Density</div>
              <div style="font-size: 1.5rem; font-weight: 600;">${(graphData.metrics.density * 100).toFixed(1)}%</div>
            </div>
            <div>
              <div style="font-size: 0.75rem; color: var(--rembr-text-secondary);">Components</div>
              <div style="font-size: 1.5rem; font-weight: 600;">${graphData.metrics.connected_components}</div>
            </div>
            <div>
              <div style="font-size: 0.75rem; color: var(--rembr-text-secondary);">Avg Clustering</div>
              <div style="font-size: 1.5rem; font-weight: 600;">${(graphData.metrics.avg_clustering_coefficient * 100).toFixed(1)}%</div>
            </div>
          </div>
        </div>
      </div>

      <div class="rembr-card" id="node-details" style="display: none;">
        <div class="rembr-card-title">Node Details</div>
        <div id="node-details-content"></div>
      </div>
    `,
    extraHead: SCRIPT_INCLUDES.d3,
    extraScripts: `
      <script>
        const graphData = ${graphDataJson};
        
        // Setup graph container
        const container = d3.select('#graph-container');
        const width = container.node().getBoundingClientRect().width;
        const height = 600;

        // Create SVG
        const svg = container.append('svg')
          .attr('width', width)
          .attr('height', height);

        // Add zoom behavior
        const g = svg.append('g');
        const zoom = d3.zoom()
          .scaleExtent([0.1, 4])
          .on('zoom', (event) => {
            g.attr('transform', event.transform);
          });
        svg.call(zoom);

        // Reset zoom button
        d3.select('#reset-zoom').on('click', () => {
          svg.transition().duration(750).call(
            zoom.transform,
            d3.zoomIdentity
          );
        });

        // Create force simulation
        const simulation = d3.forceSimulation(graphData.nodes)
          .force('link', d3.forceLink(graphData.edges)
            .id(d => d.id)
            .distance(d => 100 / (d.weight + 0.1))
            .strength(d => d.weight))
          .force('charge', d3.forceManyBody().strength(-200))
          .force('center', d3.forceCenter(width / 2, height / 2))
          .force('collision', d3.forceCollide().radius(d => d.size * 2 + 10));

        // Draw edges
        const link = g.append('g')
          .selectAll('line')
          .data(graphData.edges)
          .join('line')
          .attr('stroke', '#64748b')
          .attr('stroke-opacity', d => d.weight * 0.6)
          .attr('stroke-width', d => Math.sqrt(d.weight) * 2);

        // Draw nodes
        const node = g.append('g')
          .selectAll('circle')
          .data(graphData.nodes)
          .join('circle')
          .attr('r', d => d.size * 2 + 5)
          .attr('fill', d => d.color)
          .attr('stroke', '#fff')
          .attr('stroke-width', 2)
          .style('cursor', 'pointer')
          .call(d3.drag()
            .on('start', dragstarted)
            .on('drag', dragged)
            .on('end', dragended))
          .on('click', showNodeDetails)
          .on('mouseover', showTooltip)
          .on('mouseout', hideTooltip);

        // Draw labels
        const label = g.append('g')
          .selectAll('text')
          .data(graphData.nodes)
          .join('text')
          .text(d => d.label)
          .attr('font-size', 10)
          .attr('fill', '#cbd5e1')
          .attr('text-anchor', 'middle')
          .attr('dy', d => -(d.size * 2 + 10))
          .style('pointer-events', 'none');

        // Update positions on tick
        simulation.on('tick', () => {
          link
            .attr('x1', d => d.source.x)
            .attr('y1', d => d.source.y)
            .attr('x2', d => d.target.x)
            .attr('y2', d => d.target.y);

          node
            .attr('cx', d => d.x)
            .attr('cy', d => d.y);

          label
            .attr('x', d => d.x)
            .attr('y', d => d.y);
        });

        // Drag functions
        function dragstarted(event) {
          if (!event.active) simulation.alphaTarget(0.3).restart();
          event.subject.fx = event.subject.x;
          event.subject.fy = event.subject.y;
        }

        function dragged(event) {
          event.subject.fx = event.x;
          event.subject.fy = event.y;
        }

        function dragended(event) {
          if (!event.active) simulation.alphaTarget(0);
          event.subject.fx = null;
          event.subject.fy = null;
        }

        // Show tooltip
        function showTooltip(event, d) {
          const tooltip = d3.select('#node-tooltip');
          tooltip.style('display', 'block')
            .style('left', (event.pageX + 10) + 'px')
            .style('top', (event.pageY - 10) + 'px')
            .html(\`
              <div style="font-weight: 600; margin-bottom: 0.5rem;">\${d.label}</div>
              <div style="font-size: 0.75rem; color: var(--rembr-text-secondary); margin-bottom: 0.5rem;">
                <span class="rembr-badge rembr-badge-primary" style="font-size: 0.65rem;">\${d.category}</span>
              </div>
              <div style="font-size: 0.875rem; color: var(--rembr-text-secondary);">
                \${d.content.substring(0, 150)}\${d.content.length > 150 ? '...' : ''}
              </div>
              <div style="margin-top: 0.5rem; font-size: 0.75rem; color: var(--rembr-text-secondary);">
                Click for full details
              </div>
            \`);
        }

        function hideTooltip() {
          d3.select('#node-tooltip').style('display', 'none');
        }

        // Show node details
        function showNodeDetails(event, d) {
          const detailsCard = document.getElementById('node-details');
          const detailsContent = document.getElementById('node-details-content');
          
          detailsCard.style.display = 'block';
          detailsContent.innerHTML = \`
            <div style="margin-bottom: 1rem;">
              <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.5rem;">
                <div style="font-size: 1.125rem; font-weight: 600;">\${d.label}</div>
                <span class="rembr-badge rembr-badge-primary">\${d.category}</span>
              </div>
              <div style="font-size: 0.75rem; color: var(--rembr-text-secondary);">
                Created: \${new Date(d.created_at).toLocaleString()}
              </div>
            </div>
            
            <div style="background: var(--rembr-bg); padding: 1rem; border-radius: 6px; margin-bottom: 1rem;">
              <div style="font-weight: 600; margin-bottom: 0.5rem; font-size: 0.875rem;">Content</div>
              <div style="white-space: pre-wrap; color: var(--rembr-text-secondary); font-size: 0.875rem;">\${d.content}</div>
            </div>

            <div style="background: var(--rembr-bg); padding: 1rem; border-radius: 6px;">
              <div style="font-weight: 600; margin-bottom: 0.5rem; font-size: 0.875rem;">Metadata</div>
              <pre style="margin: 0; color: var(--rembr-text-secondary); font-size: 0.75rem; overflow-x: auto;">\${JSON.stringify(d.metadata, null, 2)}</pre>
            </div>
          \`;
          
          detailsCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }

        // Category filter
        d3.select('#category-filter').on('change', function() {
          const category = this.value;
          node.style('opacity', d => category === 'all' || d.category === category ? 1 : 0.1);
          label.style('opacity', d => category === 'all' || d.category === category ? 1 : 0.1);
          link.style('opacity', d => {
            if (category === 'all') return d.weight * 0.6;
            return (d.source.category === category || d.target.category === category) ? d.weight * 0.6 : 0.05;
          });
        });

        // Edge type filter
        d3.select('#edge-type-filter').on('change', function() {
          const edgeType = this.value;
          link.style('opacity', d => edgeType === 'all' || d.type === edgeType ? d.weight * 0.6 : 0.05);
        });

        // Export SVG
        d3.select('#export-svg').on('click', () => {
          const svgData = new XMLSerializer().serializeToString(svg.node());
          const blob = new Blob([svgData], { type: 'image/svg+xml' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = 'memory-graph.svg';
          a.click();
          URL.revokeObjectURL(url);
        });

        // Export PNG
        d3.select('#export-png').on('click', () => {
          const svgData = new XMLSerializer().serializeToString(svg.node());
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          const img = new Image();
          img.onload = () => {
            ctx.drawImage(img, 0, 0);
            canvas.toBlob(blob => {
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = 'memory-graph.png';
              a.click();
              URL.revokeObjectURL(url);
            });
          };
          img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgData)));
        });
      </script>
    `,
  });
}
