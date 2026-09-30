import { after } from "next/server";
import { getUser } from "@/lib/supabase/server";
import { runWorker } from "@/lib/agent/worker";

export const runtime = "nodejs";
export const maxDuration = 60;

// Extra aftrap vanuit de geopende app (handig lokaal, waar pg_cron je laptop niet kan bereiken).
export async function POST() {
  const user = await getUser();
  if (!user) return Response.json({ error: "Niet ingelogd" }, { status: 401 });
  const started = Date.now();
  after(() => runWorker({ userId: user.id, deadline: started + 55_000 }).then(() => undefined));
  return Response.json({ ok: true });
}
