import http from "node:http"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createConsoleServer } from "./server.mjs"

const USER_ONE_KEY = "session-test-user-one-key-value"
const USER_TWO_KEY = "session-test-user-two-key-value"
const CONFIG = {
  url: "https://upstream.example/mcp",
  authMode: "session",
  host: "127.0.0.1",
  port: 8080,
  timeoutMs: 5_000,
  maxBodyBytes: 8_192,
  maxResponseBytes: 32_768,
  mode: "read-write",
  allowedOrigins: [],
  sessionIdleMs: 30 * 60_000,
  sessionAbsoluteMs: 8 * 60 * 60_000,
  sessionMaximum: 10,
  loginWindowMs: 60_000,
  loginMaximum: 5,
  loginGlobalMaximum: 100,
  memoryPageSize: 50,
  trustProxy: false,
}

function toolResult(value) {
  return new Response(JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text: JSON.stringify(value) }] },
  }), { status: 200, headers: { "content-type": "application/json" } })
}

function request(server, { method = "GET", path = "/", headers = {}, body = "", origin = false } = {}) {
  const address = server.address()
  const host = `127.0.0.1:${address.port}`
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port: address.port,
      method,
      path,
      agent: false,
      headers: { connection: "close", host, ...(origin ? { origin: `http://${host}` } : {}), ...headers },
    }, (res) => {
      const chunks = []
      res.on("data", (chunk) => chunks.push(chunk))
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }))
    })
    req.on("error", reject)
    req.end(body)
  })
}

function cookieFrom(response) {
  return response.headers["set-cookie"]?.[0]?.split(";", 1)[0]
}

function apiCall(server, cookie, tool, args) {
  return request(server, {
    method: "POST",
    path: "/api/call",
    origin: true,
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ tool, args }),
  })
}

let server
beforeEach(async () => {
  vi.stubGlobal("fetch", vi.fn().mockImplementation((_url, init) => {
    const key = init.headers["x-api-key"]
    if (![USER_ONE_KEY, USER_TWO_KEY].includes(key)) {
      return Promise.resolve(new Response("Unauthorized", { status: 401 }))
    }
    const { params } = JSON.parse(init.body)
    if (params.name === "memory" && params.arguments.operation === "list_personal") {
      return Promise.resolve(toolResult({ items: [] }))
    }
    return Promise.resolve(toolResult({
      owner: key === USER_ONE_KEY ? "one" : "two",
      tool: params.name,
      args: params.arguments,
    }))
  }))
  server = createConsoleServer(CONFIG)
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
    server.closeAllConnections()
  })
})

async function login(apiKey) {
  return request(server, {
    method: "POST",
    path: "/api/login",
    origin: true,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ apiKey }),
  })
}

