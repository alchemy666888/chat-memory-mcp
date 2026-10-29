# Deployment

Deploy this service only after `chat-memory-agent` has initialized a fresh `chat_memory` schema. Roll back by deploying a compatible previous build of this service. Do not drop tables or delete rows as a routine rollback.

Use separate Preview and Production databases, or isolated schemas, with separately scoped credentials. Tests and preview deployments must not use Production credentials.

## Runtime configuration

| Variable                      | Required | Purpose                                                                                                     |
| ----------------------------- | -------- | ----------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                | yes      | PostgreSQL URL for the read role. Use the provider's pooled connection string when one is supplied.         |
| `AIVEN_PG_CA`                 | no       | Custom CA PEM, with literal `\n` escapes or base64. TLS verification stays on.                              |
| `CHAT_MEMORY_READ_TOKEN`      | yes      | Bearer token for `get_chat_memory`.                                                                         |
| `CHAT_MEMORY_ALLOWED_HOSTS`   | yes      | Comma-separated hostnames. Ports are ignored. An empty list rejects every MCP request.                      |
| `CHAT_MEMORY_ALLOWED_ORIGINS` | no       | Comma-separated absolute origins. Empty rejects every present `Origin` and still allows a missing `Origin`. |

There is no DeepSeek key, ingest token, or process token in this deployment.

Optional timeout and pool settings, with their defaults and inclusive bounds:

| Variable                            | Default | Bounds                                   |
| ----------------------------------- | ------- | ---------------------------------------- |
| `CHAT_MEMORY_POOL_MAX`              | 3       | 1–5                                      |
| `CHAT_MEMORY_CONNECTION_TIMEOUT_MS` | 300     | 100–500                                  |
| `CHAT_MEMORY_LOCK_TIMEOUT_MS`       | 400     | 50–1000                                  |
| `CHAT_MEMORY_STATEMENT_TIMEOUT_MS`  | 1500    | 200–1600                                 |
| `CHAT_MEMORY_QUERY_TIMEOUT_MS`      | 1700    | 300–1800, at least the statement timeout |
| `CHAT_MEMORY_IDLE_TIMEOUT_MS`       | 10000   | 1000–60000                               |

`CHAT_MEMORY_CONNECTION_TIMEOUT_MS + CHAT_MEMORY_STATEMENT_TIMEOUT_MS` must be 1900 or less. The bot's lookup deadline is 2000 ms and includes transport, so this service does not retry a timed-out or failed read. The caller falls back once.

The database statement timeout is set for the read transaction as well as on the pooled connection. The client query timeout is a backstop slightly above the statement timeout. An aborted request destroys that pooled connection and rolls back the read transaction when the connection is still usable.

## Connection budget

Each warm instance opens at most `CHAT_MEMORY_POOL_MAX` connections (default 3). The provider budget is that maximum multiplied by the number of concurrent Vercel instances of this service, plus the separate pools opened by `chat-memory-agent`. A transaction-pooling URL is acceptable: the read does not depend on session state outside one repeatable-read transaction, and startup SSL parameters are not required when `AIVEN_PG_CA` is unset. When a CA is set, SSL query parameters are removed so they cannot replace the pinned CA, and `rejectUnauthorized` stays true.

## Least privilege

Create a login role that cannot insert, update, delete, or change schema objects. As the schema owner:

```sql
GRANT USAGE ON SCHEMA chat_memory TO chat_memory_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA chat_memory TO chat_memory_reader;
```

Point `DATABASE_URL` at that role. Do not use `DATABASE_MIGRATOR_URL` here.

## Schema compatibility

`GET /api/health` reports configuration and whether `chat_memory.chat_memories` and `chat_memory.raw_messages` are visible. It returns no chat contents, tokens, or connection strings. `database: schema_missing` or a tool error `SCHEMA_UNSUPPORTED` means the schema owner must repair the database. This service will not create or alter tables.

A read that fails because a column is missing, the database is down, a lock or statement wait expires, or the caller cancels the request returns one MCP tool error. It does not return an empty memory result and it does not issue another query.

## Responses

Successful and failed MCP responses send `Cache-Control: no-store`. Logs include the request id, tool name, result code, elapsed time, returned message count, returned code-point count, and timeout stage. They use an HMAC prefix of the chat id. They do not include message text, summaries, tokens, connection URLs, or SQL parameters.

## Smoke check

After the schema exists and the read role is granted:

1. `GET /api/health` returns `status: ready` and no secret values.
2. `POST /api/mcp` without `Authorization: Bearer <CHAT_MEMORY_READ_TOKEN>` returns 401 and does not query stored chats.
3. An official MCP client pointed at `https://<host>/api/mcp` lists only `get_chat_memory` and can read one known chat.
