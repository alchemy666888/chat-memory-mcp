import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { redactLogText } from "@/server/observability/log";

describe("service boundaries", () => {
  it("redacts credentials from operational text", () => {
    const redacted = redactLogText(
      "Bearer super-secret-token postgres://reader:pw@db.example/memory sk-abcdefghijklmnopqrst",
    );
    expect(redacted).not.toContain("super-secret-token");
    expect(redacted).not.toContain("reader:pw");
    expect(redacted).not.toContain("sk-abcdefghijklmnopqrst");
  });

  it("has no write, migration, model, or processing implementation", () => {
    const source = readSources("src");
    expect(source).not.toMatch(
      /\b(INSERT\s+INTO|UPDATE\s+[a-z_]|DELETE\s+FROM|DROP\s+|ALTER\s+|TRUNCATE\s+|CREATE\s+(TABLE|SCHEMA|INDEX|DATABASE))\b/i,
    );
    expect(source.toLowerCase()).not.toContain("deepseek");
    expect(source).not.toContain("rejectUnauthorized: false");
    expect(source).not.toContain("rejectUnauthorized:false");
  });
});

function readSources(directory: string): string {
  const entries = readdirSync(directory);
  return entries
    .map((entry) => {
      const fullPath = path.join(directory, entry);
      if (statSync(fullPath).isDirectory()) return readSources(fullPath);
      if (!fullPath.endsWith(".ts") && !fullPath.endsWith(".tsx")) return "";
      return readFileSync(fullPath, "utf8");
    })
    .join("\n");
}
