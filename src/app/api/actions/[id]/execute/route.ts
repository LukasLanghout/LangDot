import { after } from "next/server";
import { getUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { executePendingAction } from "@/lib/actions";
import { defaultExecDeps } from "@/lib/actions-store";
import { continueAfterDecision } from "@/lib/agent/approval-flow";
import { runWorker } from "@/lib/agent/worker";

export const runtime = "nodejs";
export const maxDuration = 60;

// "Opnieuw proberen" voor een mail die al is goedgekeurd maar niet verstuurd kon worden.
// Keurt zelf niets goed: executePendingAction weigert alles wat niet "approved" is.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const started = Date.now();
  const { id } = await params;
  const user = await getUser();
  if (!user) return Response.json({ error: "Niet ingelogd" }, { status: 401 });

  const db = createAdminClient();
  const result = await executePendingAction(defaultExecDeps(db), user.id, id);
  if (!result.ok) return Response.json({ ok: false, code: result.code, error: result.message });

  if (await continueAfterDecision(db, result.action, "sent")) {
    after(() => runWorker({ userId: user.id, deadline: started + 55_000 }).then(() => undefined));
  }
  return Response.json({ ok: true, status: "executed" });
}
