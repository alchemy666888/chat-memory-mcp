import { readFileSync } from "node:fs";
import pg, { type Pool } from "pg";

export const ownerUrl =
  process.env.CHAT_MEMORY_TEST_OWNER_URL ??
  "postgres://chat_memory_owner:chat-memory-owner-test@127.0.0.1:5432/chat_memory_mcp_test";

export const readerUrl =
  process.env.CHAT_MEMORY_TEST_READER_URL ??
  "postgres://chat_memory_reader:chat-memory-reader-test@127.0.0.1:5432/chat_memory_mcp_test";

export function assertLocalTestUrl(connectionString: string): void {
  const hostname = new URL(connectionString).hostname;
  if (hostname !== "127.0.0.1" && hostname !== "localhost") {
    throw new Error("Refusing a non-local test database");
  }
}

export function applyTestSchema(
  client: pg.PoolClient | pg.Client,
): Promise<unknown> {
  const sql = readFileSync(
    new URL("../fixtures/schema.sql", import.meta.url),
    "utf8",
  );
  return client.query(sql);
}

let ownerPool: Pool | undefined;

export function getOwnerPool(): Pool {
  assertLocalTestUrl(ownerUrl);
  ownerPool ??= new pg.Pool({
    connectionString: ownerUrl,
    max: 2,
    application_name: "chat-memory-mcp-test-owner",
  });
  return ownerPool;
}

export async function endOwnerPool(): Promise<void> {
  if (!ownerPool) return;
  const previous = ownerPool;
  ownerPool = undefined;
  await previous.end();
}

export async function truncateMemory(): Promise<void> {
  await getOwnerPool().query(
    "TRUNCATE chat_memory.raw_messages, chat_memory.chat_memories",
  );
}

export type SeedMessage = {
  eventKey: string;
  turnId: string;
  sourceUpdateId: string;
  role: "user" | "assistant";
  content: string;
  occurredAt: string;
  status?: "non-process" | "processed-completed";
  processedSummaryVersion?: string;
};

export async function seedChat(input: {
  chatId: string;
  summaryText?: string;
  summaryVersion?: string;
  updatedAt?: string;
  messages?: SeedMessage[];
}): Promise<void> {
  const pool = getOwnerPool();
  await pool.query(
    `INSERT INTO chat_memory.chat_memories
       (telegram_chat_id, summary_text, summary_version, updated_at)
     VALUES ($1, $2, $3, COALESCE($4::timestamptz, now()))`,
    [
      input.chatId,
      input.summaryText ?? "",
      input.summaryVersion ?? "0",
      input.updatedAt ?? null,
    ],
  );
  for (const message of input.messages ?? []) {
    const processed = message.status === "processed-completed";
    await pool.query(
      `INSERT INTO chat_memory.raw_messages (
         telegram_chat_id, event_key, turn_id, source_update_id, role, content,
         occurred_at, status, processed_at, processed_summary_version
       )
       VALUES (
         $1, $2, $3, $4::bigint, $5, $6, $7::timestamptz, $8,
         CASE WHEN $8 = 'processed-completed' THEN now() ELSE NULL END,
         $9::bigint
       )`,
      [
        input.chatId,
        message.eventKey,
        message.turnId,
        message.sourceUpdateId,
        message.role,
        message.content,
        message.occurredAt,
        message.status ?? "non-process",
        processed ? (message.processedSummaryVersion ?? "1") : null,
      ],
    );
  }
}
