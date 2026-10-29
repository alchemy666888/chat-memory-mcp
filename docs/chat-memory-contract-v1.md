# Shared contract v1

This document is the integration contract. Keep its names, meanings, limits, and examples identical across `chat-memory-agent`, `chat-memory-mcp`, and `agent-bot`. There is no shared package and no fourth service.

`chat-memory-mcp` implements only the memory-read MCP API. Ingestion and processing belong to `chat-memory-agent`. The bot owns the caller deadlines and fallback.

## Confirmed behavior

- Both incoming user text and successfully delivered assistant answers are raw messages with explicit `user` or `assistant` roles.
- There is one cumulative summary per Telegram chat, updated from the previous summary and newly selected pending messages.
- The stored summary is at most **8,000 Unicode code points**, prioritizing important information, recent context, and recurring information. Count code points, not UTF-16 code units or bytes.
- For normal replies, use the summary plus the latest **50 pending raw messages**, with at most **24,000 code points of raw content**, followed by the current user message exactly once.
- Incoming-message saves start asynchronously. The reply path does not await save acceptance, the HTTP response, or database persistence.
- Memory retrieval is awaited, has one deadline, and is **never retried**. Failure, timeout, malformed output, or missing configuration causes a current-message-only reply attempt.
- Assistant answers are saved asynchronously only after the complete Telegram answer has been delivered successfully.
- Summarization starts only through an authenticated external processing REST call. There are no cron jobs, polling workers, startup processing, database-triggered processing, or processing calls from normal Telegram handling.
- A processing call takes **no chat ID**, automatically selects at most one eligible chat, and handles a bounded batch from that chat. It never moves on to another chat in the same call.
- A successful processing operation atomically updates that chat's summary and marks only its captured batch processed. Unselected messages and later arrivals remain pending.
- Keep processed raw rows; exclude them from ordinary pending retrieval. No retention purge or historical backfill is in scope.

## Engineering defaults

| Setting                           | Default                                                                                                                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Platform                          | Separate Vercel Next.js projects, Node.js runtime, TypeScript ESM                                                                                                                                |
| Existing stack baseline           | pnpm 10.28.1; Next.js 16.3.5 family; React/React DOM 19.3.0 family; TypeScript 6.0.2 family; pg 8.23.0 family; Zod 4.6.5 family; Vitest 5.0.1 family; ESLint/Prettier conventions from agent-bot |
| Node.js                           | Use the same supported deployed Node version across projects; preserve agent-bot's Node >=22 compatibility                                                                                       |
| Memory-read deadline in agent-bot | 2,000 ms total, including MCP discovery/connection and the one tool invocation                                                                                                                   |
| Background-save deadline          | 5,000 ms per POST, independent of the generation deadline; one attempt, no application retry                                                                                                     |
| Normal processing batch           | Oldest pending prefix, up to 100 rows and 64,000 code points of content                                                                                                                          |
| Processing request                | Synchronous result for this explicit call; 240-second application deadline within a 300-second function duration                                                                                 |
| Per-chat processing lease         | 330 seconds; database time and a random fencing token                                                                                                                                            |
| Summary model                     | DEEPSEEK_SUMMARY_MODEL defaults to deepseek-v4-pro; use DeepSeek directly                                                                                                                        |
| Summary generation                | Non-streaming, thinking disabled, no tools or web search; bounded output and validation                                                                                                          |
| Schema owner                      | chat-memory-agent owns initialization; chat-memory-mcp only reads                                                                                                                                |
| Empty processing queue            | HTTP 200, result no_work                                                                                                                                                                         |
| No eligible unlocked chat         | HTTP 200, result no_eligible_chat                                                                                                                                                                |
| Isolation                         | Separate Preview/test and Production databases or isolated schemas with separately scoped credentials                                                                                            |

## Authentication and environment ownership

All service calls use HTTPS and `Authorization: Bearer <token>`.

