#!/usr/bin/env node
// rembr-console HTTP server: static UI + /api/call proxy. Zero dependencies.
import http from "node:http"
import { readFile } from "node:fs/promises"
import { join, normalize } from "node:path"
import { fileURLToPath } from "node:url"
import { loadConfig, handleApiCall } from "./lib.mjs"

const PUBLIC_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "public")
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
}

const config = loadConfig()

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/api/call") {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const { status, payload } = await handleApiCall(config, Buffer.concat(chunks).toString("utf8"))
      res.writeHead(status, { "content-type": "application/json" })
      res.end(JSON.stringify(payload))
      return
    }

    if (req.method === "GET") {
      const urlPath = req.url === "/" ? "/index.html" : (req.url ?? "/index.html").split("?")[0]
      const safePath = normalize(urlPath).replace(/^(\.\.[/\\])+/, "")
      const filePath = join(PUBLIC_DIR, safePath)
      if (!filePath.startsWith(PUBLIC_DIR)) {
        res.writeHead(403).end()
        return
      }
      try {
        const content = await readFile(filePath)
        const ext = filePath.slice(filePath.lastIndexOf("."))
        res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream" })
        res.end(content)
        return
      } catch {
        res.writeHead(404, { "content-type": "text/plain" }).end("Not found")
        return
      }
    }

    res.writeHead(405).end()
  } catch (error) {
    res.writeHead(500, { "content-type": "application/json" })
    res.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }))
  }
})

server.listen(config.port, () => {
  console.log(`rembr-console listening on http://localhost:${config.port} → ${config.url}`)
  if (!config.apiKey) {
    console.warn("rembr-console: REMBR_API_KEY is not set — the UI will show a configuration notice")
  }
})
