import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { loadBridgeConfig } from "./bridge-config.js"
import { distillTranscript, loadDistillConfig, logLine, retryAfterSeconds, type DistillConfig } from "./distill.js"

export interface WatchConfig {
  sessionsDir: string
  pollMs: number
  idleMs: number
}

export interface SessionFile {
  path: string
  mtimeMs: number
}

export function loadWatchConfig(env: Record<string, string | undefined> = process.env): WatchConfig {
  return {
    sessionsDir: env.CODEX_SESSIONS_DIR || path.join(os.homedir(), ".codex", "sessions"),
    pollMs: Number(env.REMBR_CODEX_WATCH_POLL_MS) || 10_000,
    idleMs: Number(env.REMBR_CODEX_WATCH_IDLE_MS) || 30_000,
  }
}

export function listSessionFiles(root: string): SessionFile[] {
  const out: SessionFile[] = []
  function walk(dir: string): void {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          out.push({ path: full, mtimeMs: fs.statSync(full).mtimeMs })
        } catch {
          // file may have rotated between readdir and stat
        }
      }
    }
  }
  walk(root)
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

export function idleSessionFiles(files: SessionFile[], nowMs: number, idleMs: number): SessionFile[] {
  return files.filter((file) => nowMs - file.mtimeMs >= idleMs)
}

export async function runWatchOnce(
  watchConfig: WatchConfig,
  distillConfig: DistillConfig,
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  if (!distillConfig.enabled || env.REMBR_CAPTURE_DISABLE) return 0
  const rembrConfig = loadBridgeConfig(env)
  const files = idleSessionFiles(listSessionFiles(watchConfig.sessionsDir), Date.now(), watchConfig.idleMs)
  let processed = 0
  for (const file of files) {
    await distillTranscript(distillConfig, rembrConfig, file.path)
    processed++
  }
  return processed
}

export async function runWatchCli(args: string[], env: Record<string, string | undefined> = process.env): Promise<number> {
  const once = args.includes("--once")
  const watchConfig = loadWatchConfig(env)
  const distillConfig = loadDistillConfig(env)
  if (!distillConfig.enabled || env.REMBR_CAPTURE_DISABLE) return 0

  if (once) {
    await runWatchOnce(watchConfig, distillConfig, env)
    return 0
  }

  console.error(
    `codex-rembr-watch: watching ${watchConfig.sessionsDir} every ${watchConfig.pollMs}ms, idle ${watchConfig.idleMs}ms`,
  )
  for (;;) {
    let sleepMs = watchConfig.pollMs
    try {
      const processed = await runWatchOnce(watchConfig, distillConfig, env)
      if (processed) logLine(distillConfig, `watch pass processed ${processed} idle session file(s)`)
    } catch (error) {
      const retryAfter = retryAfterSeconds(error)
      if (retryAfter !== null) {
        sleepMs = Math.max(watchConfig.pollMs, retryAfter * 1000)
        logLine(distillConfig, `watch paused after rate limit for ${Math.round(sleepMs / 1000)}s`)
      }
      logLine(distillConfig, `watch pass failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    await new Promise((resolve) => setTimeout(resolve, sleepMs))
  }
}
