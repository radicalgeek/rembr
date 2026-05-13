---
description: Start a basic RLM analysis - decompose task and investigate with subagents
agent: rlm
tools: ['codebase', 'search', 'terminal']
model: Claude Sonnet 4
---

# RLM Analysis Task

You are starting an RLM (Recursive Language Model) analysis. Follow the RLM orchestration protocol:

## Your Task
Analyze the following request using RLM decomposition:

${input}

## Protocol

1. **Generate Task ID**: Create `rlm-{timestamp}-{random}`

2. **Store Initial Context**: Use Rembr to store task initialization

3. **Decompose**: Break into 2-5 focused subtasks

4. **For Each Subtask**:
   - Create Rembr context snapshot
   - Investigate using code tools (rg, grep, find)
   - Store validated findings in Rembr

5. **Synthesize**: Combine all findings into comprehensive answer

## Output Requirements

- Cite specific files and line numbers
- Store all findings in Rembr immediately
- Report only what you can verify
- End with actionable recommendations

Begin your RLM analysis now.
