import { describe, expect, it } from "vitest";
import { ConfigurationError } from "@/server/chat-memory/errors";
import { postgresPoolConfig } from "@/server/postgres/client";
import {
  normalizeCertificate,
  normalizePostgresUrl,
  readDatabaseSettings,
} from "@/server/postgres/config";

const base = {
  DATABASE_URL: "postgres://reader:secret@db.example:5432/memory",
  CHAT_MEMORY_POOL_MAX: "3",
  CHAT_MEMORY_CONNECTION_TIMEOUT_MS: "300",
  CHAT_MEMORY_LOCK_TIMEOUT_MS: "400",
  CHAT_MEMORY_STATEMENT_TIMEOUT_MS: "1500",
  CHAT_MEMORY_QUERY_TIMEOUT_MS: "1700",
  CHAT_MEMORY_IDLE_TIMEOUT_MS: "10000",
};

describe("postgres configuration", () => {
  it("normalizes loose ssl modes and certificates without disabling verification", () => {
    expect(
      normalizePostgresUrl(
        "postgres://reader:secret@db.example:5432/memory?sslmode=require",
      ),
    ).toContain("sslmode=verify-full");
    const pem = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";
    expect(normalizeCertificate(pem.replace(/\n/g, "\\n"))).toBe(pem);
    expect(normalizeCertificate(Buffer.from(pem).toString("base64"))).toBe(pem);

    const settings = readDatabaseSettings({
      ...base,
      DATABASE_URL:
        "postgres://reader:secret@db.example:5432/memory?sslmode=require",
      AIVEN_PG_CA: Buffer.from(pem).toString("base64"),
    });
    const pool = postgresPoolConfig(settings);
    expect(pool.connectionString).not.toContain("sslmode");
    expect(pool.ssl).toEqual({ ca: pem, rejectUnauthorized: true });
    expect(JSON.stringify(pool)).not.toContain('rejectUnauthorized":false');
  });

  it("rejects timeout budgets that can exceed the caller deadline", () => {
    expect(() =>
      readDatabaseSettings({
        ...base,
        CHAT_MEMORY_STATEMENT_TIMEOUT_MS: "1600",
        CHAT_MEMORY_CONNECTION_TIMEOUT_MS: "500",
        CHAT_MEMORY_QUERY_TIMEOUT_MS: "1800",
      }),
    ).toThrow(ConfigurationError);
  });
});
