#!/usr/bin/env node
import { runDistillCli } from "./distill.js"

runDistillCli(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (error) => {
    console.error(`codex-rembr-distill: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  },
)
