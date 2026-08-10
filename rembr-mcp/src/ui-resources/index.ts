/**
 * Rembr UI Resources - MCP Apps Integration
 * 
 * This module provides utilities for creating interactive UIs for MCP tools.
 * 
 * Supports two integration approaches:
 * 
 * 1. **Simple HTML Return (Recommended)**
 *    Return HTML directly from tool responses using renderTemplate()
 *    
 * 2. **@mcp-ui/server SDK (Advanced)**
 *    Use createUIResource() for standardized UI resource wrapping
 * 
 * @see {@link https://spec.modelcontextprotocol.io/extensions/ui-apps/}
 * @see {@link https://www.npmjs.com/package/@mcp-ui/server}
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { createUIResource } from '@mcp-ui/server';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Template rendering options
 */
export interface TemplateOptions {
  title: string;
  subtitle?: string;
  content: string;
  extraHead?: string;
  headerActions?: string;
  extraScripts?: string;
}

/** Escape text before inserting it into trusted renderer markup. */
export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  })[character]!);
}

/** Serialise data without allowing a stored `</script>` to end its element. */
export function safeJsonForHtml(value: unknown): string {
  return JSON.stringify(value, null, 2)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * Load and render the base HTML template with provided content
 */
export function renderTemplate(options: TemplateOptions): string {
  const templatePath = join(__dirname, 'templates', 'base.html');
  let template = readFileSync(templatePath, 'utf-8');

  // Replace template variables
  template = template.replace('{{title}}', escapeHtml(options.title));
  template = template.replace('{{subtitle}}', escapeHtml(options.subtitle || 'Interactive Memory Exploration'));
  template = template.replace('{{content}}', options.content);
  template = template.replace('{{extra_head}}', options.extraHead || '');
  template = template.replace('{{header_actions}}', options.headerActions || '');
  template = template.replace('{{extra_scripts}}', options.extraScripts || '');

  // Release boundary: MCP raw HTML is static. Remove every executable script
  // and inline event handler even if a client ignores the document CSP.
  template = template.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  template = template.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');

  return template;
}

/**
 * Common script includes for interactive UIs
 */
export const SCRIPT_INCLUDES = {
  d3: '',
  chartjs: '',
  diff: '',
  all: '',
};

/**
 * Common style includes for interactive UIs
 */
export const STYLE_INCLUDES = {
  highlightjs: '',
  fontawesome: '',
};

/**
 * UI resource metadata for MCP Apps
 */
export interface UIResourceMetadata {
  name: string;
  description: string;
  mimeType: string;
  uri: string;
}

/**
 * Create UI resource metadata for MCP Apps integration
 */
export function createUIResourceMetadata(
  name: string,
  description: string,
  resourceId: string
): UIResourceMetadata {
  return {
    name,
    description,
    mimeType: 'text/html',
    uri: `rembr://ui-resources/${resourceId}`,
  };
}

/**
 * Helper to create error UI
 */
export function renderError(error: Error | string): string {
  const errorMessage = process.env.NODE_ENV === 'production'
    ? 'The interface could not be rendered.'
    : typeof error === 'string' ? error : error.message;

  return renderTemplate({
    title: 'Error',
    subtitle: 'Something went wrong',
    content: `
      <div class="rembr-card">
        <div class="rembr-card-title">
          <span class="rembr-badge rembr-badge-error">Error</span>
          Error Loading UI
        </div>
        <p style="color: var(--rembr-text-secondary); margin-bottom: 1rem;">
          An error occurred while rendering this interface:
        </p>
        <pre style="background: var(--rembr-bg); padding: 1rem; border-radius: 6px; overflow-x: auto; color: var(--rembr-error);">
${escapeHtml(errorMessage)}
        </pre>
      </div>
    `,
  });
}

/**
 * Helper to create loading UI
 */
export function renderLoading(message: string = 'Loading...'): string {
  return renderTemplate({
    title: 'Loading',
    subtitle: 'Please wait',
    content: `
      <div class="rembr-card" style="text-align: center; padding: 3rem;">
        <div class="rembr-loading" style="width: 40px; height: 40px; margin: 0 auto 1rem;"></div>
        <p style="color: var(--rembr-text-secondary);">${escapeHtml(message)}</p>
      </div>
    `,
  });
}

/**
 * Create a UI resource using @mcp-ui/server SDK
 * 
 * This wraps HTML content in the standard MCP UI resource format.
 * Use this when you want to return UI resources in tool responses.
 * 
 * @example
 * ```typescript
 * import { createRembrUIResource } from './ui-resources/index.js';
 * import { renderMemoryGraph } from './ui-resources/memory-graph.js';
 * 
 * // In your tool handler:
 * const graph = await analyticsService.generateContextGraph(tenantId);
 * const uiResource = createRembrUIResource(renderMemoryGraph(graph));
 * 
 * return {
 *   content: [uiResource]
 * };
 * ```
 */
export function createRembrUIResource(html: string) {
  return createUIResource({
    uri: 'ui://rembr/ui-resource',
    content: { type: 'rawHtml', htmlString: html },
    encoding: 'text',
  });
}

/**
 * Create a dual-format response (JSON + UI)
 * 
 * Returns both a JSON representation and an interactive UI.
 * Clients that don't support UI apps will fall back to JSON.
 * 
 * @example
 * ```typescript
 * const graph = await analyticsService.generateContextGraph(tenantId);
 * 
 * return createDualFormatResponse(
 *   graph, // JSON data
 *   renderMemoryGraph(graph) // HTML UI
 * );
 * ```
 */
export function createDualFormatResponse(
  jsonData: any,
  html: string
): { content: Array<{ type: string; text: string; mimeType?: string }> } {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(jsonData, null, 2)
      },
      {
        type: 'text',
        text: html,
        mimeType: 'text/html'
      }
    ]
  };
}

// Note: All exports are already declared inline above
