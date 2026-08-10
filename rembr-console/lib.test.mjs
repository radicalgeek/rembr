import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  loadConfig,
  handleApiCall,
  callRembr,
  authenticateConsoleRequest,
  isOriginAllowed,
  ALLOWED_TOOLS,
} from "./lib.mjs"

const CONSOLE_TOKEN = "console-test-token-with-at-least-32-bytes"
const CONFIG = {
  url: "https://rembr.test/mcp",
  apiKey: "upstream-test-key",
  authToken: CONSOLE_TOKEN,
  host: "127.0.0.1",
  port: 8080,
  timeoutMs: 5000,
  maxBodyBytes: 65_536,
  maxResponseBytes: 2_097_152,
  mode: "read-only",
  allowedOrigins: [],
}
const REQUEST = { authorization: `Bearer ${CONSOLE_TOKEN}` }

function toolResult(value) {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: value }] } }),
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
  it("binds loopback and fails closed without distinct secrets", () => {
    const config = loadConfig({})
    expect(config.host).toBe("127.0.0.1")
    expect(config.mode).toBe("read-only")
    expect(config.configurationError).toContain("REMBR_API_KEY")
    expect(config.configurationError).toContain("REMBR_CONSOLE_AUTH_TOKEN")
  })

  it("accepts bounded explicit settings", () => {
    const config = loadConfig({
      REMBR_URL: "https://x.example/mcp",
      REMBR_API_KEY: "upstream",
      REMBR_CONSOLE_AUTH_TOKEN: CONSOLE_TOKEN,
      REMBR_CONSOLE_MODE: "read-write",
      HOST: "0.0.0.0",
      PORT: "9000",
    })
    expect(config).toMatchObject({ host: "0.0.0.0", port: 9000, mode: "read-write" })
    expect(config.configurationError).toBeUndefined()
  })
})

describe("console request authentication", () => {
  it("requires a correctly formed bearer token", () => {
    expect(authenticateConsoleRequest(CONFIG).status).toBe(401)
    expect(authenticateConsoleRequest(CONFIG, "Basic no").status).toBe(401)
    expect(authenticateConsoleRequest(CONFIG, "Bearer wrong").status).toBe(401)
    expect(authenticateConsoleRequest(CONFIG, REQUEST.authorization)).toEqual({ ok: true })
  })

  it("enforces browser origins", () => {
    expect(isOriginAllowed(CONFIG, undefined, "localhost:8080")).toBe(true)
    expect(isOriginAllowed(CONFIG, "http://localhost:8080", "localhost:8080")).toBe(true)
    expect(isOriginAllowed(CONFIG, "https://attacker.example", "localhost:8080")).toBe(false)
    expect(isOriginAllowed({ ...CONFIG, allowedOrigins: ["https://console.example"] },
      "https://console.example", "internal:8080")).toBe(true)
  })
})

describe("handleApiCall", () => {
  it("authenticates before forwarding", async () => {
    expect((await handleApiCall(CONFIG, '{"tool":"memory","args":{"operation":"list"}}')).status).toBe(401)
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  })

  it("allows only explicit read operations by default", async () => {
    for (const [tool, operation] of [
      ["memory", "list"], ["search", "query"], ["stats", "usage"],
      ["stats", "embeddings"], ["context", "list"], ["snapshot", "list"],
    ]) {
      const args = operation === "query" ? { operation, query: "x" } : { operation }
      expect((await handleApiCall(CONFIG, JSON.stringify({ tool, args }), REQUEST)).status).toBe(200)
    }
    expect(new Set(ALLOWED_TOOLS)).toEqual(new Set(["memory", "search", "stats", "context", "snapshot"]))
  })

  it("denies destructive or unknown operations in read-only mode", async () => {
    for (const [tool, operation] of [
      ["memory", "create"], ["memory", "delete"], ["memory", "update"],
      ["context", "delete"], ["snapshot", "restore"], ["audit", "export"],
    ]) {
      const { status } = await handleApiCall(CONFIG, JSON.stringify({ tool, args: { operation } }), REQUEST)
      expect(status).toBe(403)
    }
  })

  it("allows only the two advertised writes when explicitly enabled", async () => {
    const writable = { ...CONFIG, mode: "read-write" }
    expect((await handleApiCall(writable, JSON.stringify({
      tool: "memory", args: { operation: "create", content: "safe" },
    }), REQUEST)).status).toBe(200)
    expect((await handleApiCall(writable, JSON.stringify({
      tool: "memory", args: { operation: "delete", id: "00000000-0000-4000-8000-000000000000" },
    }), REQUEST)).status).toBe(200)
    expect((await handleApiCall(writable, JSON.stringify({
      tool: "snapshot", args: { operation: "delete" },
    }), REQUEST)).status).toBe(403)
  })

  it("validates and caps caller-controlled arguments", async () => {
    expect((await handleApiCall(CONFIG, "{not json", REQUEST)).status).toBe(400)
    expect((await handleApiCall(CONFIG, JSON.stringify({
      tool: "search", args: { operation: "query", query: "x", limit: 101 },
    }), REQUEST)).status).toBe(400)
    expect((await handleApiCall(CONFIG, JSON.stringify({
      tool: "search", args: { operation: "query", query: "x".repeat(8_193) },
    }), REQUEST)).status).toBe(400)
  })

  it("holds the upstream API key server-side", async () => {
    const { status, payload } = await handleApiCall(CONFIG, JSON.stringify({
      tool: "search", args: { operation: "query", query: "x" },
    }), REQUEST)
    expect(status).toBe(200)
    expect(payload).toEqual({ ok: true, text: "ok" })
    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(url).toBe("https://rembr.test/mcp")
    expect(init.headers["x-api-key"]).toBe("upstream-test-key")
  })
})

describe("callRembr", () => {
  it("parses SSE responses", async () => {
    const sse = `data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "from sse" }] } })}\n\n`
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
    ))
    expect(await callRembr(CONFIG, "memory", { operation: "list" })).toEqual({ ok: true, text: "from sse" })
  })

  it("caps upstream responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(toolResult("x".repeat(1_000))))
    const result = await callRembr({ ...CONFIG, maxResponseBytes: 128 }, "memory", { operation: "list" })
    expect(result).toEqual({ ok: false, error: "Rembr response exceeded the console limit" })
  })

  it("does not expose network exception detail", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("sensitive host detail")))
    expect(await callRembr(CONFIG, "memory", { operation: "list" })).toEqual({ ok: false, error: "Rembr is unreachable" })
  })
})
