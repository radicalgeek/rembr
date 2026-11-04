import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { describe, expect, it, vi } from "vitest"

const spawnMock = vi.fn()
vi.mock("node:child_process", () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }))

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { distillTranscript, loadDistillConfig, reportsToolUse, runDistiller } from "./distill.js"

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough; kill: () => void }
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = new PassThrough()
  child.kill = () => {}
  return child
}

describe("runDistiller codex invocation", () => {
  it("runs codex exec outside a git repo without persisting a session", async () => {
    const child = fakeChild()
    spawnMock.mockReturnValue(child)
    const config = loadDistillConfig({ REMBR_DISTILL_MODEL: "example-model" })
    const pending = runDistiller(config, "USER: hello")
    child.emit("close", 1)
    await pending

    const [command, args, options] = spawnMock.mock.calls[0] as [string, string[], { cwd: string; env: Record<string, string> }]
    expect(command).toBe("codex")
    expect(args.slice(0, 4)).toEqual(["exec", "--json", "--skip-git-repo-check", "--ephemeral"])
    expect(args.slice(-2)).toEqual(["--model", "example-model"])
    expect(options.env.REMBR_CAPTURE_DISABLE).toBe("1")
  })

  it("runs extraction without tools, MCP servers or user config", async () => {
    const child = fakeChild()
    spawnMock.mockReturnValue(child)
    const pending = runDistiller(loadDistillConfig({}), "USER: hello")
    child.emit("close", 1)
    await pending

    const [, args, options] = spawnMock.mock.calls.at(-1) as [string, string[], { cwd: string }]
    expect(args).toContain("--ignore-user-config")
    expect(args).toContain("--ignore-rules")
    expect(args[args.indexOf("--sandbox") + 1]).toBe("read-only")
    expect(args[args.indexOf("--cd") + 1]).toBe(options.cwd)
    expect(args).toContain('web_search="disabled"')
    expect(args).toContain("agents.enabled=false")
    for (const feature of ["shell_tool", "unified_exec", "code_mode_host", "apps", "plugins", "multi_agent", "hooks"]) {
      expect(args[args.indexOf(feature) - 1]).toBe("--disable")
    }
    expect(fs.existsSync(options.cwd)).toBe(false)
  })

  it("discards a result when the session reports a tool call", async () => {
    const child = fakeChild()
    spawnMock.mockReturnValue(child)
    const pending = runDistiller(loadDistillConfig({}), "USER: hello")
    const memories = JSON.stringify({ memories: [{ content: "A durable fixture fact.", category: "facts" }] })
    child.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "echo hi" } }) + "\n")
    child.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: memories } }) + "\n")
    child.stdout.end()
    await new Promise((resolve) => setImmediate(resolve))
    child.emit("close", 0)

    expect(await pending).toBeNull()
  })

  it("accepts a tools-free result", () => {
    const stdout = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "{}" } })
    expect(reportsToolUse(stdout)).toBe(false)
  })
})

describe("distillTranscript secret filter logging", () => {
  it("logs only a count for secret-shaped memories, never their content", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-rembr-log-"))
    const transcript = path.join(stateDir, "rollout-fixture.jsonl")
    fs.writeFileSync(
      transcript,
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Fixture request" }] } }) + "\n",
    )
    const child = fakeChild()
    spawnMock.mockReturnValue(child)
    const config = loadDistillConfig({ REMBR_STATE_DIR: stateDir, REMBR_DISTILL_MIN_RECORDS: "1" })
    const client = { remember: vi.fn(async () => ({})) }
    const secret = "password=fixture-secret-value"
    const pending = distillTranscript(config, { url: "http://example.test", apiKey: "", timeoutMs: 1000 } as never, transcript, client as never)
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
    const reply = JSON.stringify({ memories: [{ content: secret, category: "facts" }] })
    child.stdout.end(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: reply } }) + "\n")
    await new Promise((resolve) => setImmediate(resolve))
    child.emit("close", 0)
    await pending

    const log = fs.readFileSync(config.logFile, "utf8")
    expect(client.remember).not.toHaveBeenCalled()
    expect(log).toContain("skipped-secret-shape: 1 memories")
    expect(log).not.toContain("fixture-secret-value")
  })
})
