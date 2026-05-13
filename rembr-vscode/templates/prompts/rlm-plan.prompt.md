---
description: Generate an RLM decomposition plan without executing - for review before action
agent: plan
tools: ['codebase', 'search']
model: Claude Sonnet 4
---

# RLM Plan Generation

Generate an RLM decomposition plan for the following task WITHOUT executing it. This is for review before starting actual work.

## Task to Plan
${input}

## Output Format

```markdown
# RLM Decomposition Plan

## Task ID
rlm-{timestamp}-{random}

## Task Analysis
[Brief analysis of what this task requires]

## Decomposition

### Subtask 1: [Name]
- **Objective**: [Single clear goal]
- **Scope**: [Files/areas to investigate]
- **Search Strategy**: [What patterns/files to look for]
- **Expected Output**: [Type of finding expected]
- **Dependencies**: [Other subtasks this depends on]

### Subtask 2: [Name]
...

## Investigation Tools
[List of tools needed: rg, grep, find, etc.]

## Rembr Storage Plan
- Context: [What task context to store]
- Facts: [What findings to capture]
- Learning: [What synthesis to produce]

## Estimated Complexity
- Subtask count: N
- Estimated depth: L0 + L1
- Risk factors: [What could complicate this]

## Recommended Mode
- [ ] Basic RLM (fast, single-pass)
- [ ] Ralph-RLM (acceptance-driven, looped)

Rationale: [Why this mode is recommended]
```

Generate the plan now. Do not execute any investigations.
