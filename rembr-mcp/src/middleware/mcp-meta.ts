/**
 * MCP Request _meta Extraction (SEP-2575, SEP-2567, SEP-414)
 *
 * Under MCP 2026-07-28 the initialize handshake is removed and every request
 * carries client metadata in `params._meta`:
 *
 *   - io.modelcontextprotocol/protocolVersion   (string)
 *   - io.modelcontextprotocol/clientInfo        ({ name, version, ... })
 *   - io.modelcontextprotocol/clientCapabilities (object)
 *
 * SEP-414 additionally documents W3C trace-context keys in `_meta`:
 *
 *   - traceparent / tracestate / baggage
 *
 * Clients on older protocol revisions (2025-11-25 and earlier) won't send
 * these fields, so every field here is optional. Extraction never throws.
 */

export interface McpClientInfo {
  name?: string;
  version?: string;
  [key: string]: unknown;
}

export interface McpRequestMeta {
  /** io.modelcontextprotocol/protocolVersion from _meta (2026-07-28 clients) */
  protocolVersion?: string;
  /** io.modelcontextprotocol/clientInfo from _meta */
  clientInfo?: McpClientInfo;
  /** io.modelcontextprotocol/clientCapabilities from _meta */
  clientCapabilities?: Record<string, unknown>;
  /** W3C trace context (SEP-414) */
  traceparent?: string;
  tracestate?: string;
  baggage?: string;
}

const META_PREFIX = 'io.modelcontextprotocol/';

/**
 * Extract MCP 2026-07-28 client metadata and trace context from a JSON-RPC
 * request body. Tolerates missing/malformed bodies (returns empty object).
 */
export function extractMcpMeta(body: unknown): McpRequestMeta {
  const result: McpRequestMeta = {};

  if (!body || typeof body !== 'object') return result;
  const params = (body as { params?: unknown }).params;
  if (!params || typeof params !== 'object') return result;
  const meta = (params as { _meta?: unknown })._meta;
  if (!meta || typeof meta !== 'object') return result;

  const m = meta as Record<string, unknown>;

  const protocolVersion = m[`${META_PREFIX}protocolVersion`];
  if (typeof protocolVersion === 'string') {
    result.protocolVersion = protocolVersion;
  }

  const clientInfo = m[`${META_PREFIX}clientInfo`];
  if (clientInfo && typeof clientInfo === 'object') {
    result.clientInfo = clientInfo as McpClientInfo;
  }

  const clientCapabilities = m[`${META_PREFIX}clientCapabilities`];
  if (clientCapabilities && typeof clientCapabilities === 'object') {
    result.clientCapabilities = clientCapabilities as Record<string, unknown>;
  }

  // SEP-414: W3C trace context keys are unprefixed in _meta
  for (const key of ['traceparent', 'tracestate', 'baggage'] as const) {
    const value = m[key];
    if (typeof value === 'string') {
      result[key] = value;
    }
  }

  return result;
}
