/**
 * Integration test for multi-server split (REM-38 Phase 2)
 * 
 * Verifies that:
 * 1. Each server type exposes the correct tools
 * 2. SERVER_TYPE environment variable is respected
 * 3. Tool filtering works correctly at runtime
 * 4. Backward compatibility is maintained
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, ChildProcess } from 'child_process';

// Spawns real server processes from dist/ and needs PostgreSQL + Redis on
// localhost. Opt in explicitly: RUN_MULTI_SERVER_TESTS=true npm run test:integration
const RUN_MULTI_SERVER = process.env.RUN_MULTI_SERVER_TESTS === 'true';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

// Helper to start a server with specific SERVER_TYPE
async function startServer(serverType: 'core' | 'rlm' | 'analytics' | 'all', port: number): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const server = spawn('node', ['dist/index-http.js'], {
      env: {
        ...process.env,
        SERVER_TYPE: serverType,
        PORT: port.toString(),
        DB_HOST: 'localhost',
        DB_PORT: '5432',
        DB_NAME: 'rembr_test',
        DB_USER: 'postgres',
        DB_PASSWORD: 'postgres',
        REDIS_HOST: 'localhost',
        REDIS_PORT: '6379',
        NODE_ENV: 'test'
      }
    });

    server.stdout?.on('data', (data) => {
      if (data.toString().includes('listening on port')) {
        resolve(server);
      }
    });

    server.stderr?.on('data', (data) => {
      console.error(`Server ${serverType} error:`, data.toString());
    });

    // Timeout after 10 seconds
    setTimeout(() => {
      reject(new Error(`Server ${serverType} failed to start within 10 seconds`));
    }, 10000);
  });
}

// Helper to fetch tools from a server
async function fetchTools(port: number): Promise<Tool[]> {
  const response = await fetch(`http://localhost:${port}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list'
    })
  });

  const data = await response.json();
  return data.result?.tools || [];
}

describe.skipIf(!RUN_MULTI_SERVER)('Multi-Server Split Integration Tests', () => {
  const servers: Map<string, ChildProcess> = new Map();
  const ports = {
    core: 4001,
    rlm: 4002,
    analytics: 4003,
    all: 4004
  };

  beforeAll(async () => {
    // Start all server types
    for (const [type, port] of Object.entries(ports)) {
      const server = await startServer(type as any, port);
      servers.set(type, server);
    }

    // Wait a bit for all servers to be ready
    await new Promise(resolve => setTimeout(resolve, 2000));
  }, 60000); // 60 second timeout for server startup

  afterAll(async () => {
    // Stop all servers
    for (const server of servers.values()) {
      server.kill();
    }
  });

  it('core server should expose exactly 5 tools', async () => {
    const tools = await fetchTools(ports.core);
    expect(tools).toHaveLength(5);
    
    const toolNames = tools.map(t => t.name).sort();
    expect(toolNames).toEqual(['context', 'memory', 'search', 'snapshot', 'stats']);
  });

  it('rlm server should expose exactly 4 tools', async () => {
    const tools = await fetchTools(ports.rlm);
    expect(tools).toHaveLength(4);
    
    const toolNames = tools.map(t => t.name).sort();
    expect(toolNames).toEqual(['audit', 'causality', 'classify', 'temporal']);
  });

  it('analytics server should expose exactly 2 tools', async () => {
    const tools = await fetchTools(ports.analytics);
    expect(tools).toHaveLength(2);
    
    const toolNames = tools.map(t => t.name).sort();
    expect(toolNames).toEqual(['contradictions', 'graph']);
  });

  it('all server should expose exactly 11 tools', async () => {
    const tools = await fetchTools(ports.all);
    expect(tools).toHaveLength(11);
    
    const toolNames = tools.map(t => t.name).sort();
    expect(toolNames).toEqual([
      'audit',
      'causality',
      'classify',
      'context',
      'contradictions',
      'graph',
      'memory',
      'search',
      'snapshot',
      'stats',
      'temporal'
    ]);
  });

  it('tool count should match expectations', async () => {
    const coreTools = await fetchTools(ports.core);
    const rlmTools = await fetchTools(ports.rlm);
    const analyticsTools = await fetchTools(ports.analytics);
    const allTools = await fetchTools(ports.all);

    // Core + RLM + Analytics should equal All
    expect(coreTools.length + rlmTools.length + analyticsTools.length).toBe(allTools.length);
    expect(allTools.length).toBe(11);
  });

  it('no tool overlap between specialized servers', async () => {
    const coreTools = await fetchTools(ports.core);
    const rlmTools = await fetchTools(ports.rlm);
    const analyticsTools = await fetchTools(ports.analytics);

    const coreNames = new Set(coreTools.map(t => t.name));
    const rlmNames = new Set(rlmTools.map(t => t.name));
    const analyticsNames = new Set(analyticsTools.map(t => t.name));

    // Check no overlap between core and rlm
    for (const name of coreNames) {
      expect(rlmNames.has(name)).toBe(false);
      expect(analyticsNames.has(name)).toBe(false);
    }

    // Check no overlap between rlm and analytics
    for (const name of rlmNames) {
      expect(analyticsNames.has(name)).toBe(false);
    }
  });

  it('all server should contain all tools from specialized servers', async () => {
    const coreTools = await fetchTools(ports.core);
    const rlmTools = await fetchTools(ports.rlm);
    const analyticsTools = await fetchTools(ports.analytics);
    const allTools = await fetchTools(ports.all);

    const allToolNames = new Set(allTools.map(t => t.name));

    // Every tool from core should be in all
    for (const tool of coreTools) {
      expect(allToolNames.has(tool.name)).toBe(true);
    }

    // Every tool from rlm should be in all
    for (const tool of rlmTools) {
      expect(allToolNames.has(tool.name)).toBe(true);
    }

    // Every tool from analytics should be in all
    for (const tool of analyticsTools) {
      expect(allToolNames.has(tool.name)).toBe(true);
    }
  });
});
