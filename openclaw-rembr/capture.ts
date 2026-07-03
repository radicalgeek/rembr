// memory-rembr capture heuristics: which user text is worth persisting, and
// hygiene checks so memory can't be used as a prompt-injection channel.

import { type RembrCategory } from "./config.js"

const BUILTIN_TRIGGERS = [
  "remember",
  "don't forget",
  "dont forget",
  "my name is",
  "call me",
  "i prefer",
  "i like",
  "i love",
  "i hate",
  "i always",
  "i never",
  "i usually",
  "save this",
  "note that",
  "for future reference",
  "going forward",
  "from now on",
]

const INJECTION_PATTERNS = [
  /ignore (all|any|previous|prior|the) .{0,40}(instructions|context|rules)/i,
  /disregard .{0,40}(instructions|context|rules)/i,
  /forget (everything|all|your) .{0,40}(instructions|rules)/i,
  /you (are|must|should) now (act|behave|respond|pretend)/i,
  /new (system )?instructions\s*:/i,
  /system prompt/i,
  /<\/?(system|assistant|instructions?)>/i,
  /\[(system|assistant)\]/i,
]

/** True when text looks like prompt instructions rather than a durable fact. */
export function looksLikePromptInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((pattern) => pattern.test(text))
}

export interface ShouldCaptureOptions {
  customTriggers?: string[]
  maxChars: number
}

/** True when a user message looks memory-worthy for auto-capture. */
export function shouldCapture(text: string, options: ShouldCaptureOptions): boolean {
  const trimmed = text.trim()
  if (trimmed.length < 8 || trimmed.length > options.maxChars) return false
  if (looksLikePromptInjection(trimmed)) return false
  const lower = trimmed.toLowerCase()
  const triggers = options.customTriggers
    ? [...BUILTIN_TRIGGERS, ...options.customTriggers]
    : BUILTIN_TRIGGERS
  return triggers.some((trigger) => lower.includes(trigger))
}

/** Best-effort category detection for auto-captured text. */
export function detectCategory(text: string, fallback: RembrCategory): RembrCategory {
  const lower = text.toLowerCase()
  if (/(i prefer|i like|i love|i hate|i always|i never|i usually|call me|my name is)/.test(lower)) {
    return "preferences"
  }
  if (/(decided|decision|we chose|we agreed|let's go with|going with)/.test(lower)) {
    return "decisions"
  }
  if (/(remind me|reminder|due (on|by)|deadline)/.test(lower)) {
    return "reminders"
  }
  if (/(goal|objective|we want to|aiming (for|to))/.test(lower)) {
    return "goals"
  }
  return fallback
}

/**
 * Extract user-authored text from an opaque session message. Message shapes
 * vary by runtime, so this is defensive: it accepts `content` as a string or
 * as an array of `{ type: "text", text }` parts, and only for role "user".
 */
export function extractUserTextContent(message: unknown): string[] {
  if (!message || typeof message !== "object") return []
  const msg = message as { role?: unknown; content?: unknown }
  if (msg.role !== "user") return []
  if (typeof msg.content === "string") return msg.content.trim() ? [msg.content] : []
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter(
        (part): part is { type: string; text: string } =>
          !!part &&
          typeof part === "object" &&
          (part as { type?: unknown }).type === "text" &&
          typeof (part as { text?: unknown }).text === "string" &&
          !!(part as { text: string }).text.trim(),
      )
      .map((part) => part.text)
  }
  return []
}

/** Truncate text to a budget, marking the cut. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}
