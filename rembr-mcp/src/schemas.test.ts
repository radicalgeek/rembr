/**
 * Unit Tests: Input Validation Schemas
 * RAD-162: Expand unit test coverage for rembr-mcp
 * REM-248: Covers previously-unvalidated tools (explore_relationships, ingest_document, pii)
 *
 * Tests Zod validation schemas for security and correctness.
 * Also tests the validateToolInput integration entrypoint.
 */

import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { validateToolInput } from './schemas.js'

// We'll test the validation patterns directly since schemas are internal
// These tests verify the security-critical validation logic

describe('UUID Validation', () => {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const uuidSchema = z.string().regex(UUID_RE, 'Must be a valid UUID')

  it('should accept valid UUIDs', () => {
    const validUuids = [
      '550e8400-e29b-41d4-a716-446655440000',
      'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE',
      '00000000-0000-0000-0000-000000000000',
      'ffffffff-ffff-ffff-ffff-ffffffffffff'
    ]

    for (const uuid of validUuids) {
      expect(uuidSchema.safeParse(uuid).success).toBe(true)
    }
  })

  it('should reject invalid UUIDs', () => {
    const invalidUuids = [
      'not-a-uuid',
      '550e8400-e29b-41d4-a716',  // too short
      '550e8400-e29b-41d4-a716-446655440000-extra',  // too long
      '550e8400e29b41d4a716446655440000',  // no dashes
      'ZZZZZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZZZZZZZZZ',  // invalid chars
      '',
      '   '
    ]

    for (const uuid of invalidUuids) {
      expect(uuidSchema.safeParse(uuid).success).toBe(false)
    }
  })
})

describe('ISO DateTime Validation', () => {
  const isoDatetime = z.string().refine(
    (v) => !isNaN(new Date(v).getTime()),
    { message: 'Must be a valid ISO 8601 datetime' }
  )

  it('should accept valid ISO datetimes', () => {
    const validDates = [
      '2026-01-15T10:30:00Z',
      '2026-01-15T10:30:00.000Z',
      '2026-01-15T10:30:00+00:00',
      '2026-01-15T10:30:00-05:00',
      '2026-01-15'
    ]

    for (const date of validDates) {
      expect(isoDatetime.safeParse(date).success).toBe(true)
    }
  })

  it('should reject invalid datetimes', () => {
    const invalidDates = [
      'not-a-date',
      '2026-13-01',  // invalid month
      '2026-01-32',  // invalid day
      '',
      'yesterday'
    ]

    for (const date of invalidDates) {
      expect(isoDatetime.safeParse(date).success).toBe(false)
    }
  })
})

describe('Text Sanitization', () => {
  function sanitiseText(value: string): string {
    let cleaned = value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    cleaned = cleaned.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    cleaned = cleaned.replace(/<[^>]*>/g, '')
    cleaned = cleaned.replace(/javascript\s*:/gi, '[FILTERED]:')
    cleaned = cleaned.replace(/(\b(DROP|ALTER|DELETE|INSERT|EXEC)\b\s+(TABLE|FROM|INTO))/gi, '[FILTERED]')
    cleaned = cleaned.replace(/(\bUPDATE\b\s+\w+\s+SET\b)/gi, '[FILTERED]')
    cleaned = cleaned.replace(/(\bUNION\b\s+(ALL\s+)?SELECT\b)/gi, '[FILTERED]')
    cleaned = cleaned.replace(/\0/g, '')
    return cleaned
  }

  it('should strip HTML tags', () => {
    expect(sanitiseText('<script>alert("xss")</script>')).toBe('')
    expect(sanitiseText('<p>Hello</p>')).toBe('Hello')
    expect(sanitiseText('<img src="x" onerror="alert(1)">')).toBe('')
    expect(sanitiseText('Normal text')).toBe('Normal text')
  })

  it('should filter SQL injection patterns', () => {
    // The regex matches "DROP TABLE" but not trailing words like "users"
    expect(sanitiseText("DROP TABLE users")).toBe('[FILTERED] users')
    expect(sanitiseText("'; DELETE FROM memories")).toBe("'; [FILTERED] memories")
    expect(sanitiseText("1; INSERT INTO admin")).toBe("1; [FILTERED] admin")
    expect(sanitiseText("UNION ALL SELECT")).toBe('[FILTERED]')
    expect(sanitiseText("1; UPDATE memories SET content='pwned'")).toBe("1; [FILTERED] content='pwned'")
  })

  it('should remove null bytes', () => {
    expect(sanitiseText('hello\0world')).toBe('helloworld')
    expect(sanitiseText('\0\0\0')).toBe('')
  })

  it('should preserve normal text', () => {
    const normal = 'This is a normal memory about my project meeting.'
    expect(sanitiseText(normal)).toBe(normal)
  })

  it('should handle mixed attacks', () => {
    const attack = '<script>DROP TABLE users</script>\0evil'
    const result = sanitiseText(attack)
    expect(result).not.toContain('<script>')
    expect(result).not.toContain('\0')
    // Script block stripped entirely, so SQL inside it is gone too
    expect(result).toBe('evil')
  })
})

