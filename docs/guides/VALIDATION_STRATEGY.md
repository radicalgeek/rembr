# MCP Tool Input Validation Strategy

**REM-248** — Closes the attack surface exposed by 49 MCP tool entry points.

---

## Overview

Every MCP tool call passes through a single validation gate before any business logic executes. This document explains the architecture, coverage, and extension guide.

## Architecture

```
Client → MCP transport → index-http.ts (tool handler)
                              │
                              ▼
                     sanitizeArgs()          ← UUID field pre-sanitisation
                              │
                              ▼
                     validateToolInput()     ← Zod schema parse + sanitise
                              │
                    ┌─────────┴──────────┐
                  success               failure
                    │                     │
                    ▼                     ▼
             handler (uses          reject with
             validated args)        structured error
```

### `sanitizeArgs` (pre-pass)

Runs before Zod validation. Strips dangerous characters from known UUID fields to prevent SQL injection attempts from bypassing UUID validation. Operates on a fixed allow-list of field names (`id`, `memory_id`, `context_id`, etc.).

### `validateToolInput` (primary gate)

Located in `rembr-mcp/src/schemas.ts`. Looks up the tool's Zod schema by name, calls `safeParse`, and returns either validated+sanitised data or a structured error. Validation errors are returned to the client as `isError: true` responses and tracked in metrics.

---

## Coverage

All 49 tool entry points are covered:

| # | Tool | Notes |
|---|------|-------|
| 1–46 | store_memory … get_storage_usage | Original coverage (RAD-46) |
| 47 | `explore_relationships` | REM-248: depth clamped 1–3, UUID validated, relationship_types bounded |
| 48 | `ingest_document` | REM-248: chunk_size bounded 200–5000, content sanitised |
| 49 | `pii` | REM-248: operation enum, text required for detect/redact, UUID for audit |

---

## Validation Layers

### Layer 1 — Type & Format
- UUIDs: strict regex `^[0-9a-f]{8}-[0-9a-f]{4}-...$`
- Dates: `new Date(v).getTime()` not-NaN check (ISO 8601 compatible)
- Enums: exhaustive `z.enum([...])` — unknown values fail hard

### Layer 2 — Bounds
- String lengths: `safeString(maxLen)` prevents large-payload attacks
  - Names / labels: 500 chars
  - Descriptions: 5,000 chars
  - Content bodies: 100,000 chars
  - Query strings: 2,000 chars
- Pagination: `paginationLimit(max, default)` — positive integer, bounded max
- Scores: `score01` — number in [0, 1]
- Depths / hops: `z.number().int().min(1).max(3)` (graph traversal)

### Layer 3 — Sanitisation
All text fields pass through `sanitiseText()`:
- Strips HTML tags (`<[^>]*>`)
- Replaces common SQL injection fragments (`DROP TABLE`, `DELETE FROM`, etc.) with `[FILTERED]`
- Removes null bytes (`\0`)

Note: the database layer also uses parameterised queries, so this is defence-in-depth, not the primary SQL injection guard.

### Layer 4 — Cross-field Refinement
Some tools use `superRefine` or `refine` for multi-field logic:
- `create_snapshot`: requires at least one of `memory_ids`, `context_ids`, or `query`
- `search_at_time`: requires `as_of_time` or `timestamp`
- `create_temporal_snapshot`: requires `snapshot_name` or `name`
- `pii`: requires `text` when `operation` is `detect` or `redact`

---

## Adding a New Tool

1. **Define the schema** in `schemas.ts` following existing patterns:

```typescript
// N. my_new_tool
const myNewToolSchema = z.object({
  id: uuid,                              // UUID fields use the shared uuid validator
  query: safeString(2000),               // Text fields use safeString(maxLen)
  limit: paginationLimit(100, 10),       // Pagination uses paginationLimit
  options: safeMetadata                  // Free-form objects use safeMetadata
});
```

2. **Register it** in `toolSchemas`:

```typescript
export const toolSchemas: Record<string, z.ZodTypeAny> = {
  // ... existing tools ...
  my_new_tool: myNewToolSchema
};
```

3. **Write tests** in `schemas.test.ts`:
   - Happy path with minimal and full inputs
   - Missing required fields
   - Boundary values (min, max, edge)
   - Injection payloads (HTML, SQL)
   - Invalid types (string where number expected, etc.)

---

## Security Considerations

### What this protects against
- **Injection attacks**: HTML stripping + SQL fragment filtering + parameterised queries
- **Oversized payloads**: `safeContent` limit of 100KB prevents memory exhaustion
- **Type confusion**: Zod rejects unexpected types before they reach handlers
- **Enum abuse**: Strict enum validation prevents operation escalation (e.g. `pii.operation`)
- **UUID injection**: UUID regex rejects non-UUID values before DB queries

### What this does NOT protect against
- **Authenticated abuse**: A valid API key can still call any tool it has access to. Rate limiting (`rate-limiter.ts`) is the primary defence here.
- **Semantic attacks**: A valid query string can still trigger expensive vector searches. Rate limiting + cost controls apply.
- **Content-level attacks**: Malicious content stored via `store_memory` is sanitised at ingestion, but downstream consumers must also handle untrusted content safely.

---

## Related Files

- `rembr-mcp/src/schemas.ts` — Zod schemas + `validateToolInput`
- `rembr-mcp/src/schemas.test.ts` — Unit tests
- `rembr-mcp/src/index-http.ts` — Validation gate call site (line ~2379)
- `rembr-mcp/src/rate-limiter.ts` — Complementary rate-limiting defence
