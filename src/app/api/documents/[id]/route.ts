import { getUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { deleteDocument } from "@/lib/documents/store";
import { logAudit } from "@/lib/audit";

export const runtime = "nodejs";

// Vastzetten ("altijd meenemen") aan/uit.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getUser();
  if (!user) return Response.json({ error: "Niet ingelogd" }, { status: 401 });
  const body = await req.json().catch(() => null);
  const pinned = body?.pinned === true;
  const db = createAdminClient();
  const { data } = await db.from("documents").update({ pinned }).eq("id", id).eq("user_id", user.id).select("name").maybeSingle();
  if (!data) return Response.json({ error: "Niet gevonden" }, { status: 404 });
  await logAudit(db, { userId: user.id, actor: "user", action: pinned ? "document_pinned" : "document_unpinned", input: { name: data.name } });
  return Response.json({ ok: true });
}

// Verwijderen: rij én bestand in de opslag.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getUser();
  if (!user) return Response.json({ error: "Niet ingelogd" }, { status: 401 });
  const db = createAdminClient();
  const removed = await deleteDocument(user.id, id, db);
  if (!removed) return Response.json({ error: "Niet gevonden" }, { status: 404 });
  await logAudit(db, { userId: user.id, actor: "user", action: "document_deleted", input: { name: removed.name } });
  return Response.json({ ok: true });
}
