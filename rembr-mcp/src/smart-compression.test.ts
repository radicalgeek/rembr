/**
 * Smart Compression Service Tests (REM-99)
 */

import { describe, it, expect } from 'vitest';
import {
  classifyContentImportance,
  splitIntoBlocks,
  estimateTokens,
  compressContent,
  previewCompression,
  DEFAULT_COMPRESSION_CONFIG,
  type ContentImportance,
} from './smart-compression.js';

describe('Smart Compression Service', () => {
  describe('classifyContentImportance', () => {
    it('should classify decisions', () => {
      const samples = [
        'We decided to use PostgreSQL for the database',
        'Therefore, we will implement caching',
        'The strategy: use Redis for session storage',
        'Key decision: adopt TypeScript',
      ];
      
      for (const sample of samples) {
        expect(classifyContentImportance(sample, 'agent')).toBe('decision');
      }
    });
    
    it('should classify user requests', () => {
      const samples = [
        'Can you help me with this?',
        'I need to implement authentication',
        'Please add error handling',
        'Would you review this code?',
      ];
      
      for (const sample of samples) {
        expect(classifyContentImportance(sample, 'user')).toBe('user_request');
      }
    });
    
    it('should classify acknowledgments', () => {
      const samples = [
        'Okay, got it',
        'Thanks for the info',
        'I understand',
        'Will do',
      ];
      
      for (const sample of samples) {
        const importance = classifyContentImportance(sample, 'agent');
        expect(importance).toBe('acknowledgment');
      }
    });
    
    it('should classify filler', () => {
      const samples = [
        'Um, well...',
        'just a second',
        'hi',
      ];
      
      for (const sample of samples) {
        const importance = classifyContentImportance(sample, 'agent');
        expect(importance).toBe('filler');
      }
    });
    
    it('should default to technical_detail', () => {
      const sample = 'The function returns a Promise that resolves with the data';
      expect(classifyContentImportance(sample, 'agent')).toBe('technical_detail');
    });
  });
  
  describe('splitIntoBlocks', () => {
    it('should split by double newlines', () => {
      const content = 'Block 1\n\nBlock 2\n\nBlock 3';
      const blocks = splitIntoBlocks(content, 'user');
      
      expect(blocks).toHaveLength(3);
      expect(blocks[0].content).toBe('Block 1');
      expect(blocks[1].content).toBe('Block 2');
      expect(blocks[2].content).toBe('Block 3');
    });
    
    it('should split by single newlines for short content', () => {
      const content = 'Line 1\nLine 2\nLine 3';
      const blocks = splitIntoBlocks(content, 'user');
      
      expect(blocks).toHaveLength(3);
    });
    
    it('should classify each block', () => {
      const content = 'We decided to use Redis\n\nOkay, got it';
      const blocks = splitIntoBlocks(content, 'agent');
      
      expect(blocks[0].importance).toBe('decision');
      expect(blocks[1].importance).toBe('acknowledgment');
    });
    
    it('should set source correctly', () => {
      const blocks = splitIntoBlocks('Block 1\n\nBlock 2', 'user');
      
      expect(blocks[0].source).toBe('user');
      expect(blocks[1].source).toBe('user');
    });
  });
  
  describe('estimateTokens', () => {
    it('should estimate tokens as chars/4', () => {
      expect(estimateTokens('test')).toBe(1);  // 4/4 = 1
      expect(estimateTokens('hello world')).toBe(3);  // 11/4 = 2.75 → 3
      expect(estimateTokens('a'.repeat(100))).toBe(25);  // 100/4 = 25
    });
  });
  
  describe('compressContent', () => {
    it('should preserve decisions verbatim', async () => {
      const content = 'We decided to use PostgreSQL';
      
      const result = await compressContent(content, 'agent');
      
      expect(result.compressed_content).toContain('We decided to use PostgreSQL');
      expect(result.preserved_decisions).toHaveLength(1);
      expect(result.blocks_preserved).toBeGreaterThan(0);
    });
    
    it('should compress agent outputs more aggressively', async () => {
      const content = 'Some technical detail here';
      
      const agentResult = await compressContent(content, 'agent');
      const userResult = await compressContent(content, 'user');
      
      // Agent compression should be more aggressive (smaller compressed size)
      expect(agentResult.compressed_tokens).toBeLessThanOrEqual(userResult.compressed_tokens);
    });
    
    it('should remove filler completely', async () => {
      const content = 'We decided to use Redis\n\nUm, well\n\nOkay';
      
      const result = await compressContent(content, 'agent', {
        compression_ratios: {
          decision: 0.0,
          user_request: 0.2,
          technical_detail: 0.6,
          acknowledgment: 1.0,
          filler: 1.0,
        },
      });
      
      expect(result.compressed_content).not.toContain('Um, well');
      expect(result.compressed_content).not.toContain('Okay');
      expect(result.compressed_content).toContain('Redis');
    });
    
    it('should calculate compression ratio correctly', async () => {
      const content = 'A'.repeat(400);  // 100 tokens
      
      const result = await compressContent(content, 'agent', {
        compression_ratios: {
          decision: 0.0,
          user_request: 0.0,
          technical_detail: 0.5,  // 50% compression
          acknowledgment: 1.0,
          filler: 1.0,
        },
      });
      
      expect(result.original_tokens).toBe(100);
      expect(result.compressed_tokens).toBeLessThan(result.original_tokens);
      expect(result.compression_ratio).toBeLessThan(1.0);
    });
    
    it('should use default config when not provided', async () => {
      const content = 'We decided to use Redis';
      
      const result = await compressContent(content, 'agent');
      
      expect(result.compression_ratio).toBeLessThanOrEqual(1.0);
    });
    
    it('should handle custom compression ratios', async () => {
      const content = 'Technical detail here';
      
      const result = await compressContent(content, 'agent', {
        compression_ratios: {
          decision: 0.0,
          user_request: 0.0,
          technical_detail: 0.8,  // Heavy compression
          acknowledgment: 1.0,
          filler: 1.0,
        },
      });
      
      expect(result.compressed_tokens).toBeLessThan(result.original_tokens * 0.3);
    });
    
    it('should apply agent compression multiplier', async () => {
      const content = 'Technical detail\n\nMore technical info';
      
      const result = await compressContent(content, 'agent', {
        agent_compression_multiplier: 2.0,  // 2x more aggressive
        compression_ratios: {
          decision: 0.0,
          user_request: 0.2,
          technical_detail: 0.5,
          acknowledgment: 0.9,
          filler: 1.0,
        },
      });
      
      // With 2.0 multiplier, technical_detail goes from 0.5 to 1.0 (capped)
      expect(result.compressed_tokens).toBeLessThan(result.original_tokens * 0.5);
    });
  });
  
  describe('previewCompression', () => {
    it('should show preview of blocks to be compressed', async () => {
      const content = 'We decided to use Redis\n\nOkay, got it\n\nTechnical detail here';
      
      const preview = await previewCompression(content, 'agent');
      
      expect(preview.blocks).toHaveLength(3);
      expect(preview.blocks[0].will_be_compressed).toBe(false);  // decision
      expect(preview.blocks[1].will_be_compressed).toBe(true);   // acknowledgment
      expect(preview.blocks[2].will_be_compressed).toBe(true);   // technical_detail
    });
    
    it('should estimate savings correctly', async () => {
      const content = 'Um, well\n\nOkay';  // All filler
      
      const preview = await previewCompression(content, 'agent', {
        compression_ratios: {
          decision: 0.0,
          user_request: 0.2,
          technical_detail: 0.6,
          acknowledgment: 1.0,
          filler: 1.0,
        },
      });
      
      expect(preview.estimated_savings).toBeGreaterThan(0.9);  // ~100% savings
    });
    
    it('should show compression ratios per block', async () => {
      const content = 'We decided to use Redis\n\nThe implementation uses connection pooling and retry logic';
      
      const preview = await previewCompression(content, 'agent');
      
      expect(preview.blocks[0].compression_ratio).toBe(0);  // decision
      expect(preview.blocks[1].compression_ratio).toBe(DEFAULT_COMPRESSION_CONFIG.compression_ratios.technical_detail * DEFAULT_COMPRESSION_CONFIG.agent_compression_multiplier);
    });
    
    it('should handle empty content', async () => {
      const preview = await previewCompression('', 'user');
      
      expect(preview.blocks).toHaveLength(0);
      expect(preview.estimated_savings).toBe(0);
    });
  });
  
  describe('DEFAULT_COMPRESSION_CONFIG', () => {
    it('should have expected defaults', () => {
      expect(DEFAULT_COMPRESSION_CONFIG.target_ratio).toBe(0.5);
      expect(DEFAULT_COMPRESSION_CONFIG.compression_ratios.decision).toBe(0.0);
      expect(DEFAULT_COMPRESSION_CONFIG.compression_ratios.filler).toBe(1.0);
      expect(DEFAULT_COMPRESSION_CONFIG.agent_compression_multiplier).toBe(1.5);
      expect(DEFAULT_COMPRESSION_CONFIG.preserve_decision_chains).toBe(true);
      expect(DEFAULT_COMPRESSION_CONFIG.store_compressed_content).toBe(true);
    });
  });
});
