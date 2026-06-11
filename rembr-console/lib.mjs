// rembr-console core logic (zero dependencies, fully testable).
//
// The console is a pure MCP client for a Rembr server: the browser talks to
// this process, and this process forwards an *allowlisted* set of MCP tool
// calls to Rembr with the API key held server-side (never sent to the
// browser). There is no enterprise code here to gate or bypass — tenant
// management, RBAC, SSO, and billing live in a different (closed) codebase.

import crypto from "node:crypto"

/**
 * Tools the console may call. Everything else (admin-ish or destructive
 * surfaces a single-tenant console doesn't need) is rejected server-side.
 */
export const ALLOWED_TOOLS = Object.freeze([
  "memory",
  "search",
  "stats",
  "context",
  "snapshot",
  "graph",
  "contradictions",
  "temporal",
  "causality",
])

export function loadConfig(env = process.env) {
  return {
    url: env.REMBR_URL || "http://localhost:3000/mcp",
    apiKey: env.REMBR_API_KEY || undefined,
    port: Number.isFinite(Number(env.PORT)) && env.PORT ? Number(env.PORT) : 8080,
    timeoutMs: Number.isFinite(Number(env.REMBR_TIMEOUT_MS)) && env.REMBR_TIMEOUT_MS
      ? Number(env.REMBR_TIMEOUT_MS)
      : 30_000,
  }
}

function parseSseBody(body) {
  const messages = []
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
      // ignore non-JSON SSE events
    }
  }
  return messages
}

/** Forward one MCP tools/call to Rembr. Returns { ok, text } or { ok:false, error }. */
export async function callRembr(config, tool, args) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeoutMs)
  try {
    const response = await fetch(config.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-api-key": config.apiKey,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomInt(1, 1_000_000),
        method: "tools/call",
        params: { name: tool, arguments: args },
      }),
      signal: controller.signal,
    })
    if (!response.ok) {
      return { ok: false, error: `Rembr returned HTTP ${response.status}` }
    }
    const contentType = response.headers.get("content-type") ?? ""
    const body = await response.text()
    const message = contentType.includes("text/event-stream")
      ? parseSseBody(body).find((m) => m.result || m.error)
      : JSON.parse(body)
    if (!message) return { ok: false, error: "No JSON-RPC response from Rembr" }
    if (message.error) return { ok: false, error: `${message.error.message}` }
    const text = (message.result?.content ?? [])
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n")
    if (message.result?.isError) return { ok: false, error: text || "Tool call failed" }
    return { ok: true, text }
  } catch (error) {
    return {
      ok: false,
      error: error?.name === "AbortError" ? "Request to Rembr timed out" : `Rembr unreachable: ${error?.message ?? error}`,
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Handle a POST /api/call body. Returns { status, payload } for the HTTP layer.
 */
export async function handleApiCall(config, body) {
  if (!config.apiKey) {
    return {
      status: 503,
      payload: { ok: false, error: "Console is not configured: set REMBR_API_KEY (see SELF-HOSTING.md)" },
    }
  }
  let parsed
  try {
    parsed = typeof body === "string" ? JSON.parse(body) : body
  } catch {
    return { status: 400, payload: { ok: false, error: "Invalid JSON body" } }
  }
  const { tool, args } = parsed ?? {}
  if (typeof tool !== "string" || !ALLOWED_TOOLS.includes(tool)) {
    return { status: 403, payload: { ok: false, error: `Tool not allowed: ${String(tool)}` } }
  }
  if (args !== undefined && (typeof args !== "object" || Array.isArray(args) || args === null)) {
    return { status: 400, payload: { ok: false, error: "args must be an object" } }
  }
  const result = await callRembr(config, tool, args ?? {})
  return { status: result.ok ? 200 : 502, payload: result }
}
