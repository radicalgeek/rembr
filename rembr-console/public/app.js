// rembr-console UI. Talks only to this console's /api/call proxy.

async function call(tool, args) {
  const response = await fetch("/api/call", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool, args }),
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

// --- Tabs ---
document.querySelectorAll("nav button").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll("nav button").forEach((b) => b.classList.remove("active"))
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"))
    button.classList.add("active")
    document.getElementById(`tab-${button.dataset.tab}`).classList.add("active")
  })
})

// --- Connection status + initial loads ---
async function checkStatus() {
  const el = document.getElementById("status")
  const result = await call("stats", { operation: "usage" })
  if (result.ok) {
    el.textContent = "connected"
    el.className = "status ok"
  } else {
    el.textContent = result.error
    el.className = "status err"
  }
}

async function loadMemories() {
  show("memories-output", await call("memory", { operation: "list", limit: 20 }), "No memories yet — store one below.")
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

document.getElementById("refresh-memories").addEventListener("click", loadMemories)
document.getElementById("refresh-contexts").addEventListener("click", loadContexts)
document.getElementById("refresh-snapshots").addEventListener("click", loadSnapshots)
document.getElementById("refresh-stats").addEventListener("click", loadStats)

// --- Create memory ---
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

// --- Delete memory ---
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

// --- Search ---
document.getElementById("search-form").addEventListener("submit", async (event) => {
  event.preventDefault()
  const query = document.getElementById("search-query").value.trim()
  const mode = document.getElementById("search-mode").value
  if (!query) return
  document.getElementById("search-output").textContent = "Searching…"
  show(
    "search-output",
    await call("search", { operation: "query", query, search_mode: mode, limit: 20 }),
    "No matching memories.",
  )
})

checkStatus()
loadMemories()
loadContexts()
loadSnapshots()
loadStats()
