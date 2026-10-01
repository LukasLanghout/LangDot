import { getUser } from "@/lib/supabase/server";
import { notifyUser, pushConfigured } from "@/lib/push";

export const runtime = "nodejs";

export async function POST() {
  const user = await getUser();
  if (!user) return Response.json({ error: "Niet ingelogd" }, { status: 401 });
  if (!pushConfigured()) return Response.json({ ok: false, error: "Meldingen zijn op de server nog niet ingesteld." });
  const r = await notifyUser(user.id, { title: "LangDot", body: "Testmelding: meldingen werken 🎉", tag: "test" });
  return Response.json({ ok: r.sent > 0, sent: r.sent, error: r.sent ? undefined : "Geen apparaat bereikt. Zet meldingen opnieuw aan." });
}
