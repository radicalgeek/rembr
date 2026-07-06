# MCP Server Refactor Plan (REM-262)

`index-http.ts` is a ~7,400-line single-file monolith (as of 2026-06). This document
tracks the phased extraction into focused, testable modules.

## Why this matters

- **Reliability:** a single compilation error or import failure takes down all routes
- **Maintainability:** tool handler logic, auth, and HTTP routing are interleaved
- **Testability:** unit-testing a `case 'store_memory':` inside a 4,500-line class is impractical
- **Merge conflicts:** near-daily conflicts on a single file in a multi-agent team

## Target structure

```
rembr-mcp/src/
  index-http.ts            ← thin orchestrator: wires routes + starts server
  routes/
    admin.ts               ✅ DONE (Phase 1) — optimization, embeddings, backfill
    mcp.ts                 ← Phase 2: POST/GET/DELETE /mcp session handling
  handlers/
    tool-dispatch.ts       ← Phase 3: switch(toolName) → delegate to handlers
    memory-tools.ts        ← Phase 4: store_memory, get_memory, search_memory …
    graph-tools.ts         ← Phase 4: graph.get, graph.explore, infer_relationships …
    context-tools.ts       ← Phase 4: context management tools
    snapshot-tools.ts      ← Phase 4: snapshot operations
    analytics-tools.ts     ← Phase 4: contradictions, causality, temporal, audit
    admin-tools.ts         ← Phase 4: classify, stats, insights
  middleware/
    auth.ts                ← Phase 5: authenticate() extracted from index-http.ts
    rate-limiter.ts        ✅ DONE (REM-272) — already extracted
```

## Phase plan

### Phase 1 — Admin routes ✅ COMPLETE
Extracted: `routes/admin.ts`
- POST `/admin/optimize/:tenantId?`
- GET `/admin/optimize/status`
- POST `/admin/embeddings/:tenantId`
- POST `/admin/backfill-relationships/:tenantId` (pending REM-270 merge)

Risk: **low** — routes have no session state dependency.

### Phase 2 — MCP routes
Extract: `routes/mcp.ts`

> Updated 2026-06: the stateless protocol migration removed all session handling
> (see `MCP-2026-07-28-MIGRATION.md`). GET/DELETE `/mcp` now return 405 and
> `/mcp/start-auth/:sessionId` returns 410 Gone — there is no session store or
> session lifecycle left to extract, which makes this phase simpler than planned.

- POST `/mcp` — per-request stateless server creation, auth, tool dispatch entry point
- The trivial 405/410 handlers for GET/DELETE `/mcp` and `/mcp/start-auth`

Dependencies needed in context: auth, tool dispatch, embedding provider.
Risk: **low-medium** — auth already lives in `unified-auth-middleware.ts`; mostly route plumbing.

### Phase 3 — Tool dispatch
Extract: `handlers/tool-dispatch.ts`
- The giant `switch(toolName)` becomes a router that delegates to handler files
- Each handler file is independently testable
- Legacy tool routing stays in `tools/tool-router.ts` (already exists)

Risk: **medium** — many implicit dependencies on `tenantId`, `projectId`, services.
Mitigation: pass a `ToolContext` object with all dependencies.

### Phase 4 — Individual tool handlers
One file per logical group (see target structure above).
Risk: **low per file** once Phase 3 context object is established.

### Phase 5 — Auth middleware
Extract `authenticate()` from the 120-line private method in index-http.ts.
Risk: **low** — pure function (Request → AuthResult).

> Updated 2026-06: substantially done. Auth logic now lives in
> `unified-auth-middleware.ts` (`authenticateRequest()`, with unit tests);
> `index-http.ts` retains only a thin adapter method.

## Conventions

- Each module exports a factory function taking a deps object (no class methods)
- No circular imports: routes → handlers → services, never the reverse
- All extracted modules should have vitest unit tests

## Status

| Phase | Status | MR |
|-------|--------|----|
| 1 — Admin routes | ✅ merged | !XX |
| 2 — MCP routes | ⬜ not started (simplified by stateless migration) | — |
| 3 — Tool dispatch | ⬜ not started | — |
| 4 — Tool handlers | ⬜ not started | — |
| 5 — Auth middleware | ✅ done via `unified-auth-middleware.ts` (thin adapter remains in index-http.ts) | — |
