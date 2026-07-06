# Ollama Embedding Service Resilience Strategy

**REM-246: Ollama Embedding Service SPOF Mitigation**

## Overview

Rembr uses Ollama (`nomic-embed-text`, 768 dimensions) for semantic memory embeddings. Ollama is deployed as a local/cluster-internal service with no built-in high availability. To prevent it from becoming a hard single point of failure (SPOF), the `OllamaClient` implements a multi-layered resilience strategy.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Memory Store Request                     │
└───────────────────────────┬─────────────────────────────────┘
                            │
                            ▼
                  ┌─────────────────────┐
                  │  OllamaClient       │
                  │  (Singleton)        │
                  └──────────┬──────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
              ▼              ▼              ▼
      ┌──────────┐   ┌──────────┐   ┌──────────┐
      │ Redis    │   │ Circuit  │   │ Retry    │
      │ Cache    │   │ Breaker  │   │ Logic    │
      │ (24h TTL)│   │          │   │          │
      └────┬─────┘   └────┬─────┘   └────┬─────┘
           │              │              │
           │ miss         │ open?        │ exhausted?
           ▼              ▼              ▼
      ┌─────────────────────────────────────┐
      │   Ollama Embedding API              │
      │   (nomic-embed-text)                │
      │   http://ollama.ai.svc.cluster:11434│
      └─────────────────────────────────────┘
                         │
                         │ failure after retries
                         ▼
                  ┌──────────────┐
                  │   Fallback   │
                  │ Zero Vector  │
                  │ (optional)   │
                  └──────────────┘
```

## Resilience Layers

### 1. **Redis Embedding Cache (L1 Defense)**

- **Purpose:** Reduces Ollama load, provides immediate response for seen content
- **Key format:** `embedding:{model}:{sha256(text)}`
- **TTL:** 24 hours
- **Fallback:** 1000-entry LRU in-memory cache if Redis unavailable
- **Hit rate:** ~60-80% for typical workloads (identical memory retrieval)

**Impact:** Most embedding requests never hit Ollama.

---

### 2. **Request Timeout (L2 Defense)**

- **Embedding timeout:** 30 seconds
- **Text generation timeout:** 60 seconds
- **Behavior:** Request aborted if Ollama hangs or takes too long

**Impact:** Prevents indefinite hangs when Ollama is unhealthy.

---

### 3. **Exponential Backoff Retry (L3 Defense)**

- **Max retries:** 3 (configurable via `OLLAMA_MAX_RETRIES`)
- **Base delay:** 500 ms
- **Max delay:** 10 seconds
- **Jitter:** ±25% random jitter to prevent thundering herd
- **Retryable errors:**
  - Connection refused (ECONNREFUSED)
  - HTTP 503 (Service Unavailable)
  - Timeout
  - Network errors

**Impact:** Transient network blips or Ollama restarts are automatically retried.

**Example backoff schedule:**
```
Attempt 1: immediate
Attempt 2: ~500ms  (base * 2^0 + jitter)
Attempt 3: ~1000ms (base * 2^1 + jitter)
Attempt 4: ~2000ms (base * 2^2 + jitter)
```

---

### 4. **Circuit Breaker (L4 Defense)**

- **Threshold:** 5 consecutive failures
- **State:** Open (fail-fast) for 30 seconds after threshold
- **Reset:** Automatically closes after 30s cooldown
- **Per-instance:** Circuit state is not shared across pods

**Behavior:**
- **Closed (normal):** All requests attempt Ollama call
- **Open (degraded):** All requests skip Ollama and either:
  - Return zero vector (if fallback enabled)
  - Throw immediately (if fallback disabled)

**Impact:** When Ollama is completely down, stops hammering it with requests and gives it time to recover.

---

### 5. **Graceful Degradation: Zero Vector Fallback (L5 Defense)**

**Enabled via:** `OLLAMA_FALLBACK_EMBEDDING=zero`

**Behavior when all retries fail:**
- Returns a 768-dimensional zero vector `[0, 0, 0, ..., 0]`
- Memory is still stored with all metadata intact
- Content is searchable via fuzzy text search (pg_trgm)
- Semantic similarity will score near-zero (no false positives)

**Trade-offs:**
- ✅ **Pro:** System remains operational; memories are not lost
- ✅ **Pro:** pg_trgm full-text search still works
- ✅ **Pro:** Errors are logged but don't cascade
- ⚠️ **Con:** Semantic search returns no results for zero-vector memories
- ⚠️ **Con:** Relationship inference skips zero-vector memories

**Use case:** Production environments where uptime > semantic accuracy during outages.

**Warning visibility:** All fallback activations log at WARN level:
```
[OllamaClient] All retries failed. Returning zero vector (fallback mode).
Last error: connect ECONNREFUSED
```

---

### 6. **Health Check Endpoint (L6 Defense)**

**Method:** `OllamaClient.isAvailable()`

**Usage:**
- Kubernetes liveness/readiness probes
- Admin dashboard health status
- Pre-flight checks before batch operations

**Implementation:**
- Lightweight `/api/tags` call to Ollama
- 5-second timeout
- Returns `true` if Ollama responds, `false` otherwise

---

## Configuration

### Environment Variables

| Variable                      | Default                                 | Description                                  |
|-------------------------------|-----------------------------------------|----------------------------------------------|
| `OLLAMA_HOST`                 | `http://ollama.ai.svc.cluster:11434`    | Ollama base URL                              |
| `OLLAMA_EMBEDDING_MODEL`      | `nomic-embed-text`                      | Embedding model name                         |
| `OLLAMA_TEXT_MODEL`           | `llama3.1:8b`                           | Text generation model                        |
| `OLLAMA_MAX_RETRIES`          | `3`                                     | Retry attempts before fallback               |
| `OLLAMA_FALLBACK_EMBEDDING`   | (unset)                                 | Set to `zero` to enable zero-vector fallback |

