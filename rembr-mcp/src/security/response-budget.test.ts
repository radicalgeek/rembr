import { describe, expect, it } from 'vitest';
import { fitJsonResponse, fitJsonText, fitMcpToolResult } from './response-budget.js';

describe('MCP response byte budget', () => {
  it('keeps only whole result items and emits continuation counts', () => {
    const content = '🫐'.repeat(12_000);
    const response = {
      success: true,
      pagination: { items: [
        { id: 'one', content },
        { id: 'two', content },
        { id: 'three', content },
      ] },
    };

    const fitted = fitJsonResponse(response, 64 * 1024) as any;
    const encoded = JSON.stringify(fitted);
    expect(Buffer.byteLength(encoded, 'utf8')).toBeLessThanOrEqual(64 * 1024);
    expect(fitted.truncated).toBe(true);
    expect(fitted.pagination.items).toHaveLength(1);
    expect(fitted.pagination.items[0].content).toBe(content);
    expect(fitted.response_budget).toMatchObject({ returned_count: 1, total_count: 3 });
    expect(fitted.continuation).toContain('limit/max_tokens');
  });

  it('returns valid JSON and never slices a multi-byte content scalar', () => {
    const original = { items: [{ id: 'one', content: '🚀'.repeat(20_000) }, { id: 'two', content: 'safe' }] };
    const text = fitJsonText(JSON.stringify(original), 64 * 1024);
    expect(() => JSON.parse(text)).not.toThrow();
    const parsed = JSON.parse(text);
    expect(parsed.items).toEqual([]);
    expect(parsed.truncated).toBe(true);
  });

  it('applies the same budget to SDK tool content', () => {
    const result = fitMcpToolResult({
      content: [{ type: 'text', text: JSON.stringify({ memories: [
        { id: 'one', content: 'x'.repeat(900_000) },
        { id: 'two', content: 'y'.repeat(900_000) },
        { id: 'three', content: 'z'.repeat(900_000) },
      ] }) }],
    });
    expect(Buffer.byteLength(result.content[0].text, 'utf8')).toBeLessThanOrEqual(2 * 1024 * 1024);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.truncated).toBe(true);
    expect(parsed.memories).toHaveLength(2);
  });

  it('fits large arrays with linear item serialization work', () => {
    let serializations = 0;
    const items = Array.from({ length: 10_000 }, (_, index) => ({
      toJSON() {
        serializations += 1;
        return { id: index, content: 'x'.repeat(64) };
      },
    }));

    const fitted = fitJsonResponse({ items }, 64 * 1024) as any;
    expect(Buffer.byteLength(JSON.stringify(fitted), 'utf8')).toBeLessThanOrEqual(64 * 1024);
    expect(fitted.items.length).toBeGreaterThan(0);
    expect(fitted.items.length).toBeLessThan(items.length);
    // One full-size check plus, at most, one serialization per candidate item.
    expect(serializations).toBeLessThanOrEqual(items.length * 2 + 2);
  });
});
