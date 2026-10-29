import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { handleMcp } from "@/app/api/mcp/route";
import { getChatMemoryOutputSchema } from "@/server/chat-memory/contracts";
import { endPool } from "@/server/postgres/client";
import { endOwnerPool, seedChat, truncateMemory } from "../helpers/database";

const readToken = process.env.CHAT_MEMORY_READ_TOKEN ?? "";

beforeEach(async () => {
  await truncateMemory();
});

afterAll(async () => {
  await endPool();
  await endOwnerPool();
});

describe("official MCP client", () => {
  it("negotiates, lists only get_chat_memory, and validates structured output", async () => {
    await seedChat({
      chatId: "123456789",
      summaryText: "The user prefers concise replies.",
      summaryVersion: "3",
      updatedAt: "2026-10-28T10:05:00.000Z",
      messages: [
        {
          eventKey: "tg:987654320:user",
          turnId: "tg:987654320",
          sourceUpdateId: "987654320",
          role: "user",
          content: "Use a friendly tone.",
          occurredAt: "2026-10-28T10:04:00.000Z",
        },
        {
          eventKey: "tg:987654321:user",
          turnId: "tg:987654321",
          sourceUpdateId: "987654321",
          role: "user",
          content: "current turn that must stay out",
          occurredAt: "2026-10-28T10:04:30.000Z",
        },
      ],
    });
    await seedChat({
      chatId: "555",
      messages: [
        {
          eventKey: "tg:1:user",
          turnId: "tg:1",
          sourceUpdateId: "1",
          role: "user",
          content: "secret-other-chat-content",
          occurredAt: "2026-10-28T10:04:00.000Z",
        },
      ],
    });

    const logs: string[] = [];
    const spy = vi
      .spyOn(console, "info")
      .mockImplementation((line: unknown) => {
        logs.push(String(line));
      });
    const modern = await connect({ mode: "auto" });
    try {
      expect(modern.client.getProtocolEra()).toBe("modern");
      const listed = await modern.client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([
        "get_chat_memory",
      ]);
      expect(listed.tools[0]?.annotations).toMatchObject({
        readOnlyHint: true,
        idempotentHint: true,
      });
      const result = await modern.client.callTool({
        name: "get_chat_memory",
        arguments: {
          telegram_chat_id: "123456789",
          exclude_turn_id: "tg:987654321",
        },
      });
      expect(result.isError).toBeFalsy();
      const output = getChatMemoryOutputSchema.parse(result.structuredContent);
      expect(output.summary?.text).toBe("The user prefers concise replies.");
      expect(output.pending_messages.map((row) => row.content)).toEqual([
        "Use a friendly tone.",
      ]);
      expect(output.window.returned_characters).toBe(20);
      expect(JSON.stringify(output)).not.toContain("secret-other-chat-content");

      const other = await modern.client.callTool({
        name: "get_chat_memory",
        arguments: { telegram_chat_id: "555" },
      });
      const otherOutput = getChatMemoryOutputSchema.parse(
        other.structuredContent,
      );
      expect(otherOutput.pending_messages.map((row) => row.content)).toEqual([
        "secret-other-chat-content",
      ]);
      expect(JSON.stringify(otherOutput)).not.toContain("friendly tone");
    } finally {
      await modern.client.close();
      spy.mockRestore();
    }

    const legacy = await connect();
    try {
      expect(legacy.client.getProtocolEra()).toBe("legacy");
      const listed = await legacy.client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([
        "get_chat_memory",
      ]);
    } finally {
      await legacy.client.close();
    }

    const serialized = logs.join("\n");
    expect(serialized).toContain("get_chat_memory");
    expect(serialized).not.toContain("Use a friendly tone.");
    expect(serialized).not.toContain("secret-other-chat-content");
    expect(serialized).not.toContain(readToken);
    expect(serialized).not.toContain("123456789");
    expect(serialized).not.toContain("DATABASE_URL");
    expect(serialized).not.toContain("postgres://");
  });

  it("rejects an unauthenticated client before returning an empty memory", async () => {
    const response = await handleMcp(
      new Request("http://memory.test/api/mcp", {
        method: "POST",
        headers: {
          host: "memory.test",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain("pending_messages");
  });
});

async function connect(options?: {
  mode?: "auto";
}): Promise<{ client: Client }> {
  const client = new Client(
    { name: "chat-memory-contract-test", version: "0.1.0" },
    options?.mode ? { versionNegotiation: { mode: options.mode } } : undefined,
  );
  const transport = new StreamableHTTPClientTransport(
    new URL("http://memory.test/api/mcp"),
    {
      requestInit: {
        headers: { authorization: `Bearer ${readToken}` },
      },
      fetch: async (input, init) => {
        const url = new URL(typeof input === "string" ? input : input.href);
        const headers = new Headers(init?.headers);
        if (!headers.has("host")) headers.set("host", url.host);
        return handleMcp(
          new Request(url, {
            method: init?.method ?? "GET",
            headers,
            body: init?.body,
          }),
        );
      },
    },
  );
  await client.connect(transport);
  return { client };
}
