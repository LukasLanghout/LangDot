import { getUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { logAudit } from "@/lib/audit";

export const runtime = "nodejs";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getUser();
  if (!user) return Response.json({ error: "Niet ingelogd" }, { status: 401 });

  const db = createAdminClient();
  const { data } = await db.from("dot_tasks")
    .update({ status: "cancelled", locked_until: null, updated_at: new Date().toISOString() })
    .eq("id", id).eq("user_id", user.id).in("status", ["pending", "running", "needs_input"])
    .select("id, title").maybeSingle();
  if (!data) return Response.json({ error: "Geen actieve taak" }, { status: 404 });

  // Mails van deze taak die nog op goedkeuring wachten, vervallen met de taak.
  await db.from("pending_actions").update({ status: "rejected", decided_at: new Date().toISOString() })
    .eq("task_id", id).eq("user_id", user.id).eq("status", "pending");

  await logAudit(db, { userId: user.id, actor: "user", action: "task_cancelled", taskId: id, input: { title: data.title } });
  return Response.json({ ok: true });
}
