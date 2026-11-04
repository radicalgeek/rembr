#!/usr/bin/env node
// Codex Stop / PreCompact hook. Schedules the bundled distiller in a detached
// background process so the hook returns immediately. Node built-ins only:
// hooks/ is not bundled and the installed plugin has no node_modules.
import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const SESSION_ID_PATTERN = /([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i

const stateDir = process.env.REMBR_STATE_DIR || path.join(os.homedir(), ".rembr")
const logPath = process.env.REMBR_LOG || path.join(stateDir, "capture.log")

function stamp() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, "0")
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
}

function addLog(prefix, message) {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
    fs.appendFileSync(logPath, `${stamp()} ${prefix} ${message}\n`)
  } catch {
    // Hook logging must never block Codex.
  }
}

function writeHookResult() {
  process.stdout.write(`${JSON.stringify({ continue: true })}\n`)
}

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8")
  } catch {
    return ""
  }
}

function countLines(file) {
  // Same record count the distiller uses for its cursor.
  const lines = fs.readFileSync(file, "utf8").split("\n")
  return lines.length - (lines.at(-1) === "" ? 1 : 0)
}

function parseIntStrict(value, name) {
  const text = String(value).trim()
  if (!/^[+-]?\d+$/.test(text)) throw new Error(`${name} is not an integer: ${text}`)
  return Number.parseInt(text, 10)
}

function cooldownFilePath(transcriptPath) {
  const hash = createHash("sha256").update(transcriptPath, "utf8").digest("hex")
  return path.join(stateDir, "codex-distill-cooldown", hash)
}

function releaseCooldown(transcriptPath) {
  try {
    fs.unlinkSync(cooldownFilePath(transcriptPath))
  } catch {
    // Already gone.
  }
}

function runForeground() {
  if (process.env.REMBR_CAPTURE_DISABLE) return

  try {
    const stdin = readStdin()
    if (!stdin.trim()) {
      addLog("codex-hook", "hook received empty stdin")
      return
    }

    const event = JSON.parse(stdin)
    const eventName = String(event.hook_event_name ?? "")
    const isForce = eventName === "PreCompact"
    const transcriptPath = String(event.transcript_path ?? "")
    if (!transcriptPath.trim() || !fs.existsSync(transcriptPath)) {
      addLog("codex-hook", `${eventName} hook missing readable transcript_path`)
      return
    }

    const pluginRoot = process.env.PLUGIN_ROOT?.trim() ? process.env.PLUGIN_ROOT : path.dirname(path.dirname(SCRIPT_PATH))
    const distiller = path.join(pluginRoot, "plugin-dist", "distill-cli.js")
    if (!fs.existsSync(distiller)) {
      addLog("codex-hook", `distiller not found: ${distiller}`)
      return
    }

    let minRecords = process.env.REMBR_DISTILL_MIN_RECORDS
    if (isForce) minRecords = "1"
    else if (!minRecords) minRecords = "10" // same default as the distiller (src/distill.ts)

    // Do not start cooldown for a transcript that the distiller will debounce.
    if (!isForce) {
      const fileName = path.basename(transcriptPath, path.extname(transcriptPath))
      const sessionMatch = SESSION_ID_PATTERN.exec(fileName)
      if (sessionMatch) {
        const sessionId = sessionMatch[1]
        const totalRecords = countLines(transcriptPath)
        const cursorPath = path.join(stateDir, "cursors", `codex-${sessionId}`)
        let cursor = 0
        if (fs.existsSync(cursorPath)) {
          const raw = fs.readFileSync(cursorPath, "utf8").trim()
          if (/^[+-]?\d+$/.test(raw)) {
            const parsedCursor = Number.parseInt(raw, 10)
            cursor = parsedCursor <= totalRecords ? parsedCursor : 0
          }
        }
        const newRecords = totalRecords - cursor
        if (newRecords < parseIntStrict(minRecords, "REMBR_DISTILL_MIN_RECORDS")) {
          addLog("codex-hook", `Stop hook debounce preflight: ${newRecords} new records < ${minRecords}, session ${sessionId}`)
          return
        }
      }
    }

    const cooldownSeconds = process.env.REMBR_DISTILL_COOLDOWN_SECONDS
      ? parseIntStrict(process.env.REMBR_DISTILL_COOLDOWN_SECONDS, "REMBR_DISTILL_COOLDOWN_SECONDS")
      : 900
    const cooldownFile = cooldownFilePath(transcriptPath)
    const cooldownDir = path.dirname(cooldownFile)
    if (!isForce && fs.existsSync(cooldownFile)) {
      const age = (Date.now() - fs.statSync(cooldownFile).mtimeMs) / 1000
      if (age < cooldownSeconds) {
        addLog("codex-hook", `Stop hook skipped by cooldown: age=${Math.trunc(age)}s threshold=${cooldownSeconds}s transcript=${transcriptPath}`)
        return
      }
    }

    // The marker doubles as an in-flight guard. The background child releases it
    // when distillation fails, so only a successful run starts the cooldown.
    fs.mkdirSync(cooldownDir, { recursive: true })
    fs.writeFileSync(cooldownFile, new Date().toISOString(), "ascii")

    // stdio must be "ignore": a detached child holding the hook's stdout pipe
    // would keep Codex waiting for EOF until the hook timeout.
    const child = spawn(process.execPath, [SCRIPT_PATH, "--background", eventName || "unknown", transcriptPath, pluginRoot], {
      cwd: pluginRoot,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, REMBR_DISTILL_MIN_RECORDS: minRecords, REMBR_LOG: logPath },
    })
    child.unref()
    const mode = isForce ? "forced" : "scheduled"
    addLog("codex-hook", `${eventName} hook ${mode} background distiller: min_records=${minRecords} cooldown=${cooldownSeconds}s transcript=${transcriptPath}`)
  } catch (error) {
    addLog("codex-hook", `hook failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function runBackground([eventName, transcriptPath, pluginRoot]) {
  try {
    const distiller = path.join(pluginRoot, "plugin-dist", "distill-cli.js")
    addLog("codex-hook-bg", `${eventName} distiller started: min_records=${process.env.REMBR_DISTILL_MIN_RECORDS} transcript=${transcriptPath}`)
    const result = spawnSync(process.execPath, [distiller, transcriptPath], {
      cwd: pluginRoot,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    })
    if (result.error) {
      releaseCooldown(transcriptPath)
      throw result.error
    }
    if (result.status !== 0) {
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`
      const msg = output.split(/\r?\n/).filter(Boolean).join(" ").slice(0, 300)
      releaseCooldown(transcriptPath)
      addLog("codex-hook-bg", `${eventName} distiller exited ${result.status ?? result.signal}: ${msg}`)
    } else {
      addLog("codex-hook-bg", `${eventName} distiller completed: ${transcriptPath}`)
    }
  } catch (error) {
    releaseCooldown(transcriptPath)
    addLog("codex-hook-bg", `${eventName} distiller failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

if (process.argv[2] === "--background") {
  runBackground(process.argv.slice(3))
} else {
  runForeground()
  writeHookResult()
}
