/**
 * Session distillation for Codex JSONL transcripts.
 *
 * This module mirrors the Claude Code distiller: read new transcript records
 * since the cursor, build a compact digest, ask the same harness headlessly to
 * extract durable memories, then store them in Rembr. It can be run explicitly,
 * by a Codex Stop hook, or by the fallback watcher.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { REMBR_CATEGORIES, loadBridgeConfig, type BridgeConfig } from "./bridge-config.js"
import { RembrClient, RembrError } from "./rembr-client.js"

export const DIGEST_CAP = 24_000

const SECRET_PATTERNS = [
  /AKIA[0-9A-Z]{16}/,
  /(bearer|token|api[_-]?key|password|secret)\s*[=:]\s*\S+/i,
  /-----BEGIN\s+[A-Z ]*PRIVATE KEY-----/,
  /\b(mb_live_|sk-)[A-Za-z0-9_-]{8,}/,
  /ghp_[A-Za-z0-9]{20,}/,
]

export const OBSERVER_PROMPT = `You are an observer creating searchable long-term memory for future AI sessions. You are NOT the one doing the work described below.

Read the session digest and extract ONLY durable conclusions worth recalling weeks later: final decisions, root causes, verified fixes, lasting preferences, and stable project facts. Be selective: an empty memories array is preferred over low-value capture.

Never capture iterative implementation chatter, test prompts or results, troubleshooting progress, temporary validation observations, proposed-but-unconfirmed behavior, repeated reformulations, or commentary about the memory system itself. Never recapture recalled or injected memory content as a new conclusion. Do not repeat credentials, identifiers, endpoints, mailbox addresses, or other sensitive configuration merely surfaced from historical context.

Each memory must be ONE self-contained statement understandable without the session. Prefer the single strongest non-overlapping conclusion. Category must exactly match one of these pluralized values: ${REMBR_CATEGORIES.join(", ")}. An empty memories array is a valid and common answer.

Reply with ONLY a JSON object of the shape {"memories": [{"content": "...", "category": "...", "tags": ["..."]}]} and nothing else.

Session digest:
`

export interface DistillConfig {
  enabled: boolean
  model: string
  minNewRecords: number
  timeoutMs: number
  excludeCwd: string[]
  stateDir: string
  logFile: string
}

export interface CodexRecord {
  type?: string
  payload?: CodexPayload
}

interface CodexPayload {
  type?: string
  role?: string
  name?: string
  arguments?: string
  output?: string
  content?: Array<{ type?: string; text?: string }>
}

export interface DistilledMemory {
  content: string
  category: string
  tags?: string[]
}

export function retryAfterSeconds(error: unknown): number | null {
  if (!(error instanceof RembrError) || error.status !== 429) return null
  const match = error.message.match(/"retry_after"\s*:\s*(\d+)/)
  return match ? Number(match[1]) : 60
}

export function resumeCursor(cursor: number, totalLines: number): number {
  return cursor > totalLines ? 0 : cursor
}

export function loadDistillConfig(env: Record<string, string | undefined> = process.env): DistillConfig {
  const stateDir = env.REMBR_STATE_DIR || path.join(os.homedir(), ".rembr")
  return {
    enabled: !["false", "0", "no", "off"].includes(String(env.REMBR_DISTILL ?? "true").toLowerCase()),
    model: env.REMBR_DISTILL_MODEL || "",
    minNewRecords: Number(env.REMBR_DISTILL_MIN_RECORDS) || 10,
    timeoutMs: Number(env.REMBR_DISTILL_TIMEOUT_MS) || 120_000,
    excludeCwd: (env.REMBR_CAPTURE_EXCLUDE || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    stateDir,
    logFile: env.REMBR_LOG || path.join(stateDir, "capture.log"),
  }
}

export function logLine(config: DistillConfig, msg: string): void {
  try {
    fs.mkdirSync(config.stateDir, { recursive: true })
    const stamp = new Date().toISOString().replace("T", " ").slice(0, 19)
    fs.appendFileSync(config.logFile, `${stamp} distill(codex) ${msg}\n`)
  } catch {
    // fail-silent
  }
}

export function stripPrivate(text: string): string {
  return text.replace(/<private>[\s\S]*?<\/private>/gi, "")
}

export function looksLikeSecret(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text))
}

function compact(text: string, max: number): string {
  return stripPrivate(text).replace(/\s+/g, " ").trim().slice(0, max)
}

function textContent(content: CodexPayload["content"]): string {
  return (content ?? [])
    .filter((part) => ["input_text", "output_text"].includes(part.type ?? "") && typeof part.text === "string")
    .map((part) => part.text)
    .map((text) => stripPrivate(text ?? ""))
    .join("\n")
}

export function extractSessionId(records: CodexRecord[], fallback: string): string {
  for (const record of records) {
    const payload = record.payload as { session_id?: unknown; id?: unknown } | undefined
    const id = payload?.session_id ?? payload?.id
    if (typeof id === "string" && id.trim()) return id
  }
  return path.basename(fallback).replace(/\.jsonl$/i, "")
}

export function extractCwd(records: CodexRecord[]): string {
  for (const record of records) {
    const payload = record.payload as { cwd?: unknown } | undefined
    if (typeof payload?.cwd === "string") return payload.cwd
  }
  return ""
}

export function extractLines(records: CodexRecord[]): string[] {
  const lines: string[] = []
  for (const record of records) {
    if (record.type !== "response_item") continue
    const payload = record.payload
    if (payload?.type === "message" && ["user", "assistant"].includes(payload.role ?? "")) {
      const text = textContent(payload.content).trim()
      if (text) lines.push(`${payload.role === "assistant" ? "ASSISTANT" : "USER"}: ${text}`)
    } else if (payload?.type === "function_call") {
      lines.push(`TOOL CALL ${payload.name ?? "?"}: ${compact(payload.arguments ?? "", 200)}`)
    } else if (payload?.type === "function_call_output") {
      const output = compact(payload.output ?? "", 300)
      if (output) lines.push(`TOOL RESULT: ${output}`)
    }
  }
  return lines
}

export function buildDigest(lines: string[]): string {
  const digest = lines.join("\n")
  if (digest.length <= DIGEST_CAP) return digest
  const head = Math.floor(DIGEST_CAP * 0.6)
  const tail = Math.floor(DIGEST_CAP * 0.3)
  return `${digest.slice(0, head)}\n[... middle of session truncated ...]\n${digest.slice(-tail)}`
}

export function parseDistillerOutput(text: unknown): DistilledMemory[] | null {
  if (typeof text !== "string") return null
  const candidates = distillerJsonCandidates(text)
  for (const candidate of candidates) {
    const memories = parseMemoryJson(candidate)
    if (memories !== null) return memories
  }
  return null
}

function distillerJsonCandidates(text: string): string[] {
  const candidates = [text]
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const event = JSON.parse(trimmed) as {
        item?: { type?: string; text?: unknown }
        text?: unknown
      }
      const eventText = event.item?.type === "agent_message" ? event.item.text : event.text
      if (typeof eventText === "string") candidates.push(eventText)
    } catch {
      // Non-JSON lines are not Codex JSON events.
    }
  }
  return candidates
}

function parseMemoryJson(text: string): DistilledMemory[] | null {
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim()
  let payload: unknown
  try {
    payload = JSON.parse(cleaned)
  } catch {
    return null
  }
  const memories = (payload as { memories?: unknown })?.memories
  if (!Array.isArray(memories)) return null
  const valid = memories.filter(
    (m): m is DistilledMemory =>
      !!m &&
      typeof m.content === "string" &&
      m.content.trim().length > 0 &&
      (REMBR_CATEGORIES as readonly string[]).includes(m.category),
  )
  return valid.length === memories.length ? valid : null
}

function cursorFile(config: DistillConfig, sessionId: string): string {
  return path.join(config.stateDir, "cursors", `codex-${sessionId.replace(/[^\w.-]/g, "_")}`)
}

export function readCursor(config: DistillConfig, sessionId: string): number {
  try {
    const n = parseInt(fs.readFileSync(cursorFile(config, sessionId), "utf8").trim(), 10)
    return Number.isFinite(n) && n >= 0 ? n : 0
  } catch {
    return 0
  }
}

export function writeCursor(config: DistillConfig, sessionId: string, value: number): boolean {
  try {
    const file = cursorFile(config, sessionId)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, String(value))
    return true
  } catch (error) {
    logLine(config, `cursor write failed: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

export function runDistiller(config: DistillConfig, digest: string): Promise<DistilledMemory[] | null> {
  return new Promise((resolve) => {
    // --skip-git-repo-check: the distiller runs from arbitrary directories.
    // --ephemeral: do not persist a rollout for the throwaway distillation session.
    const args = ["exec", "--json", "--skip-git-repo-check", "--ephemeral"]
    if (config.model) args.push("--model", config.model)
    const child = spawn("codex", args, {
      shell: process.platform === "win32",
      env: { ...process.env, REMBR_CAPTURE_DISABLE: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    let settled = false
    const finish = (value: DistilledMemory[] | null, note?: string) => {
      if (settled) return
      settled = true
      if (note) logLine(config, note)
      resolve(value)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(null, `distiller timed out after ${config.timeoutMs}ms`)
    }, config.timeoutMs)
    child.on("error", (error) => {
      clearTimeout(timer)
      finish(null, `distiller spawn failed: ${error.message}`)
    })
    child.stdout.on("data", (data) => (stdout += data))
    child.stderr.on("data", (data) => (stderr += data))
    child.on("close", (code) => {
      clearTimeout(timer)
      if (code !== 0) return finish(null, `distiller exited ${code}: ${stderr.trim().slice(0, 300)}`)
      const memories = parseDistillerOutput(stdout)
      if (memories === null) {
        return finish(null, `distiller result unusable: ${stdout.trim().slice(0, 200)}`)
      }
      finish(memories)
    })
    child.stdin.on("error", () => {})
    child.stdin.end(OBSERVER_PROMPT + digest)
  })
}

export async function distillTranscript(
  config: DistillConfig,
  rembrConfig: BridgeConfig,
  transcriptPath: string,
  client = new RembrClient({ url: rembrConfig.url, apiKey: rembrConfig.apiKey, timeoutMs: rembrConfig.timeoutMs }),
): Promise<boolean> {
  let raw: string
  try {
    raw = fs.readFileSync(transcriptPath, "utf8")
  } catch {
    logLine(config, `transcript not readable: ${transcriptPath}`)
    return false
  }
  const allLines = raw.split("\n")
  const totalLines = allLines.length - (allLines.at(-1) === "" ? 1 : 0)
  const allRecords = allLines
    .slice(0, totalLines)
    .map((line) => {
      try {
        return JSON.parse(line) as CodexRecord
      } catch {
        return undefined
      }
    })
    .filter((record): record is CodexRecord => !!record)
  const sessionId = extractSessionId(allRecords, transcriptPath)
  const cwd = extractCwd(allRecords)
  if (config.excludeCwd.some((marker) => cwd.includes(marker))) {
    logLine(config, `excluded cwd, skipping session ${sessionId}`)
    return true
  }

  const storedCursor = readCursor(config, sessionId)
  const cursor = resumeCursor(storedCursor, totalLines)
  if (cursor !== storedCursor) {
    logLine(config, `transcript shrank from cursor ${storedCursor} to ${totalLines} lines; restarting session ${sessionId}`)
  }
  const records = allLines
    .slice(cursor, totalLines)
    .map((line) => {
      try {
        return JSON.parse(line) as CodexRecord
      } catch {
        return undefined
      }
    })
    .filter((record): record is CodexRecord => !!record)
  if (!records.length) return true
  if (records.length < config.minNewRecords) {
    logLine(config, `debounce: ${records.length} new records < ${config.minNewRecords}, session ${sessionId}`)
    return true
  }

  const lines = extractLines(records)
  if (!lines.length) {
    logLine(config, `no distillable content in ${records.length} new records, session ${sessionId}`)
    return true
  }

  const memories = await runDistiller(config, buildDigest(lines))
  if (memories === null) return false

  let failed = false
  for (const memory of memories) {
    if (looksLikeSecret(memory.content)) {
      logLine(config, `skipped-secret-shape: ${memory.content.slice(0, 80)}`)
      continue
    }
    try {
      await client.remember(memory.content, memory.category, {
        source: "codex-rembr",
        distilled: true,
        session_id: sessionId,
        ...(cwd ? { directory: cwd } : {}),
        tags: memory.tags ?? [],
      })
      logLine(config, `stored: ${memory.content.slice(0, 120)}`)
    } catch (error) {
      const retryAfter = retryAfterSeconds(error)
      if (retryAfter !== null) {
        logLine(config, `rate limited, aborting watcher pass; retry_after=${retryAfter}s`)
        throw error
      }
      failed = true
      logLine(config, `store failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (failed) {
    logLine(config, `partial failure, cursor kept at ${cursor}, session ${sessionId}`)
    return false
  }
  if (!memories.length) logLine(config, `nothing durable this pass, session ${sessionId}`)
  if (writeCursor(config, sessionId, totalLines)) {
    logLine(config, `cursor ${cursor} -> ${totalLines}, session ${sessionId}`)
  }
  return true
}

export async function runDistillCli(args: string[], env: Record<string, string | undefined> = process.env): Promise<number> {
  if (env.REMBR_CAPTURE_DISABLE) return 0
  const transcriptPath = args[0]
  if (!transcriptPath) {
    console.error("codex-rembr-distill: usage: codex-rembr-distill <codex-session.jsonl>")
    return 2
  }
  const config = loadDistillConfig(env)
  if (!config.enabled) return 0
  const rembrConfig = loadBridgeConfig(env)
  // A non-zero exit lets the Stop hook release its cooldown so a failed run can be retried.
  return (await distillTranscript(config, rembrConfig, transcriptPath)) ? 0 : 1
}
