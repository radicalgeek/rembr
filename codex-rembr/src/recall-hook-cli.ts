#!/usr/bin/env node
import { runRecallHook, type CodexPromptHookInput } from "./recall-hook.js"

let raw = ""
for await (const chunk of process.stdin) raw += chunk

let input: CodexPromptHookInput = {}
try {
  input = JSON.parse(raw)
} catch {
  // Malformed hook input degrades to an empty result.
}

process.stdout.write(JSON.stringify(await runRecallHook(input)))