### Example: Enable Zero Vector Fallback

```bash
# docker-compose.yml or Kubernetes deployment
environment:
  - OLLAMA_FALLBACK_EMBEDDING=zero
```

---

## Operational Scenarios

### Scenario 1: Ollama Temporarily Unavailable (< 5 min)

**Timeline:**
1. Request 1 fails → retry 3x → circuit still closed
2. Request 2 fails → retry 3x → circuit still closed
3. Request 3 fails → retry 3x → circuit still closed
4. Request 4 fails → retry 3x → circuit still closed
5. Request 5 fails → **Circuit opens**
6. Requests 6-N → Fail-fast for 30 seconds
7. After 30s → Circuit closes, normal operation resumes

**Impact:**
- First 5 requests: 4-8 second delay (retries)
- Next 30 seconds: Immediate failure or zero vector (depending on fallback mode)
- After 30s: Normal operation

**Data loss:** None (if fallback enabled)

---

### Scenario 2: Ollama Permanently Down (Deployment Issue)

**Without fallback (`OLLAMA_FALLBACK_EMBEDDING` unset):**
- All embedding requests throw errors
- Memory storage fails
- Users see 500 errors

**With fallback (`OLLAMA_FALLBACK_EMBEDDING=zero`):**
- All new memories stored with zero vectors
- Existing memories with embeddings remain searchable
- Semantic search returns reduced results
- System remains operational

**Resolution:** Deploy/fix Ollama, then trigger re-embedding:
```bash
# Re-generate embeddings for zero-vector memories
npm run generate-missing-embeddings
```

---

### Scenario 3: Ollama Slow but Responsive (High Load)

**Behavior:**
- Requests under 30s succeed (no timeout)
- Redis cache hit rate reduces load
- Circuit breaker does NOT open (requests succeed, just slowly)

**Mitigation:**
- Increase Ollama replicas (if using Kubernetes)
- Scale embedding cache TTL (reduce re-generation)
- Add batch queueing for bulk operations

---

## Monitoring

### Metrics (Prometheus)

