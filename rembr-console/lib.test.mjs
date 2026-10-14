import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  loadConfig,
  handleApiCall,
  callRembr,
  authenticateConsoleRequest,
  isOriginAllowed,
  ALLOWED_TOOLS,
  createSessionStore,
  createLoginLimiter,
  sessionCookie,
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

  it("supports hosted sessions without a server-wide API key", () => {
    const config = loadConfig({
      REMBR_URL: "https://x.example/mcp",
      REMBR_CONSOLE_AUTH_MODE: "session",
      REMBR_CONSOLE_MODE: "read-write",
    })
    expect(config.authMode).toBe("session")
    expect(config.mode).toBe("read-write")
    expect(config.memoryPageSize).toBe(50)
    expect(config.configurationError).toBeUndefined()
  })

  it("requires the absolute session lifetime to cover the idle lifetime", () => {
    const config = loadConfig({
      REMBR_CONSOLE_AUTH_MODE: "session",
      REMBR_CONSOLE_SESSION_IDLE_MS: "600000",
      REMBR_CONSOLE_SESSION_ABSOLUTE_MS: "300000",
    })
    expect(config.configurationError).toContain("must be at least the idle timeout")
  })
})

describe("hosted session controls", () => {
  const config = {
    sessionIdleMs: 100,
    sessionAbsoluteMs: 500,
    sessionMaximum: 2,
    loginWindowMs: 100,
    loginMaximum: 2,
    loginGlobalMaximum: 3,
  }

  it("keeps API keys server-side and enforces idle expiry and capacity", () => {
    let time = 1_000
    const sessions = createSessionStore(config, () => time)
    const first = sessions.create("first-user-key")
    const second = sessions.create("second-user-key")
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(sessions.create("third-user-key")).toBeNull()
    expect(sessions.resolve(`other=x; __Host-rembr_console=${first}`)).toMatchObject({ apiKey: "first-user-key" })
    time += 101
    expect(sessions.resolve(`__Host-rembr_console=${first}`)).toBeNull()
    expect(sessions.resolve(`__Host-rembr_console=${second}`)).toBeNull()
    expect(sessions.size()).toBe(0)
  })

  it("enforces absolute expiry even while a session remains active", () => {
    let time = 1_000
    const sessions = createSessionStore({ ...config, sessionIdleMs: 1_000, sessionAbsoluteMs: 100 }, () => time)
    const id = sessions.create("active-user-key")
    time += 60
    expect(sessions.resolve(`__Host-rembr_console=${id}`)).not.toBeNull()
    time += 41
    expect(sessions.resolve(`__Host-rembr_console=${id}`)).toBeNull()
  })

  it("uses a host-only secure cookie", () => {
    const cookie = sessionCookie("opaque", 3600)
    expect(cookie).toContain("__Host-rembr_console=opaque")
    expect(cookie).toContain("Path=/")
    expect(cookie).toContain("HttpOnly")
    expect(cookie).toContain("Secure")
    expect(cookie).toContain("SameSite=Strict")
    expect(cookie).not.toContain("Domain=")
  })

  it("bounds login attempts per client window", () => {
    let time = 1_000
    const limiter = createLoginLimiter(config, () => time)
    expect(limiter.consume("client")).toBe(true)
    expect(limiter.consume("client")).toBe(true)
    expect(limiter.consume("client")).toBe(false)
    expect(limiter.consume("other")).toBe(true)
    expect(limiter.consume("third")).toBe(false)
    time += 101
    expect(limiter.consume("client")).toBe(true)
  })

  it("caps tracked client identities even when they are all fresh", () => {
    const limiter = createLoginLimiter({ ...config, loginMaximum: 2, loginGlobalMaximum: 2_000 }, () => 1_000)
    for (let index = 0; index < 1_000; index += 1) {
      expect(limiter.consume(`client-${index}`)).toBe(true)
    }
    expect(limiter.consume("client-over-cap")).toBe(false)
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
  it("requires a resolved server-side session key in hosted mode", async () => {
    const body = JSON.stringify({ tool: "memory", args: { operation: "list" } })
    const missing = await handleApiCall({ ...CONFIG, authMode: "session" }, body)
    expect(missing.status).toBe(401)
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
    const allowed = await handleApiCall({ ...CONFIG, authMode: "session" }, body, { apiKey: "session-key" })
    expect(allowed.status).toBe(200)
    expect(vi.mocked(fetch).mock.calls[0][1].headers["x-api-key"]).toBe("session-key")
  })

  it("authenticates before forwarding", async () => {
    expect((await handleApiCall(CONFIG, '{"tool":"memory","args":{"operation":"list"}}')).status).toBe(401)
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  })

  it("allows only explicit read operations by default", async () => {
    for (const [tool, operation] of [
      ["memory", "list"], ["search", "query"], ["stats", "usage"],
      ["stats", "embeddings"], ["context", "list"], ["snapshot", "list"],
      ["graph", "generate"],
    ]) {
      const args = operation === "query" ? { operation, query: "x" } : { operation }
      expect((await handleApiCall(CONFIG, JSON.stringify({ tool, args }), REQUEST)).status).toBe(200)
    }
    expect(new Set(ALLOWED_TOOLS)).toEqual(new Set(["memory", "search", "stats", "context", "snapshot", "graph"]))
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
    expect((await handleApiCall(CONFIG, JSON.stringify({
      tool: "memory", args: { operation: "list", limit: 50, offset: 50 },
    }), REQUEST)).status).toBe(200)
    expect((await handleApiCall(CONFIG, JSON.stringify({
      tool: "memory", args: { operation: "list", offset: -1 },
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
