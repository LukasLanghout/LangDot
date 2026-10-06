import { getUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { gmailCapabilities } from "@/lib/connectors/store";
import { computeNextRun, describeDays, isValidTime, isValidZone } from "@/lib/schedule";
import { logAudit } from "@/lib/audit";

export const runtime = "nodejs";

// Een schema aanmaken vanuit het formulier onder "Gepland". Onafhankelijk van het taalmodel.
// Het vinkje "mail het resultaat automatisch naar mij" is de toestemming van de ingelogde gebruiker:
// alleen naar het adres van zijn verbonden Gmail-account (zie de worker: staande toestemming).
export async function POST(req: Request) {
  const user = await getUser();
  if (!user) return Response.json({ error: "Niet ingelogd" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const title = typeof body?.title === "string" ? body.title.trim().slice(0, 200) : "";
  const prompt = typeof body?.prompt === "string" ? body.prompt.trim().slice(0, 2000) : "";
  const time = typeof body?.time === "string" ? body.time.trim() : "";
  const timezone = typeof body?.timezone === "string" && body.timezone ? body.timezone : "Europe/Amsterdam";
  const days: number[] = Array.isArray(body?.days)
    ? [...new Set<number>(body.days.map(Number).filter((d: number) => Number.isInteger(d) && d >= 1 && d <= 7))]
    : [];
  if (!title) return Response.json({ error: "Geef het schema een naam." }, { status: 400 });
  if (!prompt) return Response.json({ error: "Beschrijf wat de dot moet doen." }, { status: 400 });
  if (!isValidTime(time)) return Response.json({ error: "Kies een geldige tijd." }, { status: 400 });
  if (!isValidZone(timezone)) return Response.json({ error: "Onbekende tijdzone." }, { status: 400 });
  if (!days.length) return Response.json({ error: "Kies minstens één dag." }, { status: 400 });

  const db = createAdminClient();
  const wantsAuto = body?.auto_send_to_self === true;
  let autoTo: string | null = null;
  if (wantsAuto) {
    const gmail = await gmailCapabilities(user.id, db).catch(() => null);
    if (!gmail || gmail.status !== "active" || !gmail.canSend || !gmail.email) {
      return Response.json({ error: "Automatisch mailen kan pas als Gmail verbonden is (Verbindingen)." }, { status: 409 });
    }
    autoTo = gmail.email;
  }

  // De dot krijgt de opdracht om het resultaat zelf te mailen; de toestemming zit in auto_send.
  const fullPrompt = autoTo
    ? `${prompt}\n\nVerstuur het resultaat als mail (gmail_create_draft) aan ${autoTo}, met een duidelijk onderwerp (noem de datum) en alle bronnen als klikbare links.`
    : prompt;

  const nextRun = computeNextRun(days, time, timezone);
  const { data, error } = await db.from("dot_schedules").insert({
    user_id: user.id,
    title,
    prompt: fullPrompt,
    days,
    time_of_day: time,
    timezone,
    next_run_at: nextRun,
    ...(autoTo ? { auto_send: true, auto_send_to: autoTo, auto_send_granted_at: new Date().toISOString() } : {}),
  }).select("id").single();
  if (error) {
    console.error("[schedules] aanmaken mislukt:", error.message);
    return Response.json({ error: "Aanmaken mislukt. Is migratie 0006 uitgevoerd?" }, { status: 500 });
  }

  await logAudit(db, {
    userId: user.id, actor: "user", action: "schedule_created",
    input: { title, when: `${describeDays(days)} ${time} ${timezone}`, auto_send_to: autoTo },
  });
  return Response.json({ ok: true, id: data.id, auto_send_to: autoTo });
}
