#!/usr/bin/env node
import http from "node:http"
import { readFile } from "node:fs/promises"
import { join, normalize } from "node:path"
import { fileURLToPath } from "node:url"
import { loadConfig, handleApiCall, isOriginAllowed } from "./lib.mjs"

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
  const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/api/call") {
      if (!isOriginAllowed(config, req.headers.origin, req.headers.host)) {
        respond(res, 403, { "content-type": "application/json", "cache-control": "no-store" },
          JSON.stringify({ ok: false, error: "Origin is not allowed" }))
        return
      }
      const body = await readBody(req, config.maxBodyBytes)
      const { status, payload } = await handleApiCall(config, body, {
        authorization: req.headers.authorization,
      })
      const headers = { "content-type": "application/json", "cache-control": "no-store" }
      if (status === 401) headers["www-authenticate"] = 'Bearer realm="rembr-console"'
      respond(res, status, headers, JSON.stringify(payload))
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
      if (!filePath.startsWith(`${PUBLIC_DIR}/`)) {
        respond(res, 403)
        return
      }
      try {
        const content = await readFile(filePath)
        const ext = filePath.slice(filePath.lastIndexOf("."))
        respond(res, 200, {
          "content-type": MIME[ext] ?? "application/octet-stream",
          "cache-control": ext === ".html" ? "no-store" : "public, max-age=3600",
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
