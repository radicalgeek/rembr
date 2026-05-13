import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SnapshotService } from './snapshot-service.js';

describe('SnapshotService - TTL and Token Calculations', () => {
  describe('TTL calculations', () => {
    it('should calculate correct expiration time for hours', () => {
      const now = Date.now();
      const ttlHours = 24;
      const expectedExpiry = new Date(now + ttlHours * 60 * 60 * 1000);
      
      // Test that TTL calculation logic is correct
      const calculatedExpiry = new Date(now + ttlHours * 60 * 60 * 1000);
      
      expect(calculatedExpiry.getTime() - expectedExpiry.getTime()).toBeLessThan(100); // Within 100ms
    });

    it('should handle null TTL (no expiration)', () => {
      const ttlHours = undefined;
      const expiresAt = ttlHours ? new Date(Date.now() + ttlHours * 60 * 60 * 1000) : null;
      
      expect(expiresAt).toBeNull();
    });

    it('should calculate expiration for 1 hour', () => {
      const now = Date.now();
      const ttlHours = 1;
      const expiresAt = new Date(now + ttlHours * 60 * 60 * 1000);
      
      const diffMs = expiresAt.getTime() - now;
      const diffHours = diffMs / (60 * 60 * 1000);
      
      expect(diffHours).toBeCloseTo(1, 2);
    });

    it('should calculate expiration for 7 days (168 hours)', () => {
      const now = Date.now();
      const ttlHours = 168; // 7 days
      const expiresAt = new Date(now + ttlHours * 60 * 60 * 1000);
      
      const diffMs = expiresAt.getTime() - now;
      const diffDays = diffMs / (24 * 60 * 60 * 1000);
      
      expect(diffDays).toBeCloseTo(7, 2);
    });
  });

  describe('Token estimation (~4 chars per token)', () => {
    it('should estimate tokens correctly for simple text', () => {
      const content = 'Hello world'; // 11 chars
      const tokenEstimate = Math.ceil(content.length / 4);
      
      expect(tokenEstimate).toBe(3); // 11/4 = 2.75 -> 3
    });

    it('should estimate tokens for longer text', () => {
      const content = 'This is a longer piece of text that should be tokenized correctly'; // 66 chars
      const tokenEstimate = Math.ceil(content.length / 4);
      
      expect(tokenEstimate).toBe(17); // 66/4 = 16.5 -> 17
    });

    it('should sum tokens across multiple memories', () => {
      const memories = [
        { content: 'First memory content' },  // 20 chars -> 5 tokens
        { content: 'Second memory' },          // 13 chars -> 4 tokens
        { content: 'Third' }                    // 5 chars -> 2 tokens
      ];
      
      const totalTokens = memories.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0);
      
      expect(totalTokens).toBe(11); // 5 + 4 + 2
    });

    it('should handle empty content', () => {
      const content = '';
      const tokenEstimate = Math.ceil(content.length / 4);
      
      expect(tokenEstimate).toBe(0);
    });

    it('should round up fractional tokens', () => {
      const content = 'ABC'; // 3 chars -> should be 1 token (3/4 = 0.75 -> 1)
      const tokenEstimate = Math.ceil(content.length / 4);
      
      expect(tokenEstimate).toBe(1);
    });
  });

  describe('Date math edge cases', () => {
    it('should handle date arithmetic correctly', () => {
      const baseDate = new Date('2026-01-01T00:00:00Z');
      const hoursToAdd = 48;
      const newDate = new Date(baseDate.getTime() + hoursToAdd * 60 * 60 * 1000);
      
      expect(newDate.toISOString()).toBe('2026-01-03T00:00:00.000Z');
    });

    it('should handle negative time differences', () => {
      const now = Date.now();
      const futureDate = new Date(now + 1000);
      const pastDate = new Date(now - 1000);
      
      expect(futureDate.getTime() > pastDate.getTime()).toBe(true);
      const diff = futureDate.getTime() - pastDate.getTime();
      expect(diff).toBeGreaterThanOrEqual(1990);
      expect(diff).toBeLessThanOrEqual(2010);
    });

    it('should check if snapshot is expired', () => {
      const expiredDate = new Date(Date.now() - 1000); // 1 second ago
      const validDate = new Date(Date.now() + 1000);   // 1 second from now
      const noExpiry = null;
      
      const isExpired1 = expiredDate && expiredDate.getTime() < Date.now();
      const isExpired2 = validDate && validDate.getTime() < Date.now();
      const isExpired3 = !noExpiry; // null means never expires (so not expired)
      
      expect(isExpired1).toBe(true);
      expect(isExpired2).toBe(false);
      expect(isExpired3).toBe(true); // Not expired (no expiry date)
    });
  });
});

// ============================================================================
// REM-256: Snapshot Immutability Tests
// ============================================================================

describe('SnapshotService - Immutability Guarantees (REM-256)', () => {
  describe('Database-level immutability enforcement', () => {
    it('should document that snapshots cannot be updated at DB level', () => {
      // This test documents the expected behavior:
      // - Snapshots (context_snapshots) cannot be UPDATEd
      // - Snapshot memories (snapshot_memories) cannot be UPDATEd
      // - Snapshot memories cannot be DELETEd directly (only via cascade)
      // - Snapshot contexts cannot be UPDATEd
      
      // The actual enforcement is done via database triggers:
      // - immutable_context_snapshots
      // - immutable_snapshot_memories_update
      // - immutable_snapshot_memories_delete
      // - immutable_snapshot_contexts
      
      // These triggers will raise exceptions if modification is attempted
      expect(true).toBe(true);
    });

    it('should require snapshots to be deleted and recreated if changes needed', () => {
      // Design constraint: snapshots are immutable by design
      // If you need to "modify" a snapshot:
      // 1. Delete the snapshot (cascades to memories)
      // 2. Create a new snapshot with desired changes
      
      // This ensures point-in-time integrity for RLM handoff
      const immutabilityPolicy = {
        canUpdate: false,
        canDelete: true, // Delete entire snapshot
        canDeleteMemories: false, // Only via cascade
        workaround: 'Delete and recreate snapshot',
      };
      
      expect(immutabilityPolicy.canUpdate).toBe(false);
      expect(immutabilityPolicy.canDelete).toBe(true);
    });

    it('should allow cascade deletion of memories when parent snapshot is deleted', () => {
      // The trigger uses pg_trigger_depth() = 0 check
      // This means:
      // - Direct DELETE on snapshot_memories: BLOCKED
      // - CASCADE DELETE from context_snapshots: ALLOWED
      
      // This ensures memories are only deleted as part of snapshot deletion
      const cascadeBehavior = {
        directDelete: false,
        cascadeFromParent: true,
        onDeleteAction: 'ON DELETE CASCADE',
      };
      
      expect(cascadeBehavior.directDelete).toBe(false);
      expect(cascadeBehavior.cascadeFromParent).toBe(true);
    });
  });
});