- `rembr_embedding_generation_duration_seconds{provider="ollama", model="nomic-embed-text"}`
  - Histogram of embedding latency
  - Use p95/p99 to detect slowdowns

- Circuit breaker state (via logs):
  - `[OllamaClient] Circuit breaker opened` → ALERT
  - `[OllamaClient] Circuit breaker reset` → RECOVER

- Fallback activations (via logs):
  - `[OllamaClient] Returning zero vector (fallback mode)` → WARN

### Alerts

**Critical:**
```yaml
- alert: OllamaCircuitBreakerOpen
  expr: absent_over_time(up{job="ollama"}[5m])
  for: 2m
  annotations:
    summary: "Ollama embedding service circuit breaker open"
```

**Warning:**
```yaml
- alert: OllamaEmbeddingHighLatency
  expr: histogram_quantile(0.95, rembr_embedding_generation_duration_seconds) > 5
  for: 5m
  annotations:
    summary: "Ollama p95 latency > 5 seconds"
```

---

## Testing

### Unit Tests

Located in: `rembr-mcp/src/ollama-client.test.ts`

**Coverage:**
- Circuit breaker state transitions
- Retry logic with exponential backoff
- Zero vector fallback behavior
- Cache hit/miss paths

Run:
```bash
cd rembr-mcp
npm test -- ollama-client.test.ts
```

### Integration Test

Simulate Ollama downtime:
```bash
# Stop Ollama container
docker stop ollama

# Verify fallback behavior
curl -X POST http://localhost:3001/mcp/store_memory \
  -H "X-API-Key: mb_live_..." \
  -d '{"content":"Test during outage"}'

# Check logs for fallback activation
docker logs rembr-mcp | grep "zero vector"

# Restart Ollama
docker start ollama
```

---

## Limitations

### Current Gaps

1. **No External Provider Fallback:**
   - Zero vector is a degraded state, not a full fallback
   - No automatic switch to OpenAI/Cohere/Anthropic embeddings
   - **Future work:** Implement `OpenAIEmbeddingProvider` as secondary

2. **Circuit Breaker is Per-Pod:**
   - Each pod tracks circuit state independently
   - Kubernetes HPA may scale up unhealthy pods
   - **Future work:** Shared circuit state via Redis

3. **No Batch Request Queueing:**
   - Bulk operations (e.g., 1000 memories) hit Ollama sequentially
   - No rate limiting to protect Ollama from spikes
   - **Future work:** Add batch queue with concurrency limit

4. **No Embedding Model Versioning:**
   - Model changes invalidate cache silently
   - **Future work:** Include model version in cache key

---

## Recovery Procedures

### Re-generate Zero-Vector Embeddings

After Ollama recovery, re-embed zero-vector memories:

```bash
cd rembr-mcp
npm run generate-missing-embeddings
```

**Script behavior:**
- Queries all memories with zero-vector embeddings
- Batch re-generates embeddings (100 at a time)
- Updates `memory_embeddings` table
- Logs progress and failures

---

## Related Work

- **REM-255:** Original resilience implementation (retries, circuit breaker, fallback)
- **REM-268:** Chunk-and-average strategy for long content (> 6000 chars)
- **REM-251:** Audit tamper-resistance (ensures embedding failures are logged)

---

## Conclusion

Ollama is a local/cluster service with no built-in HA, but the `OllamaClient` resilience strategy ensures it does **not** become a hard SPOF:

1. **Cache-first** → Most requests never hit Ollama
2. **Retry + backoff** → Transient failures recover automatically
3. **Circuit breaker** → Protects Ollama during sustained outages
4. **Zero vector fallback** → System remains operational (degraded mode)
5. **Health checks** → Proactive monitoring and alerting

**Trade-off:** Semantic search accuracy vs. system availability. The fallback prioritizes uptime.

**Recommendation:** Enable `OLLAMA_FALLBACK_EMBEDDING=zero` in production for maximum resilience.

---

**Last updated:** 2026-02-25  
**Owner:** Platform Team  
**Status:** Deployed (REM-255), Documented (REM-246)
