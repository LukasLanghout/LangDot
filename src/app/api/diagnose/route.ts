import { getUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseKey } from "@/lib/crypto";
import { getAccessToken, getConnector } from "@/lib/connectors/store";
import { CALENDAR_SCOPES, GMAIL_SCOPES } from "@/lib/connectors/google";
import { listCalendarEvents } from "@/lib/connectors/calendar";
import { ConnectorError } from "@/lib/connectors/errors";
import { budgetDay, dailyTokenBudget } from "@/lib/budget";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Check = { name: string; ok: boolean | null; detail: string; fix?: string };

// Zelfdiagnose voor de ingelogde gebruiker: instellingen, migraties en verbindingen.
// Toont nooit waarden van geheimen, alleen of ze er zijn.
export async function GET() {
  const user = await getUser();
  if (!user) return Response.json({ error: "Niet ingelogd" }, { status: 401 });
  const db = createAdminClient();
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);

  // ── Instellingen ──
  add({ name: "Taalmodel-key", ok: !!process.env.GONKA_API_KEY, detail: process.env.GONKA_API_KEY ? "gezet" : "ontbreekt", fix: "Zet GONKA_API_KEY in Vercel." });
  add({ name: "Google-client", ok: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET), detail: process.env.GOOGLE_CLIENT_ID ? "gezet" : "ontbreekt", fix: "Zet GOOGLE_CLIENT_ID en GOOGLE_CLIENT_SECRET in Vercel." });
  let keyOk = false;
  try { parseKey(process.env.CONNECTOR_ENCRYPTION_KEY); keyOk = true; } catch { /* zie fix */ }
  add({ name: "Encryptiesleutel", ok: keyOk, detail: keyOk ? "geldig (32 bytes)" : "ontbreekt of ongeldig", fix: "Zet CONNECTOR_ENCRYPTION_KEY (32 bytes, base64)." });
  add({ name: "Push-sleutels", ok: !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY), detail: process.env.VAPID_PUBLIC_KEY ? "gezet" : "ontbreekt", fix: "Zet VAPID_PUBLIC_KEY en VAPID_PRIVATE_KEY in Vercel." });
  add({ name: "Zoeken (Tavily)", ok: process.env.TAVILY_API_KEY ? true : null, detail: process.env.TAVILY_API_KEY ? "gezet" : "niet gezet (valt terug op DuckDuckGo)" });

  // ── Tokenbudget van vandaag ──
  {
    const { data } = await db.from("dot_usage").select("total_tokens, requests").eq("user_id", user.id).eq("day", budgetDay()).maybeSingle();
    const used = Number(data?.total_tokens ?? 0);
    const budget = dailyTokenBudget();
    const pct = Math.round((used / budget) * 100);
    add({
      name: "Tokenbudget vandaag",
      ok: used < budget * 0.9 ? true : used < budget ? null : false,
      detail: `${used.toLocaleString("nl-NL")} van ${budget.toLocaleString("nl-NL")} (${pct}%), ${data?.requests ?? 0} aanroepen`,
      fix: "Zet DAILY_TOKEN_BUDGET hoger in Vercel (en redeploy); wachtende taken gaan dan binnen 15 minuten vanzelf verder.",
    });
  }

  // ── Migraties ──
  const tables: [string, string][] = [
    ["dot_usage", "0003"], ["connectors", "0003"], ["pending_actions", "0003"],
    ["push_subscriptions", "0004"], ["documents", "0005"],
  ];
  for (const [table, migration] of tables) {
    const { error } = await db.from(table).select("*", { count: "exact", head: true }).limit(1);
    add({ name: `Tabel ${table}`, ok: !error, detail: error ? "ontbreekt" : "aanwezig", fix: `Voer migratie ${migration} uit in de Supabase SQL Editor.` });
  }
  {
    const { error } = await db.from("dot_schedules").select("auto_send, auto_send_to").limit(1);
    add({ name: "Automatisch mailen (schema's)", ok: !error, detail: error ? "kolommen ontbreken" : "aanwezig", fix: "Voer migratie 0006_auto_send.sql uit." });
  }
  {
    const { error } = await db.from("dot_tasks").select("scratch").limit(1);
    add({ name: "Taken hervatten tussen ticks", ok: !error, detail: error ? "kolom ontbreekt (taken beginnen elke tick opnieuw en lopen dan vast)" : "aanwezig", fix: "Voer migratie 0007_task_scratch.sql uit." });
  }  // Mag een afspraak-voorstel opgeslagen worden? (check constraint uit migratie 0004)
  {
    const { data, error } = await db.from("pending_actions")
      .insert({ user_id: user.id, type: "calendar_create_event", payload: { diagnose: true }, status: "expired" })
      .select("id").maybeSingle();
    if (data?.id) await db.from("pending_actions").delete().eq("id", data.id);
    add({
      name: "Afspraak-voorstellen opslaan",
      ok: !error,
      detail: error ? (error.message.includes("check") ? "geweigerd door de database (oude migratie)" : "fout bij opslaan") : "werkt",
      fix: "Voer migratie 0004_push_calendar.sql uit.",
    });
  }

  // ── Verbindingen ──
  for (const [provider, label, scope] of [
    ["gmail", "Gmail", GMAIL_SCOPES.send],
    ["google_calendar", "Google Agenda", CALENDAR_SCOPES.events],
  ] as const) {
    const c = await getConnector(user.id, provider, db).catch(() => null);
    if (!c || c.status === "revoked") {
      add({ name: `${label}: verbinding`, ok: false, detail: "niet verbonden", fix: `Verbindingen → ${label} → Verbinden.` });
      continue;
    }
    add({ name: `${label}: verbinding`, ok: c.status === "active", detail: c.status === "active" ? `verbonden als ${c.account_email ?? "?"}` : "verlopen", fix: "Verbind opnieuw." });
    const hasScope = (c.scopes ?? []).includes(scope) || (provider === "gmail" && (c.scopes ?? []).includes(GMAIL_SCOPES.compose));
    add({
      name: `${label}: rechten`,
      ok: hasScope,
      detail: hasScope ? "benodigde scope toegestaan" : "benodigde scope ontbreekt",
      fix: `Voeg ${scope} toe op het OAuth consent screen, ontkoppel en verbind opnieuw (laat alle vinkjes aan).`,
    });
    if (c.status !== "active") continue;
    try {
      const token = await getAccessToken(user.id, provider, db);
      if (provider === "google_calendar") {
        const now = new Date();
        await listCalendarEvents(token, { from: now.toISOString(), to: new Date(now.getTime() + 86_400_000).toISOString(), max: 1 });
      } else {
        const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) throw new ConnectorError("provider_error", `gmail ${res.status}`);
      }
      add({ name: `${label}: API bereikbaar`, ok: true, detail: "werkt" });
    } catch (e) {
      const detail = e instanceof ConnectorError ? e.detail || e.code : "onbekende fout";
      const fix = detail.includes("accessNotConfigured") || detail.includes("SERVICE_DISABLED")
        ? `Zet de ${label === "Gmail" ? "Gmail API" : "Google Calendar API"} aan in Google Cloud Console → APIs & Services → Library.`
        : detail.includes("insufficient") || detail.includes("PERMISSION")
          ? "Rechten ontbreken: ontkoppel en verbind opnieuw, en laat alle vinkjes aan."
          : "Verbind opnieuw; blijft het falen, kijk dan in de Vercel-logs.";
      add({ name: `${label}: API bereikbaar`, ok: false, detail, fix });
    }
  }

  return Response.json({ checks });
}
