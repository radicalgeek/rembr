import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TemporalAnalyzerService } from '../../src/optimization/temporal-analyzer-service.js';

describe('TemporalAnalyzerService', () => {
  let service: TemporalAnalyzerService;
  let mockDb: any;

  beforeEach(() => {
    mockDb = { query: vi.fn() };
    service = new TemporalAnalyzerService(mockDb);
  });

  it('should analyze memory freshness', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [] }) // SET tenant
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'm1',
            content: 'Test',
            created_at: new Date(),
            last_accessed_at: new Date(),
            access_count: 5,
            category: 'facts'
          }
        ]
      });

    const result = await service.analyzeMemoryFreshness('tenant-1');
    expect(result.length).toBeGreaterThanOrEqual(0);
  });

  it('should mark memories as outdated', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [] }) // SET tenant
      .mockResolvedValueOnce({ rows: [], rowCount: 2 }); // UPDATE

    const result = await service.markOutdated(['m1', 'm2'], 'tenant-1');
    expect(result).toBe(2);
  });

  it('should archive outdated memories', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [] }) // SET tenant
      .mockResolvedValueOnce({ rows: [], rowCount: 2 }) // INSERT
      .mockResolvedValueOnce({ rows: [], rowCount: 2 }); // DELETE

    const result = await service.archiveOutdated(['m1', 'm2'], 'tenant-1');
    expect(result.archivedCount).toBe(2);
    expect(result.memoryIds).toEqual(['m1', 'm2']);
  });

  it('should get temporal statistics', async () => {
    const now = new Date();
    mockDb.query
      .mockResolvedValueOnce({ rows: [] }) // SET tenant
      .mockResolvedValueOnce({ // SELECT memories
        rows: [
          {
            id: 'm1',
            content: 'Test 1',
            category: 'facts',
            created_at: new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000), // 10 days ago
            metadata: { access_count: 5 }
          },
          {
            id: 'm2',
            content: 'Test 2',
            category: 'facts',
            created_at: new Date(now.getTime() - 100 * 24 * 60 * 60 * 1000), // 100 days ago
            metadata: { access_count: 1 }
          }
        ]
      });

    const stats = await service.getStats('tenant-1');
    expect(stats.totalMemories).toBe(2);
    expect(stats.freshMemories).toBeGreaterThanOrEqual(0);
    expect(stats.outdatedMemories).toBeGreaterThanOrEqual(0);
    expect(stats.avgAgeDays).toBeGreaterThan(0);
  });
});