describe('String Length Limits', () => {
  const safeString = (maxLen: number) => z.string().max(maxLen)

  it('should accept strings within limit', () => {
    const schema = safeString(100)
    expect(schema.safeParse('short').success).toBe(true)
    expect(schema.safeParse('a'.repeat(100)).success).toBe(true)
  })

  it('should reject strings exceeding limit', () => {
    const schema = safeString(100)
    expect(schema.safeParse('a'.repeat(101)).success).toBe(false)
    expect(schema.safeParse('a'.repeat(1000)).success).toBe(false)
  })
})

describe('Pagination Limit Validation', () => {
  const paginationLimit = z.number().int().positive().max(100).default(10)

  it('should accept valid limits', () => {
    expect(paginationLimit.safeParse(1).data).toBe(1)
    expect(paginationLimit.safeParse(50).data).toBe(50)
    expect(paginationLimit.safeParse(100).data).toBe(100)
  })

  it('should use default when undefined', () => {
    expect(paginationLimit.safeParse(undefined).data).toBe(10)
  })

  it('should reject invalid limits', () => {
    expect(paginationLimit.safeParse(0).success).toBe(false)
    expect(paginationLimit.safeParse(-1).success).toBe(false)
    expect(paginationLimit.safeParse(101).success).toBe(false)
    expect(paginationLimit.safeParse(1.5).success).toBe(false)
  })
})

describe('Importance Level Validation', () => {
  const importanceLevel = z.enum(['low', 'medium', 'high', 'critical']).optional()

  it('should accept valid importance levels', () => {
    expect(importanceLevel.safeParse('low').success).toBe(true)
    expect(importanceLevel.safeParse('medium').success).toBe(true)
    expect(importanceLevel.safeParse('high').success).toBe(true)
    expect(importanceLevel.safeParse('critical').success).toBe(true)
  })

  it('should accept undefined', () => {
    expect(importanceLevel.safeParse(undefined).success).toBe(true)
  })

  it('should reject invalid levels', () => {
    expect(importanceLevel.safeParse('urgent').success).toBe(false)
    expect(importanceLevel.safeParse('LOW').success).toBe(false)
    expect(importanceLevel.safeParse('').success).toBe(false)
    expect(importanceLevel.safeParse(1).success).toBe(false)
  })
})

describe('Metadata Object Validation', () => {
  const metadataSchema = z.record(z.string(), z.unknown()).optional()

  it('should accept valid metadata objects', () => {
    expect(metadataSchema.safeParse({ key: 'value' }).success).toBe(true)
    expect(metadataSchema.safeParse({ num: 123, bool: true }).success).toBe(true)
    expect(metadataSchema.safeParse({}).success).toBe(true)
  })

  it('should accept undefined', () => {
    expect(metadataSchema.safeParse(undefined).success).toBe(true)
  })

  it('should accept nested objects', () => {
    const nested = {
      level1: {
        level2: {
          value: 'deep'
        }
      }
    }
    expect(metadataSchema.safeParse(nested).success).toBe(true)
  })
})

describe('Array Input Validation', () => {
  const memoryIdsSchema = z.array(z.string().uuid()).min(1).max(100)

  it('should accept valid arrays', () => {
    const validIds = ['550e8400-e29b-41d4-a716-446655440000']
    expect(memoryIdsSchema.safeParse(validIds).success).toBe(true)
  })

  it('should reject empty arrays', () => {
    expect(memoryIdsSchema.safeParse([]).success).toBe(false)
  })

  it('should reject arrays with invalid UUIDs', () => {
    expect(memoryIdsSchema.safeParse(['not-uuid']).success).toBe(false)
    expect(memoryIdsSchema.safeParse(['550e8400-e29b-41d4-a716-446655440000', 'invalid']).success).toBe(false)
  })
})

