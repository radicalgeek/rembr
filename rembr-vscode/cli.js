#!/usr/bin/env node
const { setup } = require('./setup');

console.log('🫐 REMBR VS Code RLM Agent Setup v2.0');

const args = process.argv.slice(2);
const command = args[0];

switch (command) {
  case 'setup':
  case 'init':
    console.log('Setting up GitHub Copilot with RLM agents, skills, and prompts...\n');
    setup(true);
    break;
  
  case 'help':
  case '--help':
  case '-h':
    console.log(`
🫐 REMBR VS Code RLM Agent System v2.0

Usage:
  npx @rembr/vscode setup    Configure RLM agent system in your project
  npx @rembr/vscode help     Show this help message

What it installs:
  • Custom Agents: @rlm (fast) and @ralph-rlm (quality-focused)
  • Skills: RLM orchestration patterns with validation
  • Prompts: /rlm-analyze, /ralph-analyze, /rlm-plan, /ralph-plan
  • Instructions: Memory patterns and code investigation guides
  • MCP Server: Semantic memory integration

Agent Modes:
  • @rlm: Fast decomposition for quick analysis
  • @ralph-rlm: Acceptance-driven loops with quality validation

Usage Examples:
  @rlm Analyze authentication system for security issues
  @ralph-rlm Audit API endpoints for OWASP Top 10 vulnerabilities
  /rlm-analyze "investigate rate limiting implementation"

Benefits:
  • 52% token efficiency improvement for complex tasks
  • Quality assurance through acceptance criteria
  • Persistent semantic memory across sessions
  • Handoffs between agent modes

Requirements:
  • VS Code 1.106+ with GitHub Copilot
  • Settings: chat.agent.enabled, chat.useAgentSkills enabled

Get started:
  1. Run: npx @rembr/vscode setup
  2. Get API key: https://rembr.ai/dashboard/settings
  3. Configure in VS Code: Settings → MCP → rembr.env.REMBR_API_KEY
  4. Enable required VS Code settings (see output)
  5. Try: @rlm or /rlm-analyze

Learn more: https://docs.rembr.ai/rlm-agents
`);
    break;
  
  default:
    if (!command) {
      setup(true);
    } else {
      console.error(`Unknown command: ${command}`);
      console.log('Run `npx @rembr/vscode help` for usage information');
      process.exit(1);
    }
}
