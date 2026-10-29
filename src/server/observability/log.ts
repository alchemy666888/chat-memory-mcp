import { createHmac } from "node:crypto";
import type { TimeoutStage } from "@/server/chat-memory/errors";

export type MemoryLogRecord = {
  requestId: string;
  tool: "get_chat_memory";
  result: string;
  elapsedMs: number;
  returnedMessages?: number;
  returnedCharacters?: number;
  timeoutStage?: TimeoutStage;
  chatKey?: string;
};

const credentialUrl = /[a-z][a-z0-9+.-]*:\/\/[^\s/@]*:[^\s/@]*@/gi;
const secretText =
  /(bearer\s+\S+|sk-[A-Za-z0-9_-]{8,}|(?:password|secret|api[_-]?key)\s*[:=]\s*\S+)/gi;

export function redactLogText(value: string): string {
  return value
    .replace(credentialUrl, "[REDACTED]")
    .replace(secretText, "[REDACTED]")
    .slice(0, 200);
}

export function chatLogKey(chatId: string, secret: string): string {
  return createHmac("sha256", secret).update(chatId).digest("hex").slice(0, 16);
}

export function logMemoryLookup(record: MemoryLogRecord): void {
  const line = JSON.stringify({
    component: "chat-memory-mcp",
    requestId: record.requestId,
    tool: record.tool,
    result: record.result,
    elapsedMs: record.elapsedMs,
    returnedMessages: record.returnedMessages ?? null,
    returnedCharacters: record.returnedCharacters ?? null,
    timeoutStage: record.timeoutStage ?? null,
    chatKey: record.chatKey ?? null,
  });
  console.info(line);
}

export function logOperational(record: {
  requestId: string;
  result: string;
  elapsedMs: number;
  field?: string;
}): void {
  console.info(
    JSON.stringify({
      component: "chat-memory-mcp",
      requestId: record.requestId,
      tool: "mcp",
      result: record.result,
      elapsedMs: record.elapsedMs,
      field: record.field ?? null,
    }),
  );
}
