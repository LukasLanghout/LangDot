import { after } from "next/server";
import { getUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { approveAction, describeAction, executePendingAction } from "@/lib/actions";
import { defaultExecDeps, supabaseActionStore } from "@/lib/actions-store";
import { continueAfterDecision } from "@/lib/agent/approval-flow";
import { runWorker } from "@/lib/agent/worker";
import { logAudit } from "@/lib/audit";

export const runtime = "nodejs";
export const maxDuration = 60;

// "Versturen"/"Inplannen" op de goedkeuringskaart. Dit is de ENIGE plek die een actie op approved zet,
// en alleen voor de ingelogde eigenaar. Daarna wordt direct verstuurd via de beveiligde executor.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const started = Date.now();
  const { id } = await params;
  const user = await getUser();
  if (!user) return Response.json({ error: "Niet ingelogd" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const db = createAdminClient();
  const store = supabaseActionStore(db);

  const before = await store.get(id, user.id);
  const approved = await approveAction(store, user.id, id, body && typeof body === "object" ? body : {});
  if (!approved.ok) return Response.json({ ok: false, error: approved.error }, { status: 409 });

  const edited = !!before && JSON.stringify(before.payload) !== JSON.stringify(approved.action.payload);
  await logAudit(db, {
    userId: user.id, actor: "user", action: "action_approved", taskId: approved.action.task_id,
    input: { action_id: id, type: approved.action.type, what: describeAction(approved.action), edited },
  });

  const result = await executePendingAction(defaultExecDeps(db), user.id, id);
  if (!result.ok) {
    // Goedgekeurd maar niet uitgevoerd (bv. verbinding verlopen): de kaart toont "Opnieuw proberen".
    return Response.json({ ok: false, status: "approved", code: result.code, error: result.message });
  }

  if (await continueAfterDecision(db, result.action, "done")) {
    after(() => runWorker({ userId: user.id, deadline: started + 55_000 }).then(() => undefined));
  }
  return Response.json({ ok: true, status: "executed" });
}
