import { timingSafeEqual } from "node:crypto";
import { hostHeaderValidationResponse } from "@modelcontextprotocol/server";
import { z } from "zod";
import { ConfigurationError } from "@/server/chat-memory/errors";

const tokenSchema = z.string().regex(/^[A-Za-z0-9+/=._~-]{16,512}$/);

export type AccessSettings = {
  readToken: string;
  allowedHosts: string[];
  allowedOrigins: string[];
};

export function readAccessSettings(
  env: Record<string, string | undefined> = process.env,
): AccessSettings {
  const token = tokenSchema.safeParse(env.CHAT_MEMORY_READ_TOKEN?.trim());
  if (!token.success) throw new ConfigurationError("CHAT_MEMORY_READ_TOKEN");
  return {
    readToken: token.data,
    allowedHosts: parseHosts(env.CHAT_MEMORY_ALLOWED_HOSTS),
    allowedOrigins: parseOrigins(env.CHAT_MEMORY_ALLOWED_ORIGINS),
  };
}

export function authorizeRequest(
  request: Request,
  access: AccessSettings,
): Response | null {
  if (!bearerMatches(request.headers.get("authorization"), access.readToken)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: {
        "content-type": "application/json",
        "www-authenticate": "Bearer",
      },
    });
  }
  const hostRejection = hostHeaderValidationResponse(
    request,
    access.allowedHosts,
  );
  if (hostRejection) return hostRejection;
  const originRejection = originRejectionResponse(
    request.headers.get("origin"),
    access.allowedOrigins,
  );
  if (originRejection) return originRejection;
  return null;
}

export function bearerMatches(
  header: string | null,
  expectedToken: string,
): boolean {
  const match = header ? /^Bearer ([!-~]+)$/.exec(header) : null;
  const presented = Buffer.from(match?.[1] ?? "");
  const expected = Buffer.from(expectedToken);
  if (presented.length !== expected.length) {
    timingSafeEqual(expected, expected);
    return false;
  }
  return timingSafeEqual(presented, expected);
}

function originRejectionResponse(
  origin: string | null,
  allowedOrigins: string[],
): Response | null {
  if (origin === null || origin === "") return null;
  if (!allowedOrigins.includes(origin)) {
    return new Response(JSON.stringify({ error: "forbidden_origin" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }
  return null;
}

function parseHosts(value: string | undefined): string[] {
  return unique(
    splitList(value).map((item) => {
      if (
        item.includes("://") ||
        item.includes("/") ||
        item.includes("*") ||
        item.includes(" ")
      ) {
        throw new ConfigurationError("CHAT_MEMORY_ALLOWED_HOSTS");
      }
      let hostname: string;
      try {
        hostname = new URL(`http://${item}`).hostname;
      } catch {
        throw new ConfigurationError("CHAT_MEMORY_ALLOWED_HOSTS");
      }
      if (!hostname) throw new ConfigurationError("CHAT_MEMORY_ALLOWED_HOSTS");
      return hostname;
    }),
  );
}

function parseOrigins(value: string | undefined): string[] {
  return unique(
    splitList(value).map((item) => {
      if (item.includes("*")) {
        throw new ConfigurationError("CHAT_MEMORY_ALLOWED_ORIGINS");
      }
      let url: URL;
      try {
        url = new URL(item);
      } catch {
        throw new ConfigurationError("CHAT_MEMORY_ALLOWED_ORIGINS");
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new ConfigurationError("CHAT_MEMORY_ALLOWED_ORIGINS");
      }
      if (url.username || url.password || url.search || url.hash) {
        throw new ConfigurationError("CHAT_MEMORY_ALLOWED_ORIGINS");
      }
      if (url.pathname !== "/" && url.pathname !== "") {
        throw new ConfigurationError("CHAT_MEMORY_ALLOWED_ORIGINS");
      }
      return url.origin;
    }),
  );
}

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
