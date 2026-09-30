import { after } from "next/server";
import { getUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runWorker } from "@/lib/agent/worker";
import { logAudit } from "@/lib/audit";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  const started = Date.now();
  const user = await getUser();
  if (!user) return Response.json({ error: "Niet ingelogd" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const paused = body?.paused === true;

  const db = createAdminClient();
  const { error } = await db.from("dot_profiles")
    .update({ paused, updated_at: new Date().toISOString() })
    .eq("user_id", user.id);
  if (error) return Response.json({ error: error.message }, { status: 500 });

  await logAudit(db, { userId: user.id, actor: "user", action: paused ? "paused" : "resumed" });
  if (!paused) after(() => runWorker({ userId: user.id, deadline: started + 55_000 }).then(() => undefined));
  return Response.json({ ok: true, paused });
}
