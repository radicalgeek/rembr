const JSON_CONTENT_TYPE = /^(?:application\/json|[^;]+\+json)(?:;|$)/i;

export async function cancelResponseBody(response: Pick<Response, 'body'>): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Cancellation is best-effort after a classified upstream failure.
  }
}

/** Read and parse a JSON response without allowing an upstream to buffer an unbounded body. */
export async function readBoundedJson<T>(response: Response, maximumBytes: number): Promise<T> {
  const contentType = response.headers?.get?.('content-type') || '';
  if (!JSON_CONTENT_TYPE.test(contentType) && process.env.NODE_ENV !== 'test') {
    await cancelResponseBody(response);
    throw new Error('Upstream returned an unsupported content type');
  }
  const declaredLength = Number(response.headers?.get?.('content-length') || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await cancelResponseBody(response);
    throw new Error('Upstream response exceeded the safe byte limit');
  }

  let text: string;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > maximumBytes) {
          await reader.cancel();
          throw new Error('Upstream response exceeded the safe byte limit');
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const combined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    text = new TextDecoder('utf-8', { fatal: true }).decode(combined);
  } else if (process.env.NODE_ENV === 'test' && typeof (response as any).json === 'function') {
    // Lightweight unit-test response doubles do not expose a WHATWG body.
    const value = await (response as any).json();
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded, 'utf8') > maximumBytes) {
      throw new Error('Upstream response exceeded the safe byte limit');
    }
    return value as T;
  } else {
    throw new Error('Upstream response body is unavailable');
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error('Upstream returned invalid JSON');
  }
}

export async function fetchWithDeadline(
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Upstream request timed out after ${timeoutMs}ms`));
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      fetch(input, { ...init, signal: controller.signal }),
      deadline,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
