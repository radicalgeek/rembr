import { describe, expect, it, vi } from 'vitest';
import { MemoryService } from './memory-service.js';

describe('MemoryService search accounting', () => {
  it('reserves exactly one search for text, phrase, hybrid and hybrid fallback', async () => {
    const db = {
      reserveSearchQuota: vi.fn(async () => undefined),
      searchMemories: vi.fn(async () => []),
      semanticSearch: vi.fn(async () => []),
      query: vi.fn(async () => ({ rows: [{ total: 0, indexed: 0 }] })),
    } as any;
    const provider = {
      name: 'test', model: 'test', dimensions: 2,
      generateEmbedding: vi.fn(async () => [0.1, 0.2]),
    } as any;
    const service = new MemoryService(
      '550e8400-e29b-41d4-a716-446655440000',
      '22222222-2222-4222-8222-222222222222',
      db,
      provider,
      '11111111-1111-4111-8111-111111111111',
    );

    await service.searchMemory({ query: 'text', search_mode: 'text' });
    await service.searchMemory({ query: 'phrase', search_mode: 'phrase' });
    await service.searchMemory({ query: 'hybrid', search_mode: 'hybrid' });
    provider.generateEmbedding.mockRejectedValueOnce(new Error('provider unavailable'));
    await service.searchMemory({ query: 'fallback', search_mode: 'hybrid' });

    expect(db.reserveSearchQuota).toHaveBeenCalledTimes(4);
    expect(db.searchMemories).toHaveBeenCalledTimes(4);
    expect(db.semanticSearch).toHaveBeenCalledTimes(1);
  });

  it('rejects at quota before calling an embedding provider or search query', async () => {
    const db = {
      reserveSearchQuota: vi.fn(async () => { throw new Error('Daily search limit reached'); }),
      searchMemories: vi.fn(),
      semanticSearch: vi.fn(),
    } as any;
    const provider = {
      name: 'test', model: 'test', dimensions: 2,
      generateEmbedding: vi.fn(),
    } as any;
    const service = new MemoryService(
      '550e8400-e29b-41d4-a716-446655440000', undefined, db, provider,
    );

    await expect(service.searchMemory({ query: 'blocked', search_mode: 'hybrid' }))
      .rejects.toThrow('Daily search limit reached');
    expect(provider.generateEmbedding).not.toHaveBeenCalled();
    expect(db.searchMemories).not.toHaveBeenCalled();
    expect(db.semanticSearch).not.toHaveBeenCalled();
  });
});
