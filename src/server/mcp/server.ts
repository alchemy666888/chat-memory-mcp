import "server-only";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import {
  getChatMemoryInputSchema,
  getChatMemoryOutputSchema,
} from "@/server/chat-memory/contracts";
import { MemoryReadError } from "@/server/chat-memory/errors";
import { readChatMemory } from "@/server/chat-memory/repository";
import { chatLogKey, logMemoryLookup } from "@/server/observability/log";
import { currentRequest } from "@/server/observability/request-context";

export const SERVER_NAME = "chat-memory-mcp";
export const SERVER_VERSION = "0.1.0";

export function createChatMemoryServer(): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });
  server.registerTool(
    "get_chat_memory",
    {
      title: "Get chat memory",
      description:
        "Read one Telegram chat's cumulative summary and the bounded pending raw-message window. This tool does not modify stored memory.",
      inputSchema: getChatMemoryInputSchema,
      outputSchema: getChatMemoryOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      const context = currentRequest();
      const started = context?.started ?? performance.now();
      const requestId = context?.requestId ?? "missing-request";
      try {
        const memory = await readChatMemory(
          {
            telegram_chat_id: args.telegram_chat_id,
            ...(args.exclude_turn_id
              ? { exclude_turn_id: args.exclude_turn_id }
              : {}),
          },
          context?.signal,
        );
        if (context) context.logged = true;
        logMemoryLookup({
          requestId,
          tool: "get_chat_memory",
          result: "ok",
          elapsedMs: elapsed(started),
          returnedMessages: memory.window.returned_messages,
          returnedCharacters: memory.window.returned_characters,
          ...(context
            ? {
                chatKey: chatLogKey(memory.telegram_chat_id, context.readToken),
              }
            : {}),
        });
        return {
          structuredContent: memory,
          content: [{ type: "text", text: JSON.stringify(memory) }],
        };
      } catch (error) {
        const failure =
          error instanceof MemoryReadError
            ? error
            : new MemoryReadError("INTERNAL", null);
        if (context) context.logged = true;
        logMemoryLookup({
          requestId,
          tool: "get_chat_memory",
          result: failure.code,
          elapsedMs: elapsed(started),
          timeoutStage: failure.timeoutStage,
          ...(context
            ? {
                chatKey: chatLogKey(args.telegram_chat_id, context.readToken),
              }
            : {}),
        });
        return {
          isError: true,
          content: [{ type: "text", text: failure.code }],
        };
      }
    },
  );
  return server;
}

export const mcpHandler = createMcpHandler(() => createChatMemoryServer(), {
  responseMode: "json",
  legacy: "stateless",
});

function elapsed(started: number): number {
  return Math.max(0, Math.round(performance.now() - started));
}
