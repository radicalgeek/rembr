/**
 * Demo UI - Simple interactive demo for testing MCP Apps integration
 * 
 * This demonstrates:
 * - Base template usage
 * - Interactive JavaScript
 * - Rembr branding
 * - Basic UI components
 */

import { renderTemplate } from './index.js';

export interface DemoData {
  message?: string;
  items?: Array<{
    id: string;
    label: string;
    value: number;
    status: 'active' | 'pending' | 'completed';
  }>;
}

export function renderDemoUI(data: DemoData = {}): string {
  const message = data.message || 'Welcome to Rembr Interactive UI';
  const items = data.items || [
    { id: '1', label: 'Memory Operations', value: 42, status: 'active' },
    { id: '2', label: 'Context Analytics', value: 87, status: 'completed' },
    { id: '3', label: 'Graph Visualizations', value: 63, status: 'active' },
    { id: '4', label: 'Contradiction Detection', value: 15, status: 'pending' },
  ];

  const content = `
    <div class="rembr-card">
      <div class="rembr-card-title">Interactive Demo</div>
      <p style="color: var(--rembr-text-secondary); margin-bottom: 1.5rem;">
        ${escapeHtml(message)}
      </p>

      <div style="margin-bottom: 1.5rem;">
        <button class="rembr-button" id="demo-action-btn" onclick="handleDemoAction()">
          Try Interactive Action
        </button>
        <button class="rembr-button rembr-button-secondary" style="margin-left: 0.5rem;" onclick="toggleTheme()">
          Toggle Theme
        </button>
      </div>

      <div id="demo-output" style="margin-bottom: 1.5rem; padding: 1rem; background: var(--rembr-bg); border-radius: 6px; min-height: 60px; color: var(--rembr-text-secondary);">
        <em>Click a button to see interactive behavior...</em>
      </div>
    </div>

    <div class="rembr-card">
      <div class="rembr-card-title">Sample Data</div>
      <table style="width: 100%; border-collapse: collapse;">
        <thead>
          <tr style="border-bottom: 1px solid var(--rembr-border);">
            <th style="text-align: left; padding: 0.75rem; color: var(--rembr-text-secondary);">Item</th>
            <th style="text-align: right; padding: 0.75rem; color: var(--rembr-text-secondary);">Value</th>
            <th style="text-align: center; padding: 0.75rem; color: var(--rembr-text-secondary);">Status</th>
          </tr>
        </thead>
        <tbody>
          ${items.map(item => `
            <tr style="border-bottom: 1px solid var(--rembr-border);">
              <td style="padding: 0.75rem;">${escapeHtml(item.label)}</td>
              <td style="text-align: right; padding: 0.75rem; font-weight: 600; color: var(--rembr-primary);">${item.value}</td>
              <td style="text-align: center; padding: 0.75rem;">
                <span class="rembr-badge rembr-badge-${getBadgeType(item.status)}">
                  ${item.status}
                </span>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>

    <div class="rembr-card">
      <div class="rembr-card-title">Features Tested</div>
      <ul style="color: var(--rembr-text-secondary); line-height: 2;">
        <li>✅ Base template rendering</li>
        <li>✅ Rembr branding and theme</li>
        <li>✅ Interactive JavaScript</li>
        <li>✅ Responsive components</li>
        <li>✅ Data binding</li>
        <li>✅ MCP Apps SDK integration</li>
      </ul>
    </div>
  `;

  const extraScripts = `
    <script>
      let clickCount = 0;
      let isDarkTheme = true;

      function handleDemoAction() {
        clickCount++;
        const output = document.getElementById('demo-output');
        const now = new Date().toLocaleTimeString();
        
        output.innerHTML = \`
          <div style="color: var(--rembr-success); font-weight: 500;">
            ✓ Interactive action triggered!
          </div>
          <div style="margin-top: 0.5rem; font-size: 0.875rem;">
            Click count: <strong>\${clickCount}</strong> | Time: <strong>\${now}</strong>
          </div>
          <div style="margin-top: 0.5rem; font-size: 0.875rem; color: var(--rembr-text-secondary);">
            This demonstrates that JavaScript is working correctly in the MCP UI.
          </div>
        \`;

        // Animate the button
        const btn = document.getElementById('demo-action-btn');
        btn.style.transform = 'scale(0.95)';
        setTimeout(() => {
          btn.style.transform = 'scale(1)';
        }, 100);
      }

      function toggleTheme() {
        isDarkTheme = !isDarkTheme;
        const root = document.documentElement;
        
        if (isDarkTheme) {
          // Dark theme (default)
          root.style.setProperty('--rembr-bg', '#0f172a');
          root.style.setProperty('--rembr-bg-secondary', '#1e293b');
          root.style.setProperty('--rembr-text', '#f8fafc');
          root.style.setProperty('--rembr-text-secondary', '#cbd5e1');
        } else {
          // Light theme
          root.style.setProperty('--rembr-bg', '#f8fafc');
          root.style.setProperty('--rembr-bg-secondary', '#e2e8f0');
          root.style.setProperty('--rembr-text', '#0f172a');
          root.style.setProperty('--rembr-text-secondary', '#475569');
        }
        
        const output = document.getElementById('demo-output');
        output.innerHTML = \`
          <div style="color: var(--rembr-info); font-weight: 500;">
            Theme toggled to: <strong>\${isDarkTheme ? 'Dark' : 'Light'}</strong>
          </div>
          <div style="margin-top: 0.5rem; font-size: 0.875rem; color: var(--rembr-text-secondary);">
            CSS custom properties are being updated dynamically.
          </div>
        \`;
      }

      // Auto-focus on load
      window.addEventListener('DOMContentLoaded', () => {
        console.log('Rembr Demo UI loaded successfully');
      });
    </script>
  `;

  return renderTemplate({
    title: 'Demo UI',
    subtitle: 'MCP Apps SDK Test',
    content,
    extraScripts,
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

function getBadgeType(status: string): string {
  switch (status) {
    case 'completed':
      return 'success';
    case 'pending':
      return 'warning';
    case 'active':
      return 'primary';
    default:
      return 'primary';
  }
}
