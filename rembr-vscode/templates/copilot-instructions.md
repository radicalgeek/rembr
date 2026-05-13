# RLM (Recursive Language Model) Repository Instructions

This repository uses RLM patterns for complex, multi-step coding tasks. RLM enables hierarchical task decomposition with persistent state coordination via Rembr MCP.

## Available Modes

### 1. Basic RLM Mode
- Fast, single-pass task decomposition
- Best for: Well-defined tasks, quick analysis, straightforward implementations
- Use when: You have clear requirements and don't need iterative refinement

### 2. Ralph-RLM Mode (Acceptance-Driven)
- Loops until explicit acceptance criteria are met
- Best for: Complex features, security audits, comprehensive documentation
- Use when: Quality matters more than speed, criteria must be validated

## Rembr MCP Integration

This repository uses Rembr as the persistent state coordinator for RLM operations.

### Rembr Categories
- `goals`: Acceptance criteria, exit conditions
- `context`: Progress tracking, iteration state
- `facts`: Validated findings with evidence
- `learning`: Synthesized insights, operational knowledge

### Required Metadata
All Rembr memories for RLM must include:
- `taskId`: Unique identifier (format: `rlm-YYYYMMDD-HHMMSS-{random}`)
- `level`: Hierarchy level (`L0` for orchestrator, `L1` for subagents)
- `status`: Current state (`pending`, `in_progress`, `complete`, `blocked`)

## Coding Standards for RLM Operations

### Evidence Requirements
- Never claim completion without specific file:line evidence
- Store only validated findings (confirmed via code tools)
- Update progress tracking after every iteration

### Loop Discipline
- Check acceptance criteria before claiming completion
- Regenerate plan if stuck for 3+ iterations
- Never exit loop until all criteria validated

### State Management
- Use Rembr for all persistent state (not local variables)
- Create snapshots before spawning subagents
- Aggregate results through Rembr search

## Quick Reference

| Task Type | Recommended Mode | Agent |
|-----------|------------------|-------|
| Quick analysis | Basic RLM | `@rlm` |
| Security audit | Ralph-RLM | `@ralph-rlm` |
| Documentation | Ralph-RLM | `@ralph-rlm` |
| Bug investigation | Basic RLM | `@rlm` |
| Feature implementation | Ralph-RLM | `@ralph-rlm` |
| Code review | Either | Depends on depth |

## Prompts Available

- `/rlm-analyze` - Start basic RLM analysis
- `/ralph-analyze` - Start acceptance-driven analysis
- `/rlm-plan` - Generate RLM decomposition plan only
- `/ralph-plan` - Define acceptance criteria only
