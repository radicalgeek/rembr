/**
 * Minimal stateless MCP client for the Rembr server.
 *
 * Rembr (post MCP-2026-07-28 migration) is a stateless streamable-HTTP MCP
 * server: every `tools/call` is an independent POST to /mcp authenticated by
 * x-api-key or a Bearer token. There is no session handshake and no SSE
 * notification stream, so a full MCP SDK client is unnecessary.
 */

export interface RembrClientOptions {
  url: string
  apiKey?: string
  bearerToken?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

export class RembrError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message)
    this.name = "RembrError"
  }
}

interface JsonRpcResponse {
  jsonrpc: "2.0"
  id: number | string | null
  result?: {
    content?: Array<{ type: string; text?: string }>
    isError?: boolean
  }
  error?: { code: number; message: string }
}

/** Extract JSON-RPC messages from a text/event-stream body. */
function parseSseBody(body: string): JsonRpcResponse[] {
  const messages: JsonRpcResponse[] = []
  for (const chunk of body.split(/\n\n/)) {
    const data = chunk
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("")
    if (!data) continue
    try {
      messages.push(JSON.parse(data))
    } catch {
      // ignore non-JSON SSE events (e.g. pings)
    }
  }
  return messages
}

export class RembrClient {
  private readonly url: string
  private readonly headers: Record<string, string>
  private readonly timeoutMs: number
  private readonly fetchOverride?: typeof fetch
  private nextId = 1

  constructor(options: RembrClientOptions) {
    this.url = options.url
    this.timeoutMs = options.timeoutMs ?? 15000
    this.fetchOverride = options.fetchImpl
    this.headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    }
    if (options.apiKey) this.headers["x-api-key"] = options.apiKey
    else if (options.bearerToken) this.headers["authorization"] = `Bearer ${options.bearerToken}`
  }

  /**
   * Call an MCP tool and return the concatenated text content of the result.
   * Retries once on network failure or 5xx.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const id = this.nextId++
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    })

    let lastError: unknown
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.timeoutMs)
      // resolved per call so late global fetch instrumentation/stubs are honored
      const fetchImpl = this.fetchOverride ?? fetch
      let response: Response
      try {
        response = await fetchImpl(this.url, {
          method: "POST",
          headers: this.headers,
          body: payload,
          signal: controller.signal,
        })
      } catch (error) {
        // network failure or timeout: retry once
        lastError = error
        continue
      } finally {
        clearTimeout(timer)
      }
      if (response.status >= 500) {
        lastError = new RembrError(`Rembr server error (HTTP ${response.status})`, response.status)
        continue
      }
      if (!response.ok) {
        const text = await response.text().catch(() => "")
        throw new RembrError(
          `Rembr request failed (HTTP ${response.status})${text ? `: ${text.slice(0, 300)}` : ""}`,
          response.status,
        )
      }
      // protocol and tool-level errors are not retryable
      return this.extractText(await this.parseResponse(response, id))
    }
    throw lastError instanceof Error ? lastError : new RembrError(String(lastError))
  }

  private async parseResponse(response: Response, id: number): Promise<JsonRpcResponse> {
    const contentType = response.headers.get("content-type") ?? ""
    const body = await response.text()
    if (contentType.includes("text/event-stream")) {
      const messages = parseSseBody(body)
      const match = messages.find((m) => m.id === id && (m.result || m.error))
      const fallback = messages.find((m) => m.result || m.error)
      const message = match ?? fallback
      if (!message) throw new RembrError("No JSON-RPC response found in event stream")
      return message
    }
    try {
      return JSON.parse(body)
    } catch {
      throw new RembrError(`Invalid JSON response from Rembr: ${body.slice(0, 300)}`)
    }
  }

  private extractText(message: JsonRpcResponse): string {
    if (message.error) {
      throw new RembrError(`Rembr error ${message.error.code}: ${message.error.message}`)
    }
    const text = (message.result?.content ?? [])
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n")
    if (message.result?.isError) {
      throw new RembrError(text || "Rembr tool call failed")
    }
    return text
  }

  /** Store a memory. Returns the server's confirmation text. */
  remember(
    content: string,
    category?: string,
    metadata?: Record<string, unknown>,
  ): Promise<string> {
    return this.callTool("memory", {
      operation: "create",
      content,
      ...(category ? { category } : {}),
      ...(metadata ? { metadata } : {}),
    })
  }

  /** Hybrid text+semantic search. Returns the server's result text ("" if none). */
  recall(
    query: string,
    options: { limit?: number; minSimilarity?: number; category?: string } = {},
  ): Promise<string> {
    return this.callTool("search", {
      operation: "query",
      query,
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      ...(options.minSimilarity !== undefined ? { min_similarity: options.minSimilarity } : {}),
      ...(options.category ? { category: options.category } : {}),
    })
  }

  /** Delete a memory by id. */
  forget(id: string): Promise<string> {
    return this.callTool("memory", { operation: "delete", id })
  }

  /** Liveness check against the server's /health endpoint. */
  async health(): Promise<boolean> {
    try {
      const healthUrl = new URL(this.url)
      healthUrl.pathname = healthUrl.pathname.replace(/\/mcp\/?$/, "") + "/health"
      healthUrl.search = ""
      const response = await (this.fetchOverride ?? fetch)(healthUrl.toString(), {
        method: "GET",
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      return response.ok
    } catch {
      return false
    }
  }
}
