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
    .select("id, title, pending_action").maybeSingle();
  if (!data) return Response.json({ error: "Geen actieve taak" }, { status: 404 });

  // Een openstaand concept vervalt met de taak.
  if (data.pending_action?.type === "approve_draft") {
    await db.from("dot_drafts").update({ status: "rejected" })
      .eq("id", data.pending_action.draft_id).eq("user_id", user.id).eq("status", "draft");
  }
  await logAudit(db, { userId: user.id, actor: "user", action: "task_cancelled", taskId: id, input: { title: data.title } });
  return Response.json({ ok: true });
}
