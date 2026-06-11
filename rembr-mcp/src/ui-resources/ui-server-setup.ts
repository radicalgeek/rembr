/**
 * UI Server Setup - MCP Apps SDK Integration Examples
 * 
 * This file demonstrates how to integrate interactive UIs with the Rembr MCP server.
 * 
 * **Approach 1: Simple HTML Return (Recommended for most cases)**
 * Just return HTML from tool handlers using renderTemplate()
 * 
 * **Approach 2: Resource URI Registration (Advanced)**
 * Register UI resources with explicit URIs using @modelcontextprotocol/ext-apps
 * 
 * For most use cases, Approach 1 is simpler and sufficient.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { renderDemoUI } from './demo-ui.js';

/**
 * Example: Simple HTML Return in Tool Handler
 * 
 * This is the recommended approach for most cases.
 * Just return HTML directly in the tool response.
 */
export function exampleSimpleHTMLReturn() {
  return {
    content: [
      {
        type: 'text',
        text: renderDemoUI({ message: 'Hello from Rembr!' }),
        mimeType: 'text/html'
      }
    ]
  };
}

/**
 * Example: Dual-Format Response (JSON + HTML)
 * 
 * Return both JSON (for non-UI clients) and HTML (for UI-capable clients).
 * This provides graceful fallback.
 */
export function exampleDualFormatResponse(data: any, htmlRenderer: (data: any) => string) {
  return {
    content: [
      // JSON response (always works)
      {
        type: 'text',
        text: JSON.stringify(data, null, 2)
      },
      // HTML UI (for MCP Apps-capable clients)
      {
        type: 'text',
        text: htmlRenderer(data),
        mimeType: 'text/html'
      }
    ]
  };
}

/**
 * Example: Resource URI Registration (Advanced)
 * 
 * This demonstrates how to register UI resources with explicit URIs.
 * Use this approach when you need:
 * - Better separation of concerns
 * - Client-side caching
 * - Content Security Policy configuration
 * 
 * NOTE: This is commented out as it requires server initialization context.
 * Uncomment and integrate into your server startup code if needed.
 */
export function registerUIResources(server: Server) {
  // This would require @modelcontextprotocol/ext-apps registerAppResource
  // which isn't currently used in Rembr's architecture
  
  /*
  import { registerAppResource } from '@modelcontextprotocol/ext-apps/server';
  
  registerAppResource(
    server,
    'Rembr Demo UI',
    'ui://rembr/demo',
    {
      description: 'Interactive demo UI for testing MCP Apps integration',
      mimeType: 'text/html',
      _meta: {
        ui: {
          csp: {
            'script-src': ["'unsafe-inline'"],
            'style-src': ["'unsafe-inline'"]
          }
        }
      }
    },
    async (uri) => {
      return {
        contents: [{
          uri,
          mimeType: 'text/html',
          text: renderDemoUI()
        }]
      };
    }
  );
  */
  
  console.log('UI resources registration example (currently using Simple HTML Return approach)');
}

/**
 * Integration Guide for Tool Developers
 * 
 * To add an interactive UI to your MCP tool:
 * 
 * 1. Create a renderer function in ui-resources/
 *    ```typescript
 *    export function renderMyUI(data: MyData): string {
 *      return renderTemplate({
 *        title: 'My UI',
 *        subtitle: 'Description',
 *        content: `<div>...your HTML...</div>`
 *      });
 *    }
 *    ```
 * 
 * 2. In your tool handler (e.g., index-http.ts):
 *    ```typescript
 *    import { renderMyUI } from './ui-resources/my-ui.js';
 *    
 *    case 'my_tool': {
 *      const data = await myService.getData();
 *      return {
 *        content: [
 *          { type: 'text', text: JSON.stringify(data, null, 2) },
 *          { type: 'text', text: renderMyUI(data), mimeType: 'text/html' }
 *        ]
 *      };
 *    }
 *    ```
 * 
 * 3. Test in Claude Desktop 0.8.0+ or other MCP Apps-capable clients
 * 
 * See existing examples:
 * - memory-graph.ts - D3.js force-directed graph
 * - analytics-dashboard.ts - Chart.js analytics
 * - contradiction-dashboard.ts - Side-by-side comparison
 * - snapshot-timeline.ts - Temporal visualization
 * - context-diff-viewer.ts - Diff comparison
 * - demo-ui.ts - Interactive demo
 */

export const INTEGRATION_GUIDE = {
  simpleHTMLReturn: 'Return HTML directly in tool response (recommended)',
  dualFormat: 'Return both JSON and HTML for graceful fallback',
  resourceRegistration: 'Advanced: Register resources with explicit URIs',
  
  bestPractices: [
    'Always escape user-provided content (use escapeHtml)',
    'Use renderTemplate() for consistent Rembr branding',
    'Test in a browser first (save HTML to file)',
    'Provide JSON fallback for non-UI clients',
    'Keep UIs lightweight (external CDN libraries are OK)',
    'Use inline scripts for interactivity (CSP-compliant)',
  ],
  
  externalLibraries: {
    'd3': 'Force-directed graphs, network visualizations',
    'chartjs': 'Charts and analytics dashboards',
    'diff': 'Text comparison and diff views',
    'highlightjs': 'Code syntax highlighting',
  },
  
  testingClients: [
    'Claude Desktop 0.8.0+',
    'VS Code with MCP Apps extension',
    'Browser (save HTML to file for development)',
  ],
};
