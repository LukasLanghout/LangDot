// Bijhouden welke links al in een gemailde nieuwsbrief stonden, zodat de 12:30-editie niet herhaalt wat de
// 08:20-editie al had. Dit gebeurt in code (filter op zoekresultaten), niet via de prompt.
// Alles is "best effort": ontbreekt de tabel (migratie 0009), dan gebeurt er gewoon niets.

import type { SupabaseClient } from "@supabase/supabase-js";

const TRACKING = /^(utm_[a-z]+|fbclid|gclid|ref|ref_src|mc_cid|mc_eid)$/i;

export function normalizeUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
    let s = u.toString();
    if (s.endsWith("/") && u.pathname !== "/") s = s.slice(0, -1);
    if (u.pathname === "/" && !u.search) s = s.replace(/\/$/, "");
    return s;
  } catch {
    return null;
  }
}

/** Alle http(s)-links uit Markdown of platte tekst, genormaliseerd en uniek. */
export function extractUrls(text: string): string[] {
  const found = text.match(/https?:\/\/[^\s<>()\[\]"']+[^\s<>()\[\]"'.,;:!?]/g) ?? [];
  return [...new Set(found.map(normalizeUrl).filter((u): u is string => !!u))];
}

export async function recentSentUrls(db: SupabaseClient, userId: string, hours = 36): Promise<Set<string>> {
  try {
    const since = new Date(Date.now() - hours * 3_600_000).toISOString();
    const { data, error } = await db.from("sent_links").select("url").eq("user_id", userId).gte("sent_at", since).limit(2000);
    if (error) return new Set();
    return new Set((data ?? []).map((r: { url: string }) => r.url));
  } catch {
    return new Set();
  }
}

export async function recordSentLinks(db: SupabaseClient, userId: string, body: string) {
  const urls = extractUrls(body);
  if (!urls.length) return;
  try {
    await db.from("sent_links").upsert(urls.map((url) => ({ user_id: userId, url, sent_at: new Date().toISOString() })), { onConflict: "user_id,url" });
  } catch {
    /* tabel ontbreekt: niet erg */
  }
}

/** Haalt al verstuurde links uit zoekresultaten. */
export function dropSentResults<T extends { url: string }>(results: T[], sent: Set<string>) {
  const kept: T[] = [];
  let dropped = 0;
  for (const r of results) {
    const n = normalizeUrl(r.url);
    if (n && sent.has(n)) dropped++;
    else kept.push(r);
  }
  return { kept, dropped };
}
