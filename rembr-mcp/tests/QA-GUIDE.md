# QA Guide — Rembr MCP (REM-45)

## Test Layers

| Layer | Location | Runs in CI | Requires |
|-------|----------|-----------|---------|
| Unit tests | `src/*.test.ts` | ✅ Yes | Nothing |
| QA validation | `src/qa-validation.test.ts` | ✅ Yes | Nothing |
| Integration tests | `tests/integration/*.integration.test.ts` | ❌ No (opt-in) | Database |
| Performance benchmarks | `tests/performance/benchmark.ts` | ❌ No (manual) | Database |
| E2E (UI) | `tests/e2e/` | ❌ No | Playwright + running server |

## Running Tests

```bash
# All CI tests (unit + QA validation)
cd rembr-mcp && npm test

# Integration tests (requires TEST_DATABASE_URL)
SKIP_INTEGRATION=false TEST_DATABASE_URL=postgresql://... npm test

# Performance benchmarks
TEST_DATABASE_URL=postgresql://... npx tsx tests/performance/benchmark.ts
```

## Performance Targets

| Operation | p50 target | p95 target |
|-----------|-----------|-----------|
| store_memory | < 200ms | < 500ms |
| search_memory (text) | < 300ms | < 800ms |
| search_memory (phrase) | < 300ms | < 800ms |
| get_stats | < 100ms | < 300ms |

## Key Acceptance Criteria

### Memory CRUD
- ✅ store, search, update, delete all work
- ✅ Metadata preserved round-trip
- ✅ Tenant isolation enforced

### PII (REM-50/51)
- ✅ Auto-scan on store_memory
- ✅ Auto-scan on update_memory
- ✅ exclude_pii filter on search
- ✅ Plan-tier gating: Free blocked from compliance_report + batch_scan
- ✅ Sensitivity clamped to plan maximum

### Rate Limiting (REM-48/272)
- ✅ Per-minute transport limiting (credential-based)
- ✅ Per-tenant daily quotas (1K / 100K / 1M / 10M by plan)
- ✅ X-RateLimit-* headers on all authenticated responses
- ✅ 429 with Retry-After on exceeded limits
- ✅ Fail-open on Redis unavailability

### Load
- ✅ 10 concurrent store_memory requests
- ✅ 10 concurrent search_memory requests
- ✅ Mixed concurrent operations without errors
