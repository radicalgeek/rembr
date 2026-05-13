---
name: rlm-orchestration
description: Use this skill when decomposing complex coding tasks into subagent investigations. Applies RLM (Recursive Language Model) patterns for hierarchical task breakdown with Rembr state coordination.
license: MIT
---

# RLM Orchestration Skill

This skill teaches you how to perform Recursive Language Model (RLM) orchestration for complex coding tasks.

## When to Use This Skill

Activate this skill when:
- Task requires analyzing multiple files or systems
- Investigation needs structured decomposition
- Results should be persisted and synthesized
- Subtasks can be investigated independently

## RLM Architecture

```
USER TASK
    ↓
┌─────────────────────────────────────┐
│          L0 ORCHESTRATOR            │
│  - Decompose task                   │
│  - Store context in Rembr           │
│  - Coordinate subagents             │
│  - Synthesize results               │
└─────────────────────────────────────┘
    ↓           ↓           ↓
┌─────────┐ ┌─────────┐ ┌─────────┐
│ L1 Sub  │ │ L1 Sub  │ │ L1 Sub  │
│ Agent   │ │ Agent   │ │ Agent   │
└─────────┘ └─────────┘ └─────────┘
    ↓           ↓           ↓
┌─────────────────────────────────────┐
│            REMBR MCP                │
│  Persistent State Coordinator       │
│  - goals, context, facts, learning  │
└─────────────────────────────────────┘
```

## Step-by-Step Process

### Step 1: Initialize Task

```javascript
// Generate unique task ID
const taskId = `rlm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// Store in Rembr
await rembr.store({
  category: "context",
  content: `Task: ${taskDescription}`,
  metadata: {
    taskId,
    level: "L0",
    type: "task_initialization",
    status: "in_progress"
  }
});
```

### Step 2: Decompose Task

Analyze the task and identify 2-5 independent subtasks:

```markdown
## Decomposition for: [Task Name]

### Subtask 1: [Name]
- Focus: [Single clear objective]
- Scope: [Files/areas to investigate]
- Output: [Expected finding type]

### Subtask 2: [Name]
...
```

### Step 3: Execute Subtasks

For each subtask:

1. **Create Context Snapshot**
   ```javascript
   await rembr.store({
     category: "context",
     content: `Subtask: ${subtaskDescription}`,
     metadata: { taskId, level: "L1", subtaskId, parentId: taskId }
   });
   ```

2. **Investigate with Code Tools**
   ```bash
   # Search for patterns
   rg "pattern" --type ts
   
   # Find relevant files
   find . -name "*.ts" -path "*auth*"
   
   # Extract specific content
   sed -n '10,50p' src/auth/handler.ts
   ```

3. **Store Validated Findings**
   ```javascript
   await rembr.store({
     category: "facts",
     content: `Finding: ${description}`,
     metadata: {
       taskId,
       subtaskId,
       evidence: ["src/auth/handler.ts:42", "src/auth/config.ts:15"],
       confidence: 0.95
     }
   });
   ```

### Step 4: Synthesize Results

```javascript
// Search for all findings
const findings = await rembr.search({
  query: taskId,
  category: "facts"
});

// Identify patterns
const patterns = analyzeFindings(findings);

// Store synthesis
await rembr.store({
  category: "learning",
  content: `Synthesis: ${synthesizedResult}`,
  metadata: {
    taskId,
    type: "synthesis",
    status: "complete",
    findingCount: findings.length
  }
});
```

## Rembr Categories Reference

| Category | Purpose | Example Content |
|----------|---------|-----------------|
| `goals` | Acceptance criteria, objectives | "Must identify all SQL injection points" |
| `context` | Task state, progress, plans | "Analyzing auth module, iteration 2" |
| `facts` | Validated findings with evidence | "Found hardcoded secret at config.ts:42" |
| `learning` | Synthesized insights | "Auth uses 3 different patterns..." |

## Best Practices

1. **Store Early, Store Often**: Put findings in Rembr immediately
2. **Evidence First**: Always include file:line references
3. **Focused Subtasks**: One clear objective per subtask
4. **Progress Updates**: Track state after each major step
5. **No Speculation**: Only report verified findings

## Example: Security Audit

```
Task: "Analyze authentication system for vulnerabilities"

Subtask 1: Credential Storage
- Search: rg "password|secret|key" --type ts
- Focus: How are credentials stored?

Subtask 2: Session Management  
- Search: rg "session|token|jwt" --type ts
- Focus: Session lifecycle and expiration

Subtask 3: Input Validation
- Search: rg "validate|sanitize|escape" --type ts
- Focus: Are inputs properly validated?

Synthesis: Combine findings into security assessment
```
