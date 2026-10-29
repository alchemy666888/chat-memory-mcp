import { z } from "zod";
import { ConfigurationError } from "@/server/chat-memory/errors";

const databaseSchema = z.object({
  DATABASE_URL: z
    .string()
    .trim()
    .pipe(z.url({ protocol: /^postgres(ql)?$/ }))
    .transform(normalizePostgresUrl),
  AIVEN_PG_CA: z
    .string()
    .trim()
    .optional()
    .transform((value) => {
      if (value === undefined || value === "") return undefined;
      return normalizeCertificate(value);
    }),
});

/**
 * Keep node-postgres on its current, strict TLS behavior without relying on
 * sslmode aliases whose meaning changes in pg v9.
 */
export function normalizePostgresUrl(connectionString: string): string {
  const url = new URL(connectionString);
  const sslmode = url.searchParams.get("sslmode")?.toLowerCase();
  const usesLibpqCompatibility =
    url.searchParams.get("uselibpqcompat")?.toLowerCase() === "true";
  if (
    !usesLibpqCompatibility &&
    ["prefer", "require", "verify-ca"].includes(sslmode ?? "")
  )
    url.searchParams.set("sslmode", "verify-full");
  return url.toString();
}

/**
 * Vercel stores pasted PEMs with literal "\n", and a real multiline value
 * cannot travel in a sandbox command environment without splitting later
 * variables. Callers that forward this to the worker base64-encode it.
 */
export function normalizeCertificate(value: string): string {
  const expanded = value.includes("\\n") ? value.replace(/\\n/g, "\n") : value;
  const trimmed = expanded.trim();
  if (trimmed.includes("BEGIN CERTIFICATE")) return trimmed;
  const decoded = Buffer.from(trimmed, "base64").toString("utf8").trim();
  if (decoded.includes("BEGIN CERTIFICATE")) return decoded;
  return trimmed;
}

const TIMEOUT_BOUNDS = {
  CHAT_MEMORY_POOL_MAX: { fallback: 3, min: 1, max: 5 },
  CHAT_MEMORY_CONNECTION_TIMEOUT_MS: { fallback: 300, min: 100, max: 500 },
  CHAT_MEMORY_LOCK_TIMEOUT_MS: { fallback: 400, min: 50, max: 1000 },
  CHAT_MEMORY_STATEMENT_TIMEOUT_MS: { fallback: 1500, min: 200, max: 1600 },
  CHAT_MEMORY_QUERY_TIMEOUT_MS: { fallback: 1700, min: 300, max: 1800 },
  CHAT_MEMORY_IDLE_TIMEOUT_MS: { fallback: 10_000, min: 1000, max: 60_000 },
} as const;

export type DatabaseSettings = {
  connectionString: string;
  certificateAuthority?: string;
  poolMax: number;
  connectionTimeoutMs: number;
  lockTimeoutMs: number;
  statementTimeoutMs: number;
  queryTimeoutMs: number;
  idleTimeoutMs: number;
};

export function readDatabaseSettings(
  env: Record<string, string | undefined> = process.env,
): DatabaseSettings {
  let parsed: z.infer<typeof databaseSchema>;
  try {
    parsed = databaseSchema.parse(env);
  } catch {
    throw new ConfigurationError("DATABASE_URL");
  }
  if (
    parsed.AIVEN_PG_CA !== undefined &&
    !parsed.AIVEN_PG_CA.includes("BEGIN CERTIFICATE")
  ) {
    throw new ConfigurationError("AIVEN_PG_CA");
  }

  const poolMax = boundedInteger(env, "CHAT_MEMORY_POOL_MAX");
  const connectionTimeoutMs = boundedInteger(
    env,
    "CHAT_MEMORY_CONNECTION_TIMEOUT_MS",
  );
  const lockTimeoutMs = boundedInteger(env, "CHAT_MEMORY_LOCK_TIMEOUT_MS");
  const statementTimeoutMs = boundedInteger(
    env,
    "CHAT_MEMORY_STATEMENT_TIMEOUT_MS",
  );
  const queryTimeoutMs = boundedInteger(env, "CHAT_MEMORY_QUERY_TIMEOUT_MS");
  const idleTimeoutMs = boundedInteger(env, "CHAT_MEMORY_IDLE_TIMEOUT_MS");

  if (queryTimeoutMs < statementTimeoutMs) {
    throw new ConfigurationError("CHAT_MEMORY_QUERY_TIMEOUT_MS");
  }
  if (connectionTimeoutMs + statementTimeoutMs > 1900) {
    throw new ConfigurationError("CHAT_MEMORY_STATEMENT_TIMEOUT_MS");
  }

  return {
    connectionString: parsed.DATABASE_URL,
    ...(parsed.AIVEN_PG_CA ? { certificateAuthority: parsed.AIVEN_PG_CA } : {}),
    poolMax,
    connectionTimeoutMs,
    lockTimeoutMs,
    statementTimeoutMs,
    queryTimeoutMs,
    idleTimeoutMs,
  };
}

function boundedInteger(
  env: Record<string, string | undefined>,
  name: keyof typeof TIMEOUT_BOUNDS,
): number {
  const bounds = TIMEOUT_BOUNDS[name];
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return bounds.fallback;
  if (!/^\d+$/.test(raw.trim())) throw new ConfigurationError(name);
  const value = Number(raw.trim());
  if (value < bounds.min || value > bounds.max)
    throw new ConfigurationError(name);
  return value;
}
