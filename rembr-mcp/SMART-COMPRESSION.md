# Smart Compression — ContextPilot Phase 4

**REM-99 | RAD-84**

## Overview

Smart hierarchical compression that preserves critical information (decisions, user requests) while aggressively compressing filler and acknowledgments. Part of the ContextPilot suite for intelligent token budget management.

## Problem

Long conversations accumulate verbose content:
- Agent acknowledgments ("Okay, got it", "Will do")
- Filler words and phrases ("Um, well...", "just a second")
- Repeated technical explanations
- Overly detailed implementation minutiae

This wastes tokens without adding value, especially when agents are more verbose than necessary.

## Solution

**Hierarchical compression** based on content importance:

1. **Classify** each block by importance (decision > user_request > technical_detail > acknowledgment > filler)
2. **Apply differential compression**:
   - Decisions: preserved verbatim (0% compression)
   - User requests: minimal compression (20%)
   - Technical details: moderate compression (60%)
   - Acknowledgments: heavy compression (90%)
   - Filler: complete removal (100%)
3. **Agent compression multiplier**: Agent outputs compressed 1.5x more aggressively than user inputs (agents tend to be more verbose)
4. **Preview mode**: See what will be compressed before applying

## Usage

### Compress Content

```typescript
import { compressContent } from './smart-compression.js';

const result = await compressContent(
  'We decided to use PostgreSQL\n\nOkay, got it\n\nThe database will use...',
  'agent',  // or 'user'
  {
    // Optional: custom compression ratios
    compression_ratios: {
      decision: 0.0,           // Preserve verbatim
      user_request: 0.2,       // 20% compression
      technical_detail: 0.6,   // 60% compression
      acknowledgment: 0.9,     // 90% compression
      filler: 1.0              // 100% compression (remove)
    },
    agent_compression_multiplier: 1.5,  // Agent outputs compressed 1.5x more
    target_ratio: 0.5  // Target 50% overall compression
  }
);

console.log(result);
// {
//   original_tokens: 150,
//   compressed_tokens: 75,
//   compression_ratio: 0.5,
//   compressed_content: "We decided to use PostgreSQL\n\nThe database will use...",
//   blocks_compressed: 2,
//   blocks_preserved: 1,
//   preserved_decisions: ['We decided to use PostgreSQL']
// }
```

### Preview Compression

```typescript
import { previewCompression } from './smart-compression.js';

const preview = await previewCompression(
  'We decided to use PostgreSQL\n\nOkay, got it\n\nTechnical detail here',
  'agent'
);

console.log(preview);
// {
//   original_tokens: 150,
//   estimated_compressed_tokens: 75,
//   estimated_savings: 0.5,  // 50% savings
//   blocks: [
//     {
//       content: 'We decided to use PostgreSQL',
//       importance: 'decision',
//       source: 'agent',
//       tokens: 50,
//       compression_ratio: 0.0,
//       will_be_compressed: false
//     },
//     {
//       content: 'Okay, got it',
//       importance: 'acknowledgment',
//       source: 'agent',
//       tokens: 25,
//       compression_ratio: 1.35,  // 0.9 base * 1.5 agent multiplier
//       will_be_compressed: true
//     },
//     // ... more blocks
//   ]
// }
```

### MCP Tool Usage

```json
{
  "name": "compression",
  "arguments": {
    "operation": "compress",
    "content": "Long conversation text...",
    "source": "agent",
    "compression_ratios": {
      "decision": 0.0,
      "user_request": 0.2,
      "technical_detail": 0.6,
      "acknowledgment": 0.9,
      "filler": 1.0
    },
    "agent_compression_multiplier": 1.5,
    "target_ratio": 0.5
  }
}
```

## Response Format

### Compress Response

```json
{
  "success": true,
  "result": {
    "original_tokens": 150,
    "compressed_tokens": 75,
    "compression_ratio": 0.5,
    "compressed_content": "Compressed text with decisions preserved...",
    "blocks_compressed": 2,
    "blocks_preserved": 1,
    "preserved_decisions": [
      "We decided to use PostgreSQL",
      "Strategy: use Redis for caching"
    ]
  }
}
```

### Preview Response

```json
{
  "success": true,
  "preview": {
    "original_tokens": 150,
    "estimated_compressed_tokens": 75,
    "estimated_savings": 0.5,
    "blocks": [
      {
        "content": "We decided to use PostgreSQL",
        "importance": "decision",
        "source": "agent",
        "tokens": 50,
        "compression_ratio": 0.0,
        "will_be_compressed": false
      },
      {
        "content": "Okay, got it",
        "importance": "acknowledgment",
        "source": "agent",
        "tokens": 25,
        "compression_ratio": 1.35,
        "will_be_compressed": true
      }
    ]
  }
}
```

## Content Classification

### Importance Levels (highest to lowest)

1. **decision**: Explicit decisions, strategies, conclusions
   - Keywords: "decided", "therefore", "strategy", "conclusion"
   - Preserved verbatim (0% compression)

2. **user_request**: User questions, requests, directives
   - Keywords: "can you", "please", "I need", "would you"
   - Minimal compression (20%)

3. **technical_detail**: Implementation details, explanations
   - Default classification for technical content
   - Moderate compression (60%)

4. **acknowledgment**: Brief confirmations, understanding signals
   - Keywords: "okay", "got it", "understood", "will do"
   - Heavy compression (90%)

