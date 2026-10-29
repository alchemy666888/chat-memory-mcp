import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { handleMcp } from "@/app/api/mcp/route";
import { endPool } from "@/server/postgres/client";

const token = "boundary-read-token-value-0001";
const keys = [
  "DATABASE_URL",
  "CHAT_MEMORY_READ_TOKEN",
  "CHAT_MEMORY_ALLOWED_HOSTS",
  "CHAT_MEMORY_ALLOWED_ORIGINS",
  "CHAT_MEMORY_CONNECTION_TIMEOUT_MS",
  "AIVEN_PG_CA",
] as const;

const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

afterEach(async () => {
  for (const key of keys) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
  await endPool();
});

describe("HTTP authentication boundary", () => {
  it("rejects a missing token before opening a database connection", async () => {
    const hits = await listen(async (port) => {
      process.env.DATABASE_URL = `postgres://reader:secret@127.0.0.1:${port}/memory`;
      process.env.CHAT_MEMORY_READ_TOKEN = token;
      process.env.CHAT_MEMORY_ALLOWED_HOSTS = "memory.test";
      process.env.CHAT_MEMORY_ALLOWED_ORIGINS = "";
      process.env.CHAT_MEMORY_CONNECTION_TIMEOUT_MS = "300";
      const response = await handleMcp(
        new Request("http://memory.test/api/mcp", {
          method: "POST",
          headers: { host: "memory.test", "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        }),
      );
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = await response.text();
      expect(body).not.toContain("secret");
      expect(body).not.toContain("postgres");
    });
    expect(hits).toBe(0);
  });

  it("does not treat the process token as a reader", async () => {
    process.env.DATABASE_URL = "postgres://reader:secret@127.0.0.1:5432/memory";
    process.env.CHAT_MEMORY_READ_TOKEN = token;
    process.env.CHAT_MEMORY_ALLOWED_HOSTS = "memory.test";
    process.env.CHAT_MEMORY_ALLOWED_ORIGINS = "";
    const response = await handleMcp(
      new Request("http://memory.test/api/mcp", {
        method: "POST",
        headers: {
          host: "memory.test",
          authorization: "Bearer process-token-value-00000001",
        },
      }),
    );
    expect(response.status).toBe(401);
  });
});

async function listen(run: (port: number) => Promise<void>): Promise<number> {
  const sockets: net.Socket[] = [];
  let hits = 0;
  const server = net.createServer((socket) => {
    hits += 1;
    sockets.push(socket);
    socket.destroy();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  try {
    await run(address.port);
    return hits;
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}
