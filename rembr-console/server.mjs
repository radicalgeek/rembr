#!/usr/bin/env node
import http from "node:http"
import { readFile } from "node:fs/promises"
import os from "node:os"
import { isIP } from "node:net"
import { join, normalize, relative, isAbsolute } from "node:path"
import { fileURLToPath } from "node:url"
import {
  loadConfig,
  handleApiCall,
  callRembr,
  isOriginAllowed,
  authenticateConsoleRequest,
  createSessionStore,
  createLoginLimiter,
  sessionCookie,
  clearedSessionCookie,
} from "./lib.mjs"

const PUBLIC_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "public")
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
}
const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "cross-origin-resource-policy": "same-origin",
}

function respond(res, status, headers = {}, body = "") {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers })
  res.end(body)
}

function readBody(req, maximumBytes) {
  return new Promise((resolve, reject) => {
    let length = 0
    const chunks = []
    let settled = false
    const onData = (chunk) => {
      length += chunk.length
      if (!settled && length > maximumBytes) {
        settled = true
        req.off("data", onData)
        req.resume()
        reject(Object.assign(new Error("Request body too large"), { status: 413 }))
        return
      }
      chunks.push(chunk)
    }
    req.on("data", onData)
    req.on("end", () => {
      if (!settled) resolve(Buffer.concat(chunks).toString("utf8"))
    })
    req.on("error", (error) => {
      if (!settled) reject(error)
    })
  })
}