describe("existing console session mode", () => {
  it("serves the existing console and reports session capabilities", async () => {
    const root = await request(server)
    expect(root.status).toBe(200)
    expect(root.body).toContain("Memory Map")
    expect(root.body).toContain("Store Memory")
    expect(root.body).toContain("Memory Store")
    expect(root.body).not.toContain("Capture Activity")
    const app = await request(server, { path: "/app.js" })
    expect(app.status).toBe(200)
    expect(app.body).toContain("loadAudienceGraph")
    expect(app.body).not.toContain("loadCaptureActivity")
    expect(app.body).not.toContain("setInterval")
    const session = JSON.parse((await request(server, { path: "/api/session" })).body)
    expect(session).toMatchObject({ authMode: "session", authenticated: false, writable: true, memoryPageSize: 50 })
  })

  it("creates an opaque secure session after validating a key", async () => {
    const response = await login(USER_ONE_KEY)
    expect(response.status).toBe(200)
    expect(response.body).not.toContain(USER_ONE_KEY)
    expect(response.headers["set-cookie"][0]).toMatch(/__Host-rembr_console=[A-Za-z0-9_-]{43}/)
    expect(response.headers["set-cookie"][0]).toContain("HttpOnly")
    expect(response.headers["set-cookie"][0]).toContain("Secure")
    expect(response.headers["set-cookie"][0]).toContain("SameSite=Strict")
  })

  it("rejects invalid keys and cross-origin login without creating a session", async () => {
    const invalid = await login("invalid-session-key-value")
    expect(invalid.status).toBe(401)
    expect(invalid.headers["set-cookie"]).toBeUndefined()
    const crossOrigin = await request(server, {
      method: "POST",
      path: "/api/login",
      headers: { "content-type": "application/json", origin: "https://attacker.example" },
      body: JSON.stringify({ apiKey: USER_ONE_KEY }),
    })
    expect(crossOrigin.status).toBe(403)
  })

  it("keeps simultaneous users isolated across every retained surface", async () => {
    const oneCookie = cookieFrom(await login(USER_ONE_KEY))
    const twoCookie = cookieFrom(await login(USER_TWO_KEY))
    const calls = [
      ["memory", { operation: "list", limit: 50, offset: 50, sort_by: "source_created_at" }],
      ["search", { operation: "query", query: "fixture", limit: 20 }],
      ["graph", { operation: "generate", cluster_algorithm: "semantic", min_edge_weight: 0.68 }],
      ["stats", { operation: "usage" }],
      ["stats", { operation: "embeddings" }],
      ["context", { operation: "list" }],
      ["snapshot", { operation: "list" }],
    ]
    for (const [tool, args] of calls) {
      const one = await apiCall(server, oneCookie, tool, args)
      const two = await apiCall(server, twoCookie, tool, args)
      expect(one.status).toBe(200)
      expect(two.status).toBe(200)
      expect(one.body).toContain('\\"owner\\":\\"one\\"')
      expect(one.body).not.toContain('\\"owner\\":\\"two\\"')
      expect(two.body).toContain('\\"owner\\":\\"two\\"')
      expect(two.body).not.toContain('\\"owner\\":\\"one\\"')
    }
  })

  it("scopes Manage writes and capture pagination to the session key", async () => {
    const oneCookie = cookieFrom(await login(USER_ONE_KEY))
    const twoCookie = cookieFrom(await login(USER_TWO_KEY))
    for (const [tool, args] of [
      ["memory", { operation: "create", content: "Fixture memory", category: "context" }],
      ["memory", { operation: "delete", id: "00000000-0000-4000-8000-000000000001" }],
      ["memory", { operation: "list", limit: 50, offset: 100, sort_by: "source_created_at" }],
    ]) {
      const one = await apiCall(server, oneCookie, tool, args)
      const two = await apiCall(server, twoCookie, tool, args)
      expect(one.status).toBe(200)
      expect(two.status).toBe(200)
      expect(one.body).toContain('\\"owner\\":\\"one\\"')
      expect(two.body).toContain('\\"owner\\":\\"two\\"')
    }
    const forwarded = vi.mocked(fetch).mock.calls.map(([, init]) => ({
      key: init.headers["x-api-key"],
      call: JSON.parse(init.body).params,
    }))
    expect(forwarded).toContainEqual({
      key: USER_ONE_KEY,
      call: { name: "memory", arguments: { operation: "list", limit: 50, offset: 100, sort_by: "source_created_at" } },
    })
  })

  it("denies writes when hosted mode is configured read-only", async () => {
    server.closeAllConnections()
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    server = createConsoleServer({ ...CONFIG, mode: "read-only" })
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
    const cookie = cookieFrom(await login(USER_ONE_KEY))
    const response = await apiCall(server, cookie, "memory", { operation: "create", content: "denied" })
    expect(response.status).toBe(403)
  })

  it("logs out one session without interrupting another", async () => {
    const oneCookie = cookieFrom(await login(USER_ONE_KEY))
    const twoCookie = cookieFrom(await login(USER_TWO_KEY))
    const logout = await request(server, { method: "POST", path: "/api/logout", origin: true, headers: { cookie: oneCookie } })
    expect(logout.status).toBe(200)
    expect((await apiCall(server, oneCookie, "memory", { operation: "list" })).status).toBe(401)
    expect((await apiCall(server, twoCookie, "memory", { operation: "list" })).status).toBe(200)
  })

  it("clears only the session whose upstream key was revoked", async () => {
    const oneCookie = cookieFrom(await login(USER_ONE_KEY))
    const twoCookie = cookieFrom(await login(USER_TWO_KEY))
    vi.mocked(fetch).mockImplementation((_url, init) => {
      const key = init.headers["x-api-key"]
      if (key === USER_ONE_KEY) return Promise.resolve(new Response("Unauthorized", { status: 401 }))
      return Promise.resolve(toolResult({ owner: "two" }))
    })
    const revoked = await apiCall(server, oneCookie, "memory", { operation: "list" })
    expect(revoked.status).toBe(401)
    expect(revoked.headers["set-cookie"][0]).toContain("Max-Age=0")
    expect((await apiCall(server, twoCookie, "memory", { operation: "list" })).status).toBe(200)
  })
})
