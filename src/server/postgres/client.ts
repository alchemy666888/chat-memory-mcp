import "server-only";
import { Pool, type PoolClient, type PoolConfig } from "pg";
import {
  MemoryReadError,
  type TimeoutStage,
} from "@/server/chat-memory/errors";
import {
  readDatabaseSettings,
  type DatabaseSettings,
} from "@/server/postgres/config";

const SCHEMA_CODES = new Set(["42P01", "3F000", "42703", "42883"]);

let pool: Pool | undefined;
let poolKey = "";

/** Builds a TLS configuration without allowing URL SSL options to replace the CA. */
export function postgresPoolConfig(settings: DatabaseSettings): PoolConfig {
  const shared: PoolConfig = {
    max: settings.poolMax,
    allowExitOnIdle: true,
    connectionTimeoutMillis: settings.connectionTimeoutMs,
    idleTimeoutMillis: settings.idleTimeoutMs,
    statement_timeout: settings.statementTimeoutMs,
    lock_timeout: settings.lockTimeoutMs,
    query_timeout: settings.queryTimeoutMs,
    application_name: "chat-memory-mcp",
  };
  if (!settings.certificateAuthority) {
    return { ...shared, connectionString: settings.connectionString };
  }

  const url = new URL(settings.connectionString);
  // node-postgres replaces an explicit `ssl` object when SSL query parameters
  // are also present, which would silently discard the Aiven CA.
  for (const parameter of ["sslmode", "sslcert", "sslkey", "sslrootcert"]) {
    url.searchParams.delete(parameter);
  }
  return {
    ...shared,
    connectionString: url.toString(),
    ssl: { ca: settings.certificateAuthority, rejectUnauthorized: true },
  };
}

export async function getPool(settings: DatabaseSettings): Promise<Pool> {
  const key = poolCacheKey(settings);
  if (pool && poolKey === key) return pool;
  if (pool) {
    const previous = pool;
    pool = undefined;
    poolKey = "";
    await previous.end();
  }
  const created = new Pool(postgresPoolConfig(settings));
  created.on("error", () => {
    // Idle-client failures must not print the connection string.
  });
  pool = created;
  poolKey = key;
  return created;
}

export async function endPool(): Promise<void> {
  if (!pool) return;
  const previous = pool;
  pool = undefined;
  poolKey = "";
  await previous.end();
}

/**
 * One repeatable-read, read-only transaction. The caller runs a single data
 * statement so the summary and pending rows share one snapshot.
 */
export async function withReadSnapshot<T>(
  run: (client: PoolClient) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const settings = readDatabaseSettings();
  if (signal?.aborted) throw new MemoryReadError("DATABASE_TIMEOUT", "cancel");

  let client: PoolClient;
  try {
    client = await connectWithSignal(await getPool(settings), signal);
    ensureClientErrorListener(client);
  } catch (error) {
    if (error instanceof MemoryReadError) throw error;
    throw mapDatabaseError(error, "connect");
  }

  let discard = false;
  const onAbort = () => {
    discard = true;
    destroyClient(client);
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    if (signal?.aborted)
      throw new MemoryReadError("DATABASE_TIMEOUT", "cancel");
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SELECT set_config('statement_timeout', $1, true)", [
      `${settings.statementTimeoutMs}ms`,
    ]);
    await client.query("SELECT set_config('lock_timeout', $1, true)", [
      `${settings.lockTimeoutMs}ms`,
    ]);
    await client.query(
      "SELECT set_config('idle_in_transaction_session_timeout', $1, true)",
      [`${settings.statementTimeoutMs + 500}ms`],
    );
    await client.query("SELECT set_config('TimeZone', 'UTC', true)");
    const value = await run(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    if (isQueryReadTimeout(error)) discard = true;
    if (!discard) {
      try {
        await client.query("ROLLBACK");
      } catch {
        discard = true;
      }
    }
    if (signal?.aborted)
      throw new MemoryReadError("DATABASE_TIMEOUT", "cancel");
    if (error instanceof MemoryReadError) throw error;
    throw mapDatabaseError(error, null);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    client.release(discard ? new Error("discard") : undefined);
  }
}

function poolCacheKey(settings: DatabaseSettings): string {
  return JSON.stringify([
    settings.connectionString,
    settings.certificateAuthority ?? "",
    settings.poolMax,
    settings.connectionTimeoutMs,
    settings.lockTimeoutMs,
    settings.statementTimeoutMs,
    settings.queryTimeoutMs,
    settings.idleTimeoutMs,
  ]);
}

function connectWithSignal(
  pool: Pool,
  signal?: AbortSignal,
): Promise<PoolClient> {
  if (signal?.aborted) {
    return Promise.reject(new MemoryReadError("DATABASE_TIMEOUT", "cancel"));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      reject(new MemoryReadError("DATABASE_TIMEOUT", "cancel"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    pool.connect().then(
      (connected) => {
        signal?.removeEventListener("abort", onAbort);
        if (signal?.aborted) {
          connected.release(new Error("discard"));
          reject(new MemoryReadError("DATABASE_TIMEOUT", "cancel"));
          return;
        }
        resolve(connected);
      },
      (error: unknown) => {
        signal?.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

const swallowClientError = () => undefined;

function ensureClientErrorListener(client: PoolClient): void {
  if (!client.listeners("error").includes(swallowClientError)) {
    client.on("error", swallowClientError);
  }
}

function destroyClient(client: PoolClient): void {
  const connection = (
    client as PoolClient & {
      connection?: { stream?: { destroy: () => void } };
    }
  ).connection;
  connection?.stream?.destroy();
}

function isQueryReadTimeout(error: unknown): boolean {
  return error instanceof Error && /query read timeout/i.test(error.message);
}

function mapDatabaseError(
  error: unknown,
  stage: TimeoutStage,
): MemoryReadError {
  if (error instanceof MemoryReadError) return error;
  const code = pgCode(error);
  if (code === "55P03") return new MemoryReadError("DATABASE_TIMEOUT", "lock");
  if (code === "57014") return new MemoryReadError("DATABASE_TIMEOUT", "query");
  if (code && SCHEMA_CODES.has(code)) {
    return new MemoryReadError("SCHEMA_UNSUPPORTED", null);
  }
  const message = error instanceof Error ? error.message : "";
  if (isQueryReadTimeout(error)) {
    return new MemoryReadError("DATABASE_TIMEOUT", "query");
  }
  if (/timeout/i.test(message)) {
    return new MemoryReadError(
      "DATABASE_TIMEOUT",
      stage === "connect" ? "connect" : "query",
    );
  }
  return new MemoryReadError("DATABASE_UNAVAILABLE", stage);
}

function pgCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}
