import { getUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createFromStorage, createFromText, MAX_UPLOAD_BYTES } from "@/lib/documents/store";
import { logAudit } from "@/lib/audit";

export const runtime = "nodejs";
export const maxDuration = 60;

// Document registreren na een upload (de browser uploadt zelf naar Supabase Storage, in de eigen map),
// of een document maken van geplakte tekst. De server leest het bestand en haalt de tekst eruit.
export async function POST(req: Request) {
  const user = await getUser();
  if (!user) return Response.json({ error: "Niet ingelogd" }, { status: 401 });
  const body = await req.json().catch(() => null);
  const db = createAdminClient();

  try {
    let doc;
    if (typeof body?.text === "string") {
      doc = await createFromText(user.id, String(body.name ?? "Notitie").slice(0, 120), body.text, body.pinned === true, db);
    } else {
      const size = Number(body?.size ?? 0);
      if (size > MAX_UPLOAD_BYTES) return Response.json({ error: "Bestand is groter dan 25 MB" }, { status: 413 });
      doc = await createFromStorage(user.id, {
        path: String(body?.path ?? ""),
        name: String(body?.name ?? "bestand"),
        mime: String(body?.mime ?? ""),
        size,
        ocrText: typeof body?.ocr_text === "string" ? body.ocr_text : null,
      }, db);
    }
    const duplicate = "duplicate" in doc && doc.duplicate === true;
    if (duplicate) return Response.json({ ok: true, document: doc, duplicate: true });
    await logAudit(db, {
      userId: user.id, actor: "user", action: "document_added",
      input: { name: doc.name, mime: doc.mime, size: doc.size }, output: { status: doc.status, chars: doc.text_chars },
    });
    return Response.json({ ok: true, document: doc });
  } catch (e) {
    console.warn("[documents] toevoegen mislukt:", e instanceof Error ? e.message : e);
    return Response.json({ error: e instanceof Error ? e.message : "Toevoegen mislukt" }, { status: 400 });
  }
}
