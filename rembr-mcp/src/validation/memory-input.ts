/**
 * Input validation for memory content storage (REM-258).
 *
 * All user-supplied content must pass these checks before being stored or
 * processed. Validation happens at the MCP tool handler boundary — the last
 * trust boundary before data reaches the database and embedding pipeline.
 */

import { MEMORY_CATEGORIES } from '../memory-service.js';

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** Maximum characters for a single memory's content field. */
export const MAX_CONTENT_LENGTH = 100_000; // ~100KB text

/** Maximum JSON-serialised size of the metadata object. */
export const MAX_METADATA_BYTES = 51_200; // 50KB

/** Maximum number of keys in the metadata object (shallow). */
export const MAX_METADATA_KEYS = 50;

/** Allowed relevance_score range. */
export const RELEVANCE_MIN = 0;
export const RELEVANCE_MAX = 1;

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface ValidationError {
  field: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

/**
 * Validate the content field for store_memory / update_memory.
 */
export function validateContent(content: unknown): ValidationError[] {
  const errors: ValidationError[] = [];

  if (content === undefined || content === null) {
    errors.push({ field: 'content', message: 'content is required' });
    return errors;
  }
  if (typeof content !== 'string') {
    errors.push({ field: 'content', message: 'content must be a string' });
    return errors;
  }
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    errors.push({ field: 'content', message: 'content must not be empty' });
  }
  if (content.length > MAX_CONTENT_LENGTH) {
    errors.push({
      field: 'content',
      message: `content exceeds maximum length of ${MAX_CONTENT_LENGTH} characters (got ${content.length})`
    });
  }
  return errors;
}

/**
 * Validate the category field.
 */
export function validateCategory(category: unknown): ValidationError[] {
  if (category === undefined || category === null) return [];
  if (typeof category !== 'string') {
    return [{ field: 'category', message: 'category must be a string' }];
  }
  if (!(MEMORY_CATEGORIES as readonly string[]).includes(category)) {
    return [{
      field: 'category',
      message: `category must be one of: ${MEMORY_CATEGORIES.join(', ')}`
    }];
  }
  return [];
}

/**
 * Validate the metadata field.
 */
export function validateMetadata(metadata: unknown): ValidationError[] {
  if (metadata === undefined || metadata === null) return [];
  if (typeof metadata !== 'object' || Array.isArray(metadata)) {
    return [{ field: 'metadata', message: 'metadata must be a plain object' }];
  }
  const keys = Object.keys(metadata as object);
  if (keys.length > MAX_METADATA_KEYS) {
    return [{
      field: 'metadata',
      message: `metadata has too many keys (${keys.length} > ${MAX_METADATA_KEYS})`
    }];
  }
  try {
    const serialised = JSON.stringify(metadata);
    if (serialised.length > MAX_METADATA_BYTES) {
      return [{
        field: 'metadata',
        message: `metadata is too large (${serialised.length} bytes > ${MAX_METADATA_BYTES})`
      }];
    }
  } catch {
    return [{ field: 'metadata', message: 'metadata is not JSON-serialisable' }];
  }
  return [];
}

/**
 * Validate the relevance_score field.
 */
export function validateRelevanceScore(score: unknown): ValidationError[] {
  if (score === undefined || score === null) return [];
  if (typeof score !== 'number' || !isFinite(score)) {
    return [{ field: 'relevance_score', message: 'relevance_score must be a finite number' }];
  }
  if (score < RELEVANCE_MIN || score > RELEVANCE_MAX) {
    return [{
      field: 'relevance_score',
      message: `relevance_score must be between ${RELEVANCE_MIN} and ${RELEVANCE_MAX}`
    }];
  }
  return [];
}

/**
 * Full validation for store_memory / update_memory inputs.
 * Returns { valid, errors } — callers should return a 400-equivalent MCP error
 * when valid is false.
 */
export function validateMemoryInput(args: Record<string, unknown>): ValidationResult {
  const errors: ValidationError[] = [
    ...validateContent(args.content),
    ...validateCategory(args.category),
    ...validateMetadata(args.metadata),
    ...validateRelevanceScore(args.relevance_score),
  ];
  return { valid: errors.length === 0, errors };
}
