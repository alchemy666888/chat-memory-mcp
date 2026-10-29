import {
  RAW_WINDOW_MAX_CODE_POINTS,
  RAW_WINDOW_MAX_MESSAGES,
  codePointLength,
  codePointSlice,
  type GetChatMemoryOutput,
} from "@/server/chat-memory/contracts";

export type PendingCandidate = {
  raw_message_id: string;
  event_key: string;
  turn_id: string;
  source_update_id: string;
  role: "user" | "assistant";
  content: string;
  occurred_at: string;
};

/**
 * `newestFirst` is the newest eligible pending rows, already limited to 50.
 * The character budget keeps a contiguous newest suffix. Only one oversized
 * newest row may be clipped. Older rows are included whole or omitted.
 */
export type PendingWindow = {
  messages: GetChatMemoryOutput["pending_messages"];
  returnedCharacters: number;
  hasMorePending: boolean;
};

export function buildPendingWindow(input: {
  newestFirst: PendingCandidate[];
  pendingCount: bigint;
}): PendingWindow {
  const newestFirst = input.newestFirst.slice(0, RAW_WINDOW_MAX_MESSAGES);
  const selected: GetChatMemoryOutput["pending_messages"] = [];
  let used = 0;
  let truncated = false;

  for (const [index, row] of newestFirst.entries()) {
    const length = codePointLength(row.content);
    if (index === 0 && length > RAW_WINDOW_MAX_CODE_POINTS) {
      selected.push({
        ...row,
        content: codePointSlice(row.content, RAW_WINDOW_MAX_CODE_POINTS),
        content_truncated: true,
      });
      used = RAW_WINDOW_MAX_CODE_POINTS;
      truncated = true;
      break;
    }
    if (used + length > RAW_WINDOW_MAX_CODE_POINTS) break;
    selected.push({ ...row, content_truncated: false });
    used += length;
  }

  const messages = selected.reverse();
  return {
    messages,
    returnedCharacters: used,
    hasMorePending: truncated || input.pendingCount > BigInt(messages.length),
  };
}
