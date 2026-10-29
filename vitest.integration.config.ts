import path from "node:path";
import { defineConfig } from "vitest/config";

const readerUrl =
  process.env.CHAT_MEMORY_TEST_READER_URL ??
  "postgres://chat_memory_reader:chat-memory-reader-test@127.0.0.1:5432/chat_memory_mcp_test";

export default defineConfig({
  resolve: {
    alias: {
      "server-only": path.resolve("./tests/mocks/server-only.ts"),
      "@": path.resolve("./src"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts", "tests/contracts/**/*.test.ts"],
    fileParallelism: false,
    globalSetup: ["./tests/helpers/global-setup.ts"],
    hookTimeout: 30_000,
    testTimeout: 20_000,
    env: {
      DATABASE_URL: readerUrl,
      CHAT_MEMORY_READ_TOKEN: "integration-read-token-00000001",
      CHAT_MEMORY_ALLOWED_HOSTS: "memory.test,127.0.0.1",
      CHAT_MEMORY_ALLOWED_ORIGINS: "https://memory.example",
      CHAT_MEMORY_POOL_MAX: "3",
      CHAT_MEMORY_CONNECTION_TIMEOUT_MS: "300",
      CHAT_MEMORY_LOCK_TIMEOUT_MS: "400",
      CHAT_MEMORY_STATEMENT_TIMEOUT_MS: "1500",
      CHAT_MEMORY_QUERY_TIMEOUT_MS: "1700",
      CHAT_MEMORY_IDLE_TIMEOUT_MS: "10000",
    },
  },
});
