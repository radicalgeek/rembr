#!/usr/bin/env node
// One-time local setup page. The browser submits the endpoint and key to
// loopback; the helper verifies a read-only MCP request and saves ~/.rembr/.env.
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { randomBytes } from "node:crypto"
import { spawn } from "node:child_process"

// Matches the plugin default in lib.mjs: the hosted Rembr service.
const defaultEndpoint = "https://rembr.ai/mcp"
const stateDir = process.env.REMBR_STATE_DIR || path.join(os.homedir(), ".rembr")
const secretPath = path.join(stateDir, ".env")
const nonce = randomBytes(24).toString("hex")
const route = `/${nonce}`
const timeoutMs = 300_000

function openBrowser(url) {
  const command = process.platform === "win32" ? "cmd.exe" : process.platform === "darwin" ? "open" : "xdg-open"
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url]
  const browser = spawn(command, args, { stdio: "ignore", detached: true })
  browser.on("error", () => process.stderr.write("Open the local setup link shown above in your browser.\n"))
  browser.unref()
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char])
}

const page = (message = "") => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Set up Rembr</title>
<style>body{font:16px system-ui,sans-serif;max-width:28rem;margin:12vh auto;padding:1rem}label{display:block;margin:1.5rem 0 .5rem}input{box-sizing:border-box;width:100%;padding:.7rem}button{margin-top:1rem;padding:.7rem 1.2rem}p{line-height:1.5}</style>
<h1>Connect Rembr</h1><p>Enter the Rembr endpoint and personal access key. The local form sends the key to that endpoint for a read-only check, then saves both in a local Claude Code profile.</p>
${message ? `<p role="alert">${message}</p>` : ""}<form method="post" action="${route}"><label for="endpoint">Rembr MCP endpoint</label><input id="endpoint" name="endpoint" type="url" value="${escapeHtml(defaultEndpoint)}" maxlength="2048" required autofocus><label for="key">Rembr access key</label><input id="key" name="key" type="password" autocomplete="off" maxlength="4096" required><button type="submit">Connect</button></form></html>`

function send(response, status, html) {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
  })
  response.end(html)
}

function isAllowedSetupOrigin(origin) {
  // Embedded Desktop browsers may submit loopback forms with opaque or absent
  // Origin values. The one-time route and exact Host check remain the CSRF guard.
  if (origin === undefined || origin === "null") return true
  try {
    const parsed = new URL(origin)
    return parsed.protocol === "http:" && parsed.hostname === "127.0.0.1"
  } catch {
    return false
  }
}

function validateEndpoint(value) {
  if (!value || value !== value.trim() || /[\r\n\0]/.test(value)) return false
  try {
    const parsed = new URL(value)
    const loopback = ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)
    return (parsed.protocol === "https:" || (parsed.protocol === "http:" && loopback)) &&
      !parsed.username && !parsed.password && !parsed.hash &&
      parsed.pathname.replace(/\/$/, "").endsWith("/mcp")
  } catch {
    return false
  }
}

async function verifyKey(endpoint, key) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  try {
    const result = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-api-key": key },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "memory", arguments: { operation: "list", limit: 1 } } }),
      signal: controller.signal,
    })
    if (!result.ok) return `Rembr returned HTTP ${result.status}. Check the endpoint, key, and network access.`
    const body = await result.text()
    const message = result.headers.get("content-type")?.includes("text/event-stream")
      ? body.split(/\r?\n/).filter((line) => line.startsWith("data:"))
          .map((line) => { try { return JSON.parse(line.slice(5).trim()) } catch { return null } })
          .find((entry) => entry?.result || entry?.error)
      : JSON.parse(body)
    if (!message?.result || message.result.isError) return "Rembr did not accept the read-only check."
    const accepted = message.result.content?.some((part) => {
      if (part.type !== "text") return false
      try { return JSON.parse(part.text).success === true } catch { return false }
    })
    return accepted ? null : "Rembr did not accept the read-only check."
  } catch {
    return "Could not reach Rembr. Check the endpoint and network access, then try again."
  } finally {
    clearTimeout(timer)
  }
}

const server = http.createServer(async (request, response) => {
  if (request.headers.host !== `127.0.0.1:${server.address()?.port}` || request.url !== route) {
    send(response, 404, "Not found")
    return
  }
  if (request.method === "GET") {
    send(response, 200, page())
    return
  }
  if (request.method !== "POST") {
    send(response, 403, "Request rejected: method")
    return
  }
  const origin = request.headers.origin
  if (!isAllowedSetupOrigin(origin)) {
    const kind = origin === undefined ? "missing" : origin === "null" ? "opaque" : "not-loopback"
    send(response, 403, `Request rejected: origin (${kind})`)
    return
  }
  if (request.headers["content-type"]?.split(";")[0] !== "application/x-www-form-urlencoded") {
    send(response, 403, "Request rejected: content-type")
    return
  }
  let body = ""
  for await (const chunk of request) {
    body += chunk
    if (body.length > 16_384) {
      send(response, 413, "Setup request too large")
      return
    }
  }
  const form = new URLSearchParams(body)
  const endpoint = form.get("endpoint") ?? ""
  const key = form.get("key") ?? ""
  if (!validateEndpoint(endpoint)) {
    send(response, 400, page("Enter an HTTPS Rembr endpoint, or use HTTP only for a loopback service. The path must end in /mcp."))
    return
  }
  if (key.length < 8 || /[\r\n\0]/.test(key) || key !== key.trim()) {
    send(response, 400, page("Enter the access key without spaces or line breaks."))
    return
  }
  const issue = await verifyKey(endpoint, key)
  if (issue) {
    send(response, 401, page(issue))
    return
  }
  try {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(secretPath, `REMBR_URL=${endpoint}\nREMBR_API_KEY=${key}\n`, { mode: 0o600 })
    fs.chmodSync(secretPath, 0o600)
    send(response, 200, "<!doctype html><html lang=\"en\"><title>Rembr ready</title><h1>Rembr is connected</h1><p>Start a new local Code session to use its tools.</p></html>")
    process.stdout.write("Rembr connection verified. Start a new local Code session.\n")
    server.close()
  } catch {
    send(response, 500, page("Could not save the setup. Check your user profile permissions."))
  }
})

server.listen(0, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${server.address().port}${route}`
  process.stdout.write(`Open the private local setup page: ${url}\n`)
  if (process.env.REMBR_SETUP_NO_BROWSER !== "1") openBrowser(url)
})
server.on("error", () => process.stderr.write("Could not open the local Rembr setup page.\n"))
setTimeout(() => {
  process.stderr.write("Rembr setup timed out. Run /rembr:setup again when ready.\n")
  server.close()
}, timeoutMs).unref()
