import { runWorker } from "@/lib/agent/worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Heartbeat: Supabase pg_cron roept dit elke minuut aan (zie supabase/cron.sql).
async function handle(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const stats = await runWorker({ deadline: Date.now() + 50_000 });
  return Response.json({ ok: true, ...stats });
}

export const GET = handle;
export const POST = handle;
