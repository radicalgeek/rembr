import { describe, expect, it, vi } from 'vitest';
import { MemoryRelationshipService } from './memory-relationship-service.js';

function createService() {
  return new MemoryRelationshipService(
    { query: vi.fn() } as any,
    { generateEmbedding: vi.fn() } as any
  ) as any;
}

describe('MemoryRelationshipService contradiction heuristics', () => {
  it('detects direct negated predicates on the same subject', () => {
    const service = createService();

    expect(service.hasContradictionPattern(
      'The system is operational',
      'The system is not operational'
    )).toBe(true);
  });

  it('does not flag unrelated text just because one side contains not', () => {
    const service = createService();

    expect(service.hasContradictionPattern(
      'Rembr production is hosted on the test cluster and serves MCP traffic.',
      'API key last_used_at is not reliable proof of recent agent activity.'
    )).toBe(false);
  });

  it('does not flag unrelated true/false or yes/no words without shared subject terms', () => {
    const service = createService();

    expect(service.hasContradictionPattern(
      'The import job returned false for one optional flag.',
      'The deployment approval answer is yes.'
    )).toBe(false);
  });
});
