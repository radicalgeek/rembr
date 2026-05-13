---
name: ralph-rlm-orchestration
description: Use this skill for acceptance-driven coding tasks that must loop until explicit criteria are met. Combines RLM decomposition with Ralph Wiggum's validation loops and stuck detection.
license: MIT
---

# Ralph-RLM Orchestration Skill

This skill teaches you how to perform acceptance-driven RLM orchestration where you loop until ALL criteria are explicitly met and validated.

## When to Use This Skill

Activate this skill when:
- Task has quality requirements that must be validated
- Completion means meeting specific, measurable criteria
- You need automatic stuck detection and recovery
- Quality matters more than speed

## Core Principle

> "The plan is disposable. The acceptance criteria are not."
> — Ralph Wiggum approach

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                 RALPH-RLM LOOP                       │
│  ┌────────────────────────────────────────────────┐  │
│  │ 1. Load criteria from Rembr                    │  │
│  │ 2. Validate findings against criteria          │  │
│  │ 3. If ALL met → COMPLETE                       │  │
│  │ 4. If NOT met → Decompose & investigate        │  │
│  │ 5. Check stuck condition                       │  │
│  │ 6. If stuck → Regenerate plan                  │  │
│  │ 7. Update progress → Loop                      │  │
│  └────────────────────────────────────────────────┘  │
│                        ↕                             │
│  ┌────────────────────────────────────────────────┐  │
│  │              REMBR MCP                         │  │
│  │  goals: Acceptance criteria                    │  │
│  │  context: Progress, iteration state            │  │
│  │  facts: Validated findings                     │  │
│  │  learning: Synthesis                           │  │
│  └────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
```

## Step-by-Step Process

### Step 1: Define Acceptance Criteria

**Before any work**, derive explicit criteria:

```javascript
const taskId = `ralph-rlm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const criteria = [
  {
    id: "AC1",
    criterion: "All authentication endpoints use rate limiting",
    evidenceRequired: "file:line showing rate limit middleware",
    status: "pending"
  },
  {
    id: "AC2", 
    criterion: "Passwords are hashed with bcrypt cost ≥10",
    evidenceRequired: "file:line showing bcrypt configuration",
    status: "pending"
  },
  {
    id: "AC3",
    criterion: "JWT tokens expire within 24 hours",
    evidenceRequired: "file:line showing token expiration setting",
    status: "pending"
  }
];

await rembr.store({
  category: "goals",
  content: JSON.stringify(criteria),
  metadata: {
    taskId,
    level: "L0",
    type: "acceptance_criteria",
    progress: { total: 3, met: 0 }
  }
});
```

### Step 2: Initialize Progress Tracking

```javascript
await rembr.store({
  category: "context",
  content: "Starting Ralph-RLM loop",
  metadata: {
    taskId,
    type: "progress",
    iteration: 1,
    stuckCount: 0,
    previousMetCount: 0,
    status: "running"
  }
});
```

### Step 3: Main Loop

```
REPEAT:
  // Load current state
  criteria = await rembr.search({ taskId, category: "goals" })
  progress = await rembr.search({ taskId, category: "context", type: "progress" })
  
  // Check completion
  metCount = criteria.filter(c => c.status === "met").length
  IF metCount === criteria.length:
    BREAK → COMPLETE
  
  // Investigate unmet criteria
  FOR EACH unmetCriterion:
    // Store L1 criteria before investigation
    await storeL1Criteria(unmetCriterion)
    
    // Investigate with code tools
    findings = await investigate(unmetCriterion)
    
    // Validate against criterion
    IF hasValidEvidence(findings, unmetCriterion):
      await storeFinding(findings)
      await updateCriterionStatus(unmetCriterion, "met")
  
  // Check stuck condition
  IF metCount === previousMetCount:
    stuckCount++
    IF stuckCount >= 3:
      await regeneratePlan()
      stuckCount = 0
  ELSE:
    stuckCount = 0
  
  // Update progress
  await updateProgress(iteration++, metCount, stuckCount)
```

### Step 4: Validation Rules

A finding is only valid when:

