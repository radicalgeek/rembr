import { describe, it, expect } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  DIGEST_CAP,
  buildDigest,
  extractLines,
  loadDistillConfig,
  looksLikeSecret,
  parseDistillerOutput,
  parseModelRef,
  readCursor,
  stripPrivate,
  OBSERVER_PROMPT,
  writeCursor,
  type SessionMessage,
} from "./distill.js"

describe("loadDistillConfig", () => {
  it("returns defaults for an empty environment", () => {
    const config = loadDistillConfig({})
    expect(config.enabled).toBe(true)
    expect(config.model).toBe("")
    expect(config.minNewMessages).toBe(10)
    expect(config.timeoutMs).toBe(120_000)
    expect(config.excludeDirs).toEqual([])
  })

  it("honours REMBR_DISTILL=false and overrides", () => {
    const config = loadDistillConfig({
      REMBR_DISTILL: "false",
      REMBR_DISTILL_MODEL: "anthropic/claude-haiku-4-5",
      REMBR_DISTILL_MIN_MESSAGES: "3",
      REMBR_DISTILL_TIMEOUT_MS: "5000",
      REMBR_CAPTURE_EXCLUDE: "secret-client, other",
    })
    expect(config.enabled).toBe(false)
    expect(config.model).toBe("anthropic/claude-haiku-4-5")
    expect(config.minNewMessages).toBe(3)
    expect(config.timeoutMs).toBe(5000)
    expect(config.excludeDirs).toEqual(["secret-client", "other"])
  })

  it("prefers an inline model override", () => {
    const config = loadDistillConfig(
      { REMBR_DISTILL_MODEL: "anthropic/claude-haiku-4-5" },
      "fixture-provider/fixture-model",
    )
    expect(config.model).toBe("fixture-provider/fixture-model")
  })
})

describe("extractLines", () => {
  const messages: SessionMessage[] = [
    {
      info: { role: "user" },
      parts: [{ type: "text", text: "Investigate the 502s <private>on client X</private> please" }],
    },
    {
      info: { role: "assistant" },
      parts: [
        { type: "text", text: "Checking the proxy config." },
        { type: "tool", tool: "read", state: { input: { path: "/etc/nginx.conf" }, output: "proxy_read_timeout 5s;" } },
        { type: "reasoning" as const, text: "thinking about it" },
      ],
    },
    {
      info: { role: "assistant" },
      parts: [{ type: "text", text: "injected", synthetic: true }],
    },
  ]

  it("extracts user/assistant text and summarized tool parts", () => {
    const lines = extractLines(messages)
    expect(lines[0]).toBe("USER: Investigate the 502s  please")
    expect(lines[1]).toBe("ASSISTANT: Checking the proxy config.")
    expect(lines[2]).toContain("TOOL CALL read:")
    expect(lines[3]).toContain("TOOL RESULT: proxy_read_timeout 5s;")
  })

  it("skips synthetic and reasoning parts", () => {
    const lines = extractLines(messages)
    expect(lines.join("\n")).not.toContain("injected")
    expect(lines.join("\n")).not.toContain("thinking about it")
  })
})

describe("stripPrivate / looksLikeSecret", () => {
  it("removes private spans", () => {
    expect(stripPrivate("a <private>hidden</private> b")).toBe("a  b")
  })

  it("flags common secret shapes", () => {
    expect(looksLikeSecret("the key is mb_live_abcdefgh12345678")).toBe(true)
    expect(looksLikeSecret("password: hunter22")).toBe(true)
    expect(looksLikeSecret("AKIAABCDEFGHIJKLMNOP")).toBe(true)
    expect(looksLikeSecret("nginx proxy_read_timeout is 60s")).toBe(false)
  })
})

describe("buildDigest", () => {
  it("keeps short digests intact", () => {
    expect(buildDigest(["a", "b"])).toBe("a\nb")
  })

  it("truncates long digests to 60% head / 30% tail", () => {
    const digest = buildDigest(["x".repeat(DIGEST_CAP * 2)])
    expect(digest.length).toBeLessThan(DIGEST_CAP + 100)
    expect(digest).toContain("[... middle of session truncated ...]")
  })
})

describe("parseDistillerOutput", () => {
  it("parses a plain JSON reply", () => {
    const memories = parseDistillerOutput('{"memories": [{"content": "Root cause was X", "category": "insights", "tags": ["nginx"]}]}')
    expect(memories).toHaveLength(1)
    expect(memories![0].category).toBe("insights")
  })

  it("strips markdown code fences", () => {
    const memories = parseDistillerOutput('```json\n{"memories": []}\n```')
    expect(memories).toEqual([])
  })

  it("rejects the entire reply when any proposed memory is invalid", () => {
    const memories = parseDistillerOutput(
      '{"memories": [{"content": "ok", "category": "facts"}, {"content": "bad", "category": "nope"}, {"content": " ", "category": "facts"}]}',
    )
    expect(memories).toBeNull()
  })

  it("returns null for non-JSON and wrong shapes", () => {
    expect(parseDistillerOutput("I could not comply")).toBeNull()
    expect(parseDistillerOutput('{"other": true}')).toBeNull()
    expect(parseDistillerOutput(undefined)).toBeNull()
  })
})

describe("OBSERVER_PROMPT", () => {
  it("makes iterative test and tuning chatter ineligible for durable capture", () => {
    expect(OBSERVER_PROMPT).toContain("test prompts or results")
    expect(OBSERVER_PROMPT).toContain("troubleshooting progress")
    expect(OBSERVER_PROMPT).toContain("repeated reformulations")
    expect(OBSERVER_PROMPT).toContain("Later verified outcomes override earlier checkpoints")
    expect(OBSERVER_PROMPT).toContain("never describe a completed validation or prerequisite as still pending")
    expect(OBSERVER_PROMPT).toContain("single strongest non-overlapping conclusion")
    expect(OBSERVER_PROMPT).toContain("Never recapture recalled or injected memory content")
    expect(OBSERVER_PROMPT).toContain("Category must exactly match")
  })
})

describe("cursor round-trip", () => {
  it("persists and sanitizes session ids", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "rembr-distill-"))
    const config = loadDistillConfig({ REMBR_STATE_DIR: stateDir })
    expect(readCursor(config, "ses/../weird id")).toBe(0)
    expect(writeCursor(config, "ses/../weird id", 42)).toBe(true)
    expect(readCursor(config, "ses/../weird id")).toBe(42)
  })
})

describe("parseModelRef", () => {
  it("splits provider/model", () => {
    expect(parseModelRef("anthropic/claude-haiku-4-5")).toEqual({
      providerID: "anthropic",
      modelID: "claude-haiku-4-5",
    })
  })

  it("returns undefined for empty or malformed refs", () => {
    expect(parseModelRef("")).toBeUndefined()
    expect(parseModelRef("no-slash")).toBeUndefined()
    expect(parseModelRef("trailing/")).toBeUndefined()
  })
})
