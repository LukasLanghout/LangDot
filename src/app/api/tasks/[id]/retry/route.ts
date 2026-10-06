import { after } from "next/server";
import { getUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runWorker } from "@/lib/agent/worker";
import { logAudit } from "@/lib/audit";
import type { Step, Task } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

// "Opnieuw" bij een mislukte of geannuleerde taak: de afgeronde stappen blijven staan, de rest begint opnieuw.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const started = Date.now();
  const { id } = await params;
  const user = await getUser();
  if (!user) return Response.json({ error: "Niet ingelogd" }, { status: 401 });

  const db = createAdminClient();
  const { data } = await db.from("dot_tasks").select("*").eq("id", id).eq("user_id", user.id).maybeSingle();
  const task = data as Task | null;
  if (!task) return Response.json({ error: "Taak niet gevonden" }, { status: 404 });
  if (task.status !== "failed" && task.status !== "cancelled") return Response.json({ error: "Deze taak kan niet opnieuw" }, { status: 409 });
  if (task.source === "chat_turn") return Response.json({ error: "Een chatbeurt start je opnieuw door het bericht nog eens te sturen" }, { status: 409 });

  // Afgeronde stappen behouden; de eerste niet-afgeronde stap gaat terug naar "pending".
  const steps: Step[] = (task.steps ?? []).map((s) => (s.status === "done" ? s : { ...s, status: "pending" as const }));
  const firstOpen = steps.findIndex((s) => s.status !== "done");
  const { data: updated } = await db.from("dot_tasks").update({
    status: "pending",
    steps,
    current_step: firstOpen < 0 ? steps.length : firstOpen,
    attempts: 0,
    step_count: 0,
    error: null,
    result: null,
    locked_until: null,
    updated_at: new Date().toISOString(),
  }).eq("id", id).eq("user_id", user.id).in("status", ["failed", "cancelled"]).select("id").maybeSingle();
  if (!updated) return Response.json({ error: "Al opnieuw gestart" }, { status: 409 });

  await db.from("dot_tasks").update({ scratch: null }).eq("id", id); // tussenstand weg (kolom bestaat na migratie 0007)
  await logAudit(db, { userId: user.id, actor: "user", action: "task_retry", taskId: id, input: { title: task.title } });
  after(() => runWorker({ userId: user.id, deadline: started + 55_000 }).then(() => undefined));
  return Response.json({ ok: true });
}
