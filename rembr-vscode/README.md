# @rembr/vscode

**Recursive Language Model (RLM) Integration for VS Code and GitHub Copilot**

Complete RLM setup with custom agents, skills, prompts, and semantic memory integration. Choose between **basic RLM** for fast decomposition or **Ralph-RLM** for acceptance-driven quality assurance.

## Quick Start

```bash
npm install -g @rembr/vscode
rembr-vscode-setup
```

**What happens next?**

✅ **Custom Agents** - `@rlm` and `@ralph-rlm` agents for task orchestration  
✅ **Skill System** - RLM orchestration skills teach decomposition patterns  
✅ **Chat Prompts** - `/rlm-analyze`, `/ralph-analyze` for quick starts  
✅ **Memory Integration** - Persistent context via rembr MCP  
✅ **Token Efficiency** - 51% reduction for complex tasks  

## Agent Modes

| Agent | Description | Best For | Exit Condition |
|-------|-------------|----------|----------------|
| `@rlm` | Basic RLM - fast decomposition | Quick analysis, bug investigation | Task complete |
| `@ralph-rlm` | Acceptance-driven loops | Security audits, quality-critical | All criteria met |

### Basic RLM Flow
```
User Task → Decompose → Investigate Subtasks → Synthesize Results
              ↓
         Store in Rembr (context, facts, learning)
```

### Ralph-RLM Flow  
```
User Task → Define Criteria → LOOP until ALL met:
                ↓              ├── Load criteria
            Store in Rembr     ├── Validate findings
            (goals category)   ├── Update status
                               ├── Check stuck
                               └── Regenerate if needed
```

## Usage Examples

### Using Custom Agents

Select the agent from the agent picker in Chat view:

```
@rlm Analyze the authentication system and identify all password handling
```

```
@ralph-rlm Audit the API endpoints for OWASP Top 10 vulnerabilities
```

### Using Chat Prompts

Type `/` followed by prompt name:

```
/rlm-analyze Investigate how user sessions are managed across services
```

```
/ralph-analyze Perform security audit of payment processing flow
```

```
/rlm-plan Generate decomposition plan for rate limiting implementation
```

### Example Workflows

#### Quick Codebase Analysis
```
@rlm Analyze the authentication system and find all places where passwords are validated
```

**Output:**
- L1-Auth: Authentication middleware analysis
- L1-Validation: Password validation logic  
- L1-Security: Hash verification patterns
- L1-Session: Session management review

#### Security Audit with Validation
```
@ralph-rlm Audit the API endpoints for OWASP Top 10 vulnerabilities

Acceptance Criteria:
✓ Input validation checked
✓ Authentication flaws identified  
✓ Sensitive data exposure reviewed
✓ XML/XXE injection tested
✓ Access control verified
✓ Security misconfiguration found
✓ XSS vulnerabilities checked
✓ Deserialization flaws tested
✓ Component vulnerabilities identified
✓ Logging/monitoring gaps found
```

#### Planning Before Execution
```
/rlm-plan Investigate how rate limiting should be implemented across microservices

Generated Plan:
1. L1-Analysis: Current rate limiting state
2. L1-Architecture: Distributed rate limit design
3. L1-Implementation: Redis-based implementation
4. L1-Monitoring: Metrics and alerting
```

Then execute:
```
@rlm [paste the generated plan above]
```

## Auto-Detection Examples

The system automatically detects when to use RLM patterns:

### ✅ Complex Tasks (Auto-RLM)
```javascript
// Multi-component implementations  
"Implement OAuth2 with JWT refresh tokens, rate limiting, and admin dashboard"

// Cross-service integrations
"Migrate user service to microservices with message queues and monitoring"

// Security audits
"Audit the authentication system for OWASP Top 10 vulnerabilities"

// Architecture analysis
"Analyze the caching layer and identify performance bottlenecks"
```

### 🎯 Simple Tasks (Standard)
```javascript
// Single file changes
"Fix this TypeScript type error"
"Add logging to this function"
"Update README with installation steps"
```

## File Structure Installed

```
your-project/
├── .github/
│   ├── copilot-instructions.md    # Repository-wide RLM instructions
│   ├── agents/
│   │   ├── rlm.agent.md           # Basic RLM agent
│   │   └── ralph-rlm.agent.md     # Acceptance-driven agent
│   ├── skills/
│   │   ├── rlm-orchestration/
│   │   │   └── SKILL.md           # RLM skill definition
│   │   └── ralph-rlm-orchestration/
│   │       └── SKILL.md           # Ralph-RLM skill definition
│   ├── prompts/
│   │   ├── rlm-analyze.prompt.md   # Quick RLM analysis start
│   │   ├── ralph-analyze.prompt.md # Quick Ralph-RLM start
│   │   ├── rlm-plan.prompt.md      # Generate plan only
│   │   └── ralph-plan.prompt.md    # Define criteria only
│   └── instructions/
│       ├── rembr-integration.instructions.md    # Memory patterns
│       └── code-investigation.instructions.md   # Code search patterns
└── .vscode/
    └── settings.json              # MCP configuration
```

## Memory Categories

RLM automatically organizes findings in rembr:

