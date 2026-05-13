---
description: Define acceptance criteria for Ralph-RLM without starting execution
agent: plan
tools: ['codebase', 'search']
model: Claude Sonnet 4
---

# Ralph-RLM Criteria Definition

Define acceptance criteria for the following task WITHOUT starting execution. These criteria will drive the Ralph-RLM loop.

## Task
${input}

## Criteria Requirements

Each criterion must be:
1. **Specific**: Precise, unambiguous statement
2. **Measurable**: Can verify with file:line or test output
3. **Binary**: Either met or not met (no partial credit)
4. **Independent**: Can validate without other criteria
5. **Evidence-based**: Clear evidence type required

## Output Format

```markdown
# Acceptance Criteria Definition

## Task ID
ralph-rlm-{timestamp}-{random}

## Task Summary
[What this task aims to achieve]

## Acceptance Criteria

| ID | Criterion | Evidence Required | Priority |
|----|-----------|-------------------|----------|
| AC1 | [Specific statement] | [file:line / test output / data] | High |
| AC2 | [Specific statement] | [file:line / test output / data] | High |
| AC3 | [Specific statement] | [file:line / test output / data] | Medium |
...

## Criterion Details

### AC1: [Short Name]
- **Full Criterion**: [Detailed statement]
- **Evidence Type**: file:line / test output / metrics
- **Validation Method**: [How to verify this is met]
- **Failure Indicators**: [What would show this is NOT met]

### AC2: [Short Name]
...

## Estimated Loop Complexity
- Criteria count: N
- Expected iterations: M
- Stuck risk: Low/Medium/High

## Recommended Investigation Order
1. AC1 → [Rationale]
2. AC3 → [Rationale]
3. AC2 → [Rationale]

## Ready to Execute?
Review these criteria before starting Ralph-RLM execution.
Use `/ralph-analyze` to begin the acceptance-driven loop.
```

Define the criteria now. Do not start investigation.
