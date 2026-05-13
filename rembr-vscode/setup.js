#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const os = require('os');

const MCP_CONFIG = {
  servers: {
    rembr: {
      url: "https://rembr.ai/mcp",
      type: "http"
    }
  },
  inputs: []
};

function ensureDirectoryExists(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function setupMCPConfig(projectRoot, toolDir, configFile) {
  const toolConfigDir = path.join(projectRoot, toolDir);
  const mcpConfigPath = path.join(toolConfigDir, configFile);
  
  ensureDirectoryExists(toolConfigDir);
  
  let config = MCP_CONFIG;
  
  // Merge with existing config if it exists
  if (fs.existsSync(mcpConfigPath)) {
    try {
      const existingConfig = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8'));
      config = {
        ...existingConfig,
        servers: {
          ...existingConfig.servers,
          rembr: MCP_CONFIG.servers.rembr
        },
        inputs: existingConfig.inputs || []
      };
      console.log(`✓ Updated existing ${toolDir}/${configFile} with REMBR server`);
    } catch (error) {
      console.warn(`⚠ Could not parse existing ${configFile}, creating new file`);
    }
  } else {
    console.log(`✓ Created ${toolDir}/${configFile} with REMBR server`);
  }
  
  fs.writeFileSync(mcpConfigPath, JSON.stringify(config, null, 2));
}

function setupVSCodeMCP(projectRoot) {
  setupMCPConfig(projectRoot, '.vscode', 'mcp.json');
}

function setupCursorMCP(projectRoot) {
  setupMCPConfig(projectRoot, '.cursor', 'mcp.json');
}

function setupWindsurfMCP(projectRoot) {
  setupMCPConfig(projectRoot, '.windsurf', 'mcp.json');
}

function setupClaudeDesktopMCP() {
  const homeDir = os.homedir();
  let configPath;
  
  if (process.platform === 'darwin') {
    configPath = path.join(homeDir, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  } else if (process.platform === 'win32') {
    configPath = path.join(homeDir, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json');
  } else {
    configPath = path.join(homeDir, '.config', 'Claude', 'claude_desktop_config.json');
  }
  
  const configDir = path.dirname(configPath);
  
  if (!fs.existsSync(configDir)) {
    console.log('⚠ Claude Desktop not found, skipping');
    return;
  }
  
  ensureDirectoryExists(configDir);
  
  let config = { mcpServers: {} };
  
  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (!config.mcpServers) config.mcpServers = {};
    } catch (error) {
      console.warn('⚠ Could not parse Claude Desktop config');
    }
  }
  
  config.mcpServers.rembr = {
    url: "https://rembr.ai/mcp",
    type: "http"
  };
  
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log('✓ Updated Claude Desktop config with REMBR server');
}

function setupGitHubCopilotAgent(projectRoot) {
  const githubDir = path.join(projectRoot, '.github');
  const agentsDir = path.join(githubDir, 'agents');
  
  ensureDirectoryExists(agentsDir);
  
  // New RLM agents (v2.0)
  const agents = [
    'rlm.agent.md',
    'ralph-rlm.agent.md'
  ];
  
  agents.forEach(agentFile => {
    const agentPath = path.join(agentsDir, agentFile);
    const templatePath = path.join(__dirname, 'templates', 'agents', agentFile);
    
    if (fs.existsSync(agentPath)) {
      console.log(`⚠ .github/agents/${agentFile} already exists, skipping`);
      return;
    }
    
    if (!fs.existsSync(templatePath)) {
      console.warn(`⚠ Template ${agentFile} not found, skipping`);
      return;
    }
    
    fs.copyFileSync(templatePath, agentPath);
    console.log(`✓ Created .github/agents/${agentFile}`);
  });
  
  // Legacy agent for backwards compatibility
  const legacyAgentPath = path.join(agentsDir, 'recursive-analyst.agent.md');
  const legacyTemplatePath = path.join(__dirname, 'templates', 'recursive-agent.agent.md');
  
  if (!fs.existsSync(legacyAgentPath) && fs.existsSync(legacyTemplatePath)) {
    fs.copyFileSync(legacyTemplatePath, legacyAgentPath);
    console.log('✓ Created .github/agents/recursive-analyst.agent.md (legacy)');
  }
}

function setupGitHubCopilotInstructions(projectRoot) {
  const githubDir = path.join(projectRoot, '.github');
  const instructionsPath = path.join(githubDir, 'copilot-instructions.md');
  
  ensureDirectoryExists(githubDir);
  
  const templatePath = path.join(__dirname, 'templates', 'copilot-instructions.md');
  
  if (!fs.existsSync(templatePath)) {
    console.warn('⚠ copilot-instructions.md template not found, skipping');
    return;
  }
  
  const instructionsContent = fs.readFileSync(templatePath, 'utf8');
  
  if (fs.existsSync(instructionsPath)) {
    console.log('⚠ .github/copilot-instructions.md already exists, skipping');
    return;
  }
  
  fs.writeFileSync(instructionsPath, instructionsContent);
  console.log('✓ Created .github/copilot-instructions.md with RLM patterns');
}

function setupRLMSkills(projectRoot) {
  const skillsDir = path.join(projectRoot, '.github', 'skills');
  ensureDirectoryExists(skillsDir);
  
  const skills = [
    'rlm-orchestration',
    'ralph-rlm-orchestration'
  ];
  
  skills.forEach(skillName => {
    const skillDir = path.join(skillsDir, skillName);
    const skillPath = path.join(skillDir, 'SKILL.md');
    const templatePath = path.join(__dirname, 'templates', 'skills', skillName, 'SKILL.md');
    
    if (fs.existsSync(skillPath)) {
      console.log(`⚠ .github/skills/${skillName}/SKILL.md already exists, skipping`);
      return;
    }
    
    if (!fs.existsSync(templatePath)) {
      console.warn(`⚠ Template skill ${skillName} not found, skipping`);
      return;
    }
    
    ensureDirectoryExists(skillDir);
    fs.copyFileSync(templatePath, skillPath);
    console.log(`✓ Created .github/skills/${skillName}/SKILL.md`);
  });
}

function setupRLMPrompts(projectRoot) {
  const promptsDir = path.join(projectRoot, '.github', 'prompts');
  ensureDirectoryExists(promptsDir);
  
  const prompts = [
    'rlm-analyze.prompt.md',
    'ralph-analyze.prompt.md',
    'rlm-plan.prompt.md',
    'ralph-plan.prompt.md'
  ];
  
  prompts.forEach(promptFile => {
    const promptPath = path.join(promptsDir, promptFile);
    const templatePath = path.join(__dirname, 'templates', 'prompts', promptFile);
    
    if (fs.existsSync(promptPath)) {
      console.log(`⚠ .github/prompts/${promptFile} already exists, skipping`);
      return;
    }
    
    if (!fs.existsSync(templatePath)) {
      console.warn(`⚠ Template prompt ${promptFile} not found, skipping`);
      return;
    }
    
    fs.copyFileSync(templatePath, promptPath);
    console.log(`✓ Created .github/prompts/${promptFile}`);
  });
}

function setupRLMInstructions(projectRoot) {
  const instructionsDir = path.join(projectRoot, '.github', 'instructions');
  ensureDirectoryExists(instructionsDir);
  
  const instructions = [
    'rembr-integration.instructions.md',
    'code-investigation.instructions.md'
  ];
  
  instructions.forEach(instructionFile => {
    const instructionPath = path.join(instructionsDir, instructionFile);
    const templatePath = path.join(__dirname, 'templates', 'instructions', instructionFile);
    
    if (fs.existsSync(instructionPath)) {
      console.log(`⚠ .github/instructions/${instructionFile} already exists, skipping`);
      return;
    }
    
    if (!fs.existsSync(templatePath)) {
      console.warn(`⚠ Template instruction ${instructionFile} not found, skipping`);
      return;
    }
    
    fs.copyFileSync(templatePath, instructionPath);
    console.log(`✓ Created .github/instructions/${instructionFile}`);
  });
}

function setupRLMHelper(projectRoot) {
  const helperPath = path.join(projectRoot, 'rlm-helper.js');
  const templatePath = path.join(__dirname, 'templates', 'rlm-helper.js');
  
  if (fs.existsSync(helperPath)) {
    console.log('⚠ rlm-helper.js already exists, skipping');
    return;
  }
  
  fs.copyFileSync(templatePath, helperPath);
  fs.chmodSync(helperPath, '755'); // Make executable
  console.log('✓ Created rlm-helper.js for task coordination');
}

function setupRLMDocumentation(projectRoot) {
  const docsDir = path.join(projectRoot, 'docs');
  ensureDirectoryExists(docsDir);
  
  // RLM Getting Started Guide
  const gettingStartedPath = path.join(docsDir, 'rlm-patterns.md');
  if (!fs.existsSync(gettingStartedPath)) {
    const templatePath = path.join(__dirname, 'templates', 'rlm-getting-started.md');
    fs.copyFileSync(templatePath, gettingStartedPath);
    console.log('✓ Created docs/rlm-patterns.md');
  }
  
  // Benchmark Results
  const benchmarkPath = path.join(docsDir, 'rlm-benchmarks.md');
  if (!fs.existsSync(benchmarkPath)) {
    const templatePath = path.join(__dirname, 'templates', 'rlm-benchmarks.md');
    fs.copyFileSync(templatePath, benchmarkPath);
    console.log('✓ Created docs/rlm-benchmarks.md');
  }
}

function setupCursorRules(projectRoot) {
  const cursorRulesPath = path.join(projectRoot, '.cursorrules');
  const templatePath = path.join(__dirname, 'templates', 'cursorrules');
  
  if (fs.existsSync(cursorRulesPath)) {
    // Append REMBR section if not already present
    const existing = fs.readFileSync(cursorRulesPath, 'utf8');
    if (existing.includes('REMBR') || existing.includes('rembr')) {
      console.log('⚠ .cursorrules already contains REMBR instructions, skipping');
      return;
    }
    const template = fs.readFileSync(templatePath, 'utf8');
    fs.writeFileSync(cursorRulesPath, existing + '\n\n' + template);
    console.log('✓ Appended REMBR instructions to .cursorrules');
  } else {
    fs.copyFileSync(templatePath, cursorRulesPath);
    console.log('✓ Created .cursorrules with REMBR instructions');
  }
}

function setupWindsurfRules(projectRoot) {
  const windsurfRulesPath = path.join(projectRoot, '.windsurfrules');
  const templatePath = path.join(__dirname, 'templates', 'windsurfrules');
  
  if (fs.existsSync(windsurfRulesPath)) {
    const existing = fs.readFileSync(windsurfRulesPath, 'utf8');
    if (existing.includes('REMBR') || existing.includes('rembr')) {
      console.log('⚠ .windsurfrules already contains REMBR instructions, skipping');
      return;
    }
    const template = fs.readFileSync(templatePath, 'utf8');
    fs.writeFileSync(windsurfRulesPath, existing + '\n\n' + template);
    console.log('✓ Appended REMBR instructions to .windsurfrules');
  } else {
    fs.copyFileSync(templatePath, windsurfRulesPath);
    console.log('✓ Created .windsurfrules with REMBR instructions');
  }
}

function setupAiderConfig(projectRoot) {
  const aiderConfigPath = path.join(projectRoot, '.aider.conf.yml');
  const templatePath = path.join(__dirname, 'templates', 'aider.conf.yml');
  
  if (fs.existsSync(aiderConfigPath)) {
    console.log('⚠ .aider.conf.yml already exists, skipping');
    console.log('  Add these lines manually:');
    console.log('  - Use REMBR for persistent semantic memory');
    console.log('  - MCP server: https://rembr.ai/mcp');
    return;
  }
  
  fs.copyFileSync(templatePath, aiderConfigPath);
  console.log('✓ Created .aider.conf.yml with REMBR instructions');
}

function setup(interactive = false) {
  // Find project root (where package.json or .git exists)
  let projectRoot = process.cwd();
  
  while (!fs.existsSync(path.join(projectRoot, 'package.json')) && 
         !fs.existsSync(path.join(projectRoot, '.git')) && 
         projectRoot !== '/') {
    projectRoot = path.dirname(projectRoot);
  }
  
  if (projectRoot === '/') {
    projectRoot = process.cwd();
  }
  
  console.log('\n🫐 Setting up REMBR client configuration...\n');
  
  try {
    // Set up MCP for VS Code
    console.log('📡 Configuring MCP servers for VS Code...');
    setupVSCodeMCP(projectRoot);
    setupClaudeDesktopMCP(); // Global config
    
    console.log('\n🤖 Configuring AI agents and RLM patterns...');
    setupGitHubCopilotAgent(projectRoot);
    setupGitHubCopilotInstructions(projectRoot);
    setupRLMSkills(projectRoot);
    setupRLMPrompts(projectRoot);
    setupRLMInstructions(projectRoot);
    setupRLMHelper(projectRoot);
    setupRLMDocumentation(projectRoot);
    
    console.log('\n✨ @rembr/vscode setup complete!\n');
    console.log('🧠 RLM Agent System Installed (v2.0):');
    console.log('  • Custom Agents: @rlm and @ralph-rlm');
    console.log('  • Skills: RLM orchestration patterns with quality validation');
    console.log('  • Prompts: /rlm-analyze, /ralph-analyze, /rlm-plan, /ralph-plan');
    console.log('  • Instructions: Memory patterns and code investigation');
    console.log('  • Semantic memory with rembr MCP integration');
    console.log('\n📡 MCP Configured for:');
    console.log('  • VS Code + GitHub Copilot');
    console.log('  • Claude Desktop');
    console.log('\n📖 Documentation Created:');
    console.log('  • docs/rlm-patterns.md - Complete usage guide');
    console.log('  • docs/rlm-benchmarks.md - Performance analysis');
    console.log('  • rlm-helper.js - Task coordination script');
    console.log('\nNext steps:');
    console.log('1. Get your API key at https://rembr.ai/dashboard/settings');
    console.log('2. Set REMBR_API_KEY in VS Code settings:');
    console.log('   Settings → Extensions → MCP → rembr.env.REMBR_API_KEY');
    console.log('3. Enable required settings:');
    console.log('   • github.copilot.chat.codeGeneration.useInstructionFiles: true');
    console.log('   • chat.agent.enabled: true');
    console.log('   • chat.useAgentSkills: true');
    console.log('4. Reload VS Code to activate agents and skills');
    console.log('5. Try agents: @rlm for analysis, @ralph-rlm for quality validation');
    console.log('6. Try prompts: /rlm-analyze "audit authentication system"');
    console.log('\n💡 Agent modes:');
    console.log('  • @rlm: Fast decomposition for quick analysis');
    console.log('  • @ralph-rlm: Acceptance-driven loops for quality assurance\n');
  } catch (error) {
    console.error('❌ Setup failed:', error.message);
    process.exit(1);
  }
}

module.exports = { setup };

// Run setup if called directly
if (require.main === module) {
  setup(true);
}
