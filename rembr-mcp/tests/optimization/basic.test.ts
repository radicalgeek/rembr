import { describe, it, expect } from 'vitest';

describe('Optimization Services - Basic Validation', () => {
  it('should import all optimization services without errors', async () => {
    const { DeduplicationService } = await import('../../src/optimization/deduplication-service.js');
    const { TemporalAnalyzerService } = await import('../../src/optimization/temporal-analyzer-service.js');
    const { RelationshipMaintainerService } = await import('../../src/optimization/relationship-maintainer-service.js');
    const { QualityScorerService } = await import('../../src/optimization/quality-scorer-service.js');

    expect(DeduplicationService).toBeDefined();
    expect(TemporalAnalyzerService).toBeDefined();
    expect(RelationshipMaintainerService).toBeDefined();
    expect(QualityScorerService).toBeDefined();
  });

  it('should successfully require database and ollama dependencies', async () => {
    const { MemoryDatabase } = await import('../../src/database.js');
    const { OllamaClient } = await import('../../src/ollama-client.js');

    expect(MemoryDatabase).toBeDefined();
    expect(OllamaClient).toBeDefined();
  });

  it('should not treat high-similarity negated facts as duplicates', async () => {
    const { DeduplicationService } = await import('../../src/optimization/deduplication-service.js');
    const db = {
      query: async (sql: string) => {
        if (sql.includes('SELECT m.id')) {
          return {
            rows: [
              {
                id: 'memory-a',
                content: 'The Rembr synthetic datastore uses PostgreSQL for durable memory storage.',
                created_at: new Date('2026-07-05T07:00:00Z'),
                category: 'facts',
                embedding: '[1,0,0]'
              },
              {
                id: 'memory-b',
                content: 'The Rembr synthetic datastore does not use PostgreSQL for durable memory storage.',
                created_at: new Date('2026-07-05T07:01:00Z'),
                category: 'facts',
                embedding: '[0.99,0.01,0]'
              }
            ]
          };
        }
        return { rows: [] };
      }
    };

    const service = new DeduplicationService(db as any, {} as any);
    const clusters = await service.findDuplicateClusters('tenant-1', 0.85);

    expect(clusters).toEqual([]);
  });

  it('should still cluster high-similarity repeated facts', async () => {
    const { DeduplicationService } = await import('../../src/optimization/deduplication-service.js');
    const db = {
      query: async (sql: string) => {
        if (sql.includes('SELECT m.id')) {
          return {
            rows: [
              {
                id: 'memory-a',
                content: 'The Rembr synthetic datastore uses PostgreSQL for durable memory storage.',
                created_at: new Date('2026-07-05T07:00:00Z'),
                category: 'facts',
                embedding: '[1,0,0]'
              },
              {
                id: 'memory-b',
                content: 'Rembr datastore uses PostgreSQL for durable memory storage.',
                created_at: new Date('2026-07-05T07:01:00Z'),
                category: 'facts',
                embedding: '[0.99,0.01,0]'
              }
            ]
          };
        }
        return { rows: [] };
      }
    };

    const service = new DeduplicationService(db as any, {} as any);
    const clusters = await service.findDuplicateClusters('tenant-1', 0.85);

    expect(clusters).toHaveLength(1);
    expect(clusters[0].memories.map((memory) => memory.id)).toEqual(['memory-a', 'memory-b']);
  });
});
