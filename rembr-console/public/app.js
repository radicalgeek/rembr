// Keep the browser-to-console bearer token in this page process only. A reload
// deliberately requires re-entry so browser storage cannot persist it.
let consoleToken = ""

function currentToken() {
  return consoleToken
}

async function call(tool, args) {
  const token = currentToken()
  if (!token) return { ok: false, error: "Enter the console access token" }
  const response = await fetch("/api/call", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ tool, args }),
    credentials: "same-origin",
    redirect: "error",
  })
  const payload = await response.json().catch(() => ({ ok: false, error: "Bad response from console server" }))
  return payload
}

function show(id, payload, emptyMessage = "Nothing found.") {
  const el = document.getElementById(id)
  if (payload.ok) {
    el.textContent = payload.text?.trim() ? payload.text : emptyMessage
    el.classList.remove("error")
  } else {
    el.textContent = `Error: ${payload.error}`
    el.classList.add("error")
  }
}

document.querySelectorAll("nav button").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll("nav button").forEach((entry) => entry.classList.remove("active"))
    document.querySelectorAll(".tab").forEach((tab) => tab.classList.remove("active"))
    button.classList.add("active")
    document.getElementById(`tab-${button.dataset.tab}`).classList.add("active")
  })
})

async function checkStatus() {
  const el = document.getElementById("status")
  const result = await call("stats", { operation: "usage" })
  el.textContent = result.ok ? "connected" : result.error
  el.className = result.ok ? "status ok" : "status err"
  return result.ok
}

async function loadMemories() {
  show("memories-output", await call("memory", { operation: "list", limit: 20 }), "No memories yet.")
}
async function loadContexts() {
  show("contexts-output", await call("context", { operation: "list" }), "No contexts yet.")
}
async function loadSnapshots() {
  show("snapshots-output", await call("snapshot", { operation: "list" }), "No snapshots yet.")
}
async function loadStats() {
  show("stats-usage", await call("stats", { operation: "usage" }))
  show("stats-embeddings", await call("stats", { operation: "embeddings" }))
}
async function loadAll() {
  if (!await checkStatus()) return
  await Promise.all([loadMemories(), loadContexts(), loadSnapshots(), loadStats()])
}

document.getElementById("connect-console").addEventListener("click", () => {
  const input = document.getElementById("console-token")
  const token = input.value.trim()
  input.value = ""
  if (token) consoleToken = token
  loadAll()
})
document.getElementById("forget-console").addEventListener("click", () => {
  consoleToken = ""
  document.getElementById("status").textContent = "authentication required"
  document.getElementById("status").className = "status"
})
document.getElementById("console-token").addEventListener("keydown", (event) => {
  if (event.key === "Enter") document.getElementById("connect-console").click()
})

document.getElementById("refresh-memories").addEventListener("click", loadMemories)
document.getElementById("refresh-contexts").addEventListener("click", loadContexts)
document.getElementById("refresh-snapshots").addEventListener("click", loadSnapshots)
document.getElementById("refresh-stats").addEventListener("click", loadStats)

document.getElementById("create-form").addEventListener("submit", async (event) => {
  event.preventDefault()
  const content = document.getElementById("create-content").value.trim()
  const category = document.getElementById("create-category").value
  if (!content) return
  const result = await call("memory", { operation: "create", content, category })
  show("create-output", result)
  if (result.ok) {
    document.getElementById("create-content").value = ""
    loadMemories()
  }
})

document.getElementById("delete-form").addEventListener("submit", async (event) => {
  event.preventDefault()
  const id = document.getElementById("delete-id").value.trim()
  if (!id) return
  const result = await call("memory", { operation: "delete", id })
  show("delete-output", result)
  if (result.ok) {
    document.getElementById("delete-id").value = ""
    loadMemories()
  }
})

document.getElementById("search-form").addEventListener("submit", async (event) => {
  event.preventDefault()
  const query = document.getElementById("search-query").value.trim()
  const mode = document.getElementById("search-mode").value
  if (!query) return
  document.getElementById("search-output").textContent = "Searching…"
  show("search-output", await call("search", { operation: "query", query, search_mode: mode, limit: 20 }),
    "No matching memories.")
})

if (currentToken()) loadAll()
