/**
 * Context Diff Viewer - Snapshot Comparison Component (REM-52)
 * Side-by-side comparison of two temporal snapshots with visual diff highlighting
 * 
 * Features:
 * - Side-by-side snapshot comparison
 * - Highlight added/removed/modified memories
 * - Visualize relationship changes  
 * - Export diff report (JSON/CSV)
 * - Filter by change type (added/removed/modified)
 * - Search within diff results
 */

import { renderTemplate } from './index.js';

export interface Memory {
  id: string;
  content: string;
  category?: string;
  created_at: Date;
  metadata?: any;
}

export interface SnapshotDiffData {
  timeA: Date;
  timeB: Date;
  added: number;
  removed: number;
  modified: number;
  details: {
    added: Memory[];
    removed: Memory[];
    modified: Array<{ before: Memory; after: Memory }>;
  };
}

/**
 * Render the context diff viewer
 */
export function renderContextDiffViewer(data: SnapshotDiffData): string {
  const dataJson = JSON.stringify(data, null, 2);
  
  // Summary stats
  const totalChanges = data.added + data.removed + data.modified;
  
  // Generate HTML for each change
  const addedHtml = data.details.added.map((memory, index) => `
    <div class="diff-card diff-added" data-type="added" id="added-${index}">
      <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.75rem;">
        <span class="rembr-badge rembr-badge-success">ADDED</span>
        <span style="font-size: 0.75rem; color: var(--rembr-text-secondary);">
          ${memory.category} · ${formatDate(memory.created_at)}
        </span>
      </div>
      <div style="padding: 0.75rem; background: rgba(34, 197, 94, 0.1); border-left: 3px solid #22c55e; border-radius: 4px;">
        <div style="white-space: pre-wrap; font-size: 0.875rem;">
          ${escapeHtml(memory.content)}
        </div>
      </div>
      ${memory.metadata ? `
        <details style="margin-top: 0.5rem;">
          <summary style="cursor: pointer; font-size: 0.75rem; color: var(--rembr-text-secondary);">
            Show metadata
          </summary>
          <pre style="font-size: 0.75rem; margin-top: 0.5rem; padding: 0.5rem; background: var(--rembr-bg); border-radius: 4px; overflow-x: auto;">${JSON.stringify(memory.metadata, null, 2)}</pre>
        </details>
      ` : ''}
    </div>
  `).join('\n');

  const removedHtml = data.details.removed.map((memory, index) => `
    <div class="diff-card diff-removed" data-type="removed" id="removed-${index}">
      <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.75rem;">
        <span class="rembr-badge rembr-badge-danger">REMOVED</span>
        <span style="font-size: 0.75rem; color: var(--rembr-text-secondary);">
          ${memory.category} · ${formatDate(memory.created_at)}
        </span>
      </div>
      <div style="padding: 0.75rem; background: rgba(239, 68, 68, 0.1); border-left: 3px solid #ef4444; border-radius: 4px;">
        <div style="white-space: pre-wrap; font-size: 0.875rem; text-decoration: line-through; opacity: 0.7;">
          ${escapeHtml(memory.content)}
        </div>
      </div>
      ${memory.metadata ? `
        <details style="margin-top: 0.5rem;">
          <summary style="cursor: pointer; font-size: 0.75rem; color: var(--rembr-text-secondary);">
            Show metadata
          </summary>
          <pre style="font-size: 0.75rem; margin-top: 0.5rem; padding: 0.5rem; background: var(--rembr-bg); border-radius: 4px; overflow-x: auto;">${JSON.stringify(memory.metadata, null, 2)}</pre>
        </details>
      ` : ''}
    </div>
  `).join('\n');

  const modifiedHtml = data.details.modified.map((change, index) => `
    <div class="diff-card diff-modified" data-type="modified" id="modified-${index}">
      <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.75rem;">
        <span class="rembr-badge rembr-badge-warning">MODIFIED</span>
        <span style="font-size: 0.75rem; color: var(--rembr-text-secondary);">
          ${change.before.category} · ${formatDate(change.before.created_at)}
        </span>
      </div>
      
      <!-- Side-by-side comparison -->
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem;">
        <!-- Before (Snapshot A) -->
        <div>
          <div style="font-weight: 600; font-size: 0.75rem; margin-bottom: 0.5rem; color: var(--rembr-text-secondary);">
            Before (${formatTime(data.timeA)})
          </div>
          <div style="padding: 0.75rem; background: rgba(239, 68, 68, 0.1); border-left: 3px solid #ef4444; border-radius: 4px;">
            <div style="white-space: pre-wrap; font-size: 0.875rem;">
              ${highlightDiff(change.before.content, change.after.content, 'remove')}
            </div>
          </div>
        </div>
        
        <!-- After (Snapshot B) -->
        <div>
          <div style="font-weight: 600; font-size: 0.75rem; margin-bottom: 0.5rem; color: var(--rembr-text-secondary);">
            After (${formatTime(data.timeB)})
          </div>
          <div style="padding: 0.75rem; background: rgba(34, 197, 94, 0.1); border-left: 3px solid #22c55e; border-radius: 4px;">
            <div style="white-space: pre-wrap; font-size: 0.875rem;">
              ${highlightDiff(change.before.content, change.after.content, 'add')}
            </div>
          </div>
        </div>
      </div>
    </div>
  `).join('\n');

  return renderTemplate({
    title: 'Context Diff Viewer',
    subtitle: 'Snapshot Comparison',
    content: `
    <!-- Data for JavaScript -->
    <script id="diff-data" type="application/json">
      ${dataJson}
    </script>

    <div class="rembr-dashboard">
      <!-- Header -->
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 2rem;">
        <div>
          <h1 style="margin: 0 0 0.5rem 0; font-size: 1.5rem;">Context Diff Viewer</h1>
          <div style="color: var(--rembr-text-secondary); font-size: 0.875rem;">
            Comparing snapshots from <strong>${formatDateTime(data.timeA)}</strong> to <strong>${formatDateTime(data.timeB)}</strong>
          </div>
        </div>
        
        <!-- Export buttons -->
        <div style="display: flex; gap: 0.5rem;">
          <button class="rembr-button rembr-button-secondary" onclick="exportDiffJson()">
            📥 Export JSON
          </button>
          <button class="rembr-button rembr-button-secondary" onclick="exportDiffCsv()">
            📊 Export CSV
          </button>
        </div>
      </div>

      <!-- Summary stats -->
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-bottom: 2rem;">
        <div class="rembr-card" style="text-align: center; padding: 1.5rem;">
          <div style="font-size: 2rem; font-weight: 700; color: #22c55e; margin-bottom: 0.5rem;">
            ${data.added}
          </div>
          <div style="color: var(--rembr-text-secondary); font-size: 0.875rem;">
            Added
          </div>
        </div>
        
        <div class="rembr-card" style="text-align: center; padding: 1.5rem;">
          <div style="font-size: 2rem; font-weight: 700; color: #ef4444; margin-bottom: 0.5rem;">
            ${data.removed}
          </div>
          <div style="color: var(--rembr-text-secondary); font-size: 0.875rem;">
            Removed
          </div>
        </div>
        
        <div class="rembr-card" style="text-align: center; padding: 1.5rem;">
          <div style="font-size: 2rem; font-weight: 700; color: #f59e0b; margin-bottom: 0.5rem;">
            ${data.modified}
          </div>
          <div style="color: var(--rembr-text-secondary); font-size: 0.875rem;">
            Modified
          </div>
        </div>
        
        <div class="rembr-card" style="text-align: center; padding: 1.5rem;">
          <div style="font-size: 2rem; font-weight: 700; color: var(--rembr-primary); margin-bottom: 0.5rem;">
            ${totalChanges}
          </div>
          <div style="color: var(--rembr-text-secondary); font-size: 0.875rem;">
            Total Changes
          </div>
        </div>
      </div>

      <!-- Filters and search -->
      <div class="rembr-card" style="margin-bottom: 1.5rem; padding: 1rem;">
        <div style="display: flex; gap: 1rem; align-items: center; flex-wrap: wrap;">
          <!-- Search -->
          <input 
            type="text" 
            id="search-input"
            placeholder="Search in diff results..." 
            class="rembr-input"
            style="flex: 1; min-width: 200px;"
            oninput="filterDiffCards()"
          />
          
          <!-- Type filters -->
          <div style="display: flex; gap: 0.5rem; align-items: center;">
            <span style="font-size: 0.875rem; color: var(--rembr-text-secondary);">Show:</span>
            <label style="display: flex; align-items: center; gap: 0.25rem; cursor: pointer;">
              <input type="checkbox" id="filter-added" checked onchange="filterDiffCards()" />
              <span style="font-size: 0.875rem;">Added</span>
            </label>
            <label style="display: flex; align-items: center; gap: 0.25rem; cursor: pointer;">
              <input type="checkbox" id="filter-removed" checked onchange="filterDiffCards()" />
              <span style="font-size: 0.875rem;">Removed</span>
            </label>
            <label style="display: flex; align-items: center; gap: 0.25rem; cursor: pointer;">
              <input type="checkbox" id="filter-modified" checked onchange="filterDiffCards()" />
              <span style="font-size: 0.875rem;">Modified</span>
            </label>
          </div>
        </div>
      </div>

      <!-- Diff results -->
      <div id="diff-container">
        ${data.modified > 0 ? `
          <h2 style="margin: 2rem 0 1rem 0; font-size: 1.25rem;">
            Modified (${data.modified})
          </h2>
          ${modifiedHtml}
        ` : ''}
        
        ${data.added > 0 ? `
          <h2 style="margin: 2rem 0 1rem 0; font-size: 1.25rem;">
            Added (${data.added})
          </h2>
          ${addedHtml}
        ` : ''}
        
        ${data.removed > 0 ? `
          <h2 style="margin: 2rem 0 1rem 0; font-size: 1.25rem;">
            Removed (${data.removed})
          </h2>
          ${removedHtml}
        ` : ''}
        
        ${totalChanges === 0 ? `
          <div class="rembr-card" style="text-align: center; padding: 3rem;">
            <div style="font-size: 3rem; margin-bottom: 1rem;">✨</div>
            <div style="font-size: 1.25rem; font-weight: 600; margin-bottom: 0.5rem;">
              No Changes Detected
            </div>
            <div style="color: var(--rembr-text-secondary);">
              The two snapshots are identical.
            </div>
          </div>
        ` : ''}
      </div>
    </div>

    <style>
      .diff-card {
        background: var(--rembr-card-bg);
        border: 1px solid var(--rembr-border);
        border-radius: 8px;
        padding: 1rem;
        margin-bottom: 1rem;
        transition: all 0.2s;
      }

      .diff-card:hover {
        box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
      }

      .diff-card.hidden {
        display: none;
      }

      .diff-highlight-add {
        background: rgba(34, 197, 94, 0.3);
        padding: 0 2px;
        border-radius: 2px;
      }

      .diff-highlight-remove {
        background: rgba(239, 68, 68, 0.3);
        padding: 0 2px;
        border-radius: 2px;
        text-decoration: line-through;
      }
    </style>

    <script>
      // Filter diff cards by search and type
      function filterDiffCards() {
        const searchTerm = document.getElementById('search-input').value.toLowerCase();
        const showAdded = document.getElementById('filter-added').checked;
        const showRemoved = document.getElementById('filter-removed').checked;
        const showModified = document.getElementById('filter-modified').checked;

        document.querySelectorAll('.diff-card').forEach(card => {
          const type = card.dataset.type;
          const text = card.textContent.toLowerCase();
          
          const typeMatch = (type === 'added' && showAdded) ||
                           (type === 'removed' && showRemoved) ||
                           (type === 'modified' && showModified);
          
          const searchMatch = searchTerm === '' || text.includes(searchTerm);
          
          if (typeMatch && searchMatch) {
            card.classList.remove('hidden');
          } else {
            card.classList.add('hidden');
          }
        });
      }

      // Export diff as JSON
      function exportDiffJson() {
        const data = JSON.parse(document.getElementById('diff-data').textContent);
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = \`snapshot-diff-\${new Date().toISOString().split('T')[0]}.json\`;
        a.click();
        URL.revokeObjectURL(url);
      }

      // Export diff as CSV
      function exportDiffCsv() {
        const data = JSON.parse(document.getElementById('diff-data').textContent);
        
        const rows = [
          ['Type', 'Category', 'Content', 'Created At', 'Before Content', 'After Content']
        ];
        
        // Added
        data.details.added.forEach(memory => {
          rows.push([
            'ADDED',
            memory.category,
            memory.content.replace(/"/g, '""'),
            new Date(memory.created_at).toISOString(),
            '',
            ''
          ]);
        });
        
        // Removed
        data.details.removed.forEach(memory => {
          rows.push([
            'REMOVED',
            memory.category,
            memory.content.replace(/"/g, '""'),
            new Date(memory.created_at).toISOString(),
            '',
            ''
          ]);
        });
        
        // Modified
        data.details.modified.forEach(change => {
          rows.push([
            'MODIFIED',
            change.before.category,
            '',
            new Date(change.before.created_at).toISOString(),
            change.before.content.replace(/"/g, '""'),
            change.after.content.replace(/"/g, '""')
          ]);
        });
        
        const csv = rows.map(row => 
          row.map(cell => \`"\${cell}"\`).join(',')
        ).join('\\n');
        
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = \`snapshot-diff-\${new Date().toISOString().split('T')[0]}.csv\`;
        a.click();
        URL.revokeObjectURL(url);
      }
    </script>
    `
  });
}

