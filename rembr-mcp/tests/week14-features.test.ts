import { describe, it, expect, beforeAll, afterAll } from 'vitest';
// Import MCP SDK from node_modules directly  
import { Client } from '../node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StreamableHTTPClientTransport } from '../node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';
import crypto from 'crypto';

// Live e2e test against a running Rembr server. Opt in by pointing
// TEST_MCP_URL at it (plus TEST_API_KEY); skipped otherwise.
const TEST_CONFIG = {
  baseUrl: process.env.TEST_MCP_URL || 'http://localhost:3001/mcp',
  apiKey: process.env.TEST_API_KEY || 'mb_live_test1234',
  timeout: 30000
};

describe.skipIf(!process.env.TEST_MCP_URL)('Week 14 Features: Causal, Temporal & Audit', () => {
  let client: Client;
  let transport: StreamableHTTPClientTransport;
  let testMemoryId1: string;
  let testMemoryId2: string;
  let causalLinkId: string;

  beforeAll(async () => {
    // Initialize MCP client with proper transport
    client = new Client({
      name: 'rembr-week14-test',
      version: '1.0.0'
    }, {
      capabilities: {}
    });

    transport = new StreamableHTTPClientTransport(new URL(TEST_CONFIG.baseUrl), {
      requestInit: {
        headers: {
          'X-API-Key': TEST_CONFIG.apiKey
        }
      }
    });

    await client.connect(transport);
    console.log('✅ MCP client connected');
  }, TEST_CONFIG.timeout);

  afterAll(async () => {
    await client.close();
  });

  describe('Setup: Create test memories', () => {
    it('should store first test memory', async () => {
      const result = await client.callTool({
        name: 'store_memory',
        arguments: {
          content: 'User logged in successfully at 10:00 AM',
          category: 'facts',
          metadata: { test: 'week14', step: 1 }
        }
      });

      expect(result).toBeDefined();
      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(true);
      expect(response.memory).toBeDefined();
      expect(response.memory.id).toBeDefined();
      
      testMemoryId1 = response.memory.id;
      console.log(`  Memory 1 created: ${testMemoryId1}`);
    });

    it('should store second test memory', async () => {
      const result = await client.callTool({
        name: 'store_memory',
        arguments: {
          content: 'User viewed dashboard after login',
          category: 'facts',
          metadata: { test: 'week14', step: 2 }
        }
      });

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(true);
      testMemoryId2 = response.memory.id;
      console.log(`  Memory 2 created: ${testMemoryId2}`);
    });
  });

  describe('Causal Reasoning Features', () => {
    it('should infer causality between memories', async () => {
      const result = await client.callTool({
        name: 'infer_causality',
        arguments: {
          cause_memory_id: testMemoryId1,
          effect_memory_id: testMemoryId2
        }
      });

      const response = JSON.parse(result.content[0].text);
      expect(response.message).toBeDefined();
      
      // Test can succeed or not detect a relationship - both are valid
      if (response.success && response.link) {
        expect(response.link.causal_strength).toBeGreaterThanOrEqual(0);
        expect(response.link.causal_strength).toBeLessThanOrEqual(1);
        causalLinkId = response.link.id; // Store for validation test
        console.log(`  Causal inference: ${response.message} (strength: ${response.link.causal_strength})`);
      } else {
        console.log(`  Causal inference: ${response.message}`);
      }
    });

    it('should get causal links for a memory', async () => {
      const result = await client.callTool({
        name: 'get_causal_links',
        arguments: {
          memory_id: testMemoryId1
        }
      });

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(true);
      expect(response.links).toBeDefined();
      expect(Array.isArray(response.links)).toBe(true);
      expect(response.count).toBeDefined();
      
      console.log(`  Found ${response.count} causal links`);
    });

    it('should trace causal chain', async () => {
      const result = await client.callTool({
        name: 'trace_causality',
        arguments: {
          memory_id: testMemoryId1,
          direction: 'causes',
          max_depth: 5
        }
      });

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(true);
      expect(response.chain).toBeDefined();
      expect(response.summary).toBeDefined();
      
      console.log(`  ${response.summary}`);
    });

    it('should validate causal link', async () => {
      // Skip if no causal link was created
      if (!causalLinkId) {
        console.log('  Skipped: No causal link to validate');
        return;
      }
      
      const result = await client.callTool({
        name: 'validate_causal_link',
        arguments: {
          link_id: causalLinkId,
          is_valid: true
        }
      });

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(true);
      expect(response.message).toBeDefined();
      
      console.log(`  Link validation: ${response.message}`);
    });
  });

  describe('Temporal Query Features', () => {
    it('should get memory history', async () => {
      const result = await client.callTool({
        name: 'get_memory_history',
        arguments: {
          memory_id: testMemoryId1
        }
      });

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(true);
      expect(response.versions).toBeDefined();
      expect(response.versions).toBeGreaterThanOrEqual(1);
      expect(response.history).toBeDefined();
      expect(Array.isArray(response.history)).toBe(true);
      
      console.log(`  Found ${response.versions} version(s) of memory`);
    });

    it('should search at specific time', async () => {
      const now = new Date().toISOString();
      const result = await client.callTool({
        name: 'search_at_time',
        arguments: {
          query: 'login',
          as_of_time: now
        }
      });

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(true);
      expect(response.results).toBeDefined();
      expect(Array.isArray(response.results)).toBe(true);
      
      console.log(`  Found ${response.count} memories at specified time`);
    });

    it('should create temporal snapshot', async () => {
      const snapshotName = `test-snapshot-${Date.now()}`;
      const result = await client.callTool({
        name: 'create_temporal_snapshot',
        arguments: {
          snapshot_name: snapshotName,
          description: 'Test snapshot for Week 14'
        }
      });

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(true);
      expect(response.snapshot_name).toBe(snapshotName);
      expect(response.snapshot_id).toBeDefined();
      
      console.log(`  Created snapshot: ${snapshotName}`);
    });

    it('should compare snapshots', async () => {
      // Compare two different times
      const timeA = new Date(Date.now() - 5000).toISOString(); // 5 seconds ago
      const timeB = new Date().toISOString(); // Now

      const result = await client.callTool({
        name: 'compare_snapshots',
        arguments: {
          time_a: timeA,
          time_b: timeB
        }
      });

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(true);
      expect(response.comparison).toBeDefined();
      expect(response.comparison.added).toBeDefined();
      expect(response.comparison.removed).toBeDefined();
      expect(response.comparison.modified).toBeDefined();
      
      console.log(`  Comparison: +${response.comparison.added} -${response.comparison.removed} ~${response.comparison.modified}`);
    });
  });

  describe('Audit Logging Features', () => {
    it('should query audit logs', async () => {
      const result = await client.callTool({
        name: 'query_audit_log',
        arguments: {
          limit: 10
        }
      });

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(true);
      expect(response.count).toBeDefined();
      expect(response.logs).toBeDefined();
      expect(Array.isArray(response.logs)).toBe(true);
      expect(response.count).toBeGreaterThan(0);
      
      console.log(`  Found ${response.count} audit events`);
      if (response.logs.length > 0) {
        console.log(`  Latest event: ${response.logs[0].action}`);
      }
    });

    it('should get audit statistics', async () => {
      const result = await client.callTool({
        name: 'get_audit_stats',
        arguments: {}
      });

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(true);
      expect(response.stats).toBeDefined();
      expect(response.stats.total_events).toBeDefined();
      expect(response.stats.unique_users).toBeDefined();
      expect(response.stats.successful_events).toBeDefined();
      
      console.log(`  Total events: ${response.stats.total_events}, Unique users: ${response.stats.unique_users}`);
    });

    it('should generate compliance report', async () => {
      const startDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const endDate = new Date().toISOString();

      const result = await client.callTool({
        name: 'generate_compliance_report',
        arguments: {
          start_date: startDate,
          end_date: endDate
        }
      });

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(true);
      expect(response.report).toBeDefined();
      expect(response.report.reportPeriod).toBeDefined();
      expect(response.report.totalEvents).toBeDefined();
      expect(response.report.failureRate).toBeDefined();
      
      console.log(`  Report generated for period: ${response.report.reportPeriod}`);
    });
  });
});