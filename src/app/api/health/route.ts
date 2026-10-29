import { MemoryReadError } from "@/server/chat-memory/errors";
import { probeSchema } from "@/server/chat-memory/repository";
import { readAccessSettings } from "@/server/mcp/security";
import { readDatabaseSettings } from "@/server/postgres/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 5;

type HealthBody = {
  status: "ready" | "degraded";
  configuration: "ready" | "invalid";
  database: "ready" | "unavailable" | "schema_missing" | "skipped";
};

export async function GET(): Promise<Response> {
  try {
    readDatabaseSettings();
    readAccessSettings();
  } catch {
    return health({
      status: "degraded",
      configuration: "invalid",
      database: "skipped",
    });
  }

  try {
    const database = await probeSchema();
    return health({
      status: database === "ready" ? "ready" : "degraded",
      configuration: "ready",
      database,
    });
  } catch (error) {
    const database =
      error instanceof MemoryReadError && error.code === "SCHEMA_UNSUPPORTED"
        ? "schema_missing"
        : "unavailable";
    return health({
      status: "degraded",
      configuration: "ready",
      database,
    });
  }
}

function health(body: HealthBody): Response {
  return Response.json(body, {
    status: body.status === "ready" ? 200 : 503,
    headers: { "cache-control": "no-store" },
  });
}
