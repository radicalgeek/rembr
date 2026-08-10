import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { validateToolInput } from './schemas.js';
import { evaluateAuthenticatedQuotas, type QuotaResult } from './security/transport-quota.js';
import { createMcpPreParserBoundary } from './security/preauth-boundary.js';
import { DISABLED_PENDING_ISOLATION } from './authorization.js';

const allowed = (count = 1): QuotaResult => ({
  allowed: true,
  count,
  limit: 100,
  retryAfterSeconds: 60,
});

describe('authenticated MCP transport boundary', () => {
  const invokePreParser = (
    headers: Record<string, string> = {},
    rawHeaders: string[] = Object.entries(headers).flatMap(([name, value]) => [name, value]),
    limits: Parameters<typeof createMcpPreParserBoundary>[0] = {},
  ) => {
    const status = vi.fn();
    const json = vi.fn();
    const setHeader = vi.fn();
    const response = { status, json, setHeader } as any;
    status.mockReturnValue(response);
    const next = vi.fn();
    const middleware = createMcpPreParserBoundary(limits);
    middleware({ method: 'POST', path: '/mcp', headers, rawHeaders } as any, response, next);
    return { status, json, setHeader, next, middleware, response };
  };

  it('rejects absent, malformed, duplicate, and ambiguous credentials before JSON parsing', () => {
    expect(invokePreParser({ 'content-type': 'application/json' }).status).toHaveBeenCalledWith(401);

    const duplicate = invokePreParser(
      { 'content-type': 'application/json', 'x-api-key': `mb_live_${'a'.repeat(64)}` },
      ['content-type', 'application/json', 'x-api-key', `mb_live_${'a'.repeat(64)}`, 'X-API-Key', `mb_live_${'b'.repeat(64)}`],
    );
    expect(duplicate.status).toHaveBeenCalledWith(401);
    expect(duplicate.next).not.toHaveBeenCalled();

    const ambiguous = invokePreParser({
      'content-type': 'application/json',
      'x-api-key': `mb_live_${'a'.repeat(64)}`,
      authorization: 'Bearer opaque-token-value',
    });
    expect(ambiguous.status).toHaveBeenCalledWith(401);
    expect(ambiguous.next).not.toHaveBeenCalled();
  });

  it('admits both current and legacy OSS API-key lengths to authentication', () => {
    for (const length of [32, 64]) {
      const key = `mb_live_${'a'.repeat(length)}`;
      const result = invokePreParser({
        'content-type': 'application/json',
        'x-api-key': key,
      });
      expect(result.next).toHaveBeenCalledOnce();
      expect(result.status).not.toHaveBeenCalled();
    }
  });

  it('rejects oversized and repeated chunked allocations before the parser fast path', () => {
    const headers = {
      'content-type': 'application/json',
      'x-api-key': `mb_live_${'a'.repeat(64)}`,
      'content-length': String(2 * 1024 * 1024 + 1),
    };
    const oversized = invokePreParser(headers);
    expect(oversized.status).toHaveBeenCalledWith(413);
    expect(oversized.next).not.toHaveBeenCalled();

    const middleware = createMcpPreParserBoundary({
      requestsPerMinute: 10,
      largeBodiesPerMinute: 1,
      reservedBytesPerMinute: 4 * 1024 * 1024,
    });
    const req = {
      method: 'POST',
      path: '/mcp',
      headers: {
        'content-type': 'application/json',
        'x-api-key': `mb_live_${'a'.repeat(64)}`,
        'transfer-encoding': 'chunked',
      },
      rawHeaders: ['content-type', 'application/json', 'x-api-key', `mb_live_${'a'.repeat(64)}`, 'transfer-encoding', 'chunked'],
    } as any;
    const firstNext = vi.fn();
    middleware(req, { status: vi.fn().mockReturnThis(), json: vi.fn(), setHeader: vi.fn() } as any, firstNext);
    expect(firstNext).toHaveBeenCalledOnce();
    const secondStatus = vi.fn();
    const secondResponse = { status: secondStatus, json: vi.fn(), setHeader: vi.fn() } as any;
    secondStatus.mockReturnValue(secondResponse);
    middleware(req, secondResponse, vi.fn());
    expect(secondStatus).toHaveBeenCalledWith(429);
  });
  it('increments both authenticated quotas before admitting a request', async () => {
    const transport = vi.fn().mockResolvedValue(allowed(3));
    const daily = vi.fn().mockResolvedValue(allowed(40));
    const request = { headers: {}, socket: {} } as any;

    const decision = await evaluateAuthenticatedQuotas(request, 'tenant-a', 'pro', { transport, daily });

    expect(decision.allowed).toBe(true);
    expect(transport).toHaveBeenCalledOnce();
    expect(daily).toHaveBeenCalledWith('tenant-a', 'pro');
    expect(transport.mock.invocationCallOrder[0]).toBeLessThan(daily.mock.invocationCallOrder[0]);
  });

  it('enforces either quota without dispatching past the boundary', async () => {
    const transportDenied = vi.fn().mockResolvedValue({ ...allowed(), allowed: false });
    const daily = vi.fn().mockResolvedValue(allowed());
    const transportDecision = await evaluateAuthenticatedQuotas({} as any, 'tenant-a', 'free', {
      transport: transportDenied,
      daily,
    });
    expect(transportDecision).toMatchObject({ allowed: false, deniedBy: 'transport' });
    expect(daily).not.toHaveBeenCalled();

    const dailyDenied = vi.fn().mockResolvedValue({ ...allowed(), allowed: false });
    const dailyDecision = await evaluateAuthenticatedQuotas({} as any, 'tenant-a', 'free', {
      transport: vi.fn().mockResolvedValue(allowed()),
      daily: dailyDenied,
    });
    expect(dailyDecision).toMatchObject({ allowed: false, deniedBy: 'daily' });
  });

  it('rejects malformed and oversized fast-path inputs', () => {
    expect(validateToolInput('store_memory', {
      content: 'x'.repeat(100_001),
      category: 'facts',
    }).success).toBe(false);
    expect(validateToolInput('search_memory', { query: 'x'.repeat(2_001) }).success).toBe(false);
    expect(validateToolInput('detect_memory_contradictions', { context_id: 'not-a-uuid' }).success).toBe(false);
  });

  it('keeps every fast path behind validation, quotas and audit context, and rejects batches', () => {
    const source = readFileSync(fileURLToPath(new URL('./index-http.ts', import.meta.url)), 'utf8');
    const validation = source.indexOf('validateToolInput(toolName, rawArgs)');
    const quotas = source.indexOf('evaluateAuthenticatedQuotas(');
    const auditContext = source.indexOf('this.auditLogger.withContext({');
    const store = source.indexOf("rpcBody?.params?.name === 'store_memory'");
    const search = source.indexOf("rpcBody?.params?.name === 'search_memory'");
    const contradictions = source.indexOf("rpcBody?.params?.name === 'detect_memory_contradictions'");

    expect(validation).toBeGreaterThan(0);
    expect(validation).toBeLessThan(quotas);
    expect(quotas).toBeLessThan(auditContext);
    expect(auditContext).toBeLessThan(store);
    expect(auditContext).toBeLessThan(search);
    expect(auditContext).toBeLessThan(contradictions);
    expect(source.indexOf('if (Array.isArray(req.body))')).toBeLessThan(source.indexOf('await this.authenticate(req)'));
    expect(source).toContain('JSON-RPC batch requests are not supported');
    expect(source).toContain('createMcpPreParserBoundary()');
    expect(source.indexOf('createMcpPreParserBoundary()')).toBeLessThan(source.indexOf("express.json({ limit: '2mb'"));
    expect(source).toContain('.filter(tool => !isToolDisabledForDiscovery(tool.name))');
    expect(source).toContain('.map(tool => pruneToolForDiscovery(tool))');
    for (const gated of [
      'work_queue',
      'rlm_session',
      'rlm_iteration',
      'rlm_evaluate_ac',
      'rlm_regenerate',
      'infer_causality',
      'trace_causality',
      'get_causal_links',
      'validate_causal_link',
      'compare_snapshots',
      'upload_attachment',
      'list_attachments',
      'get_attachment_url',
      'delete_attachment',
      'get_storage_usage',
    ]) {
      expect(source).toContain(`case '${gated}'`);
      expect(DISABLED_PENDING_ISOLATION.has(gated), `${gated} must be denied before SDK dispatch`).toBe(true);
    }
    expect(source).not.toContain('preAuthSourceCounts');
    expect(source).not.toContain('sourceCount > 1_200');
  });
});
