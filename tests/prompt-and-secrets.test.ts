import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { chatSystemPrompt, workerSystemPrompt } from "@/lib/agent/prompts";
import { fakeAgentContext } from "./agent-fixtures";

describe("geheugen gaat mee in de prompt", () => {
  it("voorkeuren staan bovenaan met de opdracht ze te volgen", () => {
    const ctx = fakeAgentContext({
      memories: [
        { id: "m1", kind: "preference", content: "Gebruiker wil korte antwoorden" },
        { id: "m2", kind: "fact", content: "Woont in Utrecht" },
      ],
    });
    for (const prompt of [chatSystemPrompt(ctx), workerSystemPrompt(ctx)]) {
      expect(prompt).toContain("Voorkeuren van de gebruiker — volg deze ALTIJD");
      expect(prompt).toContain("Gebruiker wil korte antwoorden");
      expect(prompt).toContain("Woont in Utrecht");
    }
  });

  it("zonder Gmail zegt de prompt dat er eerst verbonden moet worden", () => {
    expect(chatSystemPrompt(fakeAgentContext())).toContain("request_connection");
  });
});

// ───────────── Geen geheimen in client-code ─────────────

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

const ALLOWED_PUBLIC = new Set(["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"]);
const SERVER_ONLY = ["@/lib/llm", "@/lib/crypto", "@/lib/budget", "@/lib/supabase/admin", "@/lib/connectors/store",
  "@/lib/connectors/google", "@/lib/connectors/gmail", "@/lib/actions-store", "@/lib/agent/"];

describe("geen secrets in client-side code", () => {
  it("alleen de publieke Supabase-URL en anon key zijn NEXT_PUBLIC_", () => {
    const used = new Set<string>();
    for (const f of files(SRC)) for (const m of readFileSync(f, "utf8").matchAll(/NEXT_PUBLIC_[A-Z0-9_]+/g)) used.add(m[0]);
    const envExample = readFileSync(path.join(ROOT, ".env.example"), "utf8");
    for (const m of envExample.matchAll(/^(NEXT_PUBLIC_[A-Z0-9_]+)=/gm)) used.add(m[1]);
    expect([...used].filter((v) => !ALLOWED_PUBLIC.has(v))).toEqual([]);
  });

  it("client-componenten importeren geen server-modules (tokens, keys, LLM)", () => {
    const offenders: string[] = [];
    for (const f of files(SRC)) {
      const src = readFileSync(f, "utf8");
      if (!/^\s*["']use client["']/.test(src)) continue;
      for (const m of src.matchAll(/from\s+["']([^"']+)["']/g)) {
        if (SERVER_ONLY.some((s) => m[1] === s || m[1].startsWith(s))) offenders.push(`${path.relative(ROOT, f)} → ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it(".env.example bevat geen ingevulde geheimen", () => {
    const env = readFileSync(path.join(ROOT, ".env.example"), "utf8");
    for (const name of ["GONKA_API_KEY", "SUPABASE_SERVICE_ROLE_KEY", "GOOGLE_CLIENT_SECRET", "CONNECTOR_ENCRYPTION_KEY", "TAVILY_API_KEY", "CAURA_API_KEY"]) {
      expect(env).toMatch(new RegExp(`^${name}=\\s*$`, "m"));
    }
  });
});
