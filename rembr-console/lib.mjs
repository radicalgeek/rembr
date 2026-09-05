// Security boundary for the single-tenant Rembr console.
import crypto from "node:crypto"

const READ_OPERATIONS = Object.freeze({
  memory: new Set(["list"]),
  search: new Set(["query"]),
  stats: new Set(["usage", "embeddings"]),
  context: new Set(["list"]),
  snapshot: new Set(["list"]),
})

const WRITE_OPERATIONS = Object.freeze({
  memory: new Set(["create", "delete"]),
})

export const ALLOWED_TOOLS = Object.freeze(Object.keys(READ_OPERATIONS))

function boundedInteger(value, fallback, minimum, maximum) {
  if (value === undefined || value === "") return fallback
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback
}

export function loadConfig(env = process.env) {
  const mode = env.REMBR_CONSOLE_MODE === "read-write" ? "read-write" : "read-only"
  const config = {
    url: env.REMBR_URL || "http://localhost:3000/mcp",
    apiKey: env.REMBR_API_KEY || undefined,
    authToken: env.REMBR_CONSOLE_AUTH_TOKEN || undefined,
    host: env.HOST || "127.0.0.1",
    port: boundedInteger(env.PORT, 8080, 1, 65535),
    timeoutMs: boundedInteger(env.REMBR_TIMEOUT_MS, 30_000, 1_000, 120_000),
    maxBodyBytes: boundedInteger(env.REMBR_CONSOLE_MAX_BODY_BYTES, 65_536, 1_024, 1_048_576),
    maxResponseBytes: boundedInteger(env.REMBR_CONSOLE_MAX_RESPONSE_BYTES, 2_097_152, 65_536, 8_388_608),
    mode,
    allowedOrigins: (env.REMBR_CONSOLE_ALLOWED_ORIGINS || "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  }

  const errors = []
  try {
    const upstream = new URL(config.url)
    if (!new Set(["http:", "https:"]).has(upstream.protocol)) errors.push("REMBR_URL must use HTTP or HTTPS")
    if (upstream.username || upstream.password) errors.push("REMBR_URL must not contain credentials")
  } catch {
    errors.push("REMBR_URL must be a valid URL")
  }
  if (!config.apiKey) errors.push("REMBR_API_KEY is required")
  if (!config.authToken || Buffer.byteLength(config.authToken) < 32) {
    errors.push("REMBR_CONSOLE_AUTH_TOKEN must contain at least 32 bytes")
  }
  if (config.apiKey && config.authToken && config.apiKey === config.authToken) {
    errors.push("REMBR_CONSOLE_AUTH_TOKEN must be distinct from REMBR_API_KEY")
  }
  config.configurationError = errors.length ? errors.join("; ") : undefined
  return config
}

function digest(value) {
  return crypto.createHash("sha256").update(value).digest()
}

export function authenticateConsoleRequest(config, authorization) {
  if (config.configurationError) return { ok: false, status: 503, error: "Console security configuration is incomplete" }
  const match = typeof authorization === "string" && authorization.match(/^Bearer ([^\s]+)$/)
  if (!match) return { ok: false, status: 401, error: "Console authentication required" }
  const supplied = digest(match[1])
  const expected = digest(config.authToken)
  if (!crypto.timingSafeEqual(supplied, expected)) {
    return { ok: false, status: 401, error: "Console authentication failed" }
  }
  return { ok: true }
}

export function isOriginAllowed(config, origin, host) {
  if (!origin) return true
  if (config.allowedOrigins.includes(origin)) return true
  if (!host || /[\r\n]/.test(host)) return false
  return origin === `http://${host}` || origin === `https://${host}`
}

function operationAllowed(config, tool, args) {
  const operation = args?.operation
  if (typeof operation !== "string") return false
  if (READ_OPERATIONS[tool]?.has(operation)) return true
  return config.mode === "read-write" && WRITE_OPERATIONS[tool]?.has(operation)
}

function validateArguments(tool, args) {
  if (args === undefined || typeof args !== "object" || Array.isArray(args) || args === null) {
    return "args must be an object"
  }
  if (Object.keys(args).length > 24) return "too many arguments"
  if (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 100)) {
    return "limit must be an integer from 1 to 100"
  }
  if (tool === "search" && (typeof args.query !== "string" || args.query.length < 1 || args.query.length > 8_192)) {
    return "search query must contain 1 to 8192 characters"
  }
  if (tool === "memory" && args.operation === "create" &&
      (typeof args.content !== "string" || args.content.length < 1 || args.content.length > 65_536)) {
    return "memory content must contain 1 to 65536 characters"
  }
  if (tool === "memory" && args.operation === "delete" &&
      (typeof args.id !== "string" || !/^[0-9a-f-]{36}$/i.test(args.id))) {
    return "memory id must be a UUID"
  }
  return undefined
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
      // Ignore non-JSON SSE events.
    }
  }
  return messages
}

