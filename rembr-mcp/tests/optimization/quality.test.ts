import { describe, it, expect, beforeEach, vi } from 'vitest';
import { QualityScorerService } from '../../src/optimization/quality-scorer-service.js';

describe('QualityScorerService', () => {
  let service: QualityScorerService;
  let mockDb: any;

  beforeEach(() => {
    mockDb = { query: vi.fn() };
    service = new QualityScorerService(mockDb);
  });

  it('should calculate quality score for a tenant', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [] }) // SET tenant
      .mockResolvedValueOnce({ rows: [{ // memory stats
        total_memories: '100',
        active_memories: '95',
        archived_memories: '5'
      }] })
      .mockResolvedValueOnce({ rows: [{ // dup stats
        estimated_duplicates: '10'
      }] })
      .mockResolvedValueOnce({ rows: [{ // relationship stats
        total_relationships: '50',
        orphaned_memories: '5',
        highly_connected: '10',
        avg_relationships_per_memory: '2.5'
      }] })
      .mockResolvedValueOnce({ rows: [{ // freshness stats
        fresh_memories: '80',
        outdated_memories: '15'
      }] });

    const result = await service.calculateQualityScore('tenant-1');
    expect(result).toHaveProperty('overallQualityScore');
    expect(result.overallQualityScore).toBeGreaterThanOrEqual(0);
    expect(result.overallQualityScore).toBeLessThanOrEqual(1);
  });

  it('should store quality metrics', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [] }) // SET tenant
      .mockResolvedValueOnce({ rows: [{ id: 'metric-1' }] }); // INSERT

    const result = await service.storeMetrics({
      tenantId: 'tenant-1',
      projectId: undefined,
      totalMemories: 100,
      activeMemories: 95,
      archivedMemories: 5,
      duplicateClusters: 2,
      estimatedDuplicates: 10,
      outdatedMemories: 15,
      freshMemories: 80,
      totalRelationships: 50,
      orphanedMemories: 5,
      highlyConnected: 10,
      avgRelationshipsPerMemory: 2.5,
      relationshipDensity: 0.05,
      overallQualityScore: 0.85,
      metadata: {},
      measuredAt: new Date()
    });

    expect(typeof result).toBe('string');
  });

  it('should detect quality anomalies', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          { memory_id: 'm1', overall_score: 0.2 },
          { memory_id: 'm2', overall_score: 0.3 }
        ]
      });

    const result = await service.detectAnomalies('tenant-1');
    expect(Array.isArray(result)).toBe(true);
  });
});
