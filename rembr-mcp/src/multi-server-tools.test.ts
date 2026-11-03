/** Tool partition contracts used by the HTTP server, without external services. */
import { describe, it, expect } from 'vitest';
import { getToolsByServerType, getConsolidatedTools, type ServerType } from './tools/consolidated-tools.js';

const names = (type: ServerType) => getToolsByServerType(type).map(tool => tool.name).sort();
const partitions = {
  core: ['context', 'memory', 'search', 'snapshot', 'stats'],
  rlm: ['audit', 'causality', 'classify', 'task_analytics', 'task_export', 'task_handoff', 'temporal'],
  analytics: ['compression', 'context_analytics', 'contradictions', 'graph'],
  contextpilot: ['budget', 'checkpoint', 'context_monitor'],
} as const;

describe('Multi-server tool filtering', () => {
  for (const [type, expected] of Object.entries(partitions)) {
    it(`${type} exposes its current tool partition`, () => {
      expect(names(type as ServerType)).toEqual([...expected].sort());
    });
  }
  it('all contains the union of specialised partitions', () => {
    expect(names('all')).toEqual(Object.values(partitions).flat().sort());
  });
  it('specialised partitions do not overlap', () => {
    const all = Object.keys(partitions).flatMap(type => names(type as ServerType));
    expect(new Set(all).size).toBe(all.length);
  });
  it('every filtered tool retains the complete input contract', () => {
    const complete = getConsolidatedTools();
    for (const type of Object.keys(partitions)) {
      for (const tool of getToolsByServerType(type as ServerType)) {
        expect(tool).toEqual(complete.find(candidate => candidate.name === tool.name));
      }
    }
  });
});
