/**
 * Contradiction Detection Dashboard UI
 * Side-by-side comparison of contradicting memories with resolution actions
 * 
 * Features:
 * - Side-by-side memory comparison with diff highlighting
 * - Confidence meter visualization
 * - One-click resolution (keep A, keep B, merge)
 * - Filter by type (factual, temporal, logical, preference)
 * - Severity color coding
 */

import { renderTemplate, STYLE_INCLUDES } from './index.js';

export interface ContradictionData {
  contradictions: Array<{
    memory_a: {
      id: string;
      content: string;
      category: string;
      created_at: Date;
    };
    memory_b: {
      id: string;
      content: string;
      category: string;
      created_at: Date;
    };
    contradiction_type: 'factual' | 'temporal' | 'logical' | 'preference';
    confidence: number;
    explanation: string;
    severity: 'low' | 'medium' | 'high';
    resolution_suggestions: string[];
  }>;
}

/**
 * Render the contradiction detection dashboard
 */
export function renderContradictionDashboard(data: ContradictionData): string {
  const dataJson = JSON.stringify(data, null, 2);
  
  // Generate HTML for each contradiction
  const contradictionsHtml = data.contradictions.map((c, index) => `
    <div class="contradiction-card" 
         data-type="${c.contradiction_type}" 
         data-severity="${c.severity}"
         data-confidence="${c.confidence}"
         id="contradiction-${index}">
      
      <!-- Header with type, severity, and confidence -->
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 1rem; padding-bottom: 1rem; border-bottom: 1px solid var(--rembr-border);">
        <div style="display: flex; gap: 0.5rem; align-items: center;">
          <span class="rembr-badge rembr-badge-${getSeverityBadgeClass(c.severity)}">
            ${c.severity.toUpperCase()}
          </span>
          <span class="rembr-badge rembr-badge-primary">
            ${formatContradictionType(c.contradiction_type)}
          </span>
          <span style="font-size: 0.875rem; color: var(--rembr-text-secondary);">
            ${formatDate(c.memory_a.created_at)} vs ${formatDate(c.memory_b.created_at)}
          </span>
        </div>
        
        <!-- Confidence meter -->
        <div style="display: flex; align-items: center; gap: 0.75rem;">
          <span style="font-size: 0.875rem; color: var(--rembr-text-secondary);">Confidence:</span>
          <div style="width: 120px; height: 8px; background: var(--rembr-bg); border-radius: 4px; overflow: hidden;">
            <div style="width: ${c.confidence * 100}%; height: 100%; background: ${getConfidenceColor(c.confidence)}; transition: width 0.3s;"></div>
          </div>
          <span style="font-size: 0.875rem; font-weight: 600; color: ${getConfidenceColor(c.confidence)};">
            ${Math.round(c.confidence * 100)}%
          </span>
        </div>
      </div>

      <!-- Explanation -->
      <div style="margin-bottom: 1rem; padding: 0.75rem; background: var(--rembr-bg); border-radius: 6px; border-left: 3px solid ${getSeverityColor(c.severity)};">
        <div style="font-weight: 600; margin-bottom: 0.5rem; font-size: 0.875rem;">Why this contradicts:</div>
        <div style="color: var(--rembr-text-secondary); font-size: 0.875rem;">${c.explanation}</div>
      </div>

      <!-- Side-by-side comparison -->
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-bottom: 1rem;">
        <!-- Memory A -->
        <div style="background: var(--rembr-bg); padding: 1rem; border-radius: 6px; border: 2px solid var(--rembr-border);">
          <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.75rem;">
            <div>
              <div style="font-weight: 600; margin-bottom: 0.25rem;">Memory A</div>
              <div style="font-size: 0.75rem; color: var(--rembr-text-secondary);">
                ${c.memory_a.category} · ${formatDate(c.memory_a.created_at)}
              </div>
            </div>
            <button class="rembr-button" onclick="resolveContradiction(${index}, 'keep_a')">
              Keep This
            </button>
          </div>
          <div style="white-space: pre-wrap; font-size: 0.875rem; color: var(--rembr-text);" class="memory-content">
            ${escapeHtml(c.memory_a.content)}
          </div>
        </div>

        <!-- Memory B -->
        <div style="background: var(--rembr-bg); padding: 1rem; border-radius: 6px; border: 2px solid var(--rembr-border);">
          <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.75rem;">
            <div>
              <div style="font-weight: 600; margin-bottom: 0.25rem;">Memory B</div>
              <div style="font-size: 0.75rem; color: var(--rembr-text-secondary);">
                ${c.memory_b.category} · ${formatDate(c.memory_b.created_at)}
              </div>
            </div>
            <button class="rembr-button" onclick="resolveContradiction(${index}, 'keep_b')">
              Keep This
            </button>
          </div>
          <div style="white-space: pre-wrap; font-size: 0.875rem; color: var(--rembr-text);" class="memory-content">
            ${escapeHtml(c.memory_b.content)}
          </div>
        </div>
      </div>

      <!-- Resolution suggestions -->
      ${c.resolution_suggestions.length > 0 ? `
        <div style="margin-bottom: 1rem;">
          <div style="font-weight: 600; margin-bottom: 0.5rem; font-size: 0.875rem;">Resolution suggestions:</div>
          <ul style="list-style: none; padding: 0; margin: 0;">
            ${c.resolution_suggestions.map(s => `
              <li style="padding: 0.5rem 0.75rem; background: var(--rembr-bg); margin-bottom: 0.5rem; border-radius: 4px; font-size: 0.875rem; color: var(--rembr-text-secondary);">
                💡 ${escapeHtml(s)}
              </li>
            `).join('')}
          </ul>
        </div>
      ` : ''}

      <!-- Action buttons -->
      <div style="display: flex; gap: 0.5rem; padding-top: 1rem; border-top: 1px solid var(--rembr-border);">
        <button class="rembr-button rembr-button-secondary" onclick="mergeMemories(${index})">
          Merge Both
        </button>
        <button class="rembr-button rembr-button-secondary" onclick="ignoreContradiction(${index})">
          Ignore
        </button>
        <button class="rembr-button rembr-button-secondary" onclick="showDiff(${index})">
          Show Diff
        </button>
      </div>
    </div>
  `).join('');

  return renderTemplate({
    title: 'Contradiction Detection',
    subtitle: 'Resolve Conflicting Memories',
    content: `
      <div class="rembr-card">
        <div class="rembr-card-title">
          <span class="rembr-badge rembr-badge-warning">⚠️</span>
          ${data.contradictions.length} Contradiction${data.contradictions.length !== 1 ? 's' : ''} Detected
        </div>
        
        <!-- Filters -->
        <div style="display: flex; gap: 1rem; margin-bottom: 1.5rem; flex-wrap: wrap;">
          <div style="flex: 1; min-width: 200px;">
            <label style="display: block; font-size: 0.875rem; margin-bottom: 0.5rem; color: var(--rembr-text-secondary);">
              Filter by Type
            </label>
            <select id="type-filter" class="rembr-button rembr-button-secondary" style="width: 100%;">
              <option value="all">All Types</option>
              <option value="factual">Factual</option>
              <option value="temporal">Temporal</option>
              <option value="logical">Logical</option>
              <option value="preference">Preference</option>
            </select>
          </div>
          
          <div style="flex: 1; min-width: 200px;">
            <label style="display: block; font-size: 0.875rem; margin-bottom: 0.5rem; color: var(--rembr-text-secondary);">
              Filter by Severity
            </label>
            <select id="severity-filter" class="rembr-button rembr-button-secondary" style="width: 100%;">
              <option value="all">All Severities</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
          </div>

          <div style="flex: 1; min-width: 200px;">
            <label style="display: block; font-size: 0.875rem; margin-bottom: 0.5rem; color: var(--rembr-text-secondary);">
              Minimum Confidence
            </label>
            <input type="range" id="confidence-filter" min="0" max="100" value="0" 
                   class="rembr-button rembr-button-secondary" style="width: 100%;">
            <div style="font-size: 0.75rem; color: var(--rembr-text-secondary); margin-top: 0.25rem;">
              <span id="confidence-value">0</span>%
            </div>
          </div>
        </div>

        <!-- Statistics -->
        <div style="margin-bottom: 1.5rem; padding: 1rem; background: var(--rembr-bg); border-radius: 6px;">
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 1rem;">
            <div>
              <div style="font-size: 0.75rem; color: var(--rembr-text-secondary);">By Type</div>
              <div id="stats-by-type" style="font-size: 0.875rem; margin-top: 0.25rem;"></div>
            </div>
            <div>
              <div style="font-size: 0.75rem; color: var(--rembr-text-secondary);">By Severity</div>
              <div id="stats-by-severity" style="font-size: 0.875rem; margin-top: 0.25rem;"></div>
            </div>
            <div>
              <div style="font-size: 0.75rem; color: var(--rembr-text-secondary);">Avg Confidence</div>
              <div id="stats-avg-confidence" style="font-size: 0.875rem; margin-top: 0.25rem;"></div>
            </div>
          </div>
        </div>

        <!-- Contradictions list -->
        <div id="contradictions-container">
          ${contradictionsHtml}
        </div>

        ${data.contradictions.length === 0 ? `
          <div style="text-align: center; padding: 3rem; color: var(--rembr-text-secondary);">
            <div style="font-size: 3rem; margin-bottom: 1rem;">✅</div>
            <div style="font-size: 1.125rem; font-weight: 600; margin-bottom: 0.5rem;">No Contradictions Detected</div>
            <div style="font-size: 0.875rem;">Your memories are consistent!</div>
          </div>
        ` : ''}
      </div>

      <!-- Resolution modal (placeholder for merge action) -->
      <div id="resolution-modal" style="display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0, 0, 0, 0.8); z-index: 1000; align-items: center; justify-content: center;">
        <div class="rembr-card" style="max-width: 600px; max-height: 80vh; overflow-y: auto;">
          <div class="rembr-card-title">Resolve Contradiction</div>
          <div id="resolution-content"></div>
          <div style="margin-top: 1rem; display: flex; gap: 0.5rem; justify-content: flex-end;">
            <button class="rembr-button rembr-button-secondary" onclick="closeResolutionModal()">Cancel</button>
            <button class="rembr-button" onclick="confirmResolution()">Confirm</button>
          </div>
        </div>
      </div>
    `,
    extraHead: STYLE_INCLUDES.highlightjs,
    extraScripts: `
      <style>
        .contradiction-card {
          background: var(--rembr-bg-secondary);
          border: 1px solid var(--rembr-border);
          border-radius: 12px;
          padding: 1.5rem;
          margin-bottom: 1.5rem;
          transition: opacity 0.3s;
        }
        .contradiction-card.filtered {
          display: none;
        }
      </style>

      <script>
        const data = ${dataJson};
        
        // Calculate and display statistics
        function updateStatistics() {
          const visible = data.contradictions.filter(c => {
            const card = document.getElementById('contradiction-' + data.contradictions.indexOf(c));
            return card && !card.classList.contains('filtered');
          });

          // By type
          const byType = {};
          visible.forEach(c => byType[c.contradiction_type] = (byType[c.contradiction_type] || 0) + 1);
          document.getElementById('stats-by-type').textContent = Object.entries(byType)
            .map(([k, v]) => \`\${k}: \${v}\`)
            .join(', ') || 'None';

          // By severity
          const bySeverity = {};
          visible.forEach(c => bySeverity[c.severity] = (bySeverity[c.severity] || 0) + 1);
          document.getElementById('stats-by-severity').textContent = Object.entries(bySeverity)
            .map(([k, v]) => \`\${k}: \${v}\`)
            .join(', ') || 'None';

          // Average confidence
          const avgConf = visible.length > 0 
            ? visible.reduce((sum, c) => sum + c.confidence, 0) / visible.length
            : 0;
          document.getElementById('stats-avg-confidence').textContent = \`\${Math.round(avgConf * 100)}%\`;
        }

        // Initial statistics
        updateStatistics();

        // Filtering
        function applyFilters() {
          const typeFilter = document.getElementById('type-filter').value;
          const severityFilter = document.getElementById('severity-filter').value;
          const confidenceFilter = parseInt(document.getElementById('confidence-filter').value) / 100;

          data.contradictions.forEach((c, index) => {
            const card = document.getElementById(\`contradiction-\${index}\`);
            if (!card) return;

            const matchesType = typeFilter === 'all' || c.contradiction_type === typeFilter;
            const matchesSeverity = severityFilter === 'all' || c.severity === severityFilter;
            const matchesConfidence = c.confidence >= confidenceFilter;

            if (matchesType && matchesSeverity && matchesConfidence) {
              card.classList.remove('filtered');
            } else {
              card.classList.add('filtered');
            }
          });

          updateStatistics();
        }

        document.getElementById('type-filter').addEventListener('change', applyFilters);
        document.getElementById('severity-filter').addEventListener('change', applyFilters);
        document.getElementById('confidence-filter').addEventListener('input', function() {
          document.getElementById('confidence-value').textContent = this.value;
          applyFilters();
        });

        // Resolution actions
        function resolveContradiction(index, action) {
          const c = data.contradictions[index];
          const memory = action === 'keep_a' ? c.memory_a : c.memory_b;
          
          alert(\`Action: \${action}\\n\\nThis would update memory \${memory.id} and mark the other as resolved.\\n\\nIn a real implementation, this would call the update_memory MCP tool.\`);
        }

        function mergeMemories(index) {
          const c = data.contradictions[index];
          const modal = document.getElementById('resolution-modal');
          const content = document.getElementById('resolution-content');
          
          content.innerHTML = \`
            <div style="margin-bottom: 1rem;">
              <label style="display: block; margin-bottom: 0.5rem; font-weight: 600;">Merged Content:</label>
              <textarea style="width: 100%; min-height: 150px; padding: 0.75rem; background: var(--rembr-bg); border: 1px solid var(--rembr-border); border-radius: 6px; color: var(--rembr-text); resize: vertical;" id="merged-content">\${c.memory_a.content}\\n\\n\${c.memory_b.content}</textarea>
            </div>
            <div style="font-size: 0.875rem; color: var(--rembr-text-secondary);">
              Edit the merged content above, then confirm to create a new memory that resolves this contradiction.
            </div>
          \`;
          
          modal.style.display = 'flex';
        }

        function closeResolutionModal() {
          document.getElementById('resolution-modal').style.display = 'none';
        }

        function confirmResolution() {
          const mergedContent = document.getElementById('merged-content')?.value;
          if (mergedContent) {
            alert(\`Merged content:\\n\\n\${mergedContent}\\n\\nThis would create a new memory and mark both contradictions as resolved.\`);
            closeResolutionModal();
          }
        }

        function ignoreContradiction(index) {
          const c = data.contradictions[index];
          if (confirm(\`Ignore this \${c.contradiction_type} contradiction?\\n\\nThis will hide it from future detection.\`)) {
            document.getElementById(\`contradiction-\${index}\`).style.display = 'none';
            updateStatistics();
          }
        }

        function showDiff(index) {
          const c = data.contradictions[index];
          alert(\`Diff view would show character-level differences between:\\n\\nMemory A:\\n\${c.memory_a.content.substring(0, 100)}...\\n\\nMemory B:\\n\${c.memory_b.content.substring(0, 100)}...\\n\\n(In a real implementation, this would use a proper diff library)\`);
        }
      </script>

      <script>
        function escapeHtml(text) { return text; }
        function formatDate(date) {
          return new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        }
        function formatContradictionType(type) {
          return type.charAt(0).toUpperCase() + type.slice(1);
        }
        function getSeverityColor(severity) {
          const colors = { high: 'var(--rembr-error)', medium: 'var(--rembr-warning)', low: 'var(--rembr-info)' };
          return colors[severity] || 'var(--rembr-text-secondary)';
        }
        function getSeverityBadgeClass(severity) {
          const classes = { high: 'error', medium: 'warning', low: 'success' };
          return 'rembr-badge-' + (classes[severity] || 'primary');
        }
        function getConfidenceColor(confidence) {
          if (confidence >= 0.8) return 'var(--rembr-success)';
          if (confidence >= 0.6) return 'var(--rembr-warning)';
          return 'var(--rembr-error)';
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
  return new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatContradictionType(type: string): string {
  return type.charAt(0).toUpperCase() + type.slice(1);
}

function getSeverityColor(severity: string): string {
  const colors: Record<string, string> = {
    high: 'var(--rembr-error)',
    medium: 'var(--rembr-warning)',
    low: 'var(--rembr-info)'
  };
  return colors[severity] || 'var(--rembr-text-secondary)';
}

function getSeverityBadgeClass(severity: string): string {
  const classes: Record<string, string> = {
    high: 'error',
    medium: 'warning',
    low: 'success'
  };
  return 'rembr-badge-' + (classes[severity] || 'primary');
}

function getConfidenceColor(confidence: number): string {
  if (confidence >= 0.8) return 'var(--rembr-success)';
  if (confidence >= 0.6) return 'var(--rembr-warning)';
  return 'var(--rembr-error)';
}
