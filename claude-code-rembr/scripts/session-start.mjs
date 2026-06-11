#!/usr/bin/env node
// SessionStart hook: inject relevant Rembr memories as additional context.
import { loadConfig, readStdin, sessionStartContext, emit } from "./lib.mjs"

try {
  const input = await readStdin()
  const context = await sessionStartContext(loadConfig(), input)
  if (context) {
    emit({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: context,
      },
    })
  } else {
    emit({})
  }
} catch {
  emit({})
}
