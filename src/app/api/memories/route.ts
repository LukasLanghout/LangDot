import { getUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { logAudit } from "@/lib/audit";
import { cauraDelete, cauraUpdate, cauraWrite } from "@/lib/caura";

export const runtime = "nodejs";

// Geheugen bewerken vanuit het paneel. Via de server, zodat Caura (gedeeld geheugen) meesynchroniseert.

const KINDS = ["preference", "decision", "work", "fact"];

async function setup() {
  const user = await getUser();
  if (!user) return null;
  const db = createAdminClient();
  const { data: profile } = await db.from("dot_profiles").select("handle").eq("user_id", user.id).maybeSingle();
  return { user, db, agentId: (profile?.handle as string | undefined) ?? "langdot" };
}

async function readBody(req: Request) {
  const body = await req.json().catch(() => null);
  const content = typeof body?.content === "string" ? body.content.trim().slice(0, 1000) : "";
  const kind = KINDS.includes(body?.kind) ? (body.kind as string) : "fact";
  const id = typeof body?.id === "string" ? body.id : "";
  return { content, kind, id };
}

export async function POST(req: Request) {
  const s = await setup();
  if (!s) return Response.json({ error: "Niet ingelogd" }, { status: 401 });
  const { content, kind } = await readBody(req);
  if (!content) return Response.json({ error: "Lege notitie" }, { status: 400 });

  const { data, error } = await s.db.from("dot_memories").insert({ user_id: s.user.id, kind, content }).select("id").single();
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const cauraId = await cauraWrite({ userId: s.user.id, agentId: s.agentId, content, kind, localId: data.id });
  if (cauraId) await s.db.from("dot_memories").update({ caura_id: cauraId }).eq("id", data.id);
  await logAudit(s.db, { userId: s.user.id, actor: "user", action: "memory_added", input: { kind, content }, output: { shared: !!cauraId } });
  return Response.json({ ok: true, id: data.id });
}

export async function PATCH(req: Request) {
  const s = await setup();
  if (!s) return Response.json({ error: "Niet ingelogd" }, { status: 401 });
  const { content, kind, id } = await readBody(req);
  if (!id || !content) return Response.json({ error: "id en content zijn nodig" }, { status: 400 });

  const { data: before } = await s.db.from("dot_memories").select("content, caura_id").eq("id", id).eq("user_id", s.user.id).maybeSingle();
  if (!before) return Response.json({ error: "Niet gevonden" }, { status: 404 });

  const { error } = await s.db.from("dot_memories")
    .update({ content, kind, updated_at: new Date().toISOString() }).eq("id", id).eq("user_id", s.user.id);
  if (error) return Response.json({ error: error.message }, { status: 500 });

  if (before.caura_id) await cauraUpdate({ agentId: s.agentId, cauraId: before.caura_id, content, kind });
  await logAudit(s.db, { userId: s.user.id, actor: "user", action: "memory_edited", input: { id, before: before.content, after: content, kind } });
  return Response.json({ ok: true });
}

export async function DELETE(req: Request) {
  const s = await setup();
  if (!s) return Response.json({ error: "Niet ingelogd" }, { status: 401 });
  const id = new URL(req.url).searchParams.get("id") ?? "";

  const { data: row } = await s.db.from("dot_memories").delete().eq("id", id).eq("user_id", s.user.id)
    .select("content, caura_id").maybeSingle();
  if (!row) return Response.json({ error: "Niet gevonden" }, { status: 404 });

  if (row.caura_id) await cauraDelete({ agentId: s.agentId, cauraId: row.caura_id });
  await logAudit(s.db, { userId: s.user.id, actor: "user", action: "memory_deleted", input: { id, content: row.content } });
  return Response.json({ ok: true });
}
