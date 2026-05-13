# Rembr

<p align="center">
  <a href="https://rembr.ai">
    <img src="https://rembr.ai/logo-new.png" alt="Rembr logo" width="128" />
  </a>
</p>

<p align="center">
  <strong>Durable memory and context infrastructure for AI agents.</strong>
</p>

<p align="center">
  <a href="https://rembr.ai">Website</a>
  ·
  <a href="https://rembr.ai/docs">Docs</a>
  ·
  <a href="https://rembr.ai/portable-memory">Portable Memory</a>
  ·
  <a href="https://rembr.ai/agent-memory">Agent Debugging</a>
  ·
  <a href="https://rembr.ai/storage-vs-intelligence">Intelligence vs Storage</a>
</p>

![Rembr - Memory Infrastructure for AI Agents](https://rembr.ai/og-image.png)

Rembr is an open-source memory layer for agents that need more than chat history and vector search. It gives agents a place to store what they learn, retrieve the right context later, hand off focused context to other agents, track how facts change over time, reason over relationships, and keep long-running work resumable.

Most agent memory systems answer: "What past text is semantically similar to this prompt?"

Rembr is built for the harder production question: "What should this agent know right now, why does it believe it, what changed, and what context should another agent receive next?"

The hosted Rembr product is built around a simple idea: one memory layer should follow you across Claude, Cursor, Windsurf, local models, and any MCP-compatible tool. The public site frames this as portable memory for agents: tell one tool once, and the rest of your workflow can remember.

## Why Agents Need Rembr

LLMs are powerful inside a context window and forgetful outside it. Once a session ends, the next agent usually has to rediscover:

- The architecture it already investigated.
- The user's preferences and decisions.
- Which facts are current and which are stale.
- Why a previous agent chose a particular plan.
- What work is blocked, complete, or ready for handoff.
- Which context should be passed to a sub-agent without flooding it.

That is fine for demos. It breaks down when agents work on real projects over days or weeks.

Rembr turns agent memory into durable infrastructure:

- **Memory** for facts, decisions, preferences, workflows, insights, and project context.
- **Search** across semantic, text, phrase, hybrid, and related-memory strategies.
- **Contexts** for building focused working sets instead of dumping raw search results.
- **Snapshots** for immutable, versioned handoff packages.
- **Temporal tools** for asking what was known at a point in time.
- **Graph tools** for exploring relationships between memories, tasks, decisions, and incidents.
- **Contradiction detection** for finding stale or conflicting context.
- **Causal reasoning** for tracing why state changed and what followed.
- **RLM/task tooling** for resumable agentic work with acceptance criteria, iterations, task state, dependencies, and handoffs.
- **Audit and PII tooling** for safer production use.

## What Makes Rembr Different

Rembr is not just a vector database, and it is not just a chatbot memory store.

It is designed as an **agentic context layer**: a memory system that agents can actively use to construct, validate, version, and transfer context.

The product pages on [rembr.ai](https://rembr.ai) describe this distinction as the gap between storage and intelligence. Storage can hold text. Rembr helps agents decide which memories matter, when they mattered, how they connect, and what should be handed to the next agent.

### Agent Handoff Is A First-Class Primitive

Agents often need to delegate. Search results are not enough for that. Rembr lets an agent build a focused context, attach the relevant memories, and create an immutable snapshot so a sub-agent receives a stable baseline.

That makes handoff auditable and repeatable:

```text
search -> collect memories -> create context -> snapshot -> hand off to agent
```

### Time Matters

Project facts change. User preferences change. Production systems change. Rembr includes temporal search and memory history so an agent can ask:

- What did we know when this decision was made?
- Which memory superseded this older one?
- What changed between these two snapshots?
- Was this runbook true before the latest deployment?

### Memory Is Connected

Useful memories are rarely isolated. A decision affects a task. A task creates an incident. An incident updates a runbook. Rembr includes graph and relationship tools so agents can explore dependencies and missing links.

### Long-Running Work Needs State

For serious agent work, "remember this" is not enough. Rembr includes RLM and task tools for work that needs:

- Acceptance criteria.
- Iteration history.
- Stuck detection.
- Plan regeneration.
- Task dependencies.
- Handoff payloads.
- Durable state across compaction or session interruption.

## Comparison

The memory category is moving quickly. Rembr is complementary to many existing tools, but it optimizes for a different center of gravity: MCP-native agent work, context handoff, temporal reasoning, causal exploration, and durable task state.

| System | Best At | Memory Model | Where Rembr Differs |
| --- | --- | --- | --- |
| **Vector DB / RAG** | Retrieving similar documents or chunks | Embeddings over mostly static content | Rembr adds agent-authored memories, metadata, contexts, snapshots, temporal history, graph reasoning, contradictions, causality, and task state. |
| **LangGraph memory** | Adding short-term and long-term memory inside LangChain/LangGraph apps | Checkpointed graph state plus long-term stores | Rembr is framework-agnostic and MCP-native, with handoff snapshots, audit/PII tools, and agent workflow primitives available as tools. |
| **Mem0** | Fast managed or self-hosted memory for personalized agents | Extract, store, and retrieve user/task memories | Rembr focuses less on simple personalization and more on multi-step agent work: contexts, immutable snapshots, temporal/causal tools, RLM sessions, and work queues. |
| **Zep / Graphiti** | Temporal knowledge graphs for user and business context | Entity/fact graph with temporal invalidation | Rembr shares the belief that time and relationships matter, but packages memory as MCP tools for agent handoff, task orchestration, snapshots, audit, and RLM workflows. |
| **Letta / MemGPT-style agents** | Stateful agents that manage their own core and archival memory | Agent-centric memory blocks plus archival recall | Rembr is not an agent runtime. It is the durable memory/context substrate that many agents or runtimes can share through MCP. |
| **Plain chat history** | Keeping a conversation transcript | Ordered messages | Rembr stores distilled memories, relationships, decisions, snapshots, tasks, audit trails, and searchable context across sessions. |

References:

- [Mem0 platform overview](https://docs.mem0.ai/platform/overview)
- [Zep memory documentation](https://help.getzep.com/v2/memory)
- [Zep temporal knowledge graph concepts](https://help.getzep.com/v2/concepts)
- [Letta memory overview](https://docs.letta.com/guides/agents/memory)
- [LangGraph long-term memory](https://docs.langchain.com/oss/javascript/langchain/long-term-memory)

## What Is In This Repository

- `rembr-mcp` - MCP server for memory, search, contexts, snapshots, graph reasoning, temporal queries, causal reasoning, task workflows, audit tools, and RLM sessions.
- `rembr-vscode` - VS Code/GitHub Copilot integration with agent instructions, prompts, skills, and RLM helper patterns.
- `docs` - Public guides and reference material for using Rembr safely.

Hosted SaaS infrastructure, production manifests, internal runbooks, private operational docs, billing/admin dashboards, and tenant data are intentionally excluded from this public repository.

## Hosted Rembr

This repository is the open-source core. The hosted service at [rembr.ai](https://rembr.ai) adds managed infrastructure, dashboard access, hosted API keys, team plans, higher usage limits, analytics, and operational support.

Useful product pages:

- [Portable Memory](https://rembr.ai/portable-memory) - how Rembr keeps memory continuous across MCP-compatible tools.
- [Agent Debugging](https://rembr.ai/agent-memory) - why temporal memory and causal traces matter for understanding agent decisions.
- [Intelligence vs Storage](https://rembr.ai/storage-vs-intelligence) - why memory systems need more than raw storage and vector search.
- [Documentation](https://rembr.ai/docs) - setup and hosted product docs.

## Core Capabilities

### Durable Memory

Store structured memories with category, metadata, relevance, project, tenant, source, or workflow fields. Use concise durable memories instead of dumping raw transcripts.

```json
{
  "content": "The API gateway validates tenant context before forwarding MCP requests.",
  "category": "facts",
  "metadata": {
    "project": "backend",
    "area": "auth",
    "source": "code-audit"
  }
}
```

### Hybrid Recall

Search with semantic, text, phrase, hybrid, smart, and similar-memory modes. Use exact search for identifiers and semantic search for concepts.

### Contexts And Snapshots

Build a working set of memories for a task or sub-agent, then snapshot it when the handoff needs a stable baseline.

```text
context.create("billing-audit")
context.add_memory(memory_id)
snapshot.create(context_id)
```

### Temporal Reasoning

Ask what was known at a specific time, inspect memory history, and compare snapshot evolution.

### Graph And Causality

Explore related memories, infer relationships, detect contradictions, and trace cause-effect chains.

### RLM And Task Workflows

Use sessions, iterations, acceptance criteria, task state, dependencies, handoff payloads, and work queues for resumable agentic work.

### PII, Audit, And Compliance

Detect and redact PII, query audit logs, build reports, and preserve safer evidence trails for production systems.

## Architecture

```text
AI Agent / MCP Client
        |
        | MCP tools
        v
Rembr MCP Server
        |
        | memory, search, context, graph, temporal, task, audit
        v
PostgreSQL + pgvector
        |
        +-- optional Redis for rate limiting/session cache
        +-- optional Ollama/OpenAI-compatible embeddings
```

Rembr is intentionally exposed through MCP so it can be used by multiple agent runtimes instead of being locked to one framework.

## Quick Start

```sh
git clone https://github.com/radicalgeek/rembr.git
cd rembr/rembr-mcp
npm install
cp .env.example .env
npm run build
npm start
```

Configure your MCP client with your Rembr endpoint and API key:

```json
{
  "mcpServers": {
    "rembr": {
      "type": "http",
      "url": "https://mcp.rembr.ai/mcp",
      "headers": {
        "x-api-key": "your_api_key_here"
      }
    }
  }
}
```

## VS Code Integration

```sh
cd rembr-vscode
npm install
```

See [rembr-vscode/README.md](./rembr-vscode/README.md) for agent, prompt, and RLM workflow setup.

## When To Use Rembr

Use Rembr when your agents need to:

- Remember across sessions.
- Work across projects or tenants.
- Share context with sub-agents.
- Preserve point-in-time handoff bundles.
- Reconstruct decisions.
- Detect stale or contradictory facts.
- Track work across iterations.
- Store acceptance criteria and evidence.
- Reason about how state changed over time.

You may not need Rembr if your app only needs a single-session chatbot transcript or a basic vector search over static documents.

## Development

```sh
cd rembr-mcp
npm install
npm run build
npm audit
```

The public CI runs build and audit checks for the MCP server and audit checks for the VS Code package.

## Security

Never commit real API keys, tokens, passwords, private keys, tenant exports, or production infrastructure details.

See [SECURITY.md](./SECURITY.md) for vulnerability reporting and secret-handling rules.

## License

MIT. See [LICENSE](./LICENSE).
