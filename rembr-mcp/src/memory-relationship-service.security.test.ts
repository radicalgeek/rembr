import { describe, expect, it, vi } from 'vitest';
import { MemoryRelationshipService } from './memory-relationship-service.js';

describe('MemoryRelationshipService resource boundaries', () => {
  it('bounds the candidate query and defensively caps returned rows before parsing', async () => {
    const rows = Array.from({ length: 10_000 }, (_, index) => ({
      id: `memory-${index}`,
      content: 'bounded',
      category: 'facts',
      metadata: {},
      embedding_text: index === 0 ? '[0.1,0.2]' : 'not-json',
    }));
    const query = vi.fn().mockResolvedValue({ rows });
    const service = new MemoryRelationshipService(
      { query } as any,
      {} as any,
    );

    const candidates = await (service as any).getCandidateMemories(
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
      undefined,
      undefined,
    );

    expect(candidates).toHaveLength(100);
    expect(candidates[0].embedding).toEqual([0.1, 0.2]);
    expect(candidates[1].embedding).toBeNull();
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/LEFT\(m\.content, \$5::integer\)/);
    expect(sql).toMatch(/octet_length\(me\.embedding::text\) <= \$6::integer/);
    expect(sql).toMatch(/LIMIT \$7::integer/);
    expect(params[6]).toBe(100);
  });
});
