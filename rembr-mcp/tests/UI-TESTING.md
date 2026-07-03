# UI Testing for MCP Apps

This directory contains automated tests for the 4 interactive UIs in Rembr's MCP Apps implementation.

## Prerequisites

### Headless Testing (Linux servers without display)

Playwright tests require either a real X11 display or xvfb (X Virtual Framebuffer).

**Install xvfb:**
```bash
# Debian/Ubuntu
sudo apt-get update && sudo apt-get install -y xvfb

# Fedora/RHEL
sudo dnf install -y xorg-x11-server-Xvfb

# Arch
sudo pacman -S xorg-server-xvfb
```

**Verify installation:**
```bash
which xvfb-run  # Should output: /usr/bin/xvfb-run
```

## Test Types

### Unit Tests (Vitest)

Located in `src/ui-resources/*.test.ts`

**What they test:**
- HTML generation from data structures
- Template variable substitution
- Content rendering
- Filter controls presence
- Metrics display
- Export buttons

**Run:**
```bash
npm test -- ui-resources
```

**Coverage:**
- `memory-graph.test.ts` - 10 tests
- `contradiction-dashboard.test.ts` - 9 tests
- `analytics-dashboard.test.ts` - 9 tests
- `snapshot-timeline.test.ts` - 9 tests

**Total: 37 unit tests**

### Browser Automation Tests (Playwright)

Located in `tests/e2e/ui-resources/*.spec.ts`

**What they test:**
- Interactive features (zoom, pan, drag)
- D3.js graph rendering
- Chart.js chart rendering
- Filter interactions
- Button clicks and modal dialogs
- Export functionality

**Run:**
```bash
npm run test:e2e
```

**Run with UI:**
```bash
npm run test:e2e:ui
```

**Coverage:**
- `memory-graph.spec.ts` - 8 browser tests (D3.js force-directed graph)
- `contradiction-dashboard.spec.ts` - 9 browser tests (filters, resolution actions)
- `analytics-dashboard.spec.ts` - 11 browser tests (Chart.js, growth forecasts, risk panels)
- `snapshot-timeline.spec.ts` - 12 browser tests (D3.js timeline, comparison modal)

**Total: 40 browser automation tests**

## Test Data

All tests use mock data structures matching the actual MCP tool responses:

- **GraphData** - Nodes, edges, clusters, metrics
- **ContradictionData** - Contradicting memory pairs with confidence/severity
- **PredictiveAnalyticsData** - Growth forecasts, quality risk
- **SnapshotTimelineData** - Snapshot history with token counts

## Running All Tests

```bash
# Unit tests only
npm test

# Browser tests (requires display or xvfb)
npm run test:e2e

# Browser tests with xvfb (headless Linux servers)
npm run test:e2e:headless

# All tests (run separately)
npm test && npm run test:e2e:headless
```

## Headless Testing Script

The `test:e2e:headless` script uses xvfb-run with optimal settings:

```bash
xvfb-run --auto-servernum --server-args='-screen 0 1920x1080x24' playwright test
```

**Options explained:**
- `--auto-servernum` - Automatically picks available X display number
- `--server-args='-screen 0 1920x1080x24'` - Creates 1920x1080 virtual display with 24-bit color
- Prevents "DISPLAY not set" errors
- No manual X server management required

## CI/CD Integration

Unit tests run on every commit via GitLab CI.

Browser tests can be added to CI by:
1. Installing Playwright browsers in Docker image
2. Adding `npm run test:e2e` step to `.gitlab-ci.yml`

## Test Philosophy

**Unit tests** verify:
- Correct HTML structure
- Data embedding
- Template rendering
- No regression in output format

**Browser tests** verify:
- Real browser behavior
- D3.js/Chart.js rendering
- User interactions (clicks, filters, zoom)
- DOM updates after actions

## Future Work

- [ ] Add visual regression tests (Percy, Chromatic)
- [ ] Add accessibility tests (axe-core)
- [ ] Add performance benchmarks (Lighthouse)
- [ ] Add cross-browser testing (Firefox, Safari)

## Debugging

**Unit tests:**
```bash
npm run test:watch  # Watch mode
npm run test:ui     # Vitest UI
```

**Browser tests:**
```bash
npm run test:e2e:ui              # Playwright UI (interactive)
npx playwright test --debug      # Debug mode
npx playwright show-report       # View HTML report
```

**Generate HTML locally:**
```bash
node -e "
const { renderMemoryGraph } = require('./dist/ui-resources/memory-graph.js');
const fs = require('fs');
const testData = { /* ... */ };
fs.writeFileSync('test.html', renderMemoryGraph(testData));
"
```

Then open `test.html` in a browser.

---

**Implementation**: REM-119, REM-121 | **Date**: February 2026 | **Status**: Complete (all 4 UIs)
