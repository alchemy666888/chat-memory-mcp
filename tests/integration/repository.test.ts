import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { MemoryReadError } from "@/server/chat-memory/errors";
import { readChatMemory } from "@/server/chat-memory/repository";
import { endPool } from "@/server/postgres/client";
import {
  applyTestSchema,
  endOwnerPool,
  getOwnerPool,
  seedChat,
  truncateMemory,
  type SeedMessage,
} from "../helpers/database";

beforeEach(async () => {
  await truncateMemory();
});

afterAll(async () => {
  await endPool();
  await endOwnerPool();
});

describe("read-only snapshot repository", () => {
  it("returns an empty success for an unknown chat and pending rows for version 0", async () => {
    const unknown = await readChatMemory({ telegram_chat_id: "42" });
    expect(unknown.summary).toBeNull();
    expect(unknown.pending_messages).toEqual([]);
    expect(unknown.window).toEqual({
      returned_messages: 0,
      returned_characters: 0,
      has_more_pending: false,
    });

    await seedChat({
      chatId: "42",
      summaryVersion: "0",
      summaryText: "",
      messages: [message("1", "hello")],
    });
    const versionZero = await readChatMemory({ telegram_chat_id: "42" });
    expect(versionZero.summary).toBeNull();
    expect(versionZero.pending_messages.map((row) => row.content)).toEqual([
      "hello",
    ]);
  });

  it("excludes processed rows and the current turn before window limits", async () => {
    const pending = Array.from({ length: 50 }, (_, index) =>
      message(String(index + 1), `kept-${index + 1}`),
    );
    await seedChat({
      chatId: "7",
      summaryText: "Known preference.",
      summaryVersion: "2",
      updatedAt: "2026-10-28T10:05:00.000Z",
      messages: [
        ...pending,
        message("900", "processed-row", { status: "processed-completed" }),
        message("901", "current-turn", { turnId: "tg:901" }),
      ],
    });
    const memory = await readChatMemory({
      telegram_chat_id: "7",
      exclude_turn_id: "tg:901",
    });
    expect(memory.summary).toMatchObject({
      text: "Known preference.",
      version: "2",
    });
    expect(memory.pending_messages).toHaveLength(50);
    expect(memory.window.has_more_pending).toBe(false);
    const contents = memory.pending_messages.map((row) => row.content);
    expect(contents).not.toContain("processed-row");
    expect(contents).not.toContain("current-turn");
    expect(contents[0]).toBe("kept-1");
    expect(contents.at(-1)).toBe("kept-50");
  });

  it("returns the latest 50 of the remaining rows in chronological order", async () => {
    await seedChat({
      chatId: "8",
      summaryVersion: "1",
      summaryText: "Summary.",
      updatedAt: "2026-10-28T10:05:00.000Z",
      messages: [
        ...Array.from({ length: 51 }, (_, index) =>
          message(String(index + 1), `row-${index + 1}`),
        ),
        message("900", "exclude-me", { turnId: "tg:900" }),
      ],
    });
    const memory = await readChatMemory({
      telegram_chat_id: "8",
      exclude_turn_id: "tg:900",
    });
    expect(memory.pending_messages.map((row) => row.content)).toEqual(
      Array.from({ length: 50 }, (_, index) => `row-${index + 2}`),
    );
    expect(memory.window).toMatchObject({
      returned_messages: 50,
      has_more_pending: true,
    });
  });

  it("orders ties by source update, user before assistant, then raw id", async () => {
    await seedChat({
      chatId: "9",
      messages: [
        message("2", "assistant-same", {
          role: "assistant",
          occurredAt: "2026-10-28T10:00:00.000Z",
          eventKey: "tg:2:assistant",
        }),
        message("2", "user-same", {
          role: "user",
          occurredAt: "2026-10-28T10:00:00.000Z",
          eventKey: "tg:2:user",
        }),
        message("1", "earlier-update", {
          occurredAt: "2026-10-28T10:00:00.000Z",
        }),
      ],
    });
    const memory = await readChatMemory({ telegram_chat_id: "9" });
    expect(memory.pending_messages.map((row) => row.content)).toEqual([
      "earlier-update",
      "user-same",
      "assistant-same",
    ]);
  });

  it("clips one oversized newest row without changing the stored row", async () => {
    const stored = "😀".repeat(24_001);
    await seedChat({
      chatId: "11",
      summaryVersion: "1",
      summaryText: "Summary.",
      updatedAt: "2026-10-28T10:05:00.000Z",
      messages: [message("1", stored)],
    });
    const memory = await readChatMemory({ telegram_chat_id: "11" });
    expect(memory.pending_messages[0]?.content_truncated).toBe(true);
    expect([...(memory.pending_messages[0]?.content ?? "")].length).toBe(
      24_000,
    );
    expect(memory.window.has_more_pending).toBe(true);
    const persisted = await getOwnerPool().query<{
      content: string;
      status: string;
    }>(
      "SELECT content, status FROM chat_memory.raw_messages WHERE telegram_chat_id = $1",
      ["11"],
    );
    expect(persisted.rows[0]?.content).toBe(stored);
    expect(persisted.rows[0]?.status).toBe("non-process");
  });

  it("errors on an over-limit stored summary and keeps chats isolated", async () => {
    const owner = getOwnerPool();
    await owner.query(
      "ALTER TABLE chat_memory.chat_memories DROP CONSTRAINT chat_memories_summary_length",
    );
    try {
      await seedChat({
        chatId: "12",
        summaryVersion: "4",
        summaryText: "你".repeat(8001),
        updatedAt: "2026-10-28T10:05:00.000Z",
        messages: [message("1", "still pending")],
      });
      await expect(
        readChatMemory({ telegram_chat_id: "12" }),
      ).rejects.toMatchObject({ code: "INVALID_STORED_STATE" });
    } finally {
      await owner.query(
        "DELETE FROM chat_memory.raw_messages WHERE telegram_chat_id = $1",
        ["12"],
      );
      await owner.query(
        "DELETE FROM chat_memory.chat_memories WHERE telegram_chat_id = $1",
        ["12"],
      );
      await owner.query(
        "ALTER TABLE chat_memory.chat_memories ADD CONSTRAINT chat_memories_summary_length CHECK (char_length(summary_text) <= 8000)",
      );
    }

    await seedChat({
      chatId: "9223372036854775807",
      summaryVersion: "1",
      summaryText: "Big chat.",
      updatedAt: "2026-10-28T10:05:00.000Z",
      messages: [message("99", "bigint-chat")],
    });
    await seedChat({
      chatId: "-9223372036854775807",
      messages: [message("3", "other-chat")],
    });
    const memory = await readChatMemory({
      telegram_chat_id: "9223372036854775807",
    });
    expect(memory.telegram_chat_id).toBe("9223372036854775807");
    expect(memory.pending_messages.map((row) => row.content)).toEqual([
      "bigint-chat",
    ]);
    expect(memory.pending_messages[0]?.source_update_id).toBe("99");
    await expect(
      readChatMemory({ telegram_chat_id: "1 OR 1=1" }),
    ).rejects.toBeInstanceOf(MemoryReadError);
    const counts = await owner.query<{ chats: string }>(
      "SELECT count(*)::text AS chats FROM chat_memory.chat_memories",
    );
    expect(counts.rows[0]?.chats).toBe("2");
  });

  it("accepts summary lengths 7999 and 8000 and rejects an empty positive version", async () => {
    await seedChat({
      chatId: "13",
      summaryVersion: "1",
      summaryText: `😀${"你".repeat(7998)}`,
      updatedAt: "2026-10-28T10:05:00.000Z",
    });
    await seedChat({
      chatId: "14",
      summaryVersion: "2",
      summaryText: "你".repeat(8000),
      updatedAt: "2026-10-28T10:05:00.000Z",
    });
    await seedChat({
      chatId: "15",
      summaryVersion: "3",
      summaryText: "",
      updatedAt: "2026-10-28T10:05:00.000Z",
    });
    expect(
      (await readChatMemory({ telegram_chat_id: "13" })).summary?.text,
    ).toHaveLength(2 + 7998);
    expect(
      [
        ...((await readChatMemory({ telegram_chat_id: "14" })).summary?.text ??
          ""),
      ].length,
    ).toBe(8000);
    await expect(
      readChatMemory({ telegram_chat_id: "15" }),
    ).rejects.toMatchObject({ code: "INVALID_STORED_STATE" });
  });

  it("lets a SELECT-only role read and forbids writes and DDL", async () => {
    await seedChat({ chatId: "16", messages: [message("1", "readable")] });
    await expect(
      readChatMemory({ telegram_chat_id: "16" }),
    ).resolves.toMatchObject({
      pending_messages: [expect.objectContaining({ content: "readable" })],
    });
    const reader = await import("pg").then(
      (module) =>
        new module.default.Client({
          connectionString: process.env.DATABASE_URL,
        }),
    );
    await reader.connect();
    try {
      await expect(
        reader.query(
          "INSERT INTO chat_memory.chat_memories (telegram_chat_id) VALUES ('99')",
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        reader.query("CREATE TABLE chat_memory.forbidden_table (id int)"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        reader.query(
          "UPDATE chat_memory.chat_memories SET summary_text = 'x' WHERE telegram_chat_id = '16'",
        ),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await reader.end();
    }
  });

  it("reports a missing schema as an error", async () => {
    const owner = getOwnerPool();
    await owner.query("DROP SCHEMA chat_memory CASCADE");
    try {
      await expect(
        readChatMemory({ telegram_chat_id: "16" }),
      ).rejects.toMatchObject({ code: "SCHEMA_UNSUPPORTED" });
    } finally {
      const client = await owner.connect();
      try {
        await applyTestSchema(client);
      } finally {
        client.release();
      }
    }
  });
});

function message(
  sourceUpdateId: string,
  content: string,
  overrides: Partial<SeedMessage> = {},
): SeedMessage {
  return {
    eventKey:
      overrides.eventKey ?? `tg:${sourceUpdateId}:${overrides.role ?? "user"}`,
    turnId: overrides.turnId ?? `tg:${sourceUpdateId}`,
    sourceUpdateId,
    role: overrides.role ?? "user",
    content,
    occurredAt:
      overrides.occurredAt ??
      new Date(
        Date.UTC(2026, 9, 28, 0, 0, Number(sourceUpdateId)),
      ).toISOString(),
    ...overrides,
  };
}
