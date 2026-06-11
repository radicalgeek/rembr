# Changelog

All notable changes to @rembr/vscode will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2026-01-10

### Added

#### Complete RLM Agent System
- **Custom Agents**: `@rlm` (basic decomposition) and `@ralph-rlm` (acceptance-driven quality)
- **Skills**: RLM orchestration patterns with quality validation
  - `rlm-orchestration/SKILL.md` - Basic RLM decomposition patterns
  - `ralph-rlm-orchestration/SKILL.md` - Acceptance-driven loop patterns
- **Prompts**: Quick-start commands for Chat interface
  - `/rlm-analyze` - Start basic RLM analysis
  - `/ralph-analyze` - Start acceptance-driven analysis  
  - `/rlm-plan` - Generate decomposition plan only
  - `/ralph-plan` - Define acceptance criteria only
- **Instructions**: Specialized guidance for agents
  - `rembr-integration.instructions.md` - Memory storage patterns
  - `code-investigation.instructions.md` - Code search best practices

#### Agent Architecture
- **Basic RLM**: Fast task decomposition with single-pass completion
- **Ralph-RLM**: Iterative quality loops with acceptance criteria validation
- **Handoffs**: Seamless transitions between agent modes
- **Stuck Detection**: Auto-regenerates plans when blocked (Ralph-RLM)
- **Memory Categories**: Specialized storage (goals, context, facts, learning)

#### Enhanced Setup
- Updated installer copies complete `.github/` structure
- VS Code settings requirements check
- Migration guide for v1.x users
- Backwards compatibility with existing recursive-analyst agent

### Changed

#### Breaking Changes
- **Package Scope**: Renamed from `@rembr/client` to `@rembr/vscode`
- **Architecture**: Agent-based system replaces simple auto-detection
- **File Structure**: Complete `.github/` directory with agents, skills, prompts, instructions
- **Usage**: Chat agents (`@rlm`, `@ralph-rlm`) replace automatic pattern recognition

#### Improved
- **Token Efficiency**: Up to 52% reduction with quality improvements
- **Quality Assurance**: Ralph-RLM ensures acceptance criteria are met
- **Developer Experience**: Explicit agent selection vs automatic detection
- **Documentation**: Comprehensive examples and workflow guides

### Migration from v1.x

1. Backup existing `.github/` files
2. Run `rembr-vscode-setup` to install v2.0 structure
3. Copy custom configurations to new format
4. Enable required VS Code settings:
   - `github.copilot.chat.codeGeneration.useInstructionFiles: true`
   - `chat.agent.enabled: true` 
   - `chat.useAgentSkills: true`
5. Test with `/rlm-analyze` to verify setup

## [1.0.0] - 2026-01-06

### Added

- Initial release of @rembr/client
- Automatic MCP server configuration for:
  - VS Code + GitHub Copilot (`.vscode/mcp.json`)
  - Cursor (`.cursor/mcp.json`)
  - Windsurf (`.windsurf/mcp.json`)
  - Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json`)
- Recursive Analyst agent template for GitHub Copilot (`.github/agents/recursive-analyst.agent.md`)
- Cursor integration rules (`.cursorrules`)
- Windsurf cascade instructions (`.windsurfrules`)
- Aider configuration (`.aider.conf.yml`)
- CLI tool: `npx rembr setup`
- Postinstall setup (optional, can be disabled with `SKIP_REMBR_SETUP=1`)

### REMBR Server Features (v1.0.0)

**Core Memory Tools (5)**:
- `store_memory` - Store new memories with categories and metadata
- `search_memory` - Hybrid, semantic, text, or phrase search with metadata filtering
- `update_memory` - Update existing memories (auto-regenerates embeddings)
- `delete_memory` - Remove memories
- `list_memories` - List recent memories by category
- `get_memory` - Retrieve specific memory by ID

**Discovery Tools (2)**:
- `find_similar_memories` - Discover related memories via semantic similarity
- `get_embedding_stats` - Monitor embedding coverage and semantic search status

**Statistics (1)**:
- `get_stats` - Usage statistics, plan limits, memory counts

**Context Management for RLMs (3)**:
- `create_context` - Create logical groupings for related memories
- `list_contexts` - List all contexts in project
- `search_context` - Scoped search within a specific context
- `add_memory_to_context` - Link memories to contexts

**Snapshots for Sub-Agent Handoff (3)**:
- `create_snapshot` - Immutable memory snapshots with TTL
- `get_snapshot` - Retrieve snapshot with memories
- `list_snapshots` - List available snapshots

**Compilation & Analysis (3)**:
- `get_memory_graph` - Relationship graph for context memories
- `detect_contradictions` - Find contradicting memories
- `get_context_insights` - Pre-compiled insights (categories, temporal patterns, entities)

### Search Capabilities

**4 Search Modes**:
1. **hybrid** (default) - 0.7 semantic + 0.3 text (best for general use)
2. **semantic** - Conceptual similarity via pgvector embeddings
3. **text** - Fast fuzzy matching via pg_trgm
4. **phrase** - Multi-word exact matching via PostgreSQL full-text search

**Metadata Filtering**:
- Filter by any metadata field: `{taskId: "...", area: "...", file: "..."}`
- Essential for RLM task isolation and sub-agent context management

**Performance** (10K memories):
- Phrase search: ~30ms
- Text search: ~15ms
- Semantic search: ~25ms
- Hybrid search: ~45ms
- +10ms per metadata filter

### Pricing Tiers

- **Free**: 1,000 memories, 100 searches/day
- **Starter** (£9/mo): 10,000 memories, 1,000 searches/day
- **Pro** (£29/mo): 100,000 memories, 10,000 searches/day
- **Enterprise** (£99/mo): 1M memories, unlimited searches

### Documentation

- Comprehensive README with setup instructions
- Recursive Analyst agent template with RLM patterns
- Tool-specific configuration for each supported editor
- Examples for all search modes and metadata filtering

[1.0.0]: https://github.com/radicalgeek/rembr-client/releases/tag/v1.0.0
