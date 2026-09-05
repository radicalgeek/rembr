import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  getMetrics,
  trackEmbeddingGeneration,
  trackMcpToolCall,
  trackMemoryOperation,
  updateActiveMemories,
} from './metrics.js';

describe('Prometheus cardinality and identifier privacy', () => {
  it('never emits tenant/project IDs and buckets unknown model/tool values', async () => {
    const tenantId = 'tenant-attacker-550e8400-e29b-41d4-a716-446655440000';
    const projectId = 'project-attacker-550e8400-e29b-41d4-a716-446655440001';
    const attackerValue = 'attacker-controlled-cardinality-value';

    trackMemoryOperation('attacker-operation', 'success', tenantId);
    updateActiveMemories(tenantId, projectId, 1);
    trackMcpToolCall(attackerValue, 'success', tenantId, 0.01);
    trackEmbeddingGeneration(attackerValue, attackerValue, 0.01);

    const metrics = await getMetrics();
    expect(metrics).not.toContain(tenantId);
    expect(metrics).not.toContain(projectId);
    expect(metrics).not.toContain(attackerValue);
    expect(metrics).toContain('provider="unknown"');
    expect(metrics).toContain('model="custom"');
    expect(metrics).toContain('tool_name="unknown"');
  });

  it('statically forbids principal/resource IDs as Prometheus label arguments or names', () => {
    const violations: string[] = [];
    const forbiddenArgument = /\.labels\(\s*(?:this\.)?(?:tenant|user|project|memory|request|apiKey)Id\b/;
    const forbiddenLabelName = /labelNames\s*:\s*\[[^\]]*['"](?:tenant|user|project|memory|request|api_key)_id['"]/s;
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
          const source = readFileSync(path, 'utf8');
          if (forbiddenArgument.test(source) || forbiddenLabelName.test(source)) violations.push(path);
        }
      }
    };
    walk(join(process.cwd(), 'src'));
    expect(violations).toEqual([]);
  });
});
