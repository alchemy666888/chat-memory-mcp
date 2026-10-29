# chat-memory-mcp

Read-only MCP service for one Telegram chat's cumulative summary and bounded pending raw-message window. It exposes a stateless Streamable HTTP endpoint at `/api/mcp` with exactly one tool, `get_chat_memory`.

`chat-memory-agent` owns the `chat_memory` schema. This service never creates tables, writes rows, summarizes messages, or calls a model. A missing schema is an operational error for the schema owner to fix.

The shared wire contract is [docs/chat-memory-contract-v1.md](docs/chat-memory-contract-v1.md). Deployment, privileges, timeouts, and rollback are in [docs/deployment.md](docs/deployment.md).

## Requirements

- Node.js 22 or newer
- pnpm 10.28.1 (`packageManager` in `package.json`)
- A PostgreSQL role that can only `SELECT` from `chat_memory.chat_memories` and `chat_memory.raw_messages`

## Local checks

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test:unit
pnpm test:integration
pnpm test:contracts
pnpm build
```

Integration and contract tests use an isolated local database. Prepare it with `scripts/prepare-test-database.sh`, then run the test scripts. They refuse any database host other than `127.0.0.1` or `localhost`. The SQL in `tests/fixtures/schema.sql` is a test double, not the authoritative migration.

`pnpm test:e2e` starts the production server and checks `/api/health` plus an unauthenticated `/api/mcp` response. There is no browser UI.

## Configuration

Copy `.env.example`. Set `DATABASE_URL`, `CHAT_MEMORY_READ_TOKEN`, and `CHAT_MEMORY_ALLOWED_HOSTS`. Set `CHAT_MEMORY_ALLOWED_ORIGINS` only for browser origins that may call the endpoint; leave it empty for server-to-server callers that send no `Origin`. Set `AIVEN_PG_CA` when the provider uses a private certificate authority. Do not set a DeepSeek key or a process token in this service.

The read token must be different from the ingest and process tokens. A wrong token is rejected before a database query.
