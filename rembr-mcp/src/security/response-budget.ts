const HARD_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MIN_RESPONSE_BYTES = 64 * 1024;
const ARRAY_RESULT_KEYS = new Set([
  'items', 'memories', 'contexts', 'snapshots', 'nodes', 'edges',
  'contradictions', 'relationships', 'results', 'links', 'history',
  'attachments', 'reports', 'queues', 'requests',
]);

export function responseByteBudget(): number {
  const requested = Number(process.env.MCP_MAX_RESPONSE_BYTES || HARD_MAX_RESPONSE_BYTES);
  if (!Number.isSafeInteger(requested) || requested < MIN_RESPONSE_BYTES) return HARD_MAX_RESPONSE_BYTES;
  return Math.min(requested, HARD_MAX_RESPONSE_BYTES);
}

type JsonObject = Record<string, any>;

interface ArrayCandidate {
  path: Array<string | number>;
  label: string;
  values: unknown[];
}

function cloneWithoutResultArrays(
  value: unknown,
  path: Array<string | number> = [],
  result: ArrayCandidate[] = [],
): unknown {
  if (!value || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toJSON();
  if (Array.isArray(value)) {
    return value.map((child, index) => cloneWithoutResultArrays(child, [...path, index], result));
  }

  const clone: JsonObject = {};
  for (const [key, child] of Object.entries(value as JsonObject)) {
    const childPath = [...path, key];
    if (Array.isArray(child) && ARRAY_RESULT_KEYS.has(key)) {
      result.push({ path: childPath, label: childPath.join('.'), values: child });
      clone[key] = [];
    } else {
      clone[key] = cloneWithoutResultArrays(child, childPath, result);
    }
  }
  return clone;
}

function valueAtPath(root: JsonObject, path: Array<string | number>): any {
  let current: any = root;
  for (const segment of path) current = current?.[segment];
  return current;
}

function encodedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/**
 * Fit a JSON response by retaining only complete result items. Scalar content
 * is never sliced, so UTF-8 and stored memory text remain intact.
 */
export function fitJsonResponse<T>(value: T, maximumBytes = responseByteBudget()): T {
  if (encodedBytes(value) <= maximumBytes) return value;

  const candidates: ArrayCandidate[] = [];
  const clone = cloneWithoutResultArrays(value, [], candidates) as JsonObject;
  if (candidates.length === 0) {
    return {
      success: false,
      error: 'Response exceeds the safe byte budget; request a narrower resource',
      truncated: true,
      response_budget: { max_bytes: maximumBytes, returned_count: 0, total_count: 1 },
    } as T;
  }

  const counts: Record<string, { returned: number; total: number }> = {};
  for (const candidate of candidates) {
    counts[candidate.label] = { returned: 0, total: candidate.values.length };
  }
  clone.truncated = true;
  clone.continuation = 'Narrow filters or request a smaller limit/max_tokens, then continue from the returned page.';
  clone.response_budget = {
    max_bytes: maximumBytes,
    returned_count: 0,
    total_count: candidates.reduce((sum, candidate) => sum + candidate.values.length, 0),
    arrays: counts,
  };

  let currentBytes = encodedBytes(clone);
  if (currentBytes > maximumBytes) {
    return {
      success: false,
      error: 'Response metadata exceeds the safe byte budget; narrow the request',
      truncated: true,
      response_budget: { max_bytes: maximumBytes, returned_count: 0 },
    } as T;
  }

  let returnedCount = 0;
  outer: for (const candidate of candidates) {
    const target = valueAtPath(clone, candidate.path) as unknown[];
    for (const item of candidate.values) {
      const encodedItem = JSON.stringify(item);
      if (encodedItem === undefined) continue;
      const itemBytes = Buffer.byteLength(encodedItem, 'utf8') + (target.length > 0 ? 1 : 0);
      const nextReturnedCount = returnedCount + 1;
      const nextArrayCount = counts[candidate.label].returned + 1;
      const metadataDelta = String(nextReturnedCount).length - String(returnedCount).length
        + String(nextArrayCount).length - String(counts[candidate.label].returned).length;
      if (currentBytes + itemBytes + metadataDelta > maximumBytes) {
        break outer;
      }
      target.push(item);
      returnedCount += 1;
      counts[candidate.label].returned += 1;
      currentBytes += itemBytes + metadataDelta;
    }
  }
  clone.response_budget.returned_count = returnedCount;
  return clone as T;
}

export function fitJsonText(text: string, maximumBytes = responseByteBudget()): string {
  if (Buffer.byteLength(text, 'utf8') <= maximumBytes) return text;
  try {
    return JSON.stringify(fitJsonResponse(JSON.parse(text), maximumBytes), null, 2);
  } catch {
    return JSON.stringify({
      success: false,
      error: 'Response exceeds the safe byte budget',
      truncated: true,
      response_budget: { max_bytes: maximumBytes },
    });
  }
}

export function fitMcpToolResult<T extends { content?: Array<{ type?: string; text?: string }> }>(result: T): T {
  if (!result?.content) return result;
  return {
    ...result,
    content: result.content.map(item => item.type === 'text' && typeof item.text === 'string'
      ? { ...item, text: fitJsonText(item.text) }
      : item),
  };
}
