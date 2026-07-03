#!/usr/bin/env node
// stdio entry point: `codex-rembr` (configure as a stdio MCP server).
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { createServer, loadBridgeConfig } from "./server.js"

async function main() {
  const config = loadBridgeConfig()
  const server = createServer(config)
  await server.connect(new StdioServerTransport())
  console.error(`codex-rembr: bridging stdio MCP to ${config.url}`)
}

main().catch((error) => {
  console.error(`codex-rembr: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
