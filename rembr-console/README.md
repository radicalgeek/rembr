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
REMBR_URL=http://localhost:3000/mcp \
REMBR_API_KEY=your-scoped-upstream-key \
REMBR_CONSOLE_AUTH_TOKEN="$(openssl rand -hex 32)" \
node server.mjs
# → http://localhost:8080
```

Or via Docker / the repo's `docker-compose.yml` (see [SELF-HOSTING.md](../SELF-HOSTING.md)).

| Env var | Default | Meaning |
|---|---|---|
| `REMBR_URL` | `http://localhost:3000/mcp` | Rembr engine MCP endpoint |
| `REMBR_API_KEY` | — | API key (see the bootstrap script in SELF-HOSTING.md) |
| `REMBR_CONSOLE_AUTH_TOKEN` | — | Required, distinct browser-to-console bearer token (32+ bytes) |
| `REMBR_CONSOLE_MODE` | `read-only` | Set to `read-write` to permit memory create/delete |
| `HOST` | `127.0.0.1` | Listen address; retain loopback unless a protected proxy is in front |
| `PORT` | `8080` | Console listen port |
| `REMBR_TIMEOUT_MS` | `30000` | Upstream request timeout |
| `REMBR_CONSOLE_ALLOWED_ORIGINS` | same origin | Comma-separated origins for a trusted reverse proxy |

The console binds loopback, requires a dedicated bearer token, validates browser origins,
caps requests and exposes only the operations used by this UI. It defaults to read-only.
If it is placed behind a reverse proxy, keep the bearer check enabled, terminate TLS there
and set an explicit origin allowlist. Use an upstream key scoped to this tenant and console;
never reuse an administrative or autonomous-bootstrap credential.

## Development

```bash
npm install   # vitest only
npm test
```

Logic lives in [lib.mjs](./lib.mjs) (config, MCP proxy, allowlist); [server.mjs](./server.mjs)
is a thin zero-dependency HTTP wrapper; the UI is vanilla JS in [public/](./public).
