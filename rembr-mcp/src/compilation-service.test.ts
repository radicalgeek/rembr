import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CompilationService } from './compilation-service.js';

// Create a minimal mock for testing pure helper methods
class CompilationServiceTestable extends CompilationService {
  // Expose private methods for testing
  public testDetectContradiction(text1: string, text2: string) {
    return (this as any).detectContradiction(text1, text2);
  }

  public testCalculateTextSimilarity(text1: string, text2: string) {
    return (this as any).calculateTextSimilarity(text1, text2);
  }

  public testContainsKeyTerms(longerText: string, shorterText: string) {
    return (this as any).containsKeyTerms(longerText, shorterText);
  }

  public testGetCategoryDistribution(memories: any[]) {
    return (this as any).getCategoryDistribution(memories);
  }

  public testGetTemporalPattern(memories: any[]) {
    return (this as any).getTemporalPattern(memories);
  }

  public testExtractEntities(memories: any[]) {
    return (this as any).extractEntities(memories);
  }
}

describe('CompilationService - Pure Helper Methods', () => {
  let service: CompilationServiceTestable;

  beforeEach(() => {
    const mockDb = {} as any;
    service = new CompilationServiceTestable(mockDb);
  });

  describe('detectContradiction', () => {
    it('should detect yes/no contradiction', () => {
      const result = service.testDetectContradiction(
        'The answer is yes',
        'The answer is no'
      );
      
      expect(result.isContradiction).toBe(true);
      expect(result.confidence).toBe(0.7);
      expect(result.evidence).toContain('yes');
      expect(result.evidence).toContain('no');
    });

    it('should detect true/false contradiction', () => {
      const result = service.testDetectContradiction(
        'This statement is true',
        'This statement is false'
      );
      
      expect(result.isContradiction).toBe(true);
      expect(result.confidence).toBe(0.7);
    });

    it('should detect is/is not contradiction', () => {
      const result = service.testDetectContradiction(
        'The system is operational',
        'The system is not operational'
      );
      
      expect(result.isContradiction).toBe(true);
      expect(result.confidence).toBe(0.7);
    });

    it('should detect can/cannot contradiction', () => {
      const result = service.testDetectContradiction(
        'Users can access this feature',
        'Users cannot access this feature'
      );
      
      expect(result.isContradiction).toBe(true);
    });

    it('should not detect contradiction in similar texts', () => {
      const result = service.testDetectContradiction(
        'The system is working well',
        'The system is performing optimally'
      );
      
      expect(result.isContradiction).toBe(false);
      expect(result.confidence).toBe(0);
    });

    it('should handle case insensitivity', () => {
      const result = service.testDetectContradiction(
        'The answer is YES',
        'The answer is NO'
      );
      
      expect(result.isContradiction).toBe(true);
    });
  });

  describe('calculateTextSimilarity', () => {
    it('should return 1.0 for identical texts', () => {
      const similarity = service.testCalculateTextSimilarity(
        'hello world foo bar',
        'hello world foo bar'
      );
      
      expect(similarity).toBe(1.0);
    });

    it('should return 0 for completely different texts', () => {
      const similarity = service.testCalculateTextSimilarity(
        'apple banana orange',
        'car truck motorcycle'
      );
      
      expect(similarity).toBe(0);
    });

    it('should calculate partial similarity (Jaccard index)', () => {
      // "hello world" and "hello everyone" share "hello" (1 word)
      // Union is 3 words, so similarity = 1/3 ≈ 0.33
      const similarity = service.testCalculateTextSimilarity(
        'hello world',
        'hello everyone'
      );
      
      expect(similarity).toBeCloseTo(0.33, 1);
    });

    it('should handle case insensitivity', () => {
      const similarity = service.testCalculateTextSimilarity(
        'HELLO WORLD',
        'hello world'
      );
      
      expect(similarity).toBe(1.0);
    });

    it('should handle empty strings', () => {
      const similarity1 = service.testCalculateTextSimilarity('', '');
      const similarity2 = service.testCalculateTextSimilarity('hello', '');
      
      // Empty strings both create empty sets: intersection=0, union=0 -> 0/0 but JS returns 1.0
      expect(similarity1).toBe(1.0); // Both empty = identical
      expect(similarity2).toBe(0); // No overlap between 'hello' and empty
    });
  });

  describe('containsKeyTerms', () => {
    it('should return 1.0 when all key terms are present', () => {
      const score = service.testContainsKeyTerms(
        'This is a longer text that contains database and authentication mechanisms',
        'database authentication'
      );
      
      expect(score).toBe(1.0);
    });

    it('should return 0.5 when half of key terms are present', () => {
      const score = service.testContainsKeyTerms(
        'This text contains database but not the other term',
        'database authentication'
      );
      
      expect(score).toBe(0.5);
    });

    it('should return 0 when no key terms are present', () => {
      const score = service.testContainsKeyTerms(
        'This is completely different content',
        'database authentication'
      );
      
      expect(score).toBe(0);
    });

    it('should filter out short words (<=4 chars)', () => {
      const score = service.testContainsKeyTerms(
        'This has some text in it',
        'this has some text in it'  // All words <=4 chars
      );
      
      // Only "this", "some", "text" are >4 chars
      expect(score).toBeLessThan(1.0);
    });

    it('should be case insensitive', () => {
      const score = service.testContainsKeyTerms(
        'DATABASE AUTHENTICATION SYSTEM',
        'database authentication'
      );
      
      expect(score).toBe(1.0);
    });

    it('should handle empty shorter text', () => {
      const score = service.testContainsKeyTerms(
        'Some longer text here',
        ''
      );
      
      expect(score).toBe(0);
    });
  });

  describe('getCategoryDistribution', () => {
    it('should count memories by category', () => {
      const memories = [
        { category: 'facts' },
        { category: 'facts' },
        { category: 'preferences' },
        { category: 'goals' }
      ];
      
      const dist = service.testGetCategoryDistribution(memories);
      
      expect(dist).toEqual({
        facts: 2,
        preferences: 1,
        goals: 1
      });
    });

    it('should handle uncategorized memories', () => {
      const memories = [
        { category: 'facts' },
        { category: null },
        { category: undefined }
      ];
      
      const dist = service.testGetCategoryDistribution(memories);
      
      expect(dist.facts).toBe(1);
      expect(dist.uncategorized).toBe(2);
    });

    it('should return empty object for empty array', () => {
      const dist = service.testGetCategoryDistribution([]);
      
      expect(dist).toEqual({});
    });

    it('should handle single category', () => {
      const memories = [
        { category: 'learning' },
        { category: 'learning' }
      ];
      
      const dist = service.testGetCategoryDistribution(memories);
      
      expect(dist).toEqual({ learning: 2 });
    });
  });

  describe('getTemporalPattern', () => {
    it('should return null for less than 2 memories', () => {
      const pattern1 = service.testGetTemporalPattern([]);
      const pattern2 = service.testGetTemporalPattern([{ created_at: new Date() }]);
      
      expect(pattern1).toBeNull();
      expect(pattern2).toBeNull();
    });

    it('should calculate span in days', () => {
      const now = new Date();
      const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
      
      const memories = [
        { created_at: threeDaysAgo },
        { created_at: now }
      ];
      
      const pattern = service.testGetTemporalPattern(memories);
      
      expect(pattern).not.toBeNull();
      expect(pattern!.data.spanDays).toBeCloseTo(3, 0);
      expect(pattern!.data.count).toBe(2);
    });

    it('should calculate memory rate per day', () => {
      const now = new Date();
      const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
      
      const memories = [
        { created_at: twoDaysAgo },
        { created_at: twoDaysAgo },
        { created_at: now },
        { created_at: now }
      ];
      
      const pattern = service.testGetTemporalPattern(memories);
      
      expect(pattern!.data.rate).toBeCloseTo(2, 0); // 4 memories / 2 days
    });

    it('should describe pattern for memories within 1 day', () => {
      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
      
      const memories = [
        { created_at: oneHourAgo },
        { created_at: now }
      ];
      
      const pattern = service.testGetTemporalPattern(memories);
      
      expect(pattern!.description).toContain('within 1 day');
    });

    it('should describe pattern for memories spanning days', () => {
      const now = new Date();
      const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
      
      const memories = [
        { created_at: fiveDaysAgo },
        { created_at: now }
      ];
      
      const pattern = service.testGetTemporalPattern(memories);
      
      expect(pattern!.description).toMatch(/span.*5 days/i);
      expect(pattern!.confidence).toBe(0.8);
    });
  });

  describe('extractEntities', () => {
    it('should extract capitalized words', () => {
      const memories = [
        { content: 'John went to Paris. Sarah visited London.' }
      ];
      
      const entities = service.testExtractEntities(memories);
      
      expect(entities).toContain('John');
      expect(entities).toContain('Paris');
      expect(entities).toContain('Sarah');
      expect(entities).toContain('London');
    });

    it('should extract multi-word capitalized phrases', () => {
      const memories = [
        { content: 'New York is a city in the United States' }
      ];
      
      const entities = service.testExtractEntities(memories);
      
      expect(entities).toContain('New York');
      expect(entities).toContain('United States');
    });

    it('should filter out short entities (<=3 chars)', () => {
      const memories = [
        { content: 'Bob and Sue went to NYC' }
      ];
      
      const entities = service.testExtractEntities(memories);
      
      expect(entities).not.toContain('Bob');
      expect(entities).not.toContain('Sue');
      expect(entities).not.toContain('NYC');
    });

    it('should limit to 20 entities', () => {
      const longText = Array.from({ length: 30 }, (_, i) => `Entity${i + 1000}`).join(' ');
      const memories = [{ content: longText }];
      
      const entities = service.testExtractEntities(memories);
      
      expect(entities.length).toBeLessThanOrEqual(20);
    });

    it('should return empty array for no capitalized words', () => {
      const memories = [
        { content: 'all lowercase text here' }
      ];
      
      const entities = service.testExtractEntities(memories);
      
      expect(entities).toEqual([]);
    });

    it('should handle empty memories', () => {
      const entities = service.testExtractEntities([]);
      
      expect(entities).toEqual([]);
    });
  });
});
