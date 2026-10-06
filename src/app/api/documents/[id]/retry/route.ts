import { getUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { retryExtraction } from "@/lib/documents/store";
import { logAudit } from "@/lib/audit";

export const runtime = "nodejs";
export const maxDuration = 60;

// "Opnieuw proberen" voor een document dat niet (goed) gelezen kon worden.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getUser();
  if (!user) return Response.json({ error: "Niet ingelogd" }, { status: 401 });
  const db = createAdminClient();
  try {
    const doc = await retryExtraction(user.id, id, db);
    await logAudit(db, { userId: user.id, actor: "user", action: "document_retry", input: { name: doc.name }, output: { status: doc.status } });
    return Response.json({ ok: true, document: doc });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Opnieuw lezen mislukt" }, { status: 400 });
  }
}