/**
 * Helper: Format date
 */
function formatDate(date: Date): string {
  return new Date(date).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
}

/**
 * Helper: Format time
 */
function formatTime(date: Date): string {
  return new Date(date).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit'
  });
}

/**
 * Helper: Format date and time
 */
function formatDateTime(date: Date): string {
  return new Date(date).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

/**
 * Helper: Escape HTML
 */
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

/**
 * Helper: Highlight diff between two texts
 * Simple word-level diff highlighting
 */
function highlightDiff(before: string, after: string, mode: 'add' | 'remove'): string {
  const beforeWords = before.split(/(\s+)/);
  const afterWords = after.split(/(\s+)/);
  
  if (mode === 'remove') {
    // Highlight words that were removed
    const afterSet = new Set(afterWords);
    return beforeWords.map(word => {
      if (word.trim() && !afterSet.has(word)) {
        return `<span class="diff-highlight-remove">${escapeHtml(word)}</span>`;
      }
      return escapeHtml(word);
    }).join('');
  } else {
    // Highlight words that were added
    const beforeSet = new Set(beforeWords);
    return afterWords.map(word => {
      if (word.trim() && !beforeSet.has(word)) {
        return `<span class="diff-highlight-add">${escapeHtml(word)}</span>`;
      }
      return escapeHtml(word);
    }).join('');
  }
}
