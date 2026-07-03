# rembr-console

A single-tenant, self-hosted web console for [Rembr](https://github.com/radicalgeek/rembr):
browse, search, create, and delete memories; inspect contexts, snapshots, and usage stats.

## Design: a pure MCP client, by construction

The console talks to the Rembr engine **only through its MCP tool surface** — the same
`memory` / `search` / `context` / `snapshot` / `stats` tools agents use. There is no
private API, no feature flags, and no enterprise code in this package at all: tenant
management, RBAC, SSO, and billing live in a separate closed codebase that is never
shipped here. The OSS/enterprise boundary is *what code exists in the artifact*, not a
flag someone could flip.

Two consequences:

- **Nothing to bypass.** Unlocking "more" in this UI is impossible — the code isn't here,
  and server-side plan limits are enforced by the engine regardless of client.
- **Zero runtime dependencies.** One Node process: static files + a `/api/call` proxy that
  forwards an allowlisted set of MCP tools to Rembr, holding the API key server-side so it
  never reaches the browser.

## Run

```bash
REMBR_URL=http://localhost:3000/mcp REMBR_API_KEY=mb_live_... node server.mjs
# → http://localhost:8080
```

Or via Docker / the repo's `docker-compose.yml` (see [SELF-HOSTING.md](../SELF-HOSTING.md)).

| Env var | Default | Meaning |
|---|---|---|
| `REMBR_URL` | `http://localhost:3000/mcp` | Rembr engine MCP endpoint |
| `REMBR_API_KEY` | — | API key (see the bootstrap script in SELF-HOSTING.md) |
| `PORT` | `8080` | Console listen port |
| `REMBR_TIMEOUT_MS` | `30000` | Upstream request timeout |

The console is intended for trusted networks (localhost or behind your own reverse proxy /
auth). It deliberately ships no login system — it's single-tenant by design.

## Development

```bash
npm install   # vitest only
npm test
```

Logic lives in [lib.mjs](./lib.mjs) (config, MCP proxy, allowlist); [server.mjs](./server.mjs)
is a thin zero-dependency HTTP wrapper; the UI is vanilla JS in [public/](./public).
