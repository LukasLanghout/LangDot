import { getUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { logAudit } from "@/lib/audit";

export const runtime = "nodejs";

// Meldingen aanzetten op dit apparaat (aanmaken) of uitzetten (DELETE).
export async function POST(req: Request) {
  const user = await getUser();
  if (!user) return Response.json({ error: "Niet ingelogd" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const endpoint = typeof body?.endpoint === "string" ? body.endpoint : "";
  const p256dh = typeof body?.keys?.p256dh === "string" ? body.keys.p256dh : "";
  const auth = typeof body?.keys?.auth === "string" ? body.keys.auth : "";
  if (!/^https:\/\//.test(endpoint) || endpoint.length > 1000 || !p256dh || !auth) {
    return Response.json({ error: "Ongeldig abonnement" }, { status: 400 });
  }

  const db = createAdminClient();
  const { error } = await db.from("push_subscriptions").upsert(
    { user_id: user.id, endpoint, p256dh, auth, user_agent: (req.headers.get("user-agent") ?? "").slice(0, 300) },
    { onConflict: "endpoint" },
  );
  if (error) {
    console.error("[push] opslaan mislukt", error.message);
    return Response.json({ error: "Opslaan mislukt" }, { status: 500 });
  }
  await logAudit(db, { userId: user.id, actor: "user", action: "push_enabled", input: { device: (req.headers.get("user-agent") ?? "").slice(0, 120) } });
  return Response.json({ ok: true });
}

export async function DELETE(req: Request) {
  const user = await getUser();
  if (!user) return Response.json({ error: "Niet ingelogd" }, { status: 401 });
  const body = await req.json().catch(() => null);
  const endpoint = typeof body?.endpoint === "string" ? body.endpoint : "";
  const db = createAdminClient();
  await db.from("push_subscriptions").delete().eq("user_id", user.id).eq("endpoint", endpoint);
  await logAudit(db, { userId: user.id, actor: "user", action: "push_disabled" });
  return Response.json({ ok: true });
}
