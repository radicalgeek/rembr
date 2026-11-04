import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), "stop-distill.mjs")
const SESSION_ID = "0123abcd-4567-89ab-cdef-0123456789ab"

// Stub distiller: waits, then records how it was invoked. The delay proves the
// hook returns before the background distiller finishes.
const STUB = `import fs from "node:fs"
setTimeout(() => {
  if (process.env.STUB_FAIL) process.exit(1)
  fs.writeFileSync(process.env.STUB_MARKER, JSON.stringify({
    argv: process.argv.slice(2),
    minRecords: process.env.REMBR_DISTILL_MIN_RECORDS,
    cwd: process.cwd(),
  }))
}, 1500)
`

let root
let stateDir
let pluginRoot
let marker

function runHook(input, extraEnv = {}) {
  const started = Date.now()
  const result = spawnSync(process.execPath, [HOOK], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    encoding: "utf8",
    timeout: 15_000,
    env: {
      ...process.env,
      REMBR_CAPTURE_DISABLE: "",
      REMBR_DISTILL_MIN_RECORDS: "",
      REMBR_DISTILL_COOLDOWN_SECONDS: "",
      REMBR_LOG: "",
      REMBR_STATE_DIR: stateDir,
      PLUGIN_ROOT: pluginRoot,
      STUB_MARKER: marker,
      ...extraEnv,
    },
  })
  return { ...result, elapsedMs: Date.now() - started }
}

function writeTranscript(lines) {
  const file = path.join(root, `rollout-2026-01-01T00-00-00-${SESSION_ID}.jsonl`)
  fs.writeFileSync(file, Array.from({ length: lines }, (_, i) => JSON.stringify({ type: "event", i })).join("\n") + "\n")
  return file
}

async function waitForMarker(deadlineMs = 5_000) {
  const end = Date.now() + deadlineMs
  while (Date.now() < end) {
    if (fs.existsSync(marker)) return JSON.parse(fs.readFileSync(marker, "utf8"))
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error("background distiller did not run")
}

function log() {
  const file = path.join(stateDir, "capture.log")
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-rembr-hook-"))
  stateDir = path.join(root, "state")
  pluginRoot = path.join(root, "plugin")
  marker = path.join(root, "marker.json")
  fs.mkdirSync(path.join(pluginRoot, "plugin-dist"), { recursive: true })
  fs.writeFileSync(path.join(pluginRoot, "plugin-dist", "distill-cli.js"), STUB)
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe("codex Stop/PreCompact hook", () => {
  it("returns continue without work when capture is disabled, stdin is empty, or the transcript is missing", () => {
    for (const [input, env] of [
      [{ hook_event_name: "Stop", transcript_path: "x" }, { REMBR_CAPTURE_DISABLE: "1" }],
      ["", {}],
      [{ hook_event_name: "Stop", transcript_path: path.join(root, "missing.jsonl") }, {}],
    ]) {
      const result = runHook(input, env)
      expect(result.status).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({ continue: true })
    }
    expect(log()).toContain("hook received empty stdin")
    expect(log()).toContain("Stop hook missing readable transcript_path")
    expect(fs.existsSync(marker)).toBe(false)
  })

  it("debounces a short Stop transcript before starting cooldown", () => {
    const transcript = writeTranscript(5)
    const result = runHook({ hook_event_name: "Stop", transcript_path: transcript })
    expect(JSON.parse(result.stdout)).toEqual({ continue: true })
    expect(log()).toContain(`Stop hook debounce preflight: 5 new records < 10, session ${SESSION_ID}`)
    expect(fs.existsSync(path.join(stateDir, "codex-distill-cooldown"))).toBe(false)
  })

  it("forces PreCompact in the background, then cools down a following Stop", async () => {
    const transcript = writeTranscript(2)
    const result = runHook({ hook_event_name: "PreCompact", transcript_path: transcript })
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ continue: true })
    expect(fs.existsSync(marker)).toBe(false)

    const hash = createHash("sha256").update(transcript, "utf8").digest("hex")
    expect(fs.existsSync(path.join(stateDir, "codex-distill-cooldown", hash))).toBe(true)

    const invocation = await waitForMarker()
    expect(invocation.argv).toEqual([transcript])
    expect(invocation.minRecords).toBe("1")
    expect(fs.realpathSync(invocation.cwd)).toBe(fs.realpathSync(pluginRoot))

    const second = runHook({ hook_event_name: "Stop", transcript_path: transcript }, { REMBR_DISTILL_MIN_RECORDS: "1" })
    expect(JSON.parse(second.stdout)).toEqual({ continue: true })
    expect(log()).toContain("PreCompact hook forced background distiller: min_records=1")
    expect(log()).toContain("Stop hook skipped by cooldown")

    // Let the background stage finish logging before the temp dir is removed.
    const end = Date.now() + 5_000
    while (!log().includes("PreCompact distiller completed") && Date.now() < end) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(log()).toContain(`PreCompact distiller completed: ${transcript}`)
  })

  it("releases the cooldown when the background distiller fails, so a retry can start", async () => {
    const transcript = writeTranscript(12)
    const hash = createHash("sha256").update(transcript, "utf8").digest("hex")
    const cooldownFile = path.join(stateDir, "codex-distill-cooldown", hash)
    const result = runHook({ hook_event_name: "Stop", transcript_path: transcript }, { STUB_FAIL: "1" })
    expect(JSON.parse(result.stdout)).toEqual({ continue: true })
    expect(fs.existsSync(cooldownFile)).toBe(true)

    const end = Date.now() + 8_000
    while (!log().includes("distiller exited 1") && Date.now() < end) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(log()).toContain("Stop distiller exited 1")
    expect(fs.existsSync(cooldownFile)).toBe(false)
  })
})
