import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RelationshipMaintainerService } from '../../src/optimization/relationship-maintainer-service.js';

describe('RelationshipMaintainerService', () => {
  let service: RelationshipMaintainerService;
  let mockDb: any;
  let mockOllama: any;

  beforeEach(() => {
    mockDb = { query: vi.fn() };
    mockOllama = { generateEmbedding: vi.fn() };
    service = new RelationshipMaintainerService(mockDb, mockOllama);
  });

  it('should infer relationships', async () => {
    const embedding = new Array(768).fill(0.5);
    
    mockDb.query
      .mockResolvedValueOnce({ rows: [] }) // SET tenant
      .mockResolvedValueOnce({ // SELECT memories with low relationships
        rows: [
          { id: 'm1', content: 'A', category: 'facts', embedding, relationship_count: '0' },
          { id: 'm2', content: 'B', category: 'facts', embedding, relationship_count: '1' }
        ]
      })
      .mockResolvedValue({ rows: [{ count: '0' }] }); // hasRelationship checks (multiple calls)

    const result = await service.inferRelationships('tenant-1', 0.7, 50);
    expect(Array.isArray(result)).toBe(true);
  });

  it('should create relationships', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [] }) // SET tenant
      .mockResolvedValueOnce({ rows: [{ id: 'r1' }] }); // INSERT

    const result = await service.createRelationships([{
      sourceMemoryId: 'm1',
      targetMemoryId: 'm2',
      relationshipType: 'semantic_similarity',
      confidence: 0.9,
      evidence: {}
    }], 'tenant-1');

    expect(result).toBe(1);
  });

  it('should update relationship weights', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [] }) // SET tenant
      .mockResolvedValueOnce({ rows: [], rowCount: 5 }); // UPDATE

    const result = await service.updateWeights('tenant-1');
    expect(result.updated).toBe(5);
  });

  it('should prune weak relationships', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [] }) // SET tenant
      .mockResolvedValueOnce({ rows: [], rowCount: 3 }); // DELETE

    const result = await service.pruneWeak('tenant-1', 0.5);
    expect(result).toBe(3);
  });

  it('should get relationship statistics', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [] }) // SET tenant
      .mockResolvedValueOnce({ rows: [{ 
        total_relationships: '100',
        total_memories: '50',
        orphaned: 5,
        highly_connected: 10
      }] });

    const stats = await service.getStats('tenant-1');
    expect(stats).toHaveProperty('totalRelationships');
    expect(stats).toHaveProperty('avgRelationshipsPerMemory');
    expect(stats).toHaveProperty('orphanedMemories');
    expect(stats).toHaveProperty('highlyConnected');
  });
});
