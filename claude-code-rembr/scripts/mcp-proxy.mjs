#!/usr/bin/env node
// Stdio-to-HTTP adapter: the plugin MCP server and its hooks read the same
// local configuration. No credential is interpolated into a plugin manifest.
import readline from "node:readline"
import { loadConfig, readSecretFile } from "./lib.mjs"

const secrets = readSecretFile()
const config = loadConfig(process.env, undefined, secrets)
if (!secrets.REMBR_URL || !secrets.REMBR_API_KEY) {
  process.stderr.write("Rembr is not configured. Run /rembr:setup in a local Code session.\n")
  process.exit(1)
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })

function reply(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function error(id, message) {
  reply({ jsonrpc: "2.0", id, error: { code: -32000, message } })
}

async function forward(message) {
  if (!message || message.jsonrpc !== "2.0") return
  // A stateless HTTP backend does not retain the initialized notification.
  if (message.id === undefined) return
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
      body: JSON.stringify(message),
      signal: controller.signal,
    })
    if (!response.ok) {
      error(message.id, `Rembr returned HTTP ${response.status}`)
      return
    }
    const body = await response.text()
    if (response.headers.get("content-type")?.includes("text/event-stream")) {
      for (const chunk of body.split(/\r?\n\r?\n/)) {
        const data = chunk.split(/\r?\n/).filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim()).join("")
        if (!data) continue
        try {
          const event = JSON.parse(data)
          if (event.id === message.id) {
            reply(event)
            return
          }
        } catch { /* ignore non-JSON events */ }
      }
      error(message.id, "Rembr returned no MCP response")
    } else {
      const result = JSON.parse(body)
      if (result.id !== message.id) throw new Error("MCP response ID mismatch")
      reply(result)
    }
  } catch {
    error(message.id, "Rembr connection failed")
  } finally {
    clearTimeout(timer)
  }
}

input.on("line", (line) => {
  try {
    void forward(JSON.parse(line))
  } catch {
    error(null, "Invalid MCP request")
  }
})
