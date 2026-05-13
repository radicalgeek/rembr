/**
 * Unit tests for snapshot-timeline UI renderer
 */

import { describe, it, expect } from 'vitest';
import { renderSnapshotTimeline, SnapshotTimelineData } from './snapshot-timeline.js';

describe('snapshot-timeline', () => {
  const mockData: SnapshotTimelineData = {
    snapshots: [
      {
        id: 'snap1',
        name: 'Morning Context',
        description: 'Context from morning work',
        memory_count: 50,
        token_count: 25000,
        created_at: new Date('2026-02-08T09:00:00Z'),
        expires_at: new Date('2026-02-15T09:00:00Z')
      },
      {
        id: 'snap2',
        name: 'Afternoon Context',
        description: null,
        memory_count: 75,
        token_count: 35000,
        created_at: new Date('2026-02-08T14:00:00Z'),
        expires_at: null
      }
    ]
  };

  it('should generate valid HTML', () => {
    const html = renderSnapshotTimeline(mockData);
    
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('</html>');
  });

  it('should include timeline title', () => {
    const html = renderSnapshotTimeline(mockData);
    
    expect(html).toContain('Snapshot Timeline');
  });

  it('should include D3.js script', () => {
    const html = renderSnapshotTimeline(mockData);
    
    expect(html).toContain('d3js.org');
  });

  it('should display snapshot count', () => {
    const html = renderSnapshotTimeline(mockData);
    
    expect(html).toContain('2 Snapshots');
  });

  it('should display statistics', () => {
    const html = renderSnapshotTimeline(mockData);
    
    expect(html).toContain('Total Snapshots');
    expect(html).toContain('Total Memories');
    expect(html).toContain('Total Tokens');
  });

  it('should include timeline visualization', () => {
    const html = renderSnapshotTimeline(mockData);
    
    expect(html).toContain('timeline-viz');
  });

  it('should display snapshot cards', () => {
    const html = renderSnapshotTimeline(mockData);
    
    expect(html).toContain('Morning Context');
    expect(html).toContain('Afternoon Context');
  });

  it('should show expiration badges', () => {
    const html = renderSnapshotTimeline(mockData);
    
    expect(html).toContain('Expires');
    expect(html).toContain('No expiration');
  });

  it('should include comparison mode', () => {
    const html = renderSnapshotTimeline(mockData);
    
    expect(html).toContain('Compare');
    expect(html).toContain('comparison-modal');
  });

  it('should show empty state when no snapshots', () => {
    const emptyData: SnapshotTimelineData = { snapshots: [] };
    const html = renderSnapshotTimeline(emptyData);
    
    expect(html).toContain('No Snapshots Yet');
  });

  it('should calculate total metrics correctly', () => {
    const html = renderSnapshotTimeline(mockData);
    
    expect(html).toContain('125'); // total memories (50 + 75)
    expect(html).toContain('60,000'); // total tokens (25000 + 35000)
  });
});
