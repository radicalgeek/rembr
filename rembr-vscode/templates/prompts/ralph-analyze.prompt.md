---
description: Start an acceptance-driven Ralph-RLM analysis - loop until all criteria are met
agent: ralph-rlm
tools: ['codebase', 'search', 'terminal']
model: Claude Sonnet 4
---

# Ralph-RLM Analysis Task

You are starting a Ralph-RLM (acceptance-driven) analysis. You will loop until ALL acceptance criteria are explicitly met and validated.

## Your Task
${input}

## Protocol

### Phase 1: Define Criteria (MANDATORY FIRST STEP)

Before any investigation:
1. Generate Task ID: `ralph-rlm-{timestamp}-{random}`
2. Derive 3-7 specific, measurable acceptance criteria
3. Store criteria in Rembr (category: "goals")

Each criterion must be:
- Specific and measurable
- Verifiable with file:line evidence
- Binary (met or not met)

### Phase 2: Loop Until Complete

```
REPEAT:
  1. Load criteria from Rembr
  2. Check which are met vs pending
  3. If ALL met → Complete
  4. Investigate unmet criteria
  5. Validate findings with evidence
  6. Update criterion status
  7. Check stuck condition (3+ no progress → regenerate)
  8. Update progress
```

### Phase 3: Validation

For each finding, verify:
- Has concrete evidence (file:line)
- Satisfies a specific criterion
- Can be independently verified

### Phase 4: Synthesis

When complete:
- Aggregate all validated findings
- Check for contradictions
- Store synthesis in Rembr

## Output Format

Show progress table after each iteration:

| ID | Criterion | Status | Evidence |
|----|-----------|--------|----------|
| AC1 | ... | ✅ MET | file:line |
| AC2 | ... | ⏳ PENDING | - |

## Guardrails (The 9s)

- 99: Evidence required
- 999: Update progress every iteration
- 9999: Check criteria before completion
- 999999: Regenerate if stuck 3+ iterations
- 9999999: Never exit until ALL validated

Begin by defining your acceptance criteria now.
