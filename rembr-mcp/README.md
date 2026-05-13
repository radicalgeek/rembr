# Rembr MCP Server

The Rembr MCP server provides durable memory, search, context construction, snapshots, graph reasoning, temporal queries, causal tracing, task workflows, audit tools, and RLM session support for AI agents.

## Install

```sh
npm install
cp .env.example .env
npm run build
npm start
```

## Configuration

Use environment variables for all secrets and service URLs. Do not commit `.env` files.

Important production secrets include:

- `DATABASE_URL` or `DB_HOST`/`DB_NAME`/`DB_USER`/`DB_PASSWORD`
- `JWT_SECRET`
- `ADMIN_API_KEY`
- `API_KEY_SECRET`
- `METRICS_SECRET`

Generate secrets with a cryptographically secure source such as `openssl rand -hex 32`.

## Development

```sh
npm install
npm run build
npm test
npm audit
```

## License

MIT.