function clientSafeMessage(value, fallback) {
  if (typeof value !== "string") return fallback
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 512) || fallback
}

async function readBoundedResponse(response, maximumBytes) {
  if (!response.body) return ""
  const reader = response.body.getReader()
  const chunks = []
  let totalBytes = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    const chunk = Buffer.from(value)
    totalBytes += chunk.length
    if (totalBytes > maximumBytes) {
      await reader.cancel().catch(() => undefined)
      throw Object.assign(new Error("Response body too large"), { code: "RESPONSE_TOO_LARGE" })
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, totalBytes).toString("utf8")
}

/** Forward one narrowly authorised MCP tools/call to Rembr. */
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
      redirect: "error",
    })
    if (!response.ok) return { ok: false, error: `Rembr returned HTTP ${response.status}` }
    const declaredLength = Number(response.headers.get("content-length") || 0)
    if (declaredLength > config.maxResponseBytes) return { ok: false, error: "Rembr response exceeded the console limit" }
    const body = await readBoundedResponse(response, config.maxResponseBytes)
    const message = (response.headers.get("content-type") ?? "").includes("text/event-stream")
      ? parseSseBody(body).find((entry) => entry.result || entry.error)
      : JSON.parse(body)
    if (!message) return { ok: false, error: "No JSON-RPC response from Rembr" }
    if (message.error) return { ok: false, error: clientSafeMessage(message.error.message, "Rembr tool call failed") }
    const text = (message.result?.content ?? [])
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n")
    if (message.result?.isError) return { ok: false, error: clientSafeMessage(text, "Rembr tool call failed") }
    return { ok: true, text }
  } catch (error) {
    return {
      ok: false,
      error: error?.code === "RESPONSE_TOO_LARGE"
        ? "Rembr response exceeded the console limit"
        : error?.name === "AbortError" ? "Request to Rembr timed out" : "Rembr is unreachable",
    }
  } finally {
    clearTimeout(timer)
  }
}

export async function handleApiCall(config, body, request = {}) {
  const authentication = authenticateConsoleRequest(config, request.authorization)
  if (!authentication.ok) {
    return { status: authentication.status, payload: { ok: false, error: authentication.error } }
  }
  let parsed
  try {
    parsed = typeof body === "string" ? JSON.parse(body) : body
  } catch {
    return { status: 400, payload: { ok: false, error: "Invalid JSON body" } }
  }
  const { tool, args } = parsed ?? {}
  if (typeof tool !== "string" || !ALLOWED_TOOLS.includes(tool) || !operationAllowed(config, tool, args)) {
    return { status: 403, payload: { ok: false, error: "Tool operation is not allowed" } }
  }
  const argumentError = validateArguments(tool, args)
  if (argumentError) return { status: 400, payload: { ok: false, error: argumentError } }
  const result = await callRembr(config, tool, args)
  return { status: result.ok ? 200 : 502, payload: result }
}
