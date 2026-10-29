import "server-only";
import { z } from "zod";
import {
  CONTRACT_VERSION,
  SUMMARY_CODE_POINT_LIMIT,
  codePointLength,
  emptyChatMemory,
  getChatMemoryInputSchema,
  getChatMemoryOutputSchema,
  type GetChatMemoryOutput,
} from "@/server/chat-memory/contracts";
import { MemoryReadError } from "@/server/chat-memory/errors";
import {
  buildPendingWindow,
  type PendingCandidate,
} from "@/server/chat-memory/window";
import { withReadSnapshot } from "@/server/postgres/client";

const storedRowSchema = z
  .object({
    raw_message_id: z.string(),
    event_key: z.string(),
    turn_id: z.string(),
    source_update_id: z.string(),
    role: z.enum(["user", "assistant"]),
    content: z.string().min(1),
    occurred_at: z.string(),
  })
  .strict();

const snapshotRowSchema = z
  .object({
    chat_exists: z.string(),
    summary_text: z.string().nullable(),
    summary_version: z.string().nullable(),
    updated_at: z.string().nullable(),
    pending_count: z.string(),
    newest_rows: z.unknown(),
  })
  .strict();

const SNAPSHOT_SQL = `
WITH target AS (
  SELECT
    summary_text,
    summary_version::text AS summary_version,
    to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
  FROM chat_memory.chat_memories
  WHERE telegram_chat_id = $1
),
eligible AS (
  SELECT
    raw_message_id,
    event_key,
    turn_id,
    source_update_id,
    role,
    content,
    occurred_at
  FROM chat_memory.raw_messages
  WHERE telegram_chat_id = $1
    AND status = 'non-process'
    AND ($2::text IS NULL OR turn_id IS DISTINCT FROM $2)
),
newest AS (
  SELECT *
  FROM eligible
  ORDER BY occurred_at DESC,
           source_update_id DESC,
           CASE role WHEN 'user' THEN 0 ELSE 1 END DESC,
           raw_message_id DESC
  LIMIT 50
)
SELECT
  (SELECT count(*)::text FROM target) AS chat_exists,
  (SELECT summary_text FROM target) AS summary_text,
  (SELECT summary_version FROM target) AS summary_version,
  (SELECT updated_at FROM target) AS updated_at,
  (SELECT count(*)::text FROM eligible) AS pending_count,
  COALESCE(
    (
      SELECT json_agg(
        json_build_object(
          'raw_message_id', raw_message_id::text,
          'event_key', event_key,
          'turn_id', turn_id,
          'source_update_id', source_update_id::text,
          'role', role,
          'content', content,
          'occurred_at', to_char(occurred_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        )
        ORDER BY occurred_at DESC,
                 source_update_id DESC,
                 CASE role WHEN 'user' THEN 0 ELSE 1 END DESC,
                 raw_message_id DESC
      )
      FROM newest
    ),
    '[]'::json
  ) AS newest_rows
`;

export async function readChatMemory(
  input: { telegram_chat_id: string; exclude_turn_id?: string },
  signal?: AbortSignal,
): Promise<GetChatMemoryOutput> {
  const parsed = getChatMemoryInputSchema.safeParse(input);
  if (!parsed.success) throw new MemoryReadError("INVALID_INPUT", null);

  const row = await withReadSnapshot(async (client) => {
    const result = await client.query(SNAPSHOT_SQL, [
      parsed.data.telegram_chat_id,
      parsed.data.exclude_turn_id ?? null,
    ]);
    return result.rows[0];
  }, signal);

  return assembleMemory(parsed.data.telegram_chat_id, row);
}

export async function probeSchema(
  signal?: AbortSignal,
): Promise<"ready" | "schema_missing"> {
  const row = await withReadSnapshot(async (client) => {
    const result = await client.query<{
      memories: string | null;
      messages: string | null;
    }>(
      `SELECT to_regclass('chat_memory.chat_memories')::text AS memories,
              to_regclass('chat_memory.raw_messages')::text AS messages`,
    );
    return result.rows[0];
  }, signal);
  if (!row?.memories || !row.messages) return "schema_missing";
  return "ready";
}

function assembleMemory(
  telegramChatId: string,
  row: unknown,
): GetChatMemoryOutput {
  const snapshot = snapshotRowSchema.safeParse(row);
  if (!snapshot.success)
    throw new MemoryReadError("INVALID_STORED_STATE", null);

  let pendingCount: bigint;
  let chatExists: bigint;
  try {
    pendingCount = BigInt(snapshot.data.pending_count);
    chatExists = BigInt(snapshot.data.chat_exists);
  } catch {
    throw new MemoryReadError("INVALID_STORED_STATE", null);
  }
  if (chatExists !== 0n && chatExists !== 1n) {
    throw new MemoryReadError("INVALID_STORED_STATE", null);
  }
  if (chatExists === 0n) {
    if (pendingCount !== 0n) {
      throw new MemoryReadError("INVALID_STORED_STATE", null);
    }
    return emptyChatMemory(telegramChatId);
  }

  const summary = summaryFromRow(snapshot.data);
  const newestFirst = parseNewest(snapshot.data.newest_rows);
  if (pendingCount < BigInt(newestFirst.length)) {
    throw new MemoryReadError("INVALID_STORED_STATE", null);
  }
  const window = buildPendingWindow({ newestFirst, pendingCount });
  const output = getChatMemoryOutputSchema.safeParse({
    contract_version: CONTRACT_VERSION,
    telegram_chat_id: telegramChatId,
    summary,
    pending_messages: window.messages,
    window: {
      returned_messages: window.messages.length,
      returned_characters: window.returnedCharacters,
      has_more_pending: window.hasMorePending,
    },
  });
  if (!output.success) throw new MemoryReadError("INVALID_STORED_STATE", null);
  return output.data;
}

function summaryFromRow(row: {
  summary_text: string | null;
  summary_version: string | null;
  updated_at: string | null;
}): GetChatMemoryOutput["summary"] {
  if (
    row.summary_version === null ||
    row.summary_text === null ||
    row.updated_at === null
  ) {
    throw new MemoryReadError("INVALID_STORED_STATE", null);
  }
  let version: bigint;
  try {
    version = BigInt(row.summary_version);
  } catch {
    throw new MemoryReadError("INVALID_STORED_STATE", null);
  }
  if (version < 0n) throw new MemoryReadError("INVALID_STORED_STATE", null);
  if (version === 0n) return null;
  if (codePointLength(row.summary_text) > SUMMARY_CODE_POINT_LIMIT) {
    throw new MemoryReadError("INVALID_STORED_STATE", null);
  }
  if (row.summary_text.length === 0) {
    throw new MemoryReadError("INVALID_STORED_STATE", null);
  }
  return {
    text: row.summary_text,
    version: row.summary_version,
    updated_at: row.updated_at,
  };
}

function parseNewest(value: unknown): PendingCandidate[] {
  const rows = typeof value === "string" ? parseJson(value) : value;
  if (!Array.isArray(rows))
    throw new MemoryReadError("INVALID_STORED_STATE", null);
  return rows.map((row) => {
    const parsed = storedRowSchema.safeParse(row);
    if (!parsed.success)
      throw new MemoryReadError("INVALID_STORED_STATE", null);
    return parsed.data;
  });
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new MemoryReadError("INVALID_STORED_STATE", null);
  }
}
