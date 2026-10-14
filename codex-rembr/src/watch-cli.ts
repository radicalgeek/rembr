#!/usr/bin/env node
import { runWatchCli } from "./watch.js"

runWatchCli(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (error) => {
    console.error(`codex-rembr-watch: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  },
)
