import { describe, expect, it } from "vitest";
import {
  RAW_WINDOW_MAX_CODE_POINTS,
  codePointLength,
  codePointSlice,
} from "@/server/chat-memory/contracts";
import {
  buildPendingWindow,
  type PendingCandidate,
} from "@/server/chat-memory/window";

function row(
  content: string,
  overrides: Partial<PendingCandidate> = {},
): PendingCandidate {
  return {
    raw_message_id: "1",
    event_key: "tg:1:user",
    turn_id: "tg:1",
    source_update_id: "1",
    role: "user",
    content,
    occurred_at: "2026-10-28T10:00:00.000Z",
    ...overrides,
  };
}

describe("unicode code points", () => {
  it("counts emoji and CJK as code points", () => {
    expect(codePointLength("你")).toBe(1);
    expect(codePointLength("😀")).toBe(1);
    expect("😀".length).toBe(2);
    expect(codePointLength("Use a friendly tone.")).toBe(20);
    const sliced = codePointSlice("😀".repeat(3), 2);
    expect(codePointLength(sliced)).toBe(2);
    expect(sliced).toBe("😀😀");
    expect([...sliced].every((character) => character === "😀")).toBe(true);
  });
});

describe("buildPendingWindow", () => {
  it("returns the newest rows chronologically within the budget", () => {
    const oldest = row("old", {
      raw_message_id: "1",
      occurred_at: "2026-10-28T10:00:00.000Z",
    });
    const middle = row("mid", {
      raw_message_id: "2",
      occurred_at: "2026-10-28T10:01:00.000Z",
    });
    const newest = row("new", {
      raw_message_id: "3",
      occurred_at: "2026-10-28T10:02:00.000Z",
    });
    const window = buildPendingWindow({
      newestFirst: [newest, middle, oldest],
      pendingCount: 3n,
    });
    expect(window.messages.map((message) => message.content)).toEqual([
      "old",
      "mid",
      "new",
    ]);
    expect(window.returnedCharacters).toBe(9);
    expect(window.hasMorePending).toBe(false);
    expect(window.messages.every((message) => !message.content_truncated)).toBe(
      true,
    );
  });

  it("holds the 23999, 24000, and 24001 code-point boundaries", () => {
    const almost = buildPendingWindow({
      newestFirst: [row("你".repeat(23_999))],
      pendingCount: 1n,
    });
    expect(almost.returnedCharacters).toBe(23_999);
    expect(almost.hasMorePending).toBe(false);
    expect(almost.messages[0]?.content_truncated).toBe(false);

    const exact = buildPendingWindow({
      newestFirst: [
        row("😀".repeat(24_000)),
        row("x", { raw_message_id: "2" }),
      ],
      pendingCount: 2n,
    });
    expect(exact.messages).toHaveLength(1);
    expect(codePointLength(exact.messages[0]?.content ?? "")).toBe(24_000);
    expect(exact.messages[0]?.content_truncated).toBe(false);
    expect(exact.hasMorePending).toBe(true);

    const over = buildPendingWindow({
      newestFirst: [row("😀".repeat(24_001))],
      pendingCount: 1n,
    });
    expect(codePointLength(over.messages[0]?.content ?? "")).toBe(
      RAW_WINDOW_MAX_CODE_POINTS,
    );
    expect(over.messages[0]?.content_truncated).toBe(true);
    expect(over.hasMorePending).toBe(true);
    expect(over.messages[0]?.content.endsWith("😀")).toBe(true);
  });

  it("omits an older oversized row instead of clipping it", () => {
    const window = buildPendingWindow({
      newestFirst: [
        row("new"),
        row("你".repeat(24_000), { raw_message_id: "2" }),
      ],
      pendingCount: 2n,
    });
    expect(window.messages.map((message) => message.content)).toEqual(["new"]);
    expect(window.messages[0]?.content_truncated).toBe(false);
    expect(window.hasMorePending).toBe(true);
  });

  it("reports rows omitted by the 50-message cap", () => {
    const window = buildPendingWindow({
      newestFirst: [row("only")],
      pendingCount: 51n,
    });
    expect(window.messages).toHaveLength(1);
    expect(window.hasMorePending).toBe(true);
  });
});
