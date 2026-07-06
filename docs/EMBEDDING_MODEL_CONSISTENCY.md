# Embedding Model Consistency

**REM-249** — Detect and handle incompatible embeddings when the model changes.

---

## Problem

When Rembr's embedding model changes (e.g., `nomic-embed-text` → `all-minilm-l6-v2`), all existing vector embeddings become **incompatible** with new ones:
- Cosine similarity scores are **meaningless** across models
- Semantic search returns incorrect results
- No way to detect this silent failure

---

## Solution

**Model fingerprinting** tracks the exact model configuration for each embedding. When the model changes, old embeddings are **flagged as stale** and excluded from search until re-embedded.

### Architecture

```
OllamaClient.getModelFingerprint()
         │
         ▼
  SHA-256(provider || model || dimensions)
         │
         ▼
  Stored in memory_embeddings.model_fingerprint
         │
         ▼
  On startup or model change:
    db.markStaleEmbeddings(currentFingerprint)
         │
         ▼
  Stale embeddings:
    - is_stale = TRUE
    - Excluded from semantic search
    - Queued for re-embedding
```

---

## Database Schema

```sql
ALTER TABLE memory_embeddings ADD COLUMN model_fingerprint TEXT;
ALTER TABLE memory_embeddings ADD COLUMN is_stale BOOLEAN DEFAULT FALSE;
ALTER TABLE memory_embeddings ADD COLUMN stale_since TIMESTAMPTZ;

CREATE INDEX idx_memory_embeddings_stale
  ON memory_embeddings(is_stale, stale_since)
  WHERE is_stale = TRUE;
```

**Fingerprint computation:**
```
model_fingerprint = SHA-256(provider || '|' || model || '|' || dimensions)
```

Example: `ollama|nomic-embed-text|768` → `a3f2b1...` (64-char hex)

---

## API Usage

### 1. Mark Stale Embeddings (on startup or model change)

```typescript
import { MemoryService } from './memory-service.js';

const memoryService = new MemoryService(tenantId, projectId, db, embeddingProvider);

// Mark all embeddings with different fingerprint as stale
const staleCount = await memoryService.markStaleEmbeddings();

console.log(`Marked ${staleCount} embeddings as stale`);
```

**When to call:**
- On server startup (if `OLLAMA_EMBEDDING_MODEL` changed since last run)
- After changing the embedding model configuration
- Via a scheduled cron job to periodically verify consistency

### 2. Check Stale Count

```typescript
const staleCount = await memoryService.getStaleEmbeddingCount();

if (staleCount > 0) {
  console.warn(`⚠️  ${staleCount} stale embeddings detected. Re-embedding recommended.`);
}
```

### 3. Re-Embed Stale Vectors

```typescript
// Re-embed in batches of 50
const reEmbedded = await memoryService.reEmbedStale(50);

console.log(`♻️  Re-embedded ${reEmbedded} memories`);
```

**Background Job Pattern:**
```typescript
async function reEmbedStaleLoop() {
  while (true) {
    const count = await memoryService.getStaleEmbeddingCount();
    if (count === 0) break;

    const reEmbedded = await memoryService.reEmbedStale(50);
    console.log(`Re-embedded ${reEmbedded}/${count} stale embeddings`);

    await new Promise(resolve => setTimeout(resolve, 5000)); // 5s between batches
  }
}
```

---

## Operational Workflow

### Scenario: Changing the Embedding Model

1. **Before change:**
   ```bash
   # Current model
   OLLAMA_EMBEDDING_MODEL=nomic-embed-text
   ```

2. **Change the model:**
   ```bash
   # Update .env or k8s ConfigMap
   OLLAMA_EMBEDDING_MODEL=all-minilm-l6-v2
   ```

3. **On next server startup:**
   ```typescript
   // In server initialization
   const staleCount = await memoryService.markStaleEmbeddings();
   console.log(`Marked ${staleCount} embeddings as stale after model change`);
   ```

4. **Re-embed in background:**
   ```typescript
   // Schedule as a background job
   reEmbedStaleLoop();
   ```

5. **Monitor progress:**
   ```bash
   curl -X POST /v1/tools/call \
     -d '{"name": "get_embedding_stats"}' \
     -H "Authorization: Bearer $API_KEY"
   # Response includes stale_embedding_count
   ```

---

## Search Behavior with Stale Embeddings

**Semantic search (find_similar_memories):**
- Stale embeddings are **excluded** from results
- Query: `SELECT ... WHERE is_stale = FALSE`

**Impact:**
- Memories with stale embeddings won't appear in semantic search
- They remain accessible via list/get operations
- Re-embedding restores search functionality

---

## Testing

Run embedding consistency tests:
```bash
npm test embedding-model-consistency.test.ts
```

Tests cover:
- Fingerprint computation (deterministic + unique)
- Stale detection (marks old embeddings when model changes)
- Re-embedding (clears stale flag after update)
- Count tracking (accurate stale counts)

---

## Performance

### Fingerprint Computation
- **Cost:** 1 SHA-256 hash per embedding insert (~0.05ms)
- **Impact:** Negligible

### Stale Detection
- **Cost:** Single UPDATE query with WHERE on indexed columns
- **Example:** 100K embeddings → ~500ms

### Re-Embedding
- **Cost:** 1 embedding API call per memory
- **Throughput:** ~50 embeddings/sec with ollama (depends on GPU)
- **Strategy:** Batch re-embedding in background to avoid blocking

---

## Future Enhancements

1. **Automatic model change detection** — compare env var with stored fingerprint on startup
2. **Partial re-embedding** — prioritize high-importance memories
3. **Multi-model support** — allow multiple active models with tagged embeddings
4. **External model registry** — centralized tracking of model versions

---

## Related Files

- `rembr-mcp/src/migrations/007-embedding-model-consistency.sql` — Migration
- `rembr-mcp/src/ollama-client.ts` — `getModelFingerprint()`
- `rembr-mcp/src/ollama-provider.ts` — EmbeddingProvider interface
- `rembr-mcp/src/database.ts` — `markStaleEmbeddings()`, `getStaleEmbeddings()`
- `rembr-mcp/src/memory-service.ts` — `reEmbedStale()`
- `rembr-mcp/src/embedding-model-consistency.test.ts` — Unit tests
