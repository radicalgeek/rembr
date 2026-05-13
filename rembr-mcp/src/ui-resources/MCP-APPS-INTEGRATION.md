# MCP Apps Integration Guide - Rembr Interactive UIs

## Overview

Rembr now includes 4 interactive user interfaces powered by the MCP Apps extension, making it the **first memory service with interactive visualizations**. This guide explains how to integrate these UIs with the Rembr MCP server.

## What are MCP Apps?

MCP Apps is an extension to the Model Context Protocol that allows MCP servers to display interactive HTML/JavaScript UIs directly in conversational AI clients (Claude Desktop, VS Code Copilot, etc.). Instead of returning plain JSON, tools can now return rich, interactive dashboards.

## Available Interactive UIs

| UI | MCP Tool | Purpose |
|----|----------|---------|
| **Memory Graph** | `generate_context_graph` | Force-directed visualization of memory relationships |
| **Contradiction Dashboard** | `detect_memory_contradictions` | Side-by-side comparison of conflicting memories with resolution actions |
| **Predictive Analytics** | `generate_predictive_analytics` | Charts and insights about memory growth, quality, and patterns |
| **Snapshot Timeline** | `list_snapshots` | Temporal visualization of context snapshots with comparison tools |

## Integration Approach

There are **two ways** to integrate MCP Apps UIs:

### Approach 1: Simple HTML Return (Recommended)

Return HTML directly from the tool response. This is the simplest approach and requires minimal changes.

**Advantages:**
- No additional resource registration needed
- Works immediately with existing tools
- Easy to test and debug

**Example:**

```typescript
import { renderMemoryGraph } from './ui-resources/memory-graph.js';

case 'generate_context_graph': {
  const graph = await analyticsService.generateContextGraph(
    tenantId,
    args?.context_id as string,
    args?.include_relationships !== false
  );

  return {
    content: [{
      type: 'text',
      text: renderMemoryGraph(graph),
      mimeType: 'text/html'
    }]
  };
}
```

### Approach 2: Resource URI Registration (Advanced)

Register UI resources with explicit URIs and link them via tool metadata. This provides better separation and caching.

**Advantages:**
- Better separation of concerns
- UI resources can be cached by clients
- Supports Content Security Policy configuration

**Example:**

```typescript
import { registerAppResource } from '@modelcontextprotocol/ext-apps/server';
import { renderMemoryGraph } from './ui-resources/memory-graph.js';

// During server initialization
registerAppResource(
  server,
  'Memory Graph',
  'ui://rembr/memory-graph',
  {
    description: 'Interactive force-directed visualization of memory relationships',
    mimeType: 'text/html',
    _meta: {
      ui: {
        csp: {
          'script-src': ["'self'", 'https://d3js.org'],
          'style-src': ["'self'"]
        }
      }
    }
  },
  async (uri) => {
    // Return placeholder or fetch data
    return {
      contents: [{
        uri,
        mimeType: 'text/html',
        text: renderMemoryGraph(/* ... */)
      }]
    };
  }
);

// In tool definition
{
  name: 'generate_context_graph',
  description: 'Generate interactive context graph for visualization',
  inputSchema: { /* ... */ },
  _meta: {
    ui: {
      resourceUri: 'ui://rembr/memory-graph'
    }
  }
}
```

## Complete Integration (All 4 UIs)

### 1. Import UI Renderers

Add to `src/index-http.ts`:

```typescript
import { renderMemoryGraph } from './ui-resources/memory-graph.js';
import { renderContradictionDashboard } from './ui-resources/contradiction-dashboard.js';
import { renderAnalyticsDashboard } from './ui-resources/analytics-dashboard.js';
import { renderSnapshotTimeline } from './ui-resources/snapshot-timeline.js';
```

### 2. Update Tool Handlers

Update each tool case to return HTML:

#### Memory Graph

```typescript
case 'generate_context_graph': {
  const graph = await analyticsService.generateContextGraph(
    tenantId,
    args?.context_id as string,
    args?.include_relationships !== false
  );

  trackMcpToolCall('generate_context_graph', 'success', tenantId, duration);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(graph, null, 2)
      },
      {
        type: 'text',
        text: renderMemoryGraph(graph),
        mimeType: 'text/html'
      }
    ]
  };
}
```

#### Contradiction Dashboard

```typescript
case 'detect_memory_contradictions': {
  const contradictions = await analyticsService.detectMemoryContradictions(
    tenantId,
    args?.context_id as string,
    args?.confidence_threshold as number || 0.7
  );

  trackMcpToolCall('detect_memory_contradictions', 'success', tenantId, duration);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ contradictions }, null, 2)
      },
      {
        type: 'text',
        text: renderContradictionDashboard({ contradictions }),
        mimeType: 'text/html'
      }
    ]
  };
}
```

#### Predictive Analytics

