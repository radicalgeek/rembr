import { describe, it, expect, vi } from "vitest"
import { RembrClient, RembrError } from "./rembr-client.js"

function jsonResponse(body: unknown, init: { status?: number; contentType?: string } = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": init.contentType ?? "application/json" },
  })
}

function toolResult(id: number, text: string, isError = false) {
  return {
    jsonrpc: "2.0",
    id,
    result: { content: [{ type: "text", text }], isError },
  }
}

describe("RembrClient.callTool", () => {
  it("sends a JSON-RPC tools/call with auth header and returns text content", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(toolResult(1, "stored: mem_123")))
    const client = new RembrClient({ url: "https://rembr.test/mcp", apiKey: "mb_live_abc", fetchImpl })

    const result = await client.callTool("memory", { operation: "create", content: "hello" })

    expect(result).toBe("stored: mem_123")
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe("https://rembr.test/mcp")
    expect(init.method).toBe("POST")
    expect(init.headers["x-api-key"]).toBe("mb_live_abc")
    expect(init.headers["accept"]).toContain("text/event-stream")
    const body = JSON.parse(init.body)
    expect(body).toMatchObject({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "memory", arguments: { operation: "create", content: "hello" } },
    })
  })

  it("uses a Bearer token when no API key is given", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(toolResult(1, "ok")))
    const client = new RembrClient({ url: "https://rembr.test/mcp", bearerToken: "oauth", fetchImpl })

    await client.callTool("search", { operation: "query", query: "x" })

    expect(fetchImpl.mock.calls[0][1].headers["authorization"]).toBe("Bearer oauth")
  })

  it("parses a text/event-stream response", async () => {
    const sse = [
      `data: ${JSON.stringify(toolResult(1, "from sse"))}`,
      "",
      "data: ping",
      "",
    ].join("\n")
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(sse, { contentType: "text/event-stream" }))
    const client = new RembrClient({ url: "https://rembr.test/mcp", apiKey: "k", fetchImpl })

    expect(await client.callTool("search", { operation: "query", query: "x" })).toBe("from sse")
  })

  it("throws RembrError when the tool result isError", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(toolResult(1, "category invalid", true)))
    const client = new RembrClient({ url: "https://rembr.test/mcp", apiKey: "k", fetchImpl })

    await expect(client.callTool("memory", { operation: "create" })).rejects.toThrow("category invalid")
  })

  it("throws RembrError on JSON-RPC protocol errors", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "bad params" } }))
    const client = new RembrClient({ url: "https://rembr.test/mcp", apiKey: "k", fetchImpl })

    await expect(client.callTool("memory", {})).rejects.toThrow("bad params")
  })

  it("retries once on 5xx then succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse("oops", { status: 503 }))
      .mockResolvedValueOnce(jsonResponse(toolResult(1, "recovered")))
    const client = new RembrClient({ url: "https://rembr.test/mcp", apiKey: "k", fetchImpl })

    expect(await client.callTool("memory", { operation: "list" })).toBe("recovered")
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it("retries once on network failure then surfaces the error", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed"))
    const client = new RembrClient({ url: "https://rembr.test/mcp", apiKey: "k", fetchImpl })

    await expect(client.callTool("memory", { operation: "list" })).rejects.toThrow("fetch failed")
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it("does not retry on 4xx auth errors", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse("unauthorized", { status: 401 }))
    const client = new RembrClient({ url: "https://rembr.test/mcp", apiKey: "bad", fetchImpl })

    await expect(client.callTool("memory", { operation: "list" })).rejects.toThrow(RembrError)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

describe("convenience wrappers", () => {
  it("remember maps to memory/create with category and metadata", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(toolResult(1, "ok")))
    const client = new RembrClient({ url: "https://rembr.test/mcp", apiKey: "k", fetchImpl })

    await client.remember("use vitest", "decisions", { source: "test" })

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body)
    expect(body.params).toEqual({
      name: "memory",
      arguments: {
        operation: "create",
        content: "use vitest",
        category: "decisions",
        metadata: { source: "test" },
      },
    })
  })

  it("recall maps to search/query with limit and min_similarity", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(toolResult(1, "results")))
    const client = new RembrClient({ url: "https://rembr.test/mcp", apiKey: "k", fetchImpl })

    await client.recall("auth flow", { limit: 5, minSimilarity: 0.8 })

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body)
    expect(body.params).toEqual({
      name: "search",
      arguments: { operation: "query", query: "auth flow", limit: 5, min_similarity: 0.8 },
    })
  })

  it("forget maps to memory/delete", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(toolResult(1, "deleted")))
    const client = new RembrClient({ url: "https://rembr.test/mcp", apiKey: "k", fetchImpl })

    await client.forget("mem_42")

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body)
    expect(body.params).toEqual({ name: "memory", arguments: { operation: "delete", id: "mem_42" } })
  })

  it("health hits /health on the server root", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }))
    const client = new RembrClient({ url: "https://rembr.test/mcp", apiKey: "k", fetchImpl })

    expect(await client.health()).toBe(true)
    expect(fetchImpl.mock.calls[0][0]).toBe("https://rembr.test/health")
  })

  it("health returns false when unreachable", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed"))
    const client = new RembrClient({ url: "https://rembr.test/mcp", apiKey: "k", fetchImpl })

    expect(await client.health()).toBe(false)
  })
})