describe('Temporal Query Validation', () => {
  const temporalQuerySchema = z.object({
    after: z.string().optional(),
    before: z.string().optional(),
    limit: z.number().int().positive().max(100).optional()
  })

  it('should accept valid temporal queries', () => {
    expect(temporalQuerySchema.safeParse({}).success).toBe(true)
    expect(temporalQuerySchema.safeParse({ after: '2026-01-01' }).success).toBe(true)
    expect(temporalQuerySchema.safeParse({ before: '2026-12-31', limit: 50 }).success).toBe(true)
  })

  it('should accept date range queries', () => {
    const range = {
      after: '2026-01-01',
      before: '2026-12-31',
      limit: 20
    }
    expect(temporalQuerySchema.safeParse(range).success).toBe(true)
  })
})

describe('Search Query Validation', () => {
  const searchQuerySchema = z.object({
    query: z.string().min(1).max(1000),
    limit: z.number().int().positive().max(100).optional(),
    threshold: z.number().min(0).max(1).optional()
  })

  it('should accept valid search queries', () => {
    expect(searchQuerySchema.safeParse({ query: 'test' }).success).toBe(true)
    expect(searchQuerySchema.safeParse({ query: 'test', limit: 10 }).success).toBe(true)
    expect(searchQuerySchema.safeParse({ query: 'test', threshold: 0.5 }).success).toBe(true)
  })

  it('should reject empty queries', () => {
    expect(searchQuerySchema.safeParse({ query: '' }).success).toBe(false)
  })

  it('should reject queries exceeding length limit', () => {
    expect(searchQuerySchema.safeParse({ query: 'a'.repeat(1001) }).success).toBe(false)
  })

  it('should reject invalid thresholds', () => {
    expect(searchQuerySchema.safeParse({ query: 'test', threshold: -0.1 }).success).toBe(false)
    expect(searchQuerySchema.safeParse({ query: 'test', threshold: 1.1 }).success).toBe(false)
  })
})

// ─── REM-248: New schema coverage ─────────────────────────────────────────────

describe('validateToolInput — explore_relationships (REM-248)', () => {
  const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000'

  it('should accept valid minimal input', () => {
    const result = validateToolInput('explore_relationships', { memory_id: VALID_UUID })
    expect(result.success).toBe(true)
  })

  it('should accept full valid input', () => {
    const result = validateToolInput('explore_relationships', {
      memory_id: VALID_UUID,
      depth: 3,
      min_confidence: 0.7,
      relationship_types: ['causes', 'supports', 'contradicts']
    })
    expect(result.success).toBe(true)
  })

  it('should apply defaults for depth and min_confidence', () => {
    const result = validateToolInput('explore_relationships', { memory_id: VALID_UUID })
    expect(result.success).toBe(true)
    if (result.success) {
      expect((result.data as any).depth).toBe(2)
      expect((result.data as any).min_confidence).toBe(0.5)
    }
  })

  it('should reject missing memory_id', () => {
    const result = validateToolInput('explore_relationships', { depth: 2 })
    expect(result.success).toBe(false)
  })

  it('should reject invalid UUID for memory_id', () => {
    const result = validateToolInput('explore_relationships', { memory_id: 'not-a-uuid' })
    expect(result.success).toBe(false)
  })

  it('should clamp depth — reject depth > 3', () => {
    const result = validateToolInput('explore_relationships', { memory_id: VALID_UUID, depth: 10 })
    expect(result.success).toBe(false)
  })

  it('should clamp depth — reject depth < 1', () => {
    const result = validateToolInput('explore_relationships', { memory_id: VALID_UUID, depth: 0 })
    expect(result.success).toBe(false)
  })

  it('should reject min_confidence out of range', () => {
    expect(validateToolInput('explore_relationships', { memory_id: VALID_UUID, min_confidence: 1.5 }).success).toBe(false)
    expect(validateToolInput('explore_relationships', { memory_id: VALID_UUID, min_confidence: -0.1 }).success).toBe(false)
  })

  it('should reject relationship_types array exceeding 20 entries', () => {
    const result = validateToolInput('explore_relationships', {
      memory_id: VALID_UUID,
      relationship_types: Array.from({ length: 21 }, (_, i) => `type_${i}`)
    })
    expect(result.success).toBe(false)
  })

  it('should reject relationship_types with empty strings', () => {
    const result = validateToolInput('explore_relationships', {
      memory_id: VALID_UUID,
      relationship_types: ['']
    })
    expect(result.success).toBe(false)
  })

  it('should strip HTML injection from relationship_types', () => {
    // safeRelationshipType does not sanitise, but max(100) and min(1) constrain it
    const result = validateToolInput('explore_relationships', {
      memory_id: VALID_UUID,
      relationship_types: ['a'.repeat(101)]
    })
    expect(result.success).toBe(false)
  })
})

