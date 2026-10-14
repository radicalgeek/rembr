/**
 * Session distillation for opencode-rembr.
 *
 * On session.idle, reads the messages added since the per-session cursor,
 * builds a compact digest, and asks the SAME opencode server (a throwaway
 * side session created via the SDK — no subprocess) to extract durable
 * memories, which are then stored in Rembr.
 *
 * Every entry point is fail-silent: a failed pass logs one line to the
 * capture log and returns without advancing the cursor, so the same
 * messages are retried on the next idle. The cursor advances ONLY after a
 * fully successful pass.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { MEMORY_CATEGORIES } from "./config.js"

// Over this many chars the digest keeps 60% head / 30% tail — the start
// (task framing) and end (conclusions) of a session distill better than
// the middle.
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

Never capture iterative implementation chatter, test prompts or results, troubleshooting progress, temporary validation observations, proposed-but-unconfirmed behavior, repeated reformulations of the same conclusion, or commentary about the memory system itself. Do not store a preference or decision merely because it was stated during a transient debugging exchange. Capture it only when it is clearly intended to govern future work after the session ends. Later verified outcomes override earlier checkpoints: never describe a completed validation or prerequisite as still pending, and never invent an unmet gate that is not explicit in the final session state.

Never recapture recalled or injected memory content as a new conclusion. Do not repeat credentials, identifiers, endpoints, mailbox addresses, or other sensitive configuration merely surfaced from historical context.

Each memory must be ONE self-contained statement understandable without the session. Prefer the single strongest non-overlapping conclusion; do not emit multiple memories that cover the same outcome. Category must exactly match one of these pluralized values: ${MEMORY_CATEGORIES.join(", ")}. An empty memories array is a valid and common answer.

Reply with ONLY a JSON object of the shape {"memories": [{"content": "...", "category": "...", "tags": ["..."]}]} and nothing else.

Session digest:
`

export interface DistillConfig {
  enabled: boolean
  /** "provider/model" for the distiller session; empty = server default. */
  model: string
  minNewMessages: number
  timeoutMs: number
  /** Directory substrings that must never be distilled. */
  excludeDirs: string[]
  stateDir: string
  logFile: string
}

export function loadDistillConfig(
  env: Record<string, string | undefined> = process.env,
  modelOverride = "",
): DistillConfig {
  const stateDir = env.REMBR_STATE_DIR || path.join(os.homedir(), ".rembr")
  return {
    enabled: !["false", "0", "no", "off"].includes(String(env.REMBR_DISTILL ?? "true").toLowerCase()),
    model: modelOverride || env.REMBR_DISTILL_MODEL || "",
    minNewMessages: Number(env.REMBR_DISTILL_MIN_MESSAGES) || 10,
    timeoutMs: Number(env.REMBR_DISTILL_TIMEOUT_MS) || 120_000,
    excludeDirs: (env.REMBR_CAPTURE_EXCLUDE || "")
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
    fs.appendFileSync(config.logFile, `${stamp} distill(opencode) ${msg}\n`)
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

/**
 * Loose shape of a message returned by client.session.messages() (v1). The v2
 * adapter converts its messages to this shape and sets `cursor`.
 */
export interface SessionMessage {
  info?: { role?: string }
  /** Monotonic distillation cursor value; defaults to the 1-based position. */
  cursor?: number
  parts?: Array<{
    type?: string
    text?: string
    synthetic?: boolean
    tool?: string
    state?: { input?: unknown; output?: unknown; status?: string }
  }>
}

function summarizeValue(value: unknown, max: number): string {
  let s: string
  try {
    s = typeof value === "string" ? value : JSON.stringify(value)
  } catch {
    s = String(value)
  }
  return (s ?? "").replace(/\s+/g, " ").trim().slice(0, max)
}

/**
 * Digest lines from opencode session messages. Text parts are kept whole
 * (minus <private> spans); tool parts are summarized (200-char input,
 * 300-char output). Synthetic parts (our own recall injection) and
 * reasoning parts are skipped.
 */
export function extractLines(messages: SessionMessage[]): string[] {
  const lines: string[] = []
  for (const message of messages) {
    const role = message.info?.role === "assistant" ? "ASSISTANT" : "USER"
    for (const part of message.parts ?? []) {
      if (part.synthetic) continue
      if (part.type === "text" && typeof part.text === "string") {
        const text = stripPrivate(part.text).trim()
        if (text) lines.push(`${role}: ${text}`)
      } else if (part.type === "tool") {
        const input = summarizeValue(part.state?.input, 200)
        lines.push(`TOOL CALL ${part.tool ?? "?"}: ${input}`)
        const output = stripPrivate(summarizeValue(part.state?.output, 300))
        if (output) lines.push(`TOOL RESULT: ${output}`)
      }
      // reasoning/file/agent parts deliberately skipped
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

export interface DistilledMemory {
  content: string
  category: string
  tags?: string[]
}

/** Parse the distiller's reply into a memories array, or null when unusable. */
export function parseDistillerOutput(text: unknown): DistilledMemory[] | null {
  if (typeof text !== "string") return null
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
      m.content.trim() &&
      (MEMORY_CATEGORIES as readonly string[]).includes(m.category),
  )
  return valid.length === memories.length ? valid : null
}

/**
 * Cursor files are namespaced per host: v1 stores a message count, v2 stores
 * a message timestamp, so the two must never share a file.
 */
function cursorFile(config: DistillConfig, sessionID: string, namespace: string): string {
  return path.join(config.stateDir, "cursors", `${namespace}-${sessionID.replace(/[^\w.-]/g, "_")}`)
}

export function readCursor(config: DistillConfig, sessionID: string, namespace = "opencode"): number {
  try {
    const n = parseInt(fs.readFileSync(cursorFile(config, sessionID, namespace), "utf8").trim(), 10)
    return Number.isFinite(n) && n >= 0 ? n : 0
  } catch {
    return 0
  }
}

export function writeCursor(
  config: DistillConfig,
  sessionID: string,
  value: number,
  namespace = "opencode",
): boolean {
  try {
    const file = cursorFile(config, sessionID, namespace)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, String(value))
    return true
  } catch (err) {
    logLine(config, `cursor write failed: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

/** Split "provider/model" into the SDK's model reference, or undefined. */
export function parseModelRef(model: string): { providerID: string; modelID: string } | undefined {
  const slash = model.indexOf("/")
  if (slash <= 0 || slash === model.length - 1) return undefined
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) }
}
