import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { readChatMemory } from "@/server/chat-memory/repository";
import { endPool } from "@/server/postgres/client";
import {
  endOwnerPool,
  getOwnerPool,
  seedChat,
  truncateMemory,
} from "../helpers/database";

beforeEach(async () => {
  await truncateMemory();
});

afterAll(async () => {
  await endPool();
  await endOwnerPool();
});

describe("snapshot isolation and single failure", () => {
  it("returns one coherent snapshot across a concurrent summarization commit", async () => {
    await seedChat({
      chatId: "21",
      summaryText: "old summary",
      summaryVersion: "1",
      updatedAt: "2026-10-28T10:00:00.000Z",
      messages: [
        {
          eventKey: "tg:1:user",
          turnId: "tg:1",
          sourceUpdateId: "1",
          role: "user",
          content: "pending fact",
          occurredAt: "2026-10-28T10:01:00.000Z",
        },
      ],
    });
    await seedChat({
      chatId: "22",
      messages: [
        {
          eventKey: "tg:2:user",
          turnId: "tg:2",
          sourceUpdateId: "2",
          role: "user",
          content: "other chat",
          occurredAt: "2026-10-28T10:01:00.000Z",
        },
      ],
    });

    const writer = await getOwnerPool().connect();
    try {
      await writer.query("BEGIN");
      await writer.query(
        `UPDATE chat_memory.chat_memories
         SET summary_text = 'new summary', summary_version = 2, updated_at = '2026-10-28T10:06:00.000Z'
         WHERE telegram_chat_id = '21'`,
      );
      await writer.query(
        `UPDATE chat_memory.raw_messages
         SET status = 'processed-completed',
             processed_at = now(),
             processed_summary_version = 2
         WHERE telegram_chat_id = '21'`,
      );
      const during = await readChatMemory({ telegram_chat_id: "21" });
      expect(during.summary?.text).toBe("old summary");
      expect(during.summary?.version).toBe("1");
      expect(during.pending_messages.map((row) => row.content)).toEqual([
        "pending fact",
      ]);
      expect(JSON.stringify(during)).not.toContain("other chat");
      await writer.query("COMMIT");
    } finally {
      await writer.query("ROLLBACK").catch(() => undefined);
      writer.release();
    }

    const after = await readChatMemory({ telegram_chat_id: "21" });
    expect(after.summary?.text).toBe("new summary");
    expect(after.summary?.version).toBe("2");
    expect(after.pending_messages).toEqual([]);
    expect(after.window.has_more_pending).toBe(false);
  });

  it("returns one timeout when a lock blocks the read and then releases the session", async () => {
    await seedChat({ chatId: "31" });
    process.env.CHAT_MEMORY_LOCK_TIMEOUT_MS = "250";
    const writer = await getOwnerPool().connect();
    const started = performance.now();
    try {
      await writer.query("BEGIN");
      await writer.query(
        "LOCK TABLE chat_memory.chat_memories IN ACCESS EXCLUSIVE MODE",
      );
      await expect(
        readChatMemory({ telegram_chat_id: "31" }),
      ).rejects.toMatchObject({
        code: "DATABASE_TIMEOUT",
        timeoutStage: "lock",
      });
    } finally {
      await writer.query("ROLLBACK");
      writer.release();
      delete process.env.CHAT_MEMORY_LOCK_TIMEOUT_MS;
      await endPool();
    }
    expect(performance.now() - started).toBeLessThan(900);
    const idle = await getOwnerPool().query<{ blocked: string }>(
      `SELECT count(*)::text AS blocked
       FROM pg_stat_activity
       WHERE usename = 'chat_memory_reader' AND state = 'idle in transaction'`,
    );
    expect(idle.rows[0]?.blocked).toBe("0");
    await expect(
      readChatMemory({ telegram_chat_id: "31" }),
    ).resolves.toMatchObject({
      summary: null,
      pending_messages: [],
    });
  });

  it("returns one unavailable error for a closed database port", async () => {
    const original = process.env.DATABASE_URL;
    process.env.DATABASE_URL =
      "postgres://chat_memory_reader:chat-memory-reader-test@127.0.0.1:1/chat_memory_mcp_test";
    process.env.CHAT_MEMORY_CONNECTION_TIMEOUT_MS = "200";
    const started = performance.now();
    try {
      await expect(
        readChatMemory({ telegram_chat_id: "31" }),
      ).rejects.toMatchObject({
        code: expect.stringMatching(/^DATABASE_/),
      });
    } finally {
      process.env.DATABASE_URL = original;
      delete process.env.CHAT_MEMORY_CONNECTION_TIMEOUT_MS;
      await endPool();
    }
    expect(performance.now() - started).toBeLessThan(1_000);
    await expect(
      readChatMemory({ telegram_chat_id: "31" }),
    ).resolves.toBeTruthy();
  });

  it("cancels an in-flight read without leaving a transaction open", async () => {
    await seedChat({ chatId: "32" });
    process.env.CHAT_MEMORY_LOCK_TIMEOUT_MS = "1000";
    const writer = await getOwnerPool().connect();
    try {
      await writer.query("BEGIN");
      await writer.query(
        "LOCK TABLE chat_memory.chat_memories IN ACCESS EXCLUSIVE MODE",
      );
      const controller = new AbortController();
      const pending = readChatMemory(
        { telegram_chat_id: "32" },
        controller.signal,
      );
      setTimeout(() => controller.abort(), 40);
      await expect(pending).rejects.toMatchObject({
        code: "DATABASE_TIMEOUT",
        timeoutStage: "cancel",
      });
    } finally {
      await writer.query("ROLLBACK");
      writer.release();
      delete process.env.CHAT_MEMORY_LOCK_TIMEOUT_MS;
      await endPool();
    }
    const idle = await getOwnerPool().query<{ blocked: string }>(
      `SELECT count(*)::text AS blocked
       FROM pg_stat_activity
       WHERE usename = 'chat_memory_reader' AND state = 'idle in transaction'`,
    );
    expect(idle.rows[0]?.blocked).toBe("0");
  });
});