| Environment variable        | Set in                                                                                                                      |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| CHAT_MEMORY_INGEST_TOKEN    | agent-bot and chat-memory-agent                                                                                             |
| CHAT_MEMORY_READ_TOKEN      | agent-bot and chat-memory-mcp                                                                                               |
| CHAT_MEMORY_PROCESS_TOKEN   | chat-memory-agent and the external operator/caller only                                                                     |
| CHAT_MEMORY_ALLOWED_HOSTS   | chat-memory-mcp; explicit deployment hostname/alias allowlist                                                               |
| CHAT_MEMORY_ALLOWED_ORIGINS | chat-memory-mcp; explicit Origin allowlist; an unset/empty list rejects present Origin headers                              |
| CHAT_MEMORY_INGEST_URL      | agent-bot; full /api/v1/messages URL                                                                                        |
| CHAT_MEMORY_MCP_URL         | agent-bot; full /api/mcp URL                                                                                                |
| DATABASE_URL                | Both memory services, pointing to the same schema; separate read/write roles where available                                |
| AIVEN_PG_CA                 | Both memory services if a custom PostgreSQL CA is needed; retain agent-bot's existing normalization and strict TLS approach |
| DATABASE_MIGRATOR_URL       | chat-memory-agent's explicit schema initialization tooling only                                                             |
| DEEPSEEK_API_KEY            | agent-bot and chat-memory-agent; never chat-memory-mcp                                                                      |
| DEEPSEEK_BASE_URL           | The two DeepSeek callers; default https://api.deepseek.com                                                                  |
| DEEPSEEK_SUMMARY_MODEL      | chat-memory-agent only                                                                                                      |
| CHAT_MEMORY_READ_TIMEOUT_MS | agent-bot; default 2000                                                                                                     |
| CHAT_MEMORY_SAVE_TIMEOUT_MS | agent-bot; default 5000                                                                                                     |
| MEMORY_PROCESS_TIMEOUT_MS   | chat-memory-agent; default 240000                                                                                           |
| MEMORY_BATCH_MAX_MESSAGES   | chat-memory-agent; default 100                                                                                              |
| MEMORY_BATCH_MAX_CHARACTERS | chat-memory-agent; default 64000                                                                                            |

The three tokens must be distinct. A save token cannot read memory or process it. A read token cannot save or process it. Do not forward the process token, database credentials, or tokens inside prompts or tool arguments. Validate secrets and URLs at the relevant entry point. Bad memory configuration in agent-bot degrades memory features without stopping the reply path.

## Raw-message ingestion REST API

`POST /api/v1/messages` belongs to chat-memory-agent and requires the ingest token.

```json
{
  "contract_version": 1,
  "telegram_chat_id": "123456789",
  "event_key": "tg:987654321:user",
  "turn_id": "tg:987654321",
  "source_update_id": "987654321",
  "source_message_id": "42",
  "role": "user",
  "content": "Please remember that I prefer concise replies.",
  "occurred_at": "2026-10-28T10:00:00.000Z"
}
```

For an answer, use `event_key=tg:<update_id>:assistant`, the same `turn_id`, role `assistant`, and the complete cleaned logical answer. `source_message_id` is nullable for assistant answers; do not invent a Telegram message ID. Save after all delivery chunks succeed.

Treat Telegram identifiers as decimal strings on the wire, never JavaScript floating-point IDs. Chat IDs are canonical signed nonzero decimal strings within PostgreSQL bigint range. The current bot continues to accept private chats only. source_update_id is a nonnegative decimal string; source_message_id is a nullable positive decimal string. occurred_at is an RFC 3339 timestamp: prefer Telegram's source message date for input, and successful delivery time for an answer; fall back to the captured ingress time if source time is unavailable.