export function createConsoleServer(config) {
  const sessions = config.authMode === "session" ? createSessionStore(config) : null
  const loginLimiter = config.authMode === "session" ? createLoginLimiter(config) : null

  function hostedOriginAllowed(req) {
    return typeof req.headers.origin === "string" && isOriginAllowed(config, req.headers.origin, req.headers.host)
  }

  function clientId(req) {
    const proxyAddress = config.trustProxy ? req.headers["x-real-ip"] : undefined
    if (typeof proxyAddress === "string" && isIP(proxyAddress.trim())) return proxyAddress.trim()
    return req.socket.remoteAddress || "unknown"
  }

  function hostedSession(req) {
    return sessions?.resolve(req.headers.cookie) ?? null
  }

  const server = http.createServer(async (req, res) => {
  try {
    const requestPath = (req.url ?? "/").split("?", 1)[0]
    if (config.authMode === "session" && req.method === "POST" && requestPath === "/api/login") {
      if (!hostedOriginAllowed(req)) {
        respond(res, 403, { "content-type": "application/json", "cache-control": "no-store" },
          JSON.stringify({ ok: false, error: "Origin is not allowed" }))
        return
      }
      if (!loginLimiter.consume(clientId(req))) {
        respond(res, 429, { "content-type": "application/json", "cache-control": "no-store", "retry-after": "60" },
          JSON.stringify({ ok: false, error: "Too many login attempts" }))
        return
      }
      const body = await readBody(req, Math.min(config.maxBodyBytes, 8_192))
      let apiKey
      try {
        const parsed = JSON.parse(body)
        apiKey = typeof parsed?.apiKey === "string" ? parsed.apiKey.trim() : ""
      } catch {
        apiKey = ""
      }
      if (apiKey.length < 16 || apiKey.length > 512 || /\s/.test(apiKey)) {
        respond(res, 401, { "content-type": "application/json", "cache-control": "no-store" },
          JSON.stringify({ ok: false, error: "API key is not valid" }))
        return
      }
      const validation = await callRembr(config, "memory", { operation: "list_personal", limit: 1 }, apiKey)
      if (!validation.ok) {
        const status = validation.upstreamStatus === 401 || validation.upstreamStatus === 403 ? 401 : 502
        respond(res, status, { "content-type": "application/json", "cache-control": "no-store" },
          JSON.stringify({ ok: false, error: status === 401 ? "API key is not valid" : "Rembr is unavailable" }))
        return
      }
      const sessionId = sessions.create(apiKey)
      apiKey = ""
      if (!sessionId) {
        respond(res, 503, { "content-type": "application/json", "cache-control": "no-store" },
          JSON.stringify({ ok: false, error: "Console session capacity reached" }))
        return
      }
      respond(res, 200, {
        "content-type": "application/json",
        "cache-control": "no-store",
        "set-cookie": sessionCookie(sessionId, Math.floor(config.sessionAbsoluteMs / 1000)),
      }, JSON.stringify({ ok: true }))
      return
    }

    if (req.method === "GET" && requestPath === "/api/session") {
      const session = config.authMode === "session" ? hostedSession(req) : null
      respond(res, 200, { "content-type": "application/json", "cache-control": "no-store" },
        JSON.stringify({
          ok: true,
          authMode: config.authMode === "session" ? "session" : "static",
          authenticated: config.authMode === "session" ? Boolean(session) : false,
          writable: config.mode === "read-write",
          memoryPageSize: config.memoryPageSize ?? 50,
        }))
      return
    }

    if (config.authMode === "session" && req.method === "POST" && requestPath === "/api/logout") {
      if (!hostedOriginAllowed(req)) {
        respond(res, 403, { "content-type": "application/json", "cache-control": "no-store" },
          JSON.stringify({ ok: false, error: "Origin is not allowed" }))
        return
      }
      sessions.destroy(req.headers.cookie)
      respond(res, 200, {
        "content-type": "application/json",
        "cache-control": "no-store",
        "set-cookie": clearedSessionCookie(),
      }, JSON.stringify({ ok: true }))
      return
    }

    if (req.method === "POST" && requestPath === "/api/call") {
      if (!isOriginAllowed(config, req.headers.origin, req.headers.host)) {
        respond(res, 403, { "content-type": "application/json", "cache-control": "no-store" },
          JSON.stringify({ ok: false, error: "Origin is not allowed" }))
        return
      }
      const body = await readBody(req, config.maxBodyBytes)
      const session = config.authMode === "session" ? hostedSession(req) : null
      const { status, payload } = await handleApiCall(config, body, {
        authorization: req.headers.authorization,
        apiKey: session?.apiKey,
      })
      const headers = { "content-type": "application/json", "cache-control": "no-store" }
      if (status === 401) {
        if (config.authMode === "session") {
          sessions.destroy(req.headers.cookie)
          headers["set-cookie"] = clearedSessionCookie()
        } else {
          headers["www-authenticate"] = 'Bearer realm="rembr-console"'
        }
      }
      respond(res, status, headers, JSON.stringify(payload))
      return
    }

    if (config.authMode === "session" && requestPath.startsWith("/api/")) {
      respond(res, 404, { "content-type": "application/json", "cache-control": "no-store" },
        JSON.stringify({ ok: false, error: "Not found" }))
      return
    }

    if (req.method === "GET" && requestPath === "/api/capture-log") {
      const auth = authenticateConsoleRequest(config, req.headers.authorization)
      if (!auth.ok) {
        respond(res, auth.status, { "content-type": "application/json", "cache-control": "no-store" },
          JSON.stringify({ ok: false, error: auth.error }))
        return
      }
      const logFile = config.logFile || join(os.homedir(), ".rembr", "capture.log")
      try {
        const text = await readFile(logFile, "utf8")
        respond(res, 200, { "content-type": "application/json", "cache-control": "no-store" },
          JSON.stringify({ ok: true, text }))
      } catch {
        respond(res, 200, { "content-type": "application/json", "cache-control": "no-store" },
          JSON.stringify({ ok: true, text: "" }))
      }
      return
    }

    if (req.method === "GET" || req.method === "HEAD") {
      const rawPath = req.url === "/" ? "/index.html" : (req.url ?? "/index.html").split("?")[0]
      if (rawPath.length > 2_048 || rawPath.includes("\0")) {
        respond(res, 400, { "content-type": "text/plain; charset=utf-8" }, "Bad request")
        return
      }
      const safePath = normalize(rawPath).replace(/^([/\\]*\.\.[/\\])+/, "")
      const filePath = join(PUBLIC_DIR, safePath)
      // Containment check via relative() so path separators stay portable
      // (a literal `${PUBLIC_DIR}/` prefix check breaks on Windows).
      const contained = relative(PUBLIC_DIR, filePath)
      if (contained === "" || contained.startsWith("..") || isAbsolute(contained)) {
        respond(res, 403)
        return
      }
      try {
        const content = await readFile(filePath)
        const ext = filePath.slice(filePath.lastIndexOf("."))
        const mustRevalidate = new Set([".html", ".js", ".css"]).has(ext)
        respond(res, 200, {
          "content-type": MIME[ext] ?? "application/octet-stream",
          "cache-control": mustRevalidate ? "no-store" : "public, max-age=3600",
        }, req.method === "HEAD" ? "" : content)
        return
      } catch {
        respond(res, 404, { "content-type": "text/plain; charset=utf-8" }, "Not found")
        return
      }
    }

    respond(res, 405, { allow: "GET, HEAD, POST" })
  } catch (error) {
    if (!res.headersSent) {
      const status = error?.status === 413 ? 413 : 500
      respond(res, status, { "content-type": "application/json", "cache-control": "no-store" },
        JSON.stringify({ ok: false, error: status === 413 ? "Request body too large" : "Internal server error" }))
    }
  }
  })

  server.requestTimeout = 35_000
  server.headersTimeout = 10_000
  server.keepAliveTimeout = 5_000
  server.maxHeadersCount = 64
  return server
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const config = loadConfig()
  const server = createConsoleServer(config)
  server.listen(config.port, config.host, () => {
    console.log(`rembr-console listening on http://${config.host}:${config.port}`)
    if (config.configurationError) console.error(`rembr-console disabled: ${config.configurationError}`)
  })
}
