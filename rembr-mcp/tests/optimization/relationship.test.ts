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
    delete process.env.RELATIONSHIP_LLM_INFERENCE_ENABLED;
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

  it('uses LLM assessment to classify temporal updates', async () => {
    const embedding = new Array(768).fill(0.5);
    mockOllama.generateText = vi.fn().mockResolvedValue(JSON.stringify({
      relationshipType: 'supersedes',
      confidence: 0.88,
      evidence: 'Memory B is newer and replaces the old production endpoint.'
    }));

    mockDb.query
      .mockResolvedValueOnce({ rows: [] }) // SET tenant
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'm1',
            content: 'Production Rembr uses the old MCP endpoint.',
            category: 'facts',
            embedding,
            relationship_count: '0',
            created_at: new Date('2026-01-01T00:00:00Z')
          },
          {
            id: 'm2',
            content: 'Production Rembr now uses the new OpenAI-compatible MCP endpoint.',
            category: 'facts',
            embedding,
            relationship_count: '0',
            created_at: new Date('2026-07-01T00:00:00Z')
          }
        ]
      })
      .mockResolvedValue({ rows: [{ count: '0' }] });

    const result = await service.inferRelationships('tenant-1', 0.7, 50);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      sourceMemoryId: 'm1',
      targetMemoryId: 'm2',
      relationshipType: 'supersedes',
      confidence: 0.88,
      evidence: 'Memory B is newer and replaces the old production endpoint.'
    });
    expect(mockOllama.generateText).toHaveBeenCalledTimes(1);
  });

  it('falls back to vector classification when LLM response is invalid', async () => {
    const embedding = new Array(768).fill(0.5);
    mockOllama.generateText = vi.fn().mockResolvedValue('not json');

    mockDb.query
      .mockResolvedValueOnce({ rows: [] }) // SET tenant
      .mockResolvedValueOnce({
        rows: [
          { id: 'm1', content: 'A', category: 'facts', embedding, relationship_count: '0' },
          { id: 'm2', content: 'B', category: 'facts', embedding, relationship_count: '0' }
        ]
      })
      .mockResolvedValue({ rows: [{ count: '0' }] });

    const result = await service.inferRelationships('tenant-1', 0.7, 50);

    expect(result[0]).toMatchObject({
      relationshipType: 'similar',
      confidence: 1,
      evidence: 'Vector similarity: 1.000'
    });
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
