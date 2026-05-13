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
});
