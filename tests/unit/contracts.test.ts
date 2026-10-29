import { describe, expect, it } from "vitest";
import {
  SUMMARY_CODE_POINT_LIMIT,
  getChatMemoryInputSchema,
  getChatMemoryOutputSchema,
  summarySchema,
} from "@/server/chat-memory/contracts";

const timestamp = "2026-10-28T10:05:00.000Z";

describe("shared contract schemas", () => {
  it("accepts canonical bigint chat ids and rejects malformed ids", () => {
    expect(
      getChatMemoryInputSchema.parse({
        telegram_chat_id: "9223372036854775807",
        exclude_turn_id: "tg:987654321",
      }).telegram_chat_id,
    ).toBe("9223372036854775807");
    expect(
      getChatMemoryInputSchema.safeParse({
        telegram_chat_id: "-9223372036854775808",
      }).success,
    ).toBe(true);
    for (const telegram_chat_id of [
      "0",
      "-0",
      "01",
      "+1",
      "1.5",
      "1e2",
      "9223372036854775808",
      "-9223372036854775809",
      "1; drop table raw_messages",
      "",
    ]) {
      expect(
        getChatMemoryInputSchema.safeParse({ telegram_chat_id }).success,
      ).toBe(false);
    }
  });

  it("rejects unknown input fields", () => {
    expect(
      getChatMemoryInputSchema.safeParse({
        telegram_chat_id: "123",
        limit: 10,
      }).success,
    ).toBe(false);
  });

  it("enforces the 7999, 8000, and 8001 summary boundaries", () => {
    expect(
      summarySchema.safeParse({
        text: `😀${"你".repeat(7998)}`,
        version: "3",
        updated_at: timestamp,
      }).success,
    ).toBe(true);
    expect(
      summarySchema.safeParse({
        text: "你".repeat(SUMMARY_CODE_POINT_LIMIT),
        version: "3",
        updated_at: timestamp,
      }).success,
    ).toBe(true);
    expect(
      summarySchema.safeParse({
        text: "😀".repeat(SUMMARY_CODE_POINT_LIMIT + 1),
        version: "3",
        updated_at: timestamp,
      }).success,
    ).toBe(false);
  });

  it("computes example window counts from the example content", () => {
    const content = "Use a friendly tone.";
    const parsed = getChatMemoryOutputSchema.parse({
      contract_version: 1,
      telegram_chat_id: "123456789",
      summary: {
        text: "The user prefers concise replies.",
        version: "3",
        updated_at: timestamp,
      },
      pending_messages: [
        {
          raw_message_id: "91",
          event_key: "tg:987654320:user",
          turn_id: "tg:987654320",
          source_update_id: "987654320",
          role: "user",
          content,
          occurred_at: "2026-10-28T10:04:00.000Z",
          content_truncated: false,
        },
      ],
      window: {
        returned_messages: 1,
        returned_characters: [...content].length,
        has_more_pending: false,
      },
    });
    expect(parsed.window.returned_characters).toBe(20);
  });
});
