---
applyTo: "**"
description: Instructions for using Rembr MCP as persistent state coordinator
---

# Rembr MCP Integration

When working with RLM or Ralph-RLM patterns, use Rembr MCP for all persistent state.

## Required Categories

| Category | Purpose | When to Use |
|----------|---------|-------------|
| `goals` | Acceptance criteria | Store criteria BEFORE investigation |
| `context` | Task state, progress | Update after every major step |
| `facts` | Validated findings | Store ONLY confirmed findings |
| `learning` | Synthesized insights | Store on task completion |

## Required Metadata

All Rembr stores must include:

```json
{
  "taskId": "rlm-...", // or "ralph-rlm-..."
  "level": "L0" | "L1",
  "status": "pending" | "in_progress" | "complete" | "blocked"
}
```

## Storage Patterns

### Task Initialization
```javascript
await rembr.store({
  category: "context",
  content: "Task description...",
  metadata: { taskId, level: "L0", type: "initialization", status: "in_progress" }
});
```

### Acceptance Criteria (Ralph-RLM)
```javascript
await rembr.store({
  category: "goals",
  content: JSON.stringify(criteria),
  metadata: { taskId, level: "L0", type: "acceptance_criteria", criteria: [...] }
});
```

### Validated Finding
```javascript
await rembr.store({
  category: "facts",
  content: "Finding description...",
  metadata: { 
    taskId, 
    subtaskId,
    evidence: ["src/file.ts:42"],
    confidence: 0.95,
    criterion: "AC1" // if Ralph-RLM
  }
});
```

### Progress Update
```javascript
await rembr.store({
  category: "context",
  content: "Progress update...",
  metadata: { 
    taskId, 
    type: "progress",
    iteration: N,
    stuckCount: 0,
    criteriaProgress: { total: 5, met: 3 }
  }
});
```

## Evidence Requirements

Always include specific evidence:
- File path with line number: `src/auth/handler.ts:42`
- Test output: `"Test 'login' passed: 200 OK"`
- Metrics: `"Response time: 45ms (< 100ms threshold)"`

Never store findings without evidence.
