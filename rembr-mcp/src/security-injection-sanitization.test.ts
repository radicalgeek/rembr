/**
 * Security boundary tests for durable source fidelity and sink encoding.
 *
 * SQL and HTML-like text is legitimate memory content (source code, incident
 * notes and security findings). Input validation must preserve it exactly;
 * parameterised SQL and context-specific output encoders provide the safety
 * boundary instead of lossy keyword/tag stripping.
 */

import { describe, expect, it } from 'vitest';
import { validateToolInput } from './schemas.js';
import { encodeCsvCell, encodeMarkdownCell } from './security/export-encoding.js';
import { escapeHtml } from './ui-resources/index.js';

describe('durable source fidelity', () => {
  const sourceSamples = [
    "'; DROP TABLE memories; --",
    'UNION ALL SELECT * FROM tenants',
    '<script>alert("xss")</script>',
    '<img src="x" onerror="alert(1)">',
    'Robert\'); UPDATE memories SET content=\'safe\';--',
  ];

  for (const source of sourceSamples) {
    it(`preserves source text: ${source.slice(0, 35)}`, () => {
      const result = validateToolInput('store_memory', { content: source, category: 'facts' });
      expect(result.success).toBe(true);
      if (result.success) expect((result.data as any).content).toBe(source);
    });
  }

  it('preserves exact security search syntax', () => {
    const query = '<script> UNION SELECT password FROM users --';
    const result = validateToolInput('search_memory', { query });
    expect(result.success).toBe(true);
    if (result.success) expect((result.data as any).query).toBe(query);
  });

  it('rejects NUL bytes rather than silently changing stored text', () => {
    expect(validateToolInput('store_memory', {
      content: 'hello\0world',
      category: 'facts',
    }).success).toBe(false);
  });
});

describe('context-specific output encoding', () => {
  it('escapes active HTML at the HTML rendering sink', () => {
    const payload = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const rendered = escapeHtml(payload);
    expect(rendered).not.toContain('<script>');
    expect(rendered).not.toContain('<img');
    expect(rendered).toContain('&lt;script&gt;');
  });

  it('neutralises spreadsheet formulas in CSV cells', () => {
    expect(encodeCsvCell(' \t=HYPERLINK("https://evil.invalid")')).toMatch(/^"'/);
    expect(encodeCsvCell('+cmd')).toMatch(/^"'/);
  });

  it('keeps untrusted text inside one Markdown table cell', () => {
    expect(encodeMarkdownCell('a|b\nnext')).toBe('a\\|b<br>next');
  });
});

describe('schema size, type and object-shape limits', () => {
  for (const limit of [999_999, 0, -1, Number.NaN]) {
    it(`rejects unsafe search limit ${String(limit)}`, () => {
      expect(validateToolInput('search_memory', { query: 'test', limit }).success).toBe(false);
    });
  }

  it('accepts an in-range limit unchanged', () => {
    const result = validateToolInput('search_memory', { query: 'test', limit: 10 });
    expect(result.success).toBe(true);
    if (result.success) expect((result.data as any).limit).toBe(10);
  });

  it('rejects content exceeding 100,000 characters', () => {
    expect(validateToolInput('store_memory', {
      content: 'a'.repeat(100_001),
      category: 'facts',
    }).success).toBe(false);
  });

  it('rejects deeply nested metadata without allowing prototype pollution', () => {
    let nested: Record<string, unknown> = { value: 'end' };
    for (let index = 0; index < 50; index += 1) nested = { child: nested };
    expect(validateToolInput('store_memory', {
      content: 'test', category: 'facts', metadata: nested,
    }).success).toBe(false);

    const polluted = JSON.parse('{"content":"test","category":"facts","metadata":{"__proto__":{"polluted":true}}}');
    expect(validateToolInput('store_memory', polluted).success).toBe(true);
    expect(({} as any).polluted).toBeUndefined();
  });

  it('fails cleanly for missing fields and wrong scalar types', () => {
    expect(validateToolInput('store_memory', {}).success).toBe(false);
    expect(validateToolInput('search_memory', { query: 'test', limit: 'fifty' }).success).toBe(false);
  });
});