- New persisted row: HTTP 201 with `{"contract_version":1,"result":"stored","raw_message_id":"1"}`.
- Exact replay: HTTP 200, result `duplicate`, with the existing row ID; no new row or overwriting.
- The same chat/event key with different role, content, turn, or source identity: HTTP 409, code `IDEMPOTENCY_CONFLICT`. Timestamp differences alone do not change the already stored row.
- Invalid payload: 400; unauthenticated: 401; wrong recognized token scope: 403; unsupported media type: 415; oversized body: 413; database unavailable: 503.
- Error envelope: `{"contract_version":1,"error":{"code":"DATABASE_UNAVAILABLE","retryable":true},"request_id":"<opaque-id>"}`. Do not return SQL details or secret values.
- A successful ingestion HTTP response means the row was committed. The bot does not wait for that response.
- The incoming user row and assistant row are independent. The database must accept an assistant event even if its user event has not arrived yet.

## Memory-read MCP API

chat-memory-mcp exposes a genuine, stateless MCP Streamable HTTP endpoint at `/api/mcp` with exactly one application tool, `get_chat_memory`. Use the official matching TypeScript server/client SDK release line and its documented HTTP handler. This is not a REST endpoint renamed MCP.

The current official TypeScript SDK v2 uses `@modelcontextprotocol/server` and `@modelcontextprotocol/client`. Keep client/server versions compatible, lock exact resolved versions, and follow their version-matched documentation rather than mixing v1 import examples with v2 APIs. Use JSON responses for this read-only tool; no process-local sessions or unsolicited server messages are needed. Protocol negotiation/discovery is permitted within the single lookup deadline; it must not cause a second tools/call or a retry after failure.

Tool arguments:

```json
{
  "telegram_chat_id": "123456789",
  "exclude_turn_id": "tg:987654321"
}
```

exclude_turn_id is required for bot requests and optional for other authenticated service callers. Exclude all raw rows for that turn before applying window limits. This prevents the current input's asynchronously saved row from appearing again in the raw context. A cumulative summary may restate facts from earlier processing; "exactly once" means one explicit current-user message, without replaying its raw row.

Successful tool structuredContent:

```json
{
  "contract_version": 1,
  "telegram_chat_id": "123456789",
  "summary": {
    "text": "The user prefers concise replies.",
    "version": "3",
    "updated_at": "2026-10-28T10:05:00.000Z"
  },
  "pending_messages": [
    {
      "raw_message_id": "91",
      "event_key": "tg:987654320:user",
      "turn_id": "tg:987654320",
      "source_update_id": "987654320",
      "role": "user",
      "content": "Use a friendly tone.",
      "occurred_at": "2026-10-28T10:04:00.000Z",
      "content_truncated": false
    }
  ],
  "window": {
    "returned_messages": 1,
    "returned_characters": 20,
    "has_more_pending": false
  }
}
```

The example's counts must be computed from its actual content in fixtures; do not hardcode illustrative count fields.

Unknown chat or never summarized chat: summary null, with the available pending rows or an empty array. Return a successful empty result for an unknown chat.

Read summary and pending rows from **one database snapshot**: either one SQL statement or a short read-only repeatable-read transaction. Never read the summary before a processing commit and the raw rows after that commit in unrelated snapshots.

Define chronological order as occurred_at, source_update_id, role rank user-before-assistant, then raw_message_id. Select the newest 50 eligible pending rows in reverse order, apply the 24,000-code-point content budget as a contiguous newest window, then return them chronologically. Include only full messages, except that one individually oversized newest message may return its first 24,000 code points with content_truncated true. Metadata and JSON framing are outside this content budget. Do not alter or mark database rows when clipping a read response. Report has_more_pending when rows or content were omitted. Never include processed raw rows.

Declare and validate the MCP output schema. Tool failures use standard MCP error semantics with a bounded, non-sensitive machine code; they must not masquerade as successful empty memory. agent-bot validates the result and falls back without retry.

## External processing REST API

`POST /api/v1/memory/process` belongs to chat-memory-agent, requires the process token, and accepts an empty JSON object. Reject chat IDs and other unknown body fields. This service chooses the chat.

Example completed result:

```json
{
  "contract_version": 1,
  "result": "processed",
  "telegram_chat_id": "123456789",
  "processed_messages": 37,
  "summary_version": "4",
  "has_more_pending": true
}
```

