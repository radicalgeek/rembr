# Rembr

Durable memory and context infrastructure for AI agents.

Rembr gives agents a persistent memory layer for recall, handoff, temporal reasoning, causal analysis, task workflows, and Recursive Language Model (RLM) style work. This public repository contains the open-source Rembr MCP server, VS Code integration, and public documentation.

## What's Included

- `rembr-mcp` - MCP server for memory, search, contexts, snapshots, graph reasoning, temporal queries, task workflows, audit tools, and RLM sessions.
- `rembr-vscode` - VS Code/GitHub Copilot integration with agent instructions, prompts, and RLM helper patterns.
- `docs` - Public guides and reference material for using Rembr safely.

Hosted SaaS infrastructure, production manifests, internal runbooks, private operational docs, billing/admin dashboards, and tenant data are intentionally excluded from this public repository.

## Quick Start

```sh
cd rembr-mcp
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

## Security

Never commit real API keys, tokens, passwords, private keys, tenant exports, or production infrastructure details.

See [SECURITY.md](./SECURITY.md) for vulnerability reporting and secret-handling rules.

## License

MIT. See [LICENSE](./LICENSE).
