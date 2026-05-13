# MCP Apps SDK Setup & Base Templates

**Status:** ✅ Complete  
**Task:** REM-49 / RAD-33  
**Dependencies Installed:**
- `@modelcontextprotocol/ext-apps@^1.0.1`
- `@mcp-ui/server@^6.1.0`

## Overview

This setup provides the foundation for building interactive UIs in Rembr MCP tools. Two SDKs are available:

1. **@modelcontextprotocol/ext-apps** - Official MCP Apps extension for resource registration
2. **@mcp-ui/server** - Helper SDK for creating standardized UI resources

## What's Included

### Base Template System

- **`templates/base.html`** - Rembr-branded HTML template with:
  - Dark theme with CSS custom properties
  - Responsive design
  - Rembr logo and branding
  - Common UI components (cards, buttons, badges, loading spinner)
  - Placeholder slots for custom content

- **`index.ts`** - Core utilities:
  - `renderTemplate()` - Render content into base template
  - `createRembrUIResource()` - Wrap HTML in MCP UI resource format
  - `createDualFormatResponse()` - Return both JSON and HTML
  - Constants for common script/style includes (D3.js, Chart.js, Diff.js)

### Demo UI

- **`demo-ui.ts`** - Interactive demo showcasing:
  - Template usage
  - Interactive JavaScript
  - Data binding
  - Theme toggling
  - Rembr component library

- **`demo-ui.test.ts`** - Test coverage for demo UI

### Integration Examples

- **`ui-server-setup.ts`** - Complete integration guide with:
  - Simple HTML return examples (recommended)
  - Dual-format response examples
  - Resource URI registration (advanced)
  - Best practices
  - Testing strategies

## Two Integration Approaches

### Approach 1: Simple HTML Return (Recommended)

Return HTML directly from tool responses. This is what Rembr currently uses.

**Example:**

```typescript
import { renderMemoryGraph } from './ui-resources/memory-graph.js';

case 'generate_context_graph': {
  const graph = await analyticsService.generateContextGraph(tenantId);
  
  return {
    content: [{
      type: 'text',
      text: renderMemoryGraph(graph),
      mimeType: 'text/html'
    }]
  };
}
```

**Advantages:**
- Simple and straightforward
- No resource registration needed
- Easy to test
- Works immediately

### Approach 2: Resource URI Registration (Advanced)

Register UI resources with explicit URIs using `@modelcontextprotocol/ext-apps`.

**Example:**

```typescript
import { registerAppResource } from '@modelcontextprotocol/ext-apps/server';

registerAppResource(
  server,
  'Memory Graph',
  'ui://rembr/memory-graph',
  {
    description: 'Interactive force-directed visualization',
    mimeType: 'text/html',
    _meta: { ui: { csp: { ... } } }
  },
  async (uri) => ({
    contents: [{
      uri,
      mimeType: 'text/html',
      text: renderMemoryGraph(data)
    }]
  })
);
```

**Advantages:**
- Better separation of concerns
- Client-side caching
- CSP configuration support

## Using @mcp-ui/server

The `@mcp-ui/server` package provides helpers for creating UI resources:

```typescript
import { createRembrUIResource } from './ui-resources/index.js';

const uiResource = createRembrUIResource(html);

return {
  content: [uiResource]
};
```

This wraps your HTML in the standard MCP UI resource format.

## Existing Interactive UIs

Rembr already has 5 interactive UIs implemented:

1. **Memory Graph** (`memory-graph.ts`) - D3.js force-directed visualization
2. **Contradiction Dashboard** (`contradiction-dashboard.ts`) - Side-by-side comparison
3. **Analytics Dashboard** (`analytics-dashboard.ts`) - Chart.js analytics
4. **Snapshot Timeline** (`snapshot-timeline.ts`) - Temporal visualization
5. **Context Diff Viewer** (`context-diff-viewer.ts`) - Diff comparison
6. **Demo UI** (`demo-ui.ts`) - Interactive demo (NEW)

All use Approach 1 (Simple HTML Return).

## Testing

### In Claude Desktop (Recommended)

1. Install Claude Desktop 0.8.0+
2. Configure Rembr MCP server in settings
3. Call a tool that returns UI:
   ```
   Can you generate a context graph?
   ```
4. See the interactive UI render in conversation

### In Browser (Development)

Save HTML to file and open in browser:

```bash
cd rembr-mcp
npm run build

node -e "
const { renderDemoUI } = require('./dist/ui-resources/demo-ui.js');
const fs = require('fs');
fs.writeFileSync('demo.html', renderDemoUI());
console.log('Saved to demo.html');
"

# Open demo.html in browser
```

### In VS Code (Future)

When VS Code MCP Apps extension is available, UIs will render inline in Copilot chat.

## Adding a New Interactive UI

1. **Create renderer** in `ui-resources/your-ui.ts`:

```typescript
import { renderTemplate } from './index.js';

export function renderYourUI(data: YourData): string {
  const content = `
    <div class="rembr-card">
      <div class="rembr-card-title">Your UI Title</div>
      <!-- Your HTML here -->
    </div>
  `;

  return renderTemplate({
    title: 'Your UI',
    subtitle: 'Description',
    content,
    extraScripts: '<script>/* Your JS here */</script>'
  });
}
```

2. **Add tests** in `ui-resources/your-ui.test.ts`

3. **Use in tool handler** (`index-http.ts`):

```typescript
import { renderYourUI } from './ui-resources/your-ui.js';

case 'your_tool': {
  const data = await yourService.getData();
  return {
    content: [
      { type: 'text', text: JSON.stringify(data, null, 2) },
      { type: 'text', text: renderYourUI(data), mimeType: 'text/html' }
    ]
  };
}
```

## Security

- **Always escape user content**: Use `escapeHtml()` helper
- **CSP-compliant**: Inline scripts are OK for MCP Apps
- **External libraries**: Use trusted CDNs (D3.js, Chart.js, etc.)

## Documentation

- **MCP Apps Spec**: https://spec.modelcontextprotocol.io/extensions/ui-apps/
- **@mcp-ui/server**: https://www.npmjs.com/package/@mcp-ui/server
- **Rembr Integration Guide**: `MCP-APPS-INTEGRATION.md`
- **UI Server Setup Examples**: `ui-server-setup.ts`

## Next Steps

1. ✅ SDKs installed
2. ✅ Base templates created
3. ✅ Demo UI implemented
4. ✅ Integration examples documented
5. 📝 Test in Claude Desktop (manual)
6. 📝 Update Rembr documentation
7. 📝 Add more interactive UIs as needed

## Acceptance Criteria

- [x] `@modelcontextprotocol/ext-apps@latest` installed
- [x] `@mcp-ui/server@latest` installed
- [x] `src/ui-resources/` directory structure complete
- [x] Base HTML template with Rembr branding
- [x] UI resource system documented and ready to use
- [ ] Tested in Claude Desktop or VS Code (manual verification needed)

All prerequisites for interactive UI issues (RAD-11, 12, 13, 14) are now complete.
