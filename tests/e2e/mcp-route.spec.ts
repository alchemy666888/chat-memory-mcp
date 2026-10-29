import { expect, test } from "@playwright/test";

test("health and unauthenticated MCP route stay free of chat data", async ({
  request,
}) => {
  const health = await request.get("/api/health");
  expect(health.status()).toBe(200);
  const body = await health.json();
  expect(body).toEqual({
    status: "ready",
    configuration: "ready",
    database: "ready",
  });
  expect(JSON.stringify(body)).not.toContain("postgres");

  const denied = await request.post("/api/mcp", {
    data: { jsonrpc: "2.0", id: 1, method: "tools/list" },
  });
  expect(denied.status()).toBe(401);
  expect(denied.headers()["cache-control"]).toContain("no-store");
  expect(await denied.text()).not.toContain("pending_messages");
});
