import http from "node:http"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createConsoleServer } from "./server.mjs"

const TOKEN = "server-test-token-with-at-least-32-bytes"
const CONFIG = {
  url: "https://upstream.example/mcp",
  apiKey: "upstream-key",
  authToken: TOKEN,
  host: "127.0.0.1",
  port: 8080,
  timeoutMs: 5_000,
  maxBodyBytes: 128,
  maxResponseBytes: 4_096,
  mode: "read-only",
  allowedOrigins: [],
}

function request(server, { method = "GET", path = "/", headers = {}, body = "" } = {}) {
  const address = server.address()
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port: address.port,
      method,
      path,
      agent: false,
      headers: { connection: "close", ...headers },
    }, (res) => {
      const chunks = []
      res.on("data", (chunk) => chunks.push(chunk))
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }))
    })
    req.on("error", reject)
    req.end(body)
  })
}

let server
beforeEach(async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
    jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "ok" }] },
  }), { status: 200, headers: { "content-type": "application/json" } })))
  server = createConsoleServer(CONFIG)
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await new Promise((resolve, reject) => {
    // Stop accepting connections before terminating keep-alive sockets. Calling
    // closeAllConnections first leaves a race in which the HTTP agent can make
    // a socket idle after the sweep and keep server.close() waiting forever.
    server.close((error) => error ? reject(error) : resolve())
    server.closeAllConnections()
  })
})

describe("console HTTP boundary", () => {
  it("serves static content with a restrictive CSP", async () => {
    const response = await request(server)
    expect(response.status).toBe(200)
    expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'")
    expect(response.headers["x-content-type-options"]).toBe("nosniff")
  })

  it("requires bearer authentication and an allowed origin", async () => {
    const body = JSON.stringify({ tool: "stats", args: { operation: "usage" } })
    expect((await request(server, { method: "POST", path: "/api/call", body,
      headers: { "content-type": "application/json" } })).status).toBe(401)
    expect((await request(server, { method: "POST", path: "/api/call", body,
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`,
        origin: "https://attacker.example", host: "localhost" } })).status).toBe(403)
  })

  it("caps request bodies before tool dispatch", async () => {
    const response = await request(server, {
      method: "POST",
      path: "/api/call",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: "x".repeat(129),
    })
    expect(response.status).toBe(413)
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  })

  it("forwards a narrow authenticated read operation", async () => {
    const response = await request(server, {
      method: "POST",
      path: "/api/call",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ tool: "stats", args: { operation: "usage" } }),
    })
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toEqual({ ok: true, text: "ok" })
  })
})
