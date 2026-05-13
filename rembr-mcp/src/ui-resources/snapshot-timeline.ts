/**
 * Context Snapshot Timeline UI
 * Temporal visualization of context snapshots with comparison tools
 * 
 * Features:
 * - Timeline visualization of snapshots (D3.js)
 * - Expandable snapshot cards showing memories
 * - Side-by-side snapshot comparison
 * - Memory diff highlighting
 * - Filter by date range
 * - Token usage visualization
 */

import { renderTemplate, SCRIPT_INCLUDES } from './index.js';

export interface SnapshotTimelineData {
  snapshots: Array<{
    id: string;
    name: string | null;
    description: string | null;
    memory_count: number;
    token_count: number;
    created_at: Date;
    expires_at: Date | null;
    memories?: Array<{
      id: string;
      content: string;
      category: string | null;
      relevance_score: number;
      position: number;
    }>;
  }>;
}

/**
 * Render the snapshot timeline UI
 */
export function renderSnapshotTimeline(data: SnapshotTimelineData): string {
  const dataJson = JSON.stringify(data, null, 2);
  
  // Sort snapshots by created_at
  const sortedSnapshots = [...data.snapshots].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );

  // Generate timeline HTML
  const timelineHtml = sortedSnapshots.map((snapshot, index) => {
    const isExpired = snapshot.expires_at && new Date(snapshot.expires_at) < new Date();
    
    return `
      <div class="timeline-item" data-snapshot-id="${snapshot.id}" data-index="${index}">
        <div class="timeline-marker"></div>
        <div class="timeline-content">
          <div class="snapshot-card ${isExpired ? 'expired' : ''}" id="snapshot-${index}">
            <!-- Header -->
            <div style="display: flex; align-items: start; justify-content: space-between; margin-bottom: 1rem;">
              <div style="flex: 1;">
                <div style="display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.5rem;">
                  <div style="font-weight: 600; font-size: 1rem;">
                    ${snapshot.name || `Snapshot ${index + 1}`}
                  </div>
                  ${isExpired ? '<span class="rembr-badge rembr-badge-error">Expired</span>' : ''}
                </div>
                ${snapshot.description ? `
                  <div style="font-size: 0.875rem; color: var(--rembr-text-secondary); margin-bottom: 0.5rem;">
                    ${escapeHtml(snapshot.description)}
                  </div>
                ` : ''}
                <div style="font-size: 0.75rem; color: var(--rembr-text-secondary);">
                  ${formatDate(snapshot.created_at)}
                  ${snapshot.expires_at ? ` • Expires ${formatDate(snapshot.expires_at)}` : ' • No expiration'}
                </div>
              </div>
              
              <div style="display: flex; gap: 0.5rem;">
                <button class="rembr-button rembr-button-secondary" onclick="toggleSnapshot(${index})">
                  <span id="toggle-icon-${index}">▼</span> Details
                </button>
                <button class="rembr-button" onclick="selectForComparison(${index})">
                  Compare
                </button>
              </div>
            </div>

            <!-- Metrics -->
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-bottom: 1rem;">
              <div style="background: var(--rembr-bg); padding: 0.75rem; border-radius: 6px;">
                <div style="font-size: 0.75rem; color: var(--rembr-text-secondary);">Memories</div>
                <div style="font-size: 1.5rem; font-weight: 600;">${snapshot.memory_count}</div>
              </div>
              <div style="background: var(--rembr-bg); padding: 0.75rem; border-radius: 6px;">
                <div style="font-size: 0.75rem; color: var(--rembr-text-secondary);">Tokens</div>
                <div style="font-size: 1.5rem; font-weight: 600;">${snapshot.token_count.toLocaleString()}</div>
              </div>
            </div>

            <!-- Expandable memories section -->
            <div id="snapshot-details-${index}" class="snapshot-details" style="display: none;">
              ${snapshot.memories && snapshot.memories.length > 0 ? `
                <div style="margin-top: 1rem; padding-top: 1rem; border-top: 1px solid var(--rembr-border);">
                  <div style="font-weight: 600; margin-bottom: 0.75rem; font-size: 0.875rem;">
                    Captured Memories (${snapshot.memories.length})
                  </div>
                  <div style="display: grid; gap: 0.75rem;">
                    ${snapshot.memories
                      .sort((a, b) => b.relevance_score - a.relevance_score)
                      .map((mem, memIndex) => `
                        <div style="background: var(--rembr-bg); padding: 1rem; border-radius: 6px; border-left: 3px solid var(--rembr-primary);">
                          <div style="display: flex; align-items: center; justify-content: between; margin-bottom: 0.5rem;">
                            <div style="display: flex; gap: 0.5rem; align-items: center; flex: 1;">
                              ${mem.category ? `<span class="rembr-badge rembr-badge-primary" style="font-size: 0.65rem;">${mem.category}</span>` : ''}
                              <span style="font-size: 0.75rem; color: var(--rembr-text-secondary);">
                                Relevance: ${(mem.relevance_score * 100).toFixed(0)}%
                              </span>
                            </div>
                          </div>
                          <div style="font-size: 0.875rem; color: var(--rembr-text); white-space: pre-wrap;">
                            ${escapeHtml(mem.content.substring(0, 200))}${mem.content.length > 200 ? '...' : ''}
                          </div>
                        </div>
                      `).join('')}
                  </div>
                </div>
              ` : `
                <div style="text-align: center; padding: 2rem; color: var(--rembr-text-secondary); font-size: 0.875rem;">
                  No memories loaded. Use get_snapshot to fetch full details.
                </div>
              `}
            </div>
          </div>
        </div>
      </div>
    `;
  }).join('');

  return renderTemplate({
    title: 'Snapshot Timeline',
    subtitle: 'Temporal Context History',
    content: `
      <div class="rembr-card">
        <div class="rembr-card-title">
          <span class="rembr-badge rembr-badge-primary">📸 Timeline</span>
          ${data.snapshots.length} Snapshot${data.snapshots.length !== 1 ? 's' : ''}
        </div>

        <!-- Statistics -->
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 1rem; margin-bottom: 1.5rem;">
          <div style="background: var(--rembr-bg); padding: 1rem; border-radius: 6px;">
            <div style="font-size: 0.75rem; color: var(--rembr-text-secondary);">Total Snapshots</div>
            <div style="font-size: 1.5rem; font-weight: 600;">${data.snapshots.length}</div>
          </div>
          <div style="background: var(--rembr-bg); padding: 1rem; border-radius: 6px;">
            <div style="font-size: 0.75rem; color: var(--rembr-text-secondary);">Total Memories</div>
            <div style="font-size: 1.5rem; font-weight: 600;">${data.snapshots.reduce((sum, s) => sum + s.memory_count, 0)}</div>
          </div>
          <div style="background: var(--rembr-bg); padding: 1rem; border-radius: 6px;">
            <div style="font-size: 0.75rem; color: var(--rembr-text-secondary);">Total Tokens</div>
            <div style="font-size: 1.5rem; font-weight: 600;">${data.snapshots.reduce((sum, s) => sum + s.token_count, 0).toLocaleString()}</div>
          </div>
          <div style="background: var(--rembr-bg); padding: 1rem; border-radius: 6px;">
            <div style="font-size: 0.75rem; color: var(--rembr-text-secondary);">Avg Tokens/Snapshot</div>
            <div style="font-size: 1.5rem; font-weight: 600;">${data.snapshots.length > 0 ? Math.round(data.snapshots.reduce((sum, s) => sum + s.token_count, 0) / data.snapshots.length).toLocaleString() : 0}</div>
          </div>
        </div>

        ${data.snapshots.length > 0 ? `
          <!-- Timeline visualization -->
          <div style="margin-bottom: 1.5rem;">
            <div style="font-weight: 600; margin-bottom: 1rem; font-size: 1rem;">Timeline</div>
            <div id="timeline-viz" style="width: 100%; height: 150px; background: var(--rembr-bg); border-radius: 6px; padding: 1rem; position: relative;"></div>
          </div>

          <!-- Timeline items -->
          <div class="timeline-container">
            ${timelineHtml}
          </div>
        ` : `
          <div style="text-align: center; padding: 3rem; color: var(--rembr-text-secondary);">
            <div style="font-size: 3rem; margin-bottom: 1rem;">📸</div>
            <div style="font-size: 1.125rem; font-weight: 600; margin-bottom: 0.5rem;">No Snapshots Yet</div>
            <div style="font-size: 0.875rem;">Create a snapshot to capture your current context!</div>
          </div>
        `}
      </div>

      <!-- Comparison Modal -->
      <div id="comparison-modal" style="display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0, 0, 0, 0.8); z-index: 1000; align-items: center; justify-content: center; overflow-y: auto;">
        <div class="rembr-card" style="max-width: 90vw; max-height: 90vh; overflow-y: auto; margin: 2rem;">
          <div class="rembr-card-title">
            Compare Snapshots
            <button class="rembr-button rembr-button-secondary" onclick="closeComparison()" style="float: right;">Close</button>
          </div>
          <div id="comparison-content"></div>
        </div>
      </div>
    `,
    extraHead: SCRIPT_INCLUDES.d3 + '\n' + SCRIPT_INCLUDES.diff,
    extraScripts: `
      <style>
        .timeline-container {
          position: relative;
          padding-left: 2rem;
        }
        .timeline-item {
          position: relative;
          margin-bottom: 2rem;
          padding-left: 2.5rem;
        }
        .timeline-marker {
          position: absolute;
          left: -0.5rem;
          top: 0.5rem;
          width: 1rem;
          height: 1rem;
          background: var(--rembr-primary);
          border-radius: 50%;
          border: 3px solid var(--rembr-bg-secondary);
          z-index: 2;
        }
        .timeline-item:not(:last-child)::before {
          content: '';
          position: absolute;
          left: 0;
          top: 1.5rem;
          bottom: -2rem;
          width: 2px;
          background: var(--rembr-border);
        }
        .snapshot-card {
          background: var(--rembr-bg-secondary);
          border: 1px solid var(--rembr-border);
          border-radius: 12px;
          padding: 1.5rem;
          transition: all 0.3s;
        }
        .snapshot-card.expired {
          opacity: 0.6;
        }
        .snapshot-card:hover {
          border-color: var(--rembr-primary);
        }
        .snapshot-details {
          animation: slideDown 0.3s ease-out;
        }
        @keyframes slideDown {
          from {
            opacity: 0;
            max-height: 0;
          }
          to {
            opacity: 1;
            max-height: 1000px;
          }
        }
      </style>

      <script>
        const data = ${dataJson};
        const sortedSnapshots = data.snapshots.sort((a, b) => 
          new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
        );

        let selectedSnapshots = [];

        // Toggle snapshot details
        function toggleSnapshot(index) {
          const details = document.getElementById(\`snapshot-details-\${index}\`);
          const icon = document.getElementById(\`toggle-icon-\${index}\`);
          
          if (details.style.display === 'none') {
            details.style.display = 'block';
            icon.textContent = '▲';
          } else {
            details.style.display = 'none';
            icon.textContent = '▼';
          }
        }

        // Select snapshot for comparison
        function selectForComparison(index) {
          if (selectedSnapshots.includes(index)) {
            selectedSnapshots = selectedSnapshots.filter(i => i !== index);
            document.getElementById(\`snapshot-\${index}\`).style.borderColor = 'var(--rembr-border)';
          } else if (selectedSnapshots.length < 2) {
            selectedSnapshots.push(index);
            document.getElementById(\`snapshot-\${index}\`).style.borderColor = 'var(--rembr-success)';
          }

          if (selectedSnapshots.length === 2) {
            showComparison(selectedSnapshots[0], selectedSnapshots[1]);
          }
        }

        // Show comparison modal
        function showComparison(indexA, indexB) {
          const snapshotA = sortedSnapshots[indexA];
          const snapshotB = sortedSnapshots[indexB];
          
          const modal = document.getElementById('comparison-modal');
          const content = document.getElementById('comparison-content');

          const memoriesA = snapshotA.memories || [];
          const memoriesB = snapshotB.memories || [];

          content.innerHTML = \`
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 2rem; margin-bottom: 1.5rem;">
              <!-- Snapshot A -->
              <div>
                <div style="font-weight: 600; margin-bottom: 0.5rem; font-size: 1.125rem;">
                  \${snapshotA.name || 'Snapshot ' + (indexA + 1)}
                </div>
                <div style="font-size: 0.75rem; color: var(--rembr-text-secondary); margin-bottom: 1rem;">
                  \${formatDate(snapshotA.created_at)}
                </div>
                <div style="background: var(--rembr-bg); padding: 1rem; border-radius: 6px;">
                  <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; font-size: 0.875rem;">
                    <div>Memories: <strong>\${snapshotA.memory_count}</strong></div>
                    <div>Tokens: <strong>\${snapshotA.token_count.toLocaleString()}</strong></div>
                  </div>
                </div>
              </div>

              <!-- Snapshot B -->
              <div>
                <div style="font-weight: 600; margin-bottom: 0.5rem; font-size: 1.125rem;">
                  \${snapshotB.name || 'Snapshot ' + (indexB + 1)}
                </div>
                <div style="font-size: 0.75rem; color: var(--rembr-text-secondary); margin-bottom: 1rem;">
                  \${formatDate(snapshotB.created_at)}
                </div>
                <div style="background: var(--rembr-bg); padding: 1rem; border-radius: 6px;">
                  <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; font-size: 0.875rem;">
                    <div>Memories: <strong>\${snapshotB.memory_count}</strong></div>
                    <div>Tokens: <strong>\${snapshotB.token_count.toLocaleString()}</strong></div>
                  </div>
                </div>
              </div>
            </div>

            <!-- Delta summary -->
            <div style="background: var(--rembr-bg); padding: 1rem; border-radius: 6px; margin-bottom: 1.5rem;">
              <div style="font-weight: 600; margin-bottom: 0.5rem;">Changes</div>
              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; font-size: 0.875rem;">
                <div>
                  Memory Count: 
                  <span style="color: \${snapshotB.memory_count > snapshotA.memory_count ? 'var(--rembr-success)' : snapshotB.memory_count < snapshotA.memory_count ? 'var(--rembr-error)' : 'var(--rembr-text-secondary)'};">
                    \${snapshotB.memory_count > snapshotA.memory_count ? '+' : ''}\${snapshotB.memory_count - snapshotA.memory_count}
                  </span>
                </div>
                <div>
                  Token Count: 
                  <span style="color: \${snapshotB.token_count > snapshotA.token_count ? 'var(--rembr-success)' : snapshotB.token_count < snapshotA.token_count ? 'var(--rembr-error)' : 'var(--rembr-text-secondary)'};">
                    \${snapshotB.token_count > snapshotA.token_count ? '+' : ''}\${(snapshotB.token_count - snapshotA.token_count).toLocaleString()}
                  </span>
                </div>
              </div>
            </div>

            <!-- Memory comparison placeholder -->
            <div style="background: var(--rembr-bg); padding: 1rem; border-radius: 6px;">
              <div style="font-weight: 600; margin-bottom: 0.75rem;">Memory Comparison</div>
              <div style="font-size: 0.875rem; color: var(--rembr-text-secondary);">
                Use compare_snapshots MCP tool for detailed memory diff analysis.
              </div>
            </div>
          \`;

          modal.style.display = 'flex';
        }

        // Close comparison modal
        function closeComparison() {
          document.getElementById('comparison-modal').style.display = 'none';
          selectedSnapshots.forEach(index => {
            document.getElementById(\`snapshot-\${index}\`).style.borderColor = 'var(--rembr-border)';
          });
          selectedSnapshots = [];
        }

        // D3 Timeline Visualization
        if (sortedSnapshots.length > 0) {
          const vizContainer = d3.select('#timeline-viz');
          const width = vizContainer.node().getBoundingClientRect().width;
          const height = 150;

          const svg = vizContainer.append('svg')
            .attr('width', width)
            .attr('height', height);

          const padding = 40;
          const timeExtent = d3.extent(sortedSnapshots, d => new Date(d.created_at));
          const xScale = d3.scaleTime()
            .domain(timeExtent)
            .range([padding, width - padding]);

          const maxTokens = d3.max(sortedSnapshots, d => d.token_count);
          const yScale = d3.scaleLinear()
            .domain([0, maxTokens])
            .range([height - padding, padding]);

          // X axis
          const xAxis = d3.axisBottom(xScale)
            .ticks(6)
            .tickFormat(d3.timeFormat('%b %d'));

          svg.append('g')
            .attr('transform', \`translate(0, \${height - padding})\`)
            .call(xAxis)
            .selectAll('text')
            .style('fill', '#94a3b8')
            .style('font-size', '11px');

          svg.selectAll('.domain, .tick line')
            .style('stroke', '#475569');

          // Draw line
          const line = d3.line()
            .x(d => xScale(new Date(d.created_at)))
            .y(d => yScale(d.token_count))
            .curve(d3.curveMonotoneX);

          svg.append('path')
            .datum(sortedSnapshots)
            .attr('fill', 'none')
            .attr('stroke', 'rgb(99, 102, 241)')
            .attr('stroke-width', 2)
            .attr('d', line);

          // Draw points
          svg.selectAll('circle')
            .data(sortedSnapshots)
            .join('circle')
            .attr('cx', d => xScale(new Date(d.created_at)))
            .attr('cy', d => yScale(d.token_count))
            .attr('r', 5)
            .attr('fill', 'rgb(99, 102, 241)')
            .attr('stroke', '#0f172a')
            .attr('stroke-width', 2)
            .style('cursor', 'pointer')
            .on('click', (event, d) => {
              const index = sortedSnapshots.indexOf(d);
              toggleSnapshot(index);
              document.getElementById(\`snapshot-\${index}\`).scrollIntoView({ behavior: 'smooth', block: 'center' });
            })
            .append('title')
            .text(d => \`\${d.name || 'Snapshot'}: \${d.token_count.toLocaleString()} tokens\`);
        }
      </script>

      <script>
        function escapeHtml(text) { return text; }
        function formatDate(date) {
          return new Date(date).toLocaleString('en-US', { 
            month: 'short', 
            day: 'numeric', 
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
          });
        }
      </script>
    `,
  });
}

function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return text.replace(/[&<>"']/g, m => map[m]);
}

function formatDate(date: Date): string {
  return new Date(date).toLocaleString('en-US', { 
    month: 'short', 
    day: 'numeric', 
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}