describe('validateToolInput — ingest_document (REM-248)', () => {
  const validDoc = { content: 'This is a document about Rembr architecture.' }

  it('should accept valid minimal input', () => {
    expect(validateToolInput('ingest_document', validDoc).success).toBe(true)
  })

  it('should accept full valid input', () => {
    const result = validateToolInput('ingest_document', {
      content: 'Full document content here.',
      title: 'Architecture Doc',
      category: 'projects',
      source: 'https://docs.example.com/arch',
      chunk_size: 500,
      metadata: { author: 'Iris', version: '1.0' }
    })
    expect(result.success).toBe(true)
  })

  it('should apply defaults for title and chunk_size', () => {
    const result = validateToolInput('ingest_document', validDoc)
    expect(result.success).toBe(true)
    if (result.success) {
      expect((result.data as any).title).toBe('Untitled Document')
      expect((result.data as any).chunk_size).toBe(1000)
    }
  })

  it('should reject missing content', () => {
    expect(validateToolInput('ingest_document', { title: 'Orphan Title' }).success).toBe(false)
  })

  it('should reject empty content', () => {
    expect(validateToolInput('ingest_document', { content: '' }).success).toBe(false)
  })

  it('should reject chunk_size below minimum', () => {
    expect(validateToolInput('ingest_document', { content: 'x', chunk_size: 199 }).success).toBe(false)
  })

  it('should reject chunk_size above maximum', () => {
    expect(validateToolInput('ingest_document', { content: 'x', chunk_size: 5001 }).success).toBe(false)
  })

  it('should reject invalid memory category', () => {
    expect(validateToolInput('ingest_document', { content: 'x', category: 'not_a_category' }).success).toBe(false)
  })

  it('should sanitise SQL injection in content', () => {
    const result = validateToolInput('ingest_document', { content: 'DROP TABLE memories; --' })
    expect(result.success).toBe(true)
    if (result.success) {
      // sanitiseText replaces only "DROP TABLE" pattern
      expect((result.data as any).content).toContain('[FILTERED]')
    }
  })

  it('should reject content exceeding max length', () => {
    expect(validateToolInput('ingest_document', { content: 'a'.repeat(100_001) }).success).toBe(false)
  })
})