5. **filler**: Filler words, hesitations, irrelevant content
   - Keywords: "um", "well", "just a second"
   - Complete removal (100%)

## Compression Strategies

### Agent Compression Multiplier

Agent outputs are compressed more aggressively because agents tend to be verbose:

```
effective_ratio = base_ratio * agent_compression_multiplier
```

Example:
- Technical detail base: 60% compression
- Agent multiplier: 1.5x
- Effective agent compression: 60% * 1.5 = 90%

### Block Splitting

Content is split into blocks by:
1. Double newlines (`\n\n`) for structured content
2. Single newlines for short content (< 200 chars)

Each block is classified and compressed independently.

## Integration with ContextPilot

### Phase 1: Foundation (REM-102)
- `context_budgets` table for token limits
- Budget management infrastructure

### Phase 2: Intelligence (REM-103)
- Budget-aware memory search
- Smart result truncation
- Token estimation utilities

### Phase 3: Analytics (REM-101)
- Token waste detection (repeated info, stale context)
- Compression event tracking
- Efficiency scoring

### Phase 4: Smart Compression (REM-99) ← **You are here**
- Hierarchical content compression
- Decision preservation
- Agent output optimization

## Workflow Example

```typescript
// 1. Check budget status (REM-100)
const budgetCheck = await checkBudget(pool, tenantId, 'coding-budget', {
  conversation: 45000,  // 90% of 50k allocation
  tools: 27000          // 90% of 30k allocation
});

// 2. If approaching limit, analyze waste (REM-101)
if (budgetCheck.overall_status === 'critical') {
  const analytics = await getContextAnalytics(pool, tenantId, sessionId);
  
  // 3. If waste detected, compress content (REM-99)
  if (analytics.waste.total_waste_tokens > 1000) {
    const compressed = await compressContent(
      conversationHistory,
      'agent',
      {
        target_ratio: 0.5,  // Aim for 50% reduction
        agent_compression_multiplier: 1.5
      }
    );
    
    // 4. Update context with compressed content
    conversationHistory = compressed.compressed_content;
  }
}
```

## Configuration

### Default Settings

```typescript
export const DEFAULT_COMPRESSION_CONFIG: CompressionConfig = {
  target_ratio: 0.5,  // Aim for 50% compression
  compression_ratios: {
    decision: 0.0,              // Preserve verbatim
    user_request: 0.2,          // 20% compression
    technical_detail: 0.6,      // 60% compression
    acknowledgment: 0.9,        // 90% compression
    filler: 1.0                 // 100% compression (remove)
  },
  agent_compression_multiplier: 1.5,  // Agent outputs compressed 1.5x more
  preserve_decision_chains: true,     // Keep decision context intact
  store_compressed_content: true      // Save compressed version
};
```

### Custom Configuration

All parameters are optional and can be customized per-call:

```typescript
const result = await compressContent(content, source, {
  target_ratio: 0.7,  // Less aggressive (30% compression)
  compression_ratios: {
    decision: 0.0,
    user_request: 0.1,         // Very light compression for user input
    technical_detail: 0.5,     // Moderate compression
    acknowledgment: 1.0,       // Remove all acknowledgments
    filler: 1.0
  },
  agent_compression_multiplier: 2.0  // More aggressive agent compression
});
```

## Performance

- **Latency**: < 10ms for typical conversation blocks (< 1000 tokens)
- **Throughput**: > 100 blocks/second
- **Memory**: O(n) where n = content length
- **Compression ratio**: 40-60% typical (depends on content mix)

## Token Estimation

Uses simple approximation: `tokens ≈ characters / 4`

This is sufficient for:
- Relative comparisons (before/after)
- Budget threshold detection
- Compression ratio calculation

For precise token counting, integrate tiktoken in future iterations.

## Future Enhancements

1. **Semantic compression**: Use embeddings to detect redundant meaning (not just exact duplicates)
2. **Cross-block context**: Preserve decision chains across multiple blocks
3. **Adaptive ratios**: Learn optimal compression ratios per user/project
4. **Compression history**: Track effectiveness over time, auto-tune
5. **Tiktoken integration**: Replace char/4 approximation with exact token counts

## Error Handling

### Empty Content

```typescript
const result = await compressContent('', 'user');
// result.original_tokens === 0
// result.compressed_tokens === 0
// result.compressed_content === ''
```

### Invalid Source

```typescript
const result = await compressContent(content, 'invalid' as any);
// Defaults to 'user' behavior (no agent multiplier)
```

### Malformed Config

```typescript
const result = await compressContent(content, 'agent', {
  compression_ratios: {
    decision: 1.5  // > 1.0 invalid
  }
});
// Clamped to 1.0 (100% compression)
```

## Testing

Comprehensive test suite in `smart-compression.test.ts`:

- Content classification (decisions, user requests, acknowledgments, filler)
- Block splitting (double vs single newlines)
- Token estimation
- Compression with default/custom ratios
- Agent compression multiplier
- Preview mode
- Edge cases (empty content, single-block, all-filler)

Run tests:

```bash
npm test -- smart-compression.test.ts
```

## See Also

- [REM-102: ContextPilot Foundation](https://linear.app/radical-geek/issue/RAD-83)
- [REM-103: Budget-Aware Memory Search](https://linear.app/radical-geek/issue/RAD-83)
- [REM-101: Context Analytics](./CONTEXT-ANALYTICS.md)
- [REM-100: Token Budget Management](./BUDGET-MANAGEMENT.md)
