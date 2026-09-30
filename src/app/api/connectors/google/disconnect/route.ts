import { getUser } from "@/lib/supabase/server";
import { disconnect } from "@/lib/connectors/store";

export const runtime = "nodejs";

// Ontkoppelen: token intrekken bij Google, versleutelde tokens wissen, audit-regel (in disconnect()).
export async function POST(req: Request) {
  const user = await getUser();
  if (!user) return Response.json({ error: "Niet ingelogd" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const provider = typeof body?.provider === "string" ? body.provider : "gmail";
  const result = await disconnect(user.id, provider);
  if (!result) return Response.json({ error: "Geen verbinding gevonden" }, { status: 404 });
  return Response.json({ ok: true, revokedAtGoogle: result.revoked });
}