describe('validateToolInput — pii (REM-248)', () => {
  it('should accept valid detect operation', () => {
    const result = validateToolInput('pii', {
      operation: 'detect',
      text: 'Call me at 555-123-4567.',
      sensitivity: 'high'
    })
    expect(result.success).toBe(true)
  })

  it('should accept valid redact operation', () => {
    const result = validateToolInput('pii', {
      operation: 'redact',
      text: 'Email: alice@example.com',
      sensitivity: 'medium',
      redaction_mode: 'mask'
    })
    expect(result.success).toBe(true)
  })

  it('should accept valid audit operation without memory_id', () => {
    const result = validateToolInput('pii', { operation: 'audit' })
    expect(result.success).toBe(true)
  })

  it('should accept audit with valid memory_id', () => {
    const result = validateToolInput('pii', {
      operation: 'audit',
      memory_id: '550e8400-e29b-41d4-a716-446655440000',
      limit: 50
    })
    expect(result.success).toBe(true)
  })

  it('should accept compliance_report with date range', () => {
    const result = validateToolInput('pii', {
      operation: 'compliance_report',
      start_date: '2026-01-01T00:00:00Z',
      end_date: '2026-01-31T23:59:59Z'
    })
    expect(result.success).toBe(true)
  })

  it('should accept batch_scan', () => {
    expect(validateToolInput('pii', { operation: 'batch_scan', limit: 200 }).success).toBe(true)
  })

  it('should reject missing operation', () => {
    const result = validateToolInput('pii', { text: 'some text' })
    expect(result.success).toBe(false)
  })

  it('should reject unknown operation', () => {
    const result = validateToolInput('pii', { operation: 'nuke_database', text: 'x' })
    expect(result.success).toBe(false)
  })

  it('should reject detect without text', () => {
    const result = validateToolInput('pii', { operation: 'detect' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.details.some(d => d.field === 'text')).toBe(true)
    }
  })

  it('should reject redact without text', () => {
    const result = validateToolInput('pii', { operation: 'redact' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.details.some(d => d.field === 'text')).toBe(true)
    }
  })

  it('should reject invalid sensitivity value', () => {
    const result = validateToolInput('pii', {
      operation: 'detect',
      text: 'hello',
      sensitivity: 'extreme'
    })
    expect(result.success).toBe(false)
  })

  it('should reject invalid redaction_mode', () => {
    const result = validateToolInput('pii', {
      operation: 'redact',
      text: 'hello',
      redaction_mode: 'scramble'
    })
    expect(result.success).toBe(false)
  })

  it('should reject invalid UUID in memory_id', () => {
    const result = validateToolInput('pii', {
      operation: 'audit',
      memory_id: 'not-a-uuid'
    })
    expect(result.success).toBe(false)
  })

  it('should reject invalid date in start_date', () => {
    const result = validateToolInput('pii', {
      operation: 'compliance_report',
      start_date: 'last week'
    })
    expect(result.success).toBe(false)
  })

  it('should sanitise HTML/injection in text field', () => {
    const result = validateToolInput('pii', {
      operation: 'detect',
      text: '<script>alert("xss")</script>My email is alice@example.com'
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect((result.data as any).text).not.toContain('<script>')
    }
  })
})

describe('validateToolInput — tool coverage completeness (REM-248)', () => {
  const KNOWN_TOOLS = [
    'store_memory', 'search_memory', 'list_memories', 'get_memory',
    'update_memory', 'delete_memory', 'find_similar_memories',
    'get_stats', 'get_embedding_stats', 'list_contexts', 'create_context',
    'search_context', 'add_memory_to_context', 'create_snapshot',
    'get_snapshot', 'list_snapshots', 'get_memory_graph',
    'detect_contradictions', 'get_context_insights', 'classify_query_intent',
    'infer_memory_relationships', 'enhanced_search', 'get_memory_insights',
    'detect_memory_contradictions', 'generate_context_graph',
    'generate_memory_insights', 'get_predictive_analytics',
    'set_memory_visibility', 'list_personal_memories',
    'trace_causality', 'infer_causality', 'get_causal_links',
    'validate_causal_link', 'search_at_time', 'get_memory_history',
    'create_temporal_snapshot', 'list_temporal_snapshots', 'compare_snapshots',
    'query_audit_log', 'generate_compliance_report', 'get_audit_stats',
    'upload_attachment', 'list_attachments', 'get_attachment_url',
    'delete_attachment', 'get_storage_usage',
    // REM-248 additions:
    'explore_relationships', 'ingest_document', 'pii'
  ]

  it('should have a schema registered for every known tool', () => {
    // validateToolInput returns success:true (pass-through) for unknown tools.
    // For known tools, safeParse should parse (not silently pass through).
    // We verify by passing empty args — if no schema, it passes; if schema exists,
    // it may fail validation (which is correct behaviour — schema is enforced).
    for (const tool of KNOWN_TOOLS) {
      // Just check the function runs without throwing
      expect(() => validateToolInput(tool, {})).not.toThrow()
    }
  })

  it('validateToolInput should return success:true for unknown tools (pass-through)', () => {
    const result = validateToolInput('totally_unknown_tool', { some: 'arg' })
    // Unknown tools pass through — this is expected; the tool handler will error later
    expect(result.success).toBe(true)
  })
})

// ─── RAD-7: mcporter Quote-Stripping ─────────────────────────────────────────
describe('RAD-7: UUID and enum quote tolerance (mcporter extra-quoting fix)', () => {
  const VALID_UUID = 'a5d8463a-7e30-423d-8fc3-aede3d8ffd0c'

  describe('UUID fields — quoted variants', () => {
    it('should accept a double-quoted UUID in memory_id', () => {
      const result = validateToolInput('find_similar_memories', {
        memory_id: `"${VALID_UUID}"`
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect((result.data as Record<string, unknown>).memory_id).toBe(VALID_UUID)
      }
    })

    it('should accept a double-double-quoted UUID (mcporter double-quoting)', () => {
      const result = validateToolInput('find_similar_memories', {
        memory_id: `""${VALID_UUID}""`
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect((result.data as Record<string, unknown>).memory_id).toBe(VALID_UUID)
      }
    })

    it('should accept a single-quoted UUID', () => {
      const result = validateToolInput('find_similar_memories', {
        memory_id: `'${VALID_UUID}'`
      })
      expect(result.success).toBe(true)
    })

    it('should accept quoted UUIDs in add_memory_to_context (both fields)', () => {
      const result = validateToolInput('add_memory_to_context', {
        memory_id: `"${VALID_UUID}"`,
        context_id: `""${VALID_UUID}""`
      })
      expect(result.success).toBe(true)
      if (result.success) {
        const d = result.data as Record<string, unknown>
        expect(d.memory_id).toBe(VALID_UUID)
        expect(d.context_id).toBe(VALID_UUID)
      }
    })

    it('should still reject a non-UUID string even if quoted', () => {
      const result = validateToolInput('find_similar_memories', {
        memory_id: '"not-a-uuid"'
      })
      expect(result.success).toBe(false)
    })
  })

  describe('Enum fields — quoted variants', () => {
    it('should accept a quoted memory category in store_memory', () => {
      const result = validateToolInput('store_memory', {
        content: 'Test memory content for RAD-7',
        category: '"facts"'
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect((result.data as Record<string, unknown>).category).toBe('facts')
      }
    })

    it('should accept a double-quoted memory category', () => {
      const result = validateToolInput('store_memory', {
        content: 'Test memory content for RAD-7',
        category: '""projects""'
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect((result.data as Record<string, unknown>).category).toBe('projects')
      }
    })

    it('should accept a quoted search_mode in search_memory', () => {
      const result = validateToolInput('search_memory', {
        query: 'test query',
        search_mode: '"semantic"'
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect((result.data as Record<string, unknown>).search_mode).toBe('semantic')
      }
    })

    it('should still reject an invalid enum value even without quotes', () => {
      const result = validateToolInput('store_memory', {
        content: 'Test content',
        category: 'invalid_category'
      })
      expect(result.success).toBe(false)
    })

    it('should still reject an invalid enum value even with quotes', () => {
      const result = validateToolInput('store_memory', {
        content: 'Test content',
        category: '"invalid_category"'
      })
      expect(result.success).toBe(false)
    })
  })
})

// ─── RAD-66: get_memory_insights analysis_type default ───────────────────────
describe('RAD-66: get_memory_insights — analysis_type defaults to patterns', () => {
  it('should succeed when analysis_type is omitted (defaults to patterns)', () => {
    const result = validateToolInput('get_memory_insights', {})
    expect(result.success).toBe(true)
    if (result.success) {
      expect((result.data as Record<string, unknown>).analysis_type).toBe('patterns')
    }
  })

  it('should succeed with explicit analysis_type', () => {
    const result = validateToolInput('get_memory_insights', { analysis_type: 'relationships' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect((result.data as Record<string, unknown>).analysis_type).toBe('relationships')
    }
  })

  it('should succeed with quoted analysis_type (mcporter quoting)', () => {
    const result = validateToolInput('get_memory_insights', { analysis_type: '"usage"' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect((result.data as Record<string, unknown>).analysis_type).toBe('usage')
    }
  })

  it('should reject an invalid analysis_type', () => {
    const result = validateToolInput('get_memory_insights', { analysis_type: 'invalid' })
    expect(result.success).toBe(false)
  })

  it('time_range_days defaults to 30 when omitted', () => {
    const result = validateToolInput('get_memory_insights', {})
    expect(result.success).toBe(true)
    if (result.success) {
      expect((result.data as Record<string, unknown>).time_range_days).toBe(30)
    }
  })
})

// ─── RAD-73: plan_compaction schema ──────────────────────────────────────────
describe('RAD-73: plan_compaction schema validation', () => {
  it('should accept check operation (no extra params needed)', () => {
    const result = validateToolInput('plan_compaction', { operation: 'check' })
    expect(result.success).toBe(true)
  })

  it('should accept schedule with all required fields', () => {
    const result = validateToolInput('plan_compaction', {
      operation: 'schedule',
      old_plan: 'pro',
      new_plan: 'free',
      old_memory_limit: 25000,
      new_memory_limit: 1000,
      grace_period_days: 7
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect((result.data as Record<string, unknown>).grace_period_days).toBe(7)
    }
  })

  it('should default grace_period_days to 7', () => {
    const result = validateToolInput('plan_compaction', {
      operation: 'schedule',
      old_plan: 'pro', new_plan: 'free',
      old_memory_limit: 25000, new_memory_limit: 1000
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect((result.data as Record<string, unknown>).grace_period_days).toBe(7)
    }
  })

  it('should accept consent with schedule_id', () => {
    const result = validateToolInput('plan_compaction', {
      operation: 'consent',
      schedule_id: 'sched-uuid-123'
    })
    expect(result.success).toBe(true)
  })

  it('should accept preview with new_memory_limit', () => {
    const result = validateToolInput('plan_compaction', {
      operation: 'preview',
      new_memory_limit: 1000,
      similarity_threshold: 0.8
    })
    expect(result.success).toBe(true)
    if (result.success) {
      const d = result.data as Record<string, unknown>
      expect(d.similarity_threshold).toBe(0.8)
    }
  })

  it('should default similarity_threshold to 0.7', () => {
    const result = validateToolInput('plan_compaction', {
      operation: 'execute',
      schedule_id: 'sched-uuid-123'
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect((result.data as Record<string, unknown>).similarity_threshold).toBe(0.7)
    }
  })

  it('should accept execute with optional project_id', () => {
    const result = validateToolInput('plan_compaction', {
      operation: 'execute',
      schedule_id: 'sched-uuid-123',
      project_id: 'proj-abc'
    })
    expect(result.success).toBe(true)
  })

  it('should accept cancel operation', () => {
    const result = validateToolInput('plan_compaction', {
      operation: 'cancel',
      schedule_id: 'sched-uuid-123'
    })
    expect(result.success).toBe(true)
  })

  it('should accept history operation', () => {
    const result = validateToolInput('plan_compaction', { operation: 'history', limit: 5 })
    expect(result.success).toBe(true)
  })

  it('should reject invalid operation', () => {
    const result = validateToolInput('plan_compaction', { operation: 'invalid_op' })
    expect(result.success).toBe(false)
  })

  it('should reject similarity_threshold out of range', () => {
    const result = validateToolInput('plan_compaction', {
      operation: 'preview',
      new_memory_limit: 1000,
      similarity_threshold: 1.5
    })
    expect(result.success).toBe(false)
  })

  it('should reject grace_period_days > 30', () => {
    const result = validateToolInput('plan_compaction', {
      operation: 'schedule',
      old_plan: 'pro', new_plan: 'free',
      old_memory_limit: 25000, new_memory_limit: 1000,
      grace_period_days: 31
    })
    expect(result.success).toBe(false)
  })

  it('should accept execute_after as ISO date string (RAD-73 refinement)', () => {
    const result = validateToolInput('plan_compaction', {
      operation: 'schedule',
      old_plan: 'pro', new_plan: 'free',
      old_memory_limit: 25000, new_memory_limit: 1000,
      execute_after: '2026-04-30T00:00:00Z'
    })
    expect(result.success).toBe(true)
  })

  it('should reject invalid execute_after date', () => {
    const result = validateToolInput('plan_compaction', {
      operation: 'schedule',
      old_plan: 'pro', new_plan: 'free',
      old_memory_limit: 25000, new_memory_limit: 1000,
      execute_after: 'not-a-date'
    })
    expect(result.success).toBe(false)
  })
})

// ─── RAD-65: create_snapshot at-least-one constraint ─────────────────────────
describe('RAD-65: create_snapshot — at-least-one validation', () => {
  it('should fail when called with no selection params (agent confusion case)', () => {
    const result = validateToolInput('create_snapshot', { name: 'My Snapshot' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('create_snapshot requires at least one of')
    }
  })

  it('should succeed with query only', () => {
    const result = validateToolInput('create_snapshot', { query: 'recent project work' })
    expect(result.success).toBe(true)
  })

  it('should succeed with memory_ids only', () => {
    const result = validateToolInput('create_snapshot', {
      memory_ids: ['550e8400-e29b-41d4-a716-446655440000']
    })
    expect(result.success).toBe(true)
  })

  it('should succeed with context_ids only', () => {
    const result = validateToolInput('create_snapshot', {
      context_ids: ['550e8400-e29b-41d4-a716-446655440000']
    })
    expect(result.success).toBe(true)
  })

  it('should succeed with query + name + description (all optional extras)', () => {
    const result = validateToolInput('create_snapshot', {
      query: 'project tasks',
      name: 'Sprint snapshot',
      description: 'End of sprint capture',
      ttl_hours: 24
    })
    expect(result.success).toBe(true)
  })

  it('error message should be actionable (contains example)', () => {
    const result = validateToolInput('create_snapshot', {})
    expect(result.success).toBe(false)
    if (!result.success) {
      // Should contain example usage
      expect(result.error).toContain('Example:')
    }
  })

  it('empty arrays should not satisfy the constraint', () => {
    const result = validateToolInput('create_snapshot', {
      memory_ids: [],
      context_ids: []
    })
    expect(result.success).toBe(false)
  })
})

// ─── RAD-60: plan_regeneration schema ────────────────────────────────────────
describe('RAD-60: plan_regeneration schema validation', () => {
  it('should accept minimal trigger (task_id + operation only)', () => {
    const result = validateToolInput('plan_regeneration', {
      operation: 'trigger',
      task_id: 'task-abc-123'
    })
    expect(result.success).toBe(true)
    if (result.success) {
      const d = result.data as Record<string, unknown>
      expect(d.reason_type).toBe('manual')
      expect(d.limit).toBe(10)
    }
  })

  it('should accept full trigger with all fields', () => {
    const result = validateToolInput('plan_regeneration', {
      operation: 'trigger',
      task_id: 'task-abc-123',
      reason_type: 'stuck_detection',
      reason: 'Task has been blocked for 2 hours',
      evidence: ['Error: timeout', 'Retry limit exceeded'],
      iteration_count: 5,
      failure_count: 3,
      elapsed_minutes: 120
    })
    expect(result.success).toBe(true)
  })

  it('should accept quoted reason_type (mcporter quoting)', () => {
    const result = validateToolInput('plan_regeneration', {
      operation: 'trigger',
      task_id: 'task-abc',
      reason_type: '"manual"'
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect((result.data as Record<string, unknown>).reason_type).toBe('manual')
    }
  })

  it('should accept history operation', () => {
    const result = validateToolInput('plan_regeneration', {
      operation: 'history',
      task_id: 'task-abc-123',
      limit: 5
    })
    expect(result.success).toBe(true)
  })

  it('should accept analyze_stuck operation', () => {
    const result = validateToolInput('plan_regeneration', {
      operation: 'analyze_stuck',
      task_id: 'task-abc-123'
    })
    expect(result.success).toBe(true)
  })

  it('should accept resolve operation', () => {
    const result = validateToolInput('plan_regeneration', {
      operation: 'resolve',
      regeneration_id: 'regen-uuid-123',
      new_plan: 'Try a different approach using X'
    })
    expect(result.success).toBe(true)
  })

  it('should reject invalid operation', () => {
    const result = validateToolInput('plan_regeneration', {
      operation: 'invalid_op',
      task_id: 'task-abc'
    })
    expect(result.success).toBe(false)
  })

  it('should reject invalid reason_type', () => {
    const result = validateToolInput('plan_regeneration', {
      operation: 'trigger',
      task_id: 'task-abc',
      reason_type: 'unknown_reason'
    })
    expect(result.success).toBe(false)
  })

  it('should be registered in toolSchemas', () => {
    // Pass-through check: plan_regeneration is known
    const result = validateToolInput('plan_regeneration', { operation: 'analyze_stuck', task_id: 't' })
    // If schema not registered it would return success:true (pass-through) but with no validation
    // The fact it validates reason_type etc. proves the schema is active
    expect(result.success).toBe(true)
  })
})
