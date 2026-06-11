#!/usr/bin/env node
// UserPromptSubmit hook: auto-capture memory-worthy prompts and (optionally,
// REMBR_PROMPT_RECALL=true) inject prompt-relevant Rembr memories.
import { loadConfig, readStdin, userPromptActions, emit } from "./lib.mjs"

try {
  const input = await readStdin()
  const { additionalContext } = await userPromptActions(loadConfig(), input)
  if (additionalContext) {
    emit({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext,
      },
    })
  } else {
    emit({})
  }
} catch {
  emit({})
}
