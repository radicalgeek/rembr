import { describe, it, expect } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  DIGEST_CAP,
  buildDigest,
  extractCwd,
  extractLines,
  extractSessionId,
  loadDistillConfig,
  looksLikeSecret,
  parseDistillerOutput,
  readCursor,
  resumeCursor,
  retryAfterSeconds,
  stripPrivate,
  writeCursor,
  type CodexRecord,
} from "./distill.js"
import { RembrError } from "./rembr-client.js"

describe("loadDistillConfig", () => {
  it("returns defaults for an empty environment", () => {
    const config = loadDistillConfig({})
    expect(config.enabled).toBe(true)
    expect(config.model).toBe("")
    expect(config.minNewRecords).toBe(10)
    expect(config.timeoutMs).toBe(120_000)
    expect(config.excludeCwd).toEqual([])
  })

  it("honours REMBR_DISTILL=false and overrides", () => {
    const config = loadDistillConfig({
      REMBR_DISTILL: "false",
      REMBR_DISTILL_MODEL: "gpt-5-mini",
      REMBR_DISTILL_MIN_RECORDS: "3",
      REMBR_DISTILL_TIMEOUT_MS: "5000",
      REMBR_CAPTURE_EXCLUDE: "secret-client, other",
    })
    expect(config.enabled).toBe(false)
    expect(config.model).toBe("gpt-5-mini")
    expect(config.minNewRecords).toBe(3)
    expect(config.timeoutMs).toBe(5000)
    expect(config.excludeCwd).toEqual(["secret-client", "other"])
  })
})

describe("Codex transcript extraction", () => {
  const records: CodexRecord[] = [
    {
      type: "session_meta",
      payload: { session_id: "ses_1", cwd: "/repo" } as never,
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "developer instructions must be skipped" }],
      },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Fix login <private>client X</private>" }],
      },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Root cause was a stale callback URL." }],
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "shell_command",
        arguments: JSON.stringify({ command: "npm test" }),
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call_output",
        output: "Exit code: 0\nAll tests passed",
      },
    },
    {
      type: "world_state",
      payload: { text: "must be skipped" } as never,
    },
  ]

  it("extracts session id and cwd from metadata", () => {
    expect(extractSessionId(records, "fallback.jsonl")).toBe("ses_1")
    expect(extractCwd(records)).toBe("/repo")
  })

  it("extracts only user, assistant, and summarized tool content", () => {
    const lines = extractLines(records)
    expect(lines[0]).toBe("USER: Fix login")
    expect(lines[1]).toBe("ASSISTANT: Root cause was a stale callback URL.")
    expect(lines[2]).toContain("TOOL CALL shell_command:")
    expect(lines[3]).toContain("TOOL RESULT: Exit code: 0 All tests passed")
    expect(lines.join("\n")).not.toContain("developer instructions")
    expect(lines.join("\n")).not.toContain("world_state")
  })
})

describe("privacy and parser helpers", () => {
  it("removes private spans and flags common secret shapes", () => {
    expect(stripPrivate("a <private>hidden</private> b")).toBe("a  b")
    expect(looksLikeSecret("api_key=abc123")).toBe(true)
    expect(looksLikeSecret("root cause was stale metadata")).toBe(false)
  })

  it("rejects the entire reply when any proposed memory is invalid", () => {
    const memories = parseDistillerOutput(
      '```json\n{"memories":[{"content":"Prefer Terraform plans before apply","category":"preferences","tags":["terraform"]},{"content":"bad","category":"unknown"}]}\n```',
    )
    expect(memories).toBeNull()
    expect(parseDistillerOutput("not json")).toBeNull()
  })

  it("accepts an intentional empty result", () => {
    expect(parseDistillerOutput('{"memories":[]}')).toEqual([])
  })

  it("parses Codex exec JSONL agent_message output", () => {
    const memories = parseDistillerOutput(
      [
        '{"type":"thread.started","thread_id":"thread_1"}',
        '{"type":"turn.started"}',
        '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"{\\"memories\\":[{\\"content\\":\\"Use the HTTP transport for Codex MCP.\\",\\"category\\":\\"decisions\\",\\"tags\\":[\\"rembr\\",\\"codex\\"]}]}"}}',
      ].join("\n"),
    )
    expect(memories).toHaveLength(1)
    expect(memories?.[0].category).toBe("decisions")
  })

  it("extracts retry_after from Rembr 429 errors", () => {
    const error = new RembrError(
      'Rembr request failed (HTTP 429): {"error":"Daily Quota Exceeded","retry_after":11256}',
      429,
    )
    expect(retryAfterSeconds(error)).toBe(11256)
    expect(retryAfterSeconds(new RembrError("nope", 401))).toBeNull()
  })
})

describe("digest and cursor helpers", () => {
  it("truncates long digests", () => {
    const digest = buildDigest(["x".repeat(DIGEST_CAP * 2)])
    expect(digest.length).toBeLessThan(DIGEST_CAP + 100)
    expect(digest).toContain("[... middle of session truncated ...]")
  })

  it("persists and sanitizes cursor ids", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "rembr-codex-"))
    const config = loadDistillConfig({ REMBR_STATE_DIR: stateDir })
    expect(readCursor(config, "ses/../weird id")).toBe(0)
    expect(writeCursor(config, "ses/../weird id", 17)).toBe(true)
    expect(readCursor(config, "ses/../weird id")).toBe(17)
  })

  it("restarts from the beginning when a transcript shrinks", () => {
    expect(resumeCursor(20, 10)).toBe(0)
    expect(resumeCursor(10, 10)).toBe(10)
    expect(resumeCursor(5, 10)).toBe(5)
  })
})
