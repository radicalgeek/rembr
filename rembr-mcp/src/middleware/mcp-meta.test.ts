/**
 * Tests for MCP _meta extraction (SEP-2575 / SEP-414).
 */

import { describe, it, expect } from 'vitest';
import { extractMcpMeta } from './mcp-meta.js';

describe('extractMcpMeta', () => {
  it('extracts protocolVersion, clientInfo, and clientCapabilities', () => {
    const meta = extractMcpMeta({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'memory',
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': { name: 'claude-code', version: '2.1.0' },
          'io.modelcontextprotocol/clientCapabilities': { extensions: {} },
        },
      },
    });

    expect(meta.protocolVersion).toBe('2026-07-28');
    expect(meta.clientInfo?.name).toBe('claude-code');
    expect(meta.clientCapabilities).toEqual({ extensions: {} });
  });

  it('extracts W3C trace context keys (SEP-414)', () => {
    const meta = extractMcpMeta({
      params: {
        _meta: {
          traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
          tracestate: 'vendor=value',
          baggage: 'userId=alice',
        },
      },
    });

    expect(meta.traceparent).toBe('00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01');
    expect(meta.tracestate).toBe('vendor=value');
    expect(meta.baggage).toBe('userId=alice');
  });

  it('returns empty object for legacy clients without _meta', () => {
    expect(extractMcpMeta({ jsonrpc: '2.0', method: 'tools/list', params: {} })).toEqual({});
    expect(extractMcpMeta({ jsonrpc: '2.0', method: 'initialize' })).toEqual({});
  });

  it('never throws on malformed input', () => {
    expect(extractMcpMeta(null)).toEqual({});
    expect(extractMcpMeta(undefined)).toEqual({});
    expect(extractMcpMeta('not json')).toEqual({});
    expect(extractMcpMeta({ params: { _meta: 'bogus' } })).toEqual({});
    expect(extractMcpMeta({ params: { _meta: { 'io.modelcontextprotocol/protocolVersion': 42 } } })).toEqual({});
  });
});
