# Rembr UI Resources

Interactive user interfaces for MCP tools using the MCP Apps SDK.

**Rembr is the first memory service with interactive visualizations** powered by MCP Apps.

## Overview

This directory contains 5 interactive UIs that provide rich visualizations for Rembr's MCP tools. Each UI is built using the `@modelcontextprotocol/ext-apps` SDK and follows a consistent design pattern.

## Available UIs

| UI | File | MCP Tool | Status |
|----|------|----------|--------|
| **Memory Graph** | `memory-graph.ts` | `generate_context_graph` | ✅ Complete |
| **Contradiction Dashboard** | `contradiction-dashboard.ts` | `detect_memory_contradictions` | ✅ Complete |
| **Predictive Analytics** | `analytics-dashboard.ts` | `generate_predictive_analytics` | ✅ Complete |
| **Snapshot Timeline** | `snapshot-timeline.ts` | `list_snapshots` | ✅ Complete |
| **Context Diff Viewer** | `context-diff-viewer.ts` | `compare_snapshots` | ✅ Complete |

## Structure

```
ui-resources/
├── index.ts                        # Core utilities and base template rendering
├── templates/
│   └── base.html                  # Base HTML template with Rembr branding
├── memory-graph.ts                # Force-directed graph visualization (D3.js)
├── contradiction-dashboard.ts     # Side-by-side memory comparison
├── analytics-dashboard.ts         # Growth forecasts and insights (Chart.js)
├── snapshot-timeline.ts           # Temporal context timeline (D3.js)
├── context-diff-viewer.ts         # Snapshot comparison diff viewer (REM-52)
├── MCP-APPS-INTEGRATION.md       # Complete integration guide
└── integration-guide.md          # Original memory-graph integration guide
```

## Quick Start

### 1. Import UI Renderer

```typescript
import { renderMemoryGraph } from './ui-resources/memory-graph.js';
```

### 2. Return HTML from Tool

```typescript
case 'generate_context_graph': {
  const graph = await analyticsService.generateContextGraph(...);
  
  return {
    content: [{
      type: 'text',
      text: renderMemoryGraph(graph),
      mimeType: 'text/html'
    }]
  };
}
```

### 3. Test in Claude Desktop

Call the tool from Claude Desktop (v0.8.0+) and the interactive UI will render.

## UI Features

### Memory Graph 🎨

**Features:**
- Force-directed physics layout using D3.js
- Color-coded nodes by category (13 categories)
- Edge thickness shows relationship strength
- Zoom/pan controls with reset
- Click nodes for full details
- Filter by category or edge type (4 types)
- Export to PNG/SVG
- Real-time metrics (nodes, edges, density, clustering)

**Data Structure:**
```typescript
{
  nodes: GraphNode[];        // id, label, content, category, size, color, created_at, metadata
  edges: GraphEdge[];        // source, target, weight, type, label
  clusters: GraphCluster[];  // id, nodes[], theme, coherence, description
  metrics: GraphMetrics;     // density, clustering, connected components
}
```

### Contradiction Dashboard ⚠️

**Features:**
- Side-by-side memory comparison
- Confidence meter (color-coded: green >80%, yellow 60-80%, red <60%)
- Explanation of why memories contradict
- One-click resolution (Keep A, Keep B, Merge, Ignore)
- Filter by type (factual, temporal, logical, preference)
- Filter by severity (high, medium, low)
- Minimum confidence slider
- Real-time statistics (by type, severity, avg confidence)
- Resolution suggestions displayed

**Data Structure:**
```typescript
{
  contradictions: ContradictionResult[];
  // memory_a, memory_b with full content
  // contradiction_type, severity, confidence
  // explanation, resolution_suggestions
}
```

### Predictive Analytics 📊

**Features:**
- 30-day memory growth forecast (Chart.js line chart)
- Category usage distribution (Chart.js doughnut chart)
- Relationship formation likelihood gauge
- Quality degradation risk panel (factors + recommendations)
- Dynamic insights (growth alerts, seasonal patterns, category concentration)
- Seasonal variation detection
- Top-level metrics cards (growth rate, relationship likelihood, risk level)

**Data Structure:**
```typescript
{
  memory_growth_prediction: { next_30_days, growth_rate, seasonal_patterns };
  category_usage_prediction: Record<category, percentage>;
  relationship_formation_likelihood: number; // 0.0-1.0
  quality_degradation_risk: { risk_level, risk_factors[], recommendations[] };
}
```

### Snapshot Timeline 📸

**Features:**
- D3.js timeline visualization (token trend chart, clickable points)
- Vertical timeline with markers and connecting lines
- Expandable snapshot cards (slide-down animation)
- Memory previews with relevance scores & category badges
- Comparison mode (select 2 snapshots, side-by-side modal)
- Delta summary (memory count, token count changes)
- Expiration badges for expired snapshots
- Statistics dashboard (totals + averages)