No work: `{"contract_version":1,"result":"no_work","processed_messages":0}`. If pending chats exist but all have active leases, return result no_eligible_chat instead. A failure before final commit returns an appropriate 5xx error and leaves the captured raw rows pending and the previous summary intact. If the connection is lost while COMMIT is being acknowledged, report COMMIT_OUTCOME_UNKNOWN: the transaction may already have committed. Do not assert rollback or automatically retry processing; a later explicit call reads committed state. An actual model call must not occur for no_work or no_eligible_chat.

## Relational schema

Use the dedicated PostgreSQL schema `chat_memory`. Store typed columns and relational constraints rather than serialized transcript files, JSONL, or whole Telegram webhook blobs. `chat-memory-agent` owns initialization. This repository does not ship an authoritative migration.

`chat_memory.chat_memories`:

| Column                      | Contract                                                      |
| --------------------------- | ------------------------------------------------------------- |
| telegram_chat_id            | text primary key, canonical bigint-range chat ID              |
| summary_text                | text not null default empty string; CHECK char_length <= 8000 |
| summary_version             | bigint not null default 0; nonnegative                        |
| created_at, updated_at      | timestamptz not null                                          |
| summarized_at               | nullable timestamptz                                          |
| processing_token            | nullable uuid fencing token                                   |
| processing_lease_expires_at | nullable timestamptz; set/unset together with token           |

An empty version-0 parent row is created at first ingestion. It provides a foreign-key parent before a summary exists; it is exposed as summary null. This is still one eventual cumulative summary row per chat.

`chat_memory.raw_messages`:

| Column                    | Contract                                                            |
| ------------------------- | ------------------------------------------------------------------- |
| raw_message_id            | bigint generated always as identity primary key                     |
| telegram_chat_id          | text not null; FK to chat_memories                                  |
| event_key                 | text not null; UNIQUE (telegram_chat_id, event_key)                 |
| turn_id                   | text not null                                                       |
| source_update_id          | bigint not null, nonnegative                                        |
| source_message_id         | nullable bigint, positive when present                              |
| role                      | text CHECK in user, assistant                                       |
| content                   | nonempty text, preserved as submitted                               |
| occurred_at               | timestamptz not null; source ordering time                          |
| received_at               | timestamptz not null default database now                           |
| status                    | text CHECK in non-process, processed-completed; default non-process |
| processed_at              | nullable timestamptz                                                |
| processed_summary_version | nullable bigint                                                     |

Enforce that pending rows have null processed_at/version and completed rows have both set, with version >0. After success, processed_summary_version identifies the cumulative version that consumed the row. A single cumulative row cannot be a foreign-key target for historical versions, so do not add an invalid FK from that version to the current summary_version.

Provide pending-only indexes supporting (chat, chronological ordering), oldest pending-chat selection, and exclusion by turn. SQL is parameterized throughout. No embeddings, vector database, full transcript as a JSON column, or legacy telegram_agent_files dependency is part of this subsystem.

## Summary content policy

The stored summary is plain text, preferably concise sections for durable facts/preferences, decisions/commitments, recent active context, and recurring themes. Prioritize explicit important user facts and constraints, decisions, commitments, and corrections; preserve recent unresolved context and repeated preferences/themes. New explicit corrections supersede conflicting older statements. Treat assistant suggestions as suggestions until the user accepts them. Preserve uncertainty and dates when useful. The database CHECK and this service both reject a stored summary above 8,000 code points. Version 0 is returned as summary null.

## Release sequence

1. Implement chat-memory-agent and initialize the fresh schema explicitly.
2. Implement chat-memory-mcp against that schema, with read-only credentials.
3. Integrate agent-bot, configure its two URLs and tokens, and exercise the real cross-service contract in an isolated environment.
4. Smoke-test asynchronous saves, awaited one-attempt retrieval, fallback, and one manual processing call before enabling production credentials.
5. Rollback by reverting the bot integration or removing its memory configuration; keep stored data intact. Roll back service code through compatible deployments. Do not drop tables as a routine rollback.

No data migration or historical import is needed. Initial schema creation is required and is not a data migration.
