import { describe, expect, it } from 'vitest';
import { AdvancedAnalyticsService } from './advanced-analytics-service.js';

describe('AdvancedAnalyticsService contradiction patterns', () => {
  it('detects one-sided negation over the same subject as a factual contradiction', async () => {
    const service = new AdvancedAnalyticsService({ query: async () => ({ rows: [] }) } as any, {} as any);

    const result = await (service as any).analyzeContradiction(
      {
        id: 'memory-a',
        content: 'The Rembr synthetic datastore uses PostgreSQL for durable memory storage.',
        category: 'facts',
        created_at: new Date('2026-07-05T07:00:00Z')
      },
      {
        id: 'memory-b',
        content: 'The Rembr synthetic datastore does not use PostgreSQL for durable memory storage.',
        category: 'facts',
        created_at: new Date('2026-07-05T07:01:00Z')
      }
    );

    expect(result).toMatchObject({
      contradiction_type: 'factual',
      severity: 'high'
    });
    expect(result.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it('does not flag unrelated one-sided negation as a contradiction', async () => {
    const service = new AdvancedAnalyticsService({ query: async () => ({ rows: [] }) } as any, {} as any);

    const result = await (service as any).analyzeContradiction(
      {
        id: 'memory-a',
        content: 'The Rembr datastore uses PostgreSQL for durable memory storage.',
        category: 'facts',
        created_at: new Date('2026-07-05T07:00:00Z')
      },
      {
        id: 'memory-b',
        content: 'The dashboard does not display invoices on the billing page.',
        category: 'facts',
        created_at: new Date('2026-07-05T07:01:00Z')
      }
    );

    expect(result).toBeNull();
  });
});
