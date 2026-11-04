import { describe, it, expect } from "vitest"
import { spawn } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const setupPath = fileURLToPath(new URL("./setup.mjs", import.meta.url))

async function startSetup(status = 200, home = fs.mkdtempSync(path.join(os.tmpdir(), "fixture-rembr-codex-setup-"))) {
  const mock = `globalThis.fetch = async () => new Response(JSON.stringify({jsonrpc:"2.0",id:1,result:{content:[{type:"text",text:JSON.stringify({success:${status === 200 ? "true" : "false"},data:[]})}]}}),{status:${status},headers:{"content-type":"application/json"}}); await import(${JSON.stringify(pathToFileURL(setupPath).href)});`
  const child = spawn(process.execPath, ["--input-type=module", "-e", mock], {
    env: { ...process.env, HOME: home, USERPROFILE: home, REMBR_URL: "", REMBR_SETUP_NO_BROWSER: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  })
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Setup page did not start")), 5000)
    child.stdout.once("data", (chunk) => {
      clearTimeout(timer)
      resolve(chunk.toString().match(/http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]+/)?.[0])
    })
    child.on("error", reject)
  })
  return { child, home, url }
}

function clean(home) {
  const rembrDir = path.join(home, ".rembr")
  const profile = path.join(rembrDir, "codex.env")
  if (fs.existsSync(profile)) fs.unlinkSync(profile)
  if (fs.existsSync(rembrDir)) fs.rmdirSync(rembrDir)
  fs.rmdirSync(home)
}

describe("local Codex setup page", () => {
  it("uses a masked key field and rejects a non-loopback origin", async () => {
    const { child, home, url } = await startSetup()
    try {
      expect(url).toBeTruthy()
      const page = await fetch(url)
      const html = await page.text()
      expect(page.status).toBe(200)
      expect(html).toContain('type="password"')
      expect(html).toContain('name="endpoint"')
      expect(html).toContain('value="https://rembr.ai/mcp"')

      const rejected = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", Origin: "https://example.test" },
        body: new URLSearchParams({ endpoint: "https://rembr.test/mcp", key: "fixture-key" }),
      })
      expect(rejected.status).toBe(403)
      expect(await rejected.text()).toBe("Request rejected: origin (not-loopback)")
      expect(fs.existsSync(path.join(home, ".rembr", "codex.env"))).toBe(false)
    } finally {
      child.kill()
      clean(home)
    }
  })

  it("verifies a read-only call before saving the Codex-specific profile", async () => {
    const { child, home, url } = await startSetup()
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", Origin: new URL(url).origin },
        body: new URLSearchParams({ endpoint: "https://rembr.test/mcp", key: "fixture-key" }),
      })
      expect(response.status).toBe(200)
      expect(await response.text()).toContain("Start a new Codex session")
      expect(fs.readFileSync(path.join(home, ".rembr", "codex.env"), "utf8")).toBe(
        "REMBR_URL=https://rembr.test/mcp\nREMBR_API_KEY=fixture-key\n",
      )
    } finally {
      child.kill()
      clean(home)
    }
  })

  it("rejects an unencrypted remote endpoint", async () => {
    const { child, home, url } = await startSetup()
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", Origin: new URL(url).origin },
        body: new URLSearchParams({ endpoint: "http://example.test/mcp", key: "fixture-key" }),
      })
      expect(response.status).toBe(400)
      expect(await response.text()).toContain("Enter an HTTPS Rembr endpoint")
      expect(fs.existsSync(path.join(home, ".rembr", "codex.env"))).toBe(false)
    } finally {
      child.kill()
      clean(home)
    }
  })

  it("does not save credentials when the read-only authentication check fails", async () => {
    const { child, home, url } = await startSetup(401)
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", Origin: new URL(url).origin },
        body: new URLSearchParams({ endpoint: "https://rembr.test/mcp", key: "fixture-key" }),
      })
      expect(response.status).toBe(401)
      expect(await response.text()).toContain("HTTP 401")
      expect(fs.existsSync(path.join(home, ".rembr", "codex.env"))).toBe(false)
    } finally {
      child.kill()
      clean(home)
    }
  })

  it("replaces an existing Codex profile after a successful reconfiguration", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "fixture-rembr-codex-setup-"))
    let first
    let second
    try {
      first = await startSetup(200, home)
      const firstResponse = await fetch(first.url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", Origin: new URL(first.url).origin },
        body: new URLSearchParams({ endpoint: "https://rembr.test/mcp", key: "fixture-key-one" }),
      })
      expect(firstResponse.status).toBe(200)
      first.child.kill()

      second = await startSetup(200, home)
      const secondResponse = await fetch(second.url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", Origin: new URL(second.url).origin },
        body: new URLSearchParams({ endpoint: "https://rembr.test/mcp", key: "fixture-key-two" }),
      })
      expect(secondResponse.status).toBe(200)
      expect(fs.readFileSync(path.join(home, ".rembr", "codex.env"), "utf8")).toContain("fixture-key-two")
    } finally {
      first?.child.kill()
      second?.child.kill()
      clean(home)
    }
  })
})
