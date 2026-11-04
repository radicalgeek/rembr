import { describe, it, expect } from "vitest"
import http from "node:http"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const proxyPath = fileURLToPath(new URL("./mcp-proxy.mjs", import.meta.url))

describe("Desktop MCP bridge", () => {
  it("forwards initialize, discovery and a read through the configured identity", async () => {
    const seen = []
    const server = http.createServer(async (request, response) => {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const rpc = JSON.parse(Buffer.concat(chunks).toString())
      seen.push({ method: rpc.method, key: request.headers["x-api-key"] })
      const result = rpc.method === "initialize"
        ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
        : rpc.method === "tools/list"
          ? { tools: [{ name: "memory", description: "Fixture memory", inputSchema: { type: "object" } }] }
          : { content: [{ type: "text", text: JSON.stringify({ success: true, data: [] }) }] }
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }))
    })
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "fixture-rembr-proxy-"))
    fs.writeFileSync(path.join(stateDir, ".env"), `REMBR_URL=http://127.0.0.1:${server.address().port}/mcp\nREMBR_API_KEY=fixture-key\n`)
    const child = spawn(process.execPath, [proxyPath], {
      env: {
        ...process.env,
        CLAUDE_PLUGIN_ROOT: path.dirname(path.dirname(proxyPath)),
        REMBR_STATE_DIR: stateDir,
        REMBR_URL: "https://old.example.test/mcp",
        REMBR_API_KEY: "old-key",
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    try {
      const responses = []
      let output = ""
      const finished = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Bridge did not answer")), 5000)
        child.stdout.on("data", (chunk) => {
          output += chunk.toString()
          for (;;) {
            const end = output.indexOf("\n")
            if (end === -1) break
            responses.push(JSON.parse(output.slice(0, end)))
            output = output.slice(end + 1)
          }
          if (responses.length === 3) {
            clearTimeout(timer)
            resolve()
          }
        })
        child.on("error", reject)
      })
      for (const [id, method, params] of [
        [1, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "fixture", version: "1" } }],
        [2, "tools/list", {}],
        [3, "tools/call", { name: "memory", arguments: { operation: "list", limit: 1 } }],
      ]) child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
      await finished
      responses.sort((left, right) => left.id - right.id)
      seen.sort((left, right) => left.method.localeCompare(right.method))
      expect(responses.map((response) => response.id)).toEqual([1, 2, 3])
      expect(responses[1].result.tools[0].name).toBe("memory")
      expect(JSON.parse(responses[2].result.content[0].text).success).toBe(true)
      expect(seen).toEqual([
        { method: "initialize", key: "fixture-key" },
        { method: "tools/call", key: "fixture-key" },
        { method: "tools/list", key: "fixture-key" },
      ])
    } finally {
      child.kill()
      server.close()
      fs.unlinkSync(path.join(stateDir, ".env"))
      fs.rmdirSync(stateDir)
    }
  })

  it("does not use a legacy key when the plugin setup file is missing", async () => {
    const child = spawn(process.execPath, [proxyPath], {
      env: {
        ...process.env,
        CLAUDE_PLUGIN_ROOT: path.dirname(path.dirname(proxyPath)),
        REMBR_STATE_DIR: "/nonexistent-rembr-path-xyz",
        REMBR_URL: "https://old.example.test/mcp",
        REMBR_API_KEY: "old-key",
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error("Bridge did not exit")) }, 5000)
      child.on("exit", (exitCode) => { clearTimeout(timer); resolve(exitCode) })
      child.on("error", reject)
    })
    expect(code).toBe(1)
  })
})