1. **Specific Evidence**: file:line reference or test output
2. **Matches Criterion**: Directly addresses the acceptance criterion
3. **Independently Verifiable**: Another agent could confirm it

```javascript
function validateFinding(finding, criterion) {
  return (
    finding.evidence?.length > 0 &&
    finding.evidence.every(e => /^[\w/.]+:\d+$/.test(e)) &&
    finding.criterion === criterion.id
  );
}
```

### Step 5: Stuck Detection & Recovery

```javascript
async function checkStuck(currentMetCount, previousMetCount, stuckCount) {
  if (currentMetCount === previousMetCount) {
    stuckCount++;
    if (stuckCount >= 3) {
      console.log("STUCK DETECTED - Regenerating plan");
      await regeneratePlan();
      return 0; // Reset stuck count
    }
  } else {
    return 0; // Progress made, reset
  }
  return stuckCount;
}

async function regeneratePlan() {
  // Load original criteria
  const criteria = await rembr.search({ category: "goals" });
  
  // Analyze what's blocking progress
  const blockers = analyzeBlockers();
  
  // Generate new decomposition approach
  const newPlan = generateAlternativePlan(criteria, blockers);
  
  // Store new plan
  await rembr.store({
    category: "context",
    content: `Regenerated plan: ${JSON.stringify(newPlan)}`,
    metadata: { type: "plan_regeneration" }
  });
}
```

### Step 6: Synthesis on Completion

```javascript
async function synthesize(taskId) {
  // Gather all validated findings
  const findings = await rembr.search({
    query: taskId,
    category: "facts"
  });
  
  // Check for contradictions
  const contradictions = findContradictions(findings);
  
  // Store synthesis
  await rembr.store({
    category: "learning",
    content: `Synthesis: All ${findings.length} criteria met. ${
      contradictions.length ? `Contradictions: ${contradictions}` : 'No contradictions.'
    }`,
    metadata: {
      taskId,
      type: "synthesis",
      status: "complete",
      criteriaCount: findings.length
    }
  });
}
```

## Acceptance Criteria Templates

### Security Audit
```markdown
- AC1: All user inputs are sanitized before database queries
- AC2: Authentication uses industry-standard hashing (bcrypt/argon2)
- AC3: Session tokens have expiration ≤24h
- AC4: CORS is configured for specific origins only
- AC5: Sensitive data is encrypted at rest
```

### Feature Implementation
```markdown
- AC1: Feature handles happy path correctly
- AC2: Feature handles all error cases gracefully
- AC3: Feature has ≥80% test coverage
- AC4: Feature is documented in README
- AC5: Feature follows existing code patterns
```

### Documentation
```markdown
- AC1: All public APIs are documented
- AC2: All configuration options are explained
- AC3: Setup instructions are complete and tested
- AC4: Examples are provided for common use cases
```

## The 9s (Guardrails)

| Rule | Description |
|------|-------------|
| 99 | Evidence required - never claim without proof |
| 999 | Update progress every iteration |
| 9999 | Check criteria before claiming completion |
| 99999 | Store learnings for future reference |
| 999999 | Regenerate plan if stuck 3+ iterations |
| 9999999 | Never exit until ALL criteria validated |

## Example: Security Audit with Ralph-RLM

```
Task: "Audit authentication system for OWASP compliance"

Acceptance Criteria:
- AC1: No SQL injection vulnerabilities
- AC2: Passwords hashed with bcrypt cost ≥12
- AC3: Session tokens use secure random generation
- AC4: Rate limiting on login endpoints
- AC5: No sensitive data in logs

Iteration 1:
- Investigated AC1: Found parameterized queries ✅
- Investigated AC2: Found bcrypt cost = 10 ❌
- Progress: 1/5 met

Iteration 2:
- Investigated AC2 again: Confirmed cost = 10
- Investigated AC3: Found crypto.randomBytes() ✅
- Progress: 2/5 met

Iteration 3:
- Investigated AC4: Found express-rate-limit ✅
- Investigated AC5: Found password logged! ❌
- Progress: 3/5 met

[Loop continues until all criteria addressed]
```