| Category | Purpose | Used By |
|----------|---------|---------|
| `goals` | Acceptance criteria and validation status | Ralph-RLM |
| `context` | Task state, decomposition progress | Both |
| `facts` | Validated findings and discoveries | Both |
| `learning` | Synthesized insights and patterns | Both |

## Performance Benefits

| Complexity | Traditional | RLM Tokens | Reduction | Quality |
|------------|-------------|------------|-----------|---------|
| **High** | 18,400 | 8,800 | **52%** | +2.5 pts |
| **Medium** | 8,200 | 4,900 | **40%** | +1.8 pts |
| **Low** | 2,100 | 2,100 | **0%** | No change |

### Why RLM Works

1. **Focused Context** - Each subagent gets only relevant code/memories
2. **Iterative Validation** - Ralph-RLM ensures quality criteria are met
3. **Persistent Learning** - Solutions stored for future reference
4. **Stuck Detection** - Automatically regenerates plans if blocked

## Agent Handoffs

Agents support workflow transitions:

```
@rlm Can you switch to Ralph-RLM for higher quality validation?
→ Hands off to @ralph-rlm with current context

@ralph-rlm This looks good, switch to basic RLM for faster completion  
→ Hands off to @rlm with findings so far
```

## Configuration

### 1. Set API Key

Configure your rembr API key in VS Code settings:

1. Get key: [rembr.ai/dashboard/settings](https://rembr.ai/dashboard/settings)
2. VS Code: `Cmd+,` → Extensions → MCP → `rembr.env.REMBR_API_KEY`
3. Reload: `Cmd+Shift+P` → "Developer: Reload Window"

### 2. Enable Required Settings

Ensure these VS Code settings are enabled:

```json
{
  "github.copilot.chat.codeGeneration.useInstructionFiles": true,
  "chat.agent.enabled": true,
  "chat.useAgentSkills": true
}
```

### 3. MCP Server Configuration

The installer adds to `.vscode/settings.json`:

```json
{
  "mcp": {
    "mcpServers": {
      "rembr": {
        "command": "npx",
        "args": ["@rembr/mcp-client"],
        "env": {
          "REMBR_API_KEY": "${REMBR_API_KEY}",
          "REMBR_PROJECT_ID": "${REMBR_PROJECT_ID}"
        }
      }
    }
  }
}
```

## Advanced Usage

### Custom Agent Creation

Create domain-specific agents in `.github/agents/`:

```markdown
---
name: Security Auditor
description: Specialized in security analysis with OWASP Top 10 focus
instructions: |
  Use Ralph-RLM patterns for security audits.
  Always define comprehensive acceptance criteria.
  Check for: injection, auth, exposure, XXE, access control,
  misconfiguration, XSS, deserialization, components, logging.
---
```

### Memory Search Patterns

```javascript
// Find related implementations
search_memory({
  query: "rate limiting middleware express redis",
  category: "facts",
  limit: 5
});

// Get similar solutions
find_similar_memories({
  memory_id: "auth-jwt-implementation-abc",
  min_similarity: 0.8
});
```

### Skill Development

Skills teach agents how to orchestrate tasks:

```markdown
# RLM Orchestration Skill

## When to use
- Complex tasks requiring decomposition
- Multi-component implementations
- Cross-system analysis

## How to decompose
1. Analyze task complexity
2. Identify major components  
3. Create focused subtasks
4. Store context in rembr
5. Synthesize findings
```

## Troubleshooting

### Agent not appearing
- Check `.github/agents/*.agent.md` exists
- Verify VS Code version ≥1.106
- Run "Chat: Configure Custom Agents" from Command Palette

### Skills not loading
- Ensure `chat.useAgentSkills` is enabled
- Check `.github/skills/*/SKILL.md` structure
- Skills load automatically based on prompt match

### Memory connection issues
- Verify MCP configuration in settings
- Check environment variables
- Test rembr connection: `curl -H "X-API-Key: YOUR_KEY" https://rembr.ai/health`

### Auto-detection not working
1. Ensure `.github/copilot-instructions.md` exists in project root
2. Restart GitHub Copilot: `Cmd+Shift+P` → "GitHub Copilot: Restart Extension"
3. Use explicit complexity indicators in requests

## Migration from v1.x

If upgrading from v1.x:

1. **Backup**: Save existing `.github/` files
2. **Install**: Run `rembr-vscode-setup` again
3. **Migrate**: Copy custom configurations to new structure
4. **Test**: Try `/rlm-analyze` to verify setup

The new agent-based system replaces the simpler auto-detection patterns.

## Getting Support

- **Documentation**: [docs.rembr.ai/rlm-patterns](https://docs.rembr.ai/rlm-patterns)
- **Examples**: Try `search_memory({query: "implementation example"})`
- **Community**: [GitHub Discussions](https://github.com/rembr-ai/community/discussions)  
- **Issues**: [GitHub Issues](https://github.com/rembr-ai/vscode-extension/issues)

## License

MIT - see [LICENSE](LICENSE) for details.

---

**Version**: 2.0.0  
**Agents**: Basic RLM (`@rlm`) and Ralph-RLM (`@ralph-rlm`)  
**Skills**: RLM orchestration patterns with quality validation  
**Memory Backend**: [rembr.ai](https://rembr.ai) semantic memory service  
**Token Efficiency**: Up to 52% reduction with quality improvements