```typescript
case 'generate_predictive_analytics': {
  const analytics = await analyticsService.generatePredictiveAnalytics(tenantId);

  trackMcpToolCall('generate_predictive_analytics', 'success', tenantId, duration);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(analytics, null, 2)
      },
      {
        type: 'text',
        text: renderAnalyticsDashboard(analytics),
        mimeType: 'text/html'
      }
    ]
  };
}
```

#### Snapshot Timeline

```typescript
case 'list_snapshots': {
  const authContext = { tenant_id: tenantId, project_id: projectId };
  const snapshots = await snapshotService.listSnapshots(
    authContext,
    projectId,
    args?.limit as number || 10
  );

  trackMcpToolCall('list_snapshots', 'success', tenantId, duration);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ success: true, count: snapshots.length, snapshots }, null, 2)
      },
      {
        type: 'text',
        text: renderSnapshotTimeline({ snapshots }),
        mimeType: 'text/html'
      }
    ]
  };
}
```

## Testing

### Claude Desktop (Recommended)

1. **Install Claude Desktop 0.8.0+** (supports MCP Apps)
2. **Configure Rembr MCP server** in Claude Desktop settings
3. **Call a tool**:
   ```
   Can you generate a context graph for my recent memories?
   ```
4. **See the interactive UI** render in the conversation

### Browser Testing (Development)

Create test HTML files for each UI:

```bash
cd rembr-mcp
node -e "
const { renderMemoryGraph } = require('./dist/ui-resources/memory-graph.js');
const fs = require('fs');
const testData = {
  nodes: [
    { id: '1', label: 'Test Node', content: 'Test content', category: 'facts', size: 5, color: '#6366f1', created_at: new Date(), metadata: {} },
    { id: '2', label: 'Related Node', content: 'Related content', category: 'preferences', size: 4, color: '#8b5cf6', created_at: new Date(), metadata: {} }
  ],
  edges: [{ source: '1', target: '2', weight: 0.8, type: 'similarity' }],
  clusters: [{ id: 'c1', nodes: ['1', '2'], theme: 'Test Cluster', coherence: 0.9, description: 'Related test nodes' }],
  metrics: { total_nodes: 2, total_edges: 1, avg_clustering_coefficient: 0.5, density: 0.5, connected_components: 1, most_central_node: '1' }
};
fs.writeFileSync('test-graph.html', renderMemoryGraph(testData));
console.log('Saved to test-graph.html - open in browser');
"
```

Repeat for other UIs:
- `renderContradictionDashboard({ contradictions: [...] })`
- `renderAnalyticsDashboard({ memory_growth_prediction: {...}, ... })`
- `renderSnapshotTimeline({ snapshots: [...] })`

## Client Capability Detection (Optional)

To gracefully fall back to JSON for clients that don't support MCP Apps:

```typescript
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
  // Fallback to JSON
  return {
    content: [{
      type: 'text',
      text: JSON.stringify(graph, null, 2)
    }]
  };
}
```

## Security Considerations

### Content Security Policy

The UIs use inline scripts and external CDN libraries (D3.js, Chart.js, Diff.js). If using Approach 2 (Resource URI), configure CSP:

```typescript
_meta: {
  ui: {
    csp: {
      'script-src': ["'self'", 'https://d3js.org', 'https://cdn.jsdelivr.net'],
      'style-src': ["'self'"]
    }
  }
}
```

### Sanitization

All user content is escaped using `escapeHtml()` to prevent XSS attacks. The UI renderers handle this automatically.

## Deployment

The UIs are built as part of the standard TypeScript compilation:

```bash
npm run build
```

The Dockerfile already includes the UI templates:

```dockerfile
# Build TypeScript
RUN npm run build

# Copy UI templates (needed at runtime)
COPY src/ui-resources/templates ./dist/ui-resources/templates
```

No additional deployment steps are needed.

## Troubleshooting

### UI doesn't render

1. **Check Claude Desktop version**: Must be 0.8.0+
2. **Verify tool returns HTML**: Check the `content[].mimeType` is `'text/html'`
3. **Check browser console**: Open test HTML files to see JavaScript errors

### Blank/broken UI

1. **Verify data structure**: Each UI expects specific data shapes
2. **Check CDN access**: D3.js, Chart.js, Diff.js must be accessible
3. **Test in browser**: Save HTML to file and open directly

### Performance issues

1. **Limit data size**: Graph with >500 nodes may be slow
2. **Paginate snapshots**: Use `limit` parameter on `list_snapshots`
3. **Reduce animation**: Consider static charts for large datasets

## Next Steps

1. ✅ All 4 UIs integrated
2. ✅ Test in Claude Desktop
3. 📝 Update Rembr documentation
4. 📝 Create launch announcement
5. 📝 Update ClawHub skill

## Support

- **MCP Apps Spec**: https://spec.modelcontextprotocol.io/extensions/ui-apps/
- **Rembr Docs**: https://docs.rembr.ai
- **Issues**: https://github.com/radicalgeek/rembr/issues