**Data Structure:**
```typescript
{
  snapshots: Snapshot[];
  // id, name, description, memory_count, token_count
  // created_at, expires_at
  // memories[] (optional with content, category, relevance_score)
}
```

### Context Diff Viewer 🔍 (REM-52)

**Features:**
- Side-by-side snapshot comparison with visual diff highlighting
- Summary statistics (added, removed, modified counts)
- Inline word-level diff highlighting (added in green, removed in red)
- Filter by change type (added/removed/modified)
- Search within diff results
- Export to JSON/CSV
- Metadata expansion for detailed inspection
- Empty state for identical snapshots

**Data Structure:**
```typescript
{
  timeA: Date;          // First snapshot timestamp
  timeB: Date;          // Second snapshot timestamp
  added: number;        // Count of added memories
  removed: number;      // Count of removed memories
  modified: number;     // Count of modified memories
  details: {
    added: Memory[];    // Memories added in snapshot B
    removed: Memory[];  // Memories removed from snapshot A
    modified: Array<{ before: Memory; after: Memory }>; // Modified memories
  };
}
```

**Use Cases:**
- Compare temporal snapshots to understand context evolution
- Track memory changes over time
- Identify when specific memories were added/removed/modified
- Export diff reports for external analysis
- Verify data integrity across snapshots

## Base Template

The `base.html` template provides:

- **Consistent branding** - Rembr color scheme (indigo/purple), dark theme
- **Responsive layout** - Works on desktop and mobile
- **Reusable components** - Buttons, cards, badges, loading states
- **Header/footer** - Logo, navigation, footer links

### Template Variables

```typescript
renderTemplate({
  title: string;           // Page title
  subtitle: string;        // Subtitle shown in header
  content: string;         // Main content area (HTML)
  extraHead?: string;      // Additional head content (styles, scripts)
  headerActions?: string;  // Header action buttons
  extraScripts?: string;   // Scripts loaded at end of body
})
```

### CSS Variables

```css
--rembr-primary: #6366f1;      /* Indigo */
--rembr-secondary: #8b5cf6;    /* Purple */
--rembr-accent: #ec4899;       /* Pink */
--rembr-success: #10b981;      /* Green */
--rembr-warning: #f59e0b;      /* Amber */
--rembr-error: #ef4444;        /* Red */
--rembr-info: #3b82f6;         /* Blue */
--rembr-bg: #0f172a;           /* Dark background */
--rembr-bg-secondary: #1e293b; /* Secondary background */
--rembr-text: #f8fafc;         /* Light text */
--rembr-text-secondary: #cbd5e1; /* Secondary text */
--rembr-border: #334155;       /* Border color */
```

### Common Libraries

The `SCRIPT_INCLUDES` constant provides CDN links:

```typescript
import { SCRIPT_INCLUDES } from './index.js';

// Individual libraries
extraHead: SCRIPT_INCLUDES.d3        // D3.js v7
extraHead: SCRIPT_INCLUDES.chartjs   // Chart.js v4
extraHead: SCRIPT_INCLUDES.diff      // Diff.js (for comparisons)

// All libraries
extraHead: SCRIPT_INCLUDES.all
```

## Integration

See `MCP-APPS-INTEGRATION.md` for complete integration guide with:
- Tool-to-UI mapping
- Resource registration (advanced)
- Client capability detection
- Security considerations
- Troubleshooting

## Testing

### In Claude Desktop (Recommended)

1. Install Claude Desktop 0.8.0+
2. Configure Rembr MCP server
3. Call a tool (e.g., "Show me my memory graph")
4. Interactive UI renders in conversation

### Browser Testing (Development)

```bash
cd rembr-mcp
node -e "
const { renderMemoryGraph } = require('./dist/ui-resources/memory-graph.js');
const fs = require('fs');
const testData = { /* ... */ };
fs.writeFileSync('test.html', renderMemoryGraph(testData));
console.log('Open test.html in browser');
"
```

## Implementation Timeline

All UIs completed in one session (Feb 7-8, 2026):

- ✅ RAD-174: SDK Installation & Setup
- ✅ RAD-169: Interactive Memory Graph
- ✅ RAD-170: Contradiction Detection Dashboard
- ✅ RAD-171: Predictive Analytics Dashboard
- ✅ RAD-172: Context Snapshot Timeline
- ✅ RAD-173: Documentation & Launch

**Total development time**: ~2.5 hours for 4 UIs (~1,900 lines of TypeScript)

## Resources

- **MCP Apps Spec**: https://spec.modelcontextprotocol.io/extensions/ui-apps/
- **Integration Guide**: `MCP-APPS-INTEGRATION.md`
- **Launch Announcement**: `../../docs/LAUNCH-MCP-APPS.md`
- **D3.js Docs**: https://d3js.org/
- **Chart.js Docs**: https://www.chartjs.org/
- **Rembr Master Plan**: `../../docs/MASTER-IMPLEMENTATION-PLAN.md`
