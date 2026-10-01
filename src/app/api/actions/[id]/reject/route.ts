import { after } from "next/server";
import { getUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { describeAction, rejectAction } from "@/lib/actions";
import { supabaseActionStore } from "@/lib/actions-store";
import { continueAfterDecision } from "@/lib/agent/approval-flow";
import { runWorker } from "@/lib/agent/worker";
import { logAudit } from "@/lib/audit";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const started = Date.now();
  const { id } = await params;
  const user = await getUser();
  if (!user) return Response.json({ error: "Niet ingelogd" }, { status: 401 });

  const db = createAdminClient();
  const r = await rejectAction(supabaseActionStore(db), user.id, id);
  if (!r.ok) return Response.json({ ok: false, error: r.error }, { status: 409 });

  await logAudit(db, {
    userId: user.id, actor: "user", action: "action_rejected", taskId: r.action.task_id,
    input: { action_id: id, type: r.action.type, what: describeAction(r.action) },
  });
  if (await continueAfterDecision(db, r.action, "rejected")) {
    after(() => runWorker({ userId: user.id, deadline: started + 55_000 }).then(() => undefined));
  }
  return Response.json({ ok: true, status: "rejected" });
}
