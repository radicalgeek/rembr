import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { loadConfig, handleApiCall, callRembr, ALLOWED_TOOLS } from "./lib.mjs"

const CONFIG = { url: "https://rembr.test/mcp", apiKey: "test-key", port: 8080, timeoutMs: 5000 }

function toolResult(text) {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }] } }),
    { status: 200, headers: { "content-type": "application/json" } },
  )
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(toolResult("ok"))))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("loadConfig", () => {
  it("applies defaults and env overrides", () => {
    const cfg = loadConfig({})
    expect(cfg.url).toBe("http://localhost:3000/mcp")
    expect(cfg.port).toBe(8080)
    expect(cfg.apiKey).toBeUndefined()

    const custom = loadConfig({ REMBR_URL: "https://x/mcp", REMBR_API_KEY: "k", PORT: "9000" })
    expect(custom.url).toBe("https://x/mcp")
    expect(custom.port).toBe(9000)
  })
})

describe("handleApiCall", () => {
  it("returns 503 with guidance when unconfigured", async () => {
    const { status, payload } = await handleApiCall({ ...CONFIG, apiKey: undefined }, '{"tool":"memory"}')
    expect(status).toBe(503)
    expect(payload.error).toContain("REMBR_API_KEY")
  })

  it("rejects tools outside the allowlist with 403", async () => {
    for (const tool of ["audit", "task_export", "budget", "not_a_tool", ""]) {
      const { status } = await handleApiCall(CONFIG, JSON.stringify({ tool, args: {} }))
      expect(status).toBe(403)
    }
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  })

  it("rejects malformed bodies and non-object args", async () => {
    expect((await handleApiCall(CONFIG, "{not json")).status).toBe(400)
    expect((await handleApiCall(CONFIG, JSON.stringify({ tool: "memory", args: [1] }))).status).toBe(400)
  })

  it("forwards allowlisted calls with the API key held server-side", async () => {
    const { status, payload } = await handleApiCall(
      CONFIG,
      JSON.stringify({ tool: "search", args: { operation: "query", query: "x" } }),
    )
    expect(status).toBe(200)
    expect(payload).toEqual({ ok: true, text: "ok" })
    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(url).toBe("https://rembr.test/mcp")
    expect(init.headers["x-api-key"]).toBe("mb_live_test")
    const body = JSON.parse(init.body)
    expect(body.params).toEqual({ name: "search", arguments: { operation: "query", query: "x" } })
  })

  it("maps upstream failures to 502 with a readable error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("ECONNREFUSED")))
    const { status, payload } = await handleApiCall(CONFIG, JSON.stringify({ tool: "memory", args: {} }))
    expect(status).toBe(502)
    expect(payload.error).toContain("Rembr unreachable")
  })

  it("every allowlisted tool is forwardable", async () => {
    for (const tool of ALLOWED_TOOLS) {
      const { status } = await handleApiCall(CONFIG, JSON.stringify({ tool, args: {} }))
      expect(status).toBe(200)
    }
  })
})

describe("callRembr", () => {
  it("parses SSE responses", async () => {
    const sse = `data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "from sse" }] } })}\n\n`
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })),
    )
    expect(await callRembr(CONFIG, "memory", {})).toEqual({ ok: true, text: "from sse" })
  })

  it("surfaces tool errors as ok:false", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: "bad category" }] } }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    )
    expect(await callRembr(CONFIG, "memory", {})).toEqual({ ok: false, error: "bad category" })
  })

  it("surfaces HTTP errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("no", { status: 401 })))
    const result = await callRembr(CONFIG, "memory", {})
    expect(result.ok).toBe(false)
    expect(result.error).toContain("401")
  })
})
