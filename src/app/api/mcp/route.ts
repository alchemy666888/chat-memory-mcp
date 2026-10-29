import { mcpHandler } from "@/server/mcp/server";
import { authorizeRequest, readAccessSettings } from "@/server/mcp/security";
import { ConfigurationError } from "@/server/chat-memory/errors";
import { readDatabaseSettings } from "@/server/postgres/config";
import { logOperational } from "@/server/observability/log";
import { requestStore } from "@/server/observability/request-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 5;

const requestIdPattern = /^[A-Za-z0-9._:-]{1,80}$/;

export function GET(request: Request): Promise<Response> {
  return handleMcp(request);
}

export function POST(request: Request): Promise<Response> {
  return handleMcp(request);
}

export function DELETE(request: Request): Promise<Response> {
  return handleMcp(request);
}

export async function handleMcp(request: Request): Promise<Response> {
  const started = performance.now();
  const requestId = resolveRequestId(request);
  let access;
  try {
    readDatabaseSettings();
    access = readAccessSettings();
  } catch (error) {
    const field = error instanceof ConfigurationError ? error.field : undefined;
    logOperational({
      requestId,
      result: "CONFIGURATION_UNAVAILABLE",
      elapsedMs: elapsed(started),
      ...(field ? { field } : {}),
    });
    return finish(requestId, json({ error: "CONFIGURATION_UNAVAILABLE" }, 503));
  }

  const rejected = authorizeRequest(request, access);
  if (rejected) {
    logOperational({
      requestId,
      result: rejected.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN",
      elapsedMs: elapsed(started),
    });
    return finish(requestId, rejected);
  }

  return requestStore.run(
    {
      requestId,
      signal: request.signal,
      readToken: access.readToken,
      started,
      logged: false,
    },
    async () => {
      const response = await mcpHandler.fetch(request, {
        authInfo: {
          token: "redacted",
          clientId: "chat-memory-read",
          scopes: ["chat_memory:read"],
        },
      });
      const store = requestStore.getStore();
      if (!store?.logged) {
        logOperational({
          requestId,
          result: `http_${response.status}`,
          elapsedMs: elapsed(started),
        });
      }
      return finish(requestId, response);
    },
  );
}

function resolveRequestId(request: Request): string {
  const supplied = request.headers.get("x-request-id");
  if (supplied && requestIdPattern.test(supplied)) return supplied;
  return crypto.randomUUID();
}

function finish(requestId: string, response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  headers.set("x-request-id", requestId);
  headers.set("x-content-type-options", "nosniff");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function elapsed(started: number): number {
  return Math.max(0, Math.round(performance.now() - started));
}
