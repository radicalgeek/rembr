#!/usr/bin/env node
// UserPromptSubmit hook: auto-capture memory-worthy prompts and inject either
// prompt-relevant or prior-session context once per Claude session.
import { loadConfig, readStdin, userPromptActions, promptHookOutput, emit } from "./lib.mjs"

// Recursion guard: headless child sessions spawned by the Stop-hook
// distiller must not recall or capture (REMBR_CAPTURE_DISABLE=1 in their env).
if (process.env.REMBR_CAPTURE_DISABLE) {
  emit({})
  process.exit(0)
}

try {
  const input = await readStdin()
  const { additionalContext } = await userPromptActions(loadConfig(), input)
  emit(promptHookOutput(additionalContext))
} catch {
  emit({})
}
