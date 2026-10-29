import { defineConfig } from "@playwright/test";

const readerUrl =
  process.env.CHAT_MEMORY_TEST_READER_URL ??
  "postgres://chat_memory_reader:chat-memory-reader-test@127.0.0.1:5432/chat_memory_mcp_test";

export default defineConfig({
  testDir: "tests/e2e",
  use: { baseURL: "http://127.0.0.1:3100" },
  webServer: {
    command: "pnpm start --port 3100",
    url: "http://127.0.0.1:3100/api/health",
    timeout: 120_000,
    reuseExistingServer: false,
    env: {
      DATABASE_URL: readerUrl,
      CHAT_MEMORY_READ_TOKEN: "integration-read-token-00000001",
      CHAT_MEMORY_ALLOWED_HOSTS: "127.0.0.1",
      CHAT_MEMORY_ALLOWED_ORIGINS: "",
    },
  },
});
