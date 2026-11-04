#!/usr/bin/env node
// Stop hook: distill the new transcript lines since the last pass into
// durable Rembr memories. Wired async in hooks.json so it never blocks the
// session; fail-silent throughout.
import { loadConfig, readStdin, emit } from "./lib.mjs"
import { loadDistillConfig, distillTranscript } from "./distill-lib.mjs"

try {
  // Recursion guard: the headless distiller session fires its own Stop hook.
  if (!process.env.REMBR_CAPTURE_DISABLE) {
    const config = loadDistillConfig()
    const rembrConfig = loadConfig()
    const input = await readStdin()
    if (config.enabled && rembrConfig.apiKey && input?.transcript_path && input?.session_id) {
      await distillTranscript(config, rembrConfig, input.transcript_path, input.session_id)
    }
  }
} catch {
  // hooks never fail loudly
}
emit({})
