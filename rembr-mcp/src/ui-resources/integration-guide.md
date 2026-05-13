# MCP Apps Integration Guide

## Overview

This guide explains how to integrate the interactive memory graph UI with the Rembr MCP server.

## Integration Steps

### 1. Import Required Modules

Add to `src/index-http.ts`:

```typescript
import { registerAppResource } from '@modelcontextprotocol/ext-apps/server';
import { renderMemoryGraph } from './ui-resources/memory-graph.js';
```

### 2. Register the Memory Graph UI Resource

Add after the server initialization:

```typescript
// Register memory graph UI resource
registerAppResource(
  server,
  'Memory Graph',
  'ui://rembr/memory-graph',
  {
    description: 'Interactive force-directed visualization of memory relationships',
    mimeType: 'text/html',
    _meta: {
      ui: {
        // Optional: CSP configuration
        csp: {
          'script-src': ["'self'", 'https://d3js.org'],
          'style-src': ["'self'"]
        }
      }
    }
  },
  async (uri) => {
    // This will be called when the UI is requested
    // For now, return a placeholder - the actual data will come from the tool call
    return {
      contents: [{
        uri,
        mimeType: 'text/html',
        text: renderMemoryGraph({
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
        })
      }]
    };
  }
);
```

### 3. Link UI to generate_context_graph Tool

Find the `generate_context_graph` tool definition and add `_meta.ui.resourceUri`:

```typescript
{
  name: 'generate_context_graph',
  description: 'Generate interactive context graph for visualization with nodes, edges, clusters, and metrics',
  inputSchema: {
    // ... existing schema ...
  },
  _meta: {
    ui: {
      resourceUri: 'ui://rembr/memory-graph'
    }
  }
}
```

### 4. Return HTML in Tool Response

Modify the `generate_context_graph` case in the tool handler:

```typescript
case 'generate_context_graph': {
  trackMcpToolCall('generate_context_graph', 'success');

  const graph = await analyticsService.generateContextGraph(
    tenantId,
    args?.context_id as string,
    args?.include_relationships !== false
  );

  // Return both JSON (for programmatic access) and HTML (for UI)
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(graph, null, 2)
      },
      {
        type: 'resource',
        resource: {
          uri: 'ui://rembr/memory-graph',
          mimeType: 'text/html',
          text: renderMemoryGraph(graph)
        }
      }
    ]
  };
}
```

## Alternative: Simpler Integration (Recommended for MVP)

For a quicker MVP, you can skip the `registerAppResource` step and just return HTML directly from the tool:

```typescript
case 'generate_context_graph': {
  trackMcpToolCall('generate_context_graph', 'success');

  const graph = await analyticsService.generateContextGraph(
    tenantId,
    args?.context_id as string,
    args?.include_relationships !== false
  );

  // Check if client supports MCP Apps
  const supportsUI = context?.clientCapabilities?.experimental?.uiApps === true;

  if (supportsUI) {
    return {
      content: [{
        type: 'text',
        text: renderMemoryGraph(graph),
        mimeType: 'text/html'
      }]
    };
  } else {
    // Fallback to JSON for non-UI clients
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(graph, null, 2)
      }]
    };
  }
}
```

## Testing

### In Claude Desktop

1. Ensure Claude Desktop has MCP Apps support (version 0.8.0+)
2. Call the `generate_context_graph` tool
3. The interactive UI should render in the conversation

### In VS Code Insiders

1. Install the MCP extension (if available)
2. Configure the Rembr MCP server
3. Call the tool from a Copilot chat
4. The UI should render inline

### Browser Testing

For development/debugging, you can test the HTML directly:

```bash
node -e "
const { renderMemoryGraph } = require('./dist/ui-resources/memory-graph.js');
const fs = require('fs');
const testData = {
  nodes: [
    { id: '1', label: 'Test Node', content: 'Test content', category: 'facts', size: 5, color: '#6366f1', created_at: new Date(), metadata: {} }
  ],
  edges: [],
  clusters: [],
  metrics: { total_nodes: 1, total_edges: 0, avg_clustering_coefficient: 0, density: 0, connected_components: 1, most_central_node: '1' }
};
fs.writeFileSync('test-graph.html', renderMemoryGraph(testData));
console.log('Saved to test-graph.html');
"
```

Then open `test-graph.html` in a browser.

## Next Steps

Once the memory graph is working:

1. Implement RAD-170: Contradiction Detection Dashboard
2. Implement RAD-171: Predictive Analytics Dashboard
3. Implement RAD-172: Context Snapshot Timeline
4. Complete RAD-173: Documentation & Launch

Each follows the same pattern:
- Create UI in `ui-resources/<name>.ts`
- Register app resource (or return HTML directly)
- Link to existing MCP tool via `_meta.ui.resourceUri`
