import { describe, expect, it } from "vitest";
import { ConfigurationError } from "@/server/chat-memory/errors";
import { authorizeRequest, readAccessSettings } from "@/server/mcp/security";

const token = "unit-read-token-value-000001";
const access = {
  readToken: token,
  allowedHosts: ["memory.test"],
  allowedOrigins: ["https://memory.example"],
};

function call(headers: Record<string, string>): Request {
  return new Request("http://memory.test/api/mcp", {
    method: "POST",
    headers,
  });
}

describe("access policy", () => {
  it("rejects a missing, wrong, or non-read token", () => {
    expect(
      authorizeRequest(call({ host: "memory.test" }), access)?.status,
    ).toBe(401);
    expect(
      authorizeRequest(
        call({
          host: "memory.test",
          authorization: "Bearer ingest-token-value-0000000001",
        }),
        access,
      )?.status,
    ).toBe(401);
    expect(
      authorizeRequest(
        call({ host: "memory.test", authorization: `Basic ${token}` }),
        access,
      )?.status,
    ).toBe(401);
  });

  it("allows an absent origin and rejects an unlisted present origin", () => {
    expect(
      authorizeRequest(
        call({ host: "memory.test", authorization: `Bearer ${token}` }),
        access,
      ),
    ).toBeNull();
    const rejected = authorizeRequest(
      call({
        host: "memory.test",
        authorization: `Bearer ${token}`,
        origin: "https://evil.example",
      }),
      access,
    );
    expect(rejected?.status).toBe(403);
    return expect(rejected?.text()).resolves.toContain("forbidden_origin");
  });

  it("rejects every present origin when the allowlist is empty", () => {
    const closed = { ...access, allowedOrigins: [] };
    expect(
      authorizeRequest(
        call({
          host: "memory.test",
          authorization: `Bearer ${token}`,
          origin: "https://memory.example",
        }),
        closed,
      )?.status,
    ).toBe(403);
    expect(
      authorizeRequest(
        call({ host: "memory.test", authorization: `Bearer ${token}` }),
        closed,
      ),
    ).toBeNull();
  });

  it("ignores forwarded host and rejects an unlisted host", () => {
    const rejected = authorizeRequest(
      call({
        host: "evil.example",
        "x-forwarded-host": "memory.test",
        authorization: `Bearer ${token}`,
      }),
      access,
    );
    expect(rejected?.status).toBe(403);
  });

  it("rejects wildcard origin and host configuration", () => {
    expect(() =>
      readAccessSettings({
        CHAT_MEMORY_READ_TOKEN: token,
        CHAT_MEMORY_ALLOWED_HOSTS: "*",
        CHAT_MEMORY_ALLOWED_ORIGINS: "",
      }),
    ).toThrow(ConfigurationError);
    expect(() =>
      readAccessSettings({
        CHAT_MEMORY_READ_TOKEN: token,
        CHAT_MEMORY_ALLOWED_HOSTS: "memory.test",
        CHAT_MEMORY_ALLOWED_ORIGINS: "https://*",
      }),
    ).toThrow(ConfigurationError);
  });
});
