// Documenten opslaan en ophalen. Alleen serverside; altijd gefilterd op user_id.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { createHash } from "node:crypto";
import { extensionOf, extractText, MAX_TEXT_CHARS } from "./extract";

export const BUCKET = "documents";
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export type DocumentMeta = {
  id: string;
  name: string;
  mime: string;
  size: number;
  status: "ready" | "unsupported" | "failed";
  text_chars: number;
  pinned: boolean;
  storage_path: string | null;
  error: string | null;
  created_at: string;
};

const META_COLUMNS = "id, name, mime, size, status, text_chars, pinned, storage_path, error, created_at";

export function safeFileName(name: string) {
  return name.normalize("NFKD").replace(/[^\w.\- ]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 120) || "bestand";
}

/** Na een upload naar Storage: bestand ophalen, tekst extraheren, rij aanmaken. */
export async function createFromStorage(
  userId: string,
  input: { path: string; name: string; mime: string; size: number; ocrText?: string | null },
  db: SupabaseClient = createAdminClient(),
): Promise<DocumentMeta & { duplicate?: boolean }> {
  if (!input.path.startsWith(`${userId}/`) || input.path.includes("..")) throw new Error("Ongeldig pad");
  const { data: blob, error } = await db.storage.from(BUCKET).download(input.path);
  if (error || !blob) throw new Error("Bestand niet gevonden in de opslag");
  const buf = Buffer.from(await blob.arrayBuffer());
  if (buf.length > MAX_UPLOAD_BYTES) throw new Error("Bestand is groter dan 25 MB");

  const sha256 = createHash("sha256").update(buf).digest("hex");
  const dupe = await findDuplicate(db, userId, sha256);
  if (dupe) {
    // Nieuwe upload is overbodig: weg ermee. Een eerdere mislukte uitlezing vervangen we (dat is "opnieuw proberen").
    if (dupe.storage_path !== input.path) await db.storage.from(BUCKET).remove([input.path]);
    if (dupe.status !== "failed") return { ...dupe, duplicate: true } as DocumentMeta & { duplicate: true };
    await deleteDocument(userId, dupe.id, db);
  }

  const mime = input.mime || blob.type || "application/octet-stream";
  let extracted = await extractText(buf, input.name, mime);
  // Afbeeldingen: de browser heeft de tekst al herkend (OCR).
  if (mime.startsWith("image/") && input.ocrText?.trim()) {
    extracted = { status: "ready", text: input.ocrText.trim().slice(0, MAX_TEXT_CHARS), kind: "image-ocr" };
  }

  const row = {
    user_id: userId,
    name: safeFileName(input.name),
    mime,
    size: buf.length,
    storage_path: input.path,
    text: extracted.text || null,
    text_chars: extracted.text.length,
    status: extracted.status,
    error: extracted.error ?? null,
  };
  // Met inhoudshash (migratie 0009). Bestaat de kolom nog niet, dan slaan we zonder hash op.
  let { data, error: insErr } = await db.from("documents").insert({ ...row, sha256 }).select(META_COLUMNS).single();
  if (insErr && /sha256/i.test(insErr.message)) {
    ({ data, error: insErr } = await db.from("documents").insert(row).select(META_COLUMNS).single());
  }
  if (insErr) throw new Error(`Opslaan mislukt: ${insErr.message}`);
  return data as DocumentMeta;
}

/** Zelfde inhoud al aanwezig? Gelezen of onleesbaar: houd het bestaande. Mislukt: ruim het op en probeer opnieuw. */
async function findDuplicate(db: SupabaseClient, userId: string, sha256: string) {
  const { data, error } = await db.from("documents").select(META_COLUMNS).eq("user_id", userId).eq("sha256", sha256).maybeSingle();
  if (error) return null; // kolom ontbreekt: geen ontdubbeling
  return (data as DocumentMeta | null) ?? null;
}

/** Leest een bestaand document opnieuw uit de opslag (na een mislukte of onvolledige uitlezing). */
export async function retryExtraction(userId: string, id: string, db: SupabaseClient = createAdminClient()) {
  const { data: row } = await db.from("documents").select("id, name, mime, storage_path").eq("user_id", userId).eq("id", id).maybeSingle();
  if (!row) throw new Error("Document niet gevonden");
  if (!row.storage_path) throw new Error("Dit document is geplakte tekst en hoeft niet opnieuw gelezen te worden");
  const { data: blob, error } = await db.storage.from(BUCKET).download(row.storage_path);
  if (error || !blob) throw new Error("Bestand niet gevonden in de opslag");
  const buf = Buffer.from(await blob.arrayBuffer());
  const extracted = await extractText(buf, row.name, row.mime);
  const { data, error: upErr } = await db.from("documents").update({
    text: extracted.text || null,
    text_chars: extracted.text.length,
    status: extracted.status,
    error: extracted.error ?? null,
  }).eq("id", id).eq("user_id", userId).select(META_COLUMNS).single();
  if (upErr) throw new Error(`Opslaan mislukt: ${upErr.message}`);
  return data as DocumentMeta;
}

/** Document van geplakte tekst (bv. een profiel). */
export async function createFromText(userId: string, name: string, text: string, pinned = false, db: SupabaseClient = createAdminClient()) {
  const clean = text.trim().slice(0, MAX_TEXT_CHARS);
  if (!clean) throw new Error("Lege tekst");
  const fileName = extensionOf(name) && name.includes(".") ? name : `${name || "Notitie"}.md`;
  const { data, error } = await db.from("documents").insert({
    user_id: userId,
    name: safeFileName(fileName),
    mime: "text/markdown",
    size: Buffer.byteLength(clean, "utf8"),
    storage_path: null,
    text: clean,
    text_chars: clean.length,
    status: "ready",
    pinned,
  }).select(META_COLUMNS).single();
  if (error) throw new Error(`Opslaan mislukt: ${error.message}`);
  return data as DocumentMeta;
}

export async function listDocuments(userId: string, db: SupabaseClient = createAdminClient(), limit = 20) {
  const { data } = await db.from("documents").select(META_COLUMNS).eq("user_id", userId)
    .order("created_at", { ascending: false }).limit(limit);
  return (data ?? []) as DocumentMeta[];
}

/** Alleen documenten van deze gebruiker; onbekende of andermans ids vallen weg. */
export async function getDocuments(userId: string, ids: string[], db: SupabaseClient = createAdminClient()) {
  if (!ids.length) return [];
  const { data } = await db.from("documents").select(META_COLUMNS).eq("user_id", userId).in("id", ids.slice(0, 20));
  return (data ?? []) as DocumentMeta[];
}

export async function readDocument(userId: string, id: string, offset = 0, length = 20_000, db: SupabaseClient = createAdminClient()) {
  const { data } = await db.from("documents").select("id, name, status, error, text, text_chars").eq("user_id", userId).eq("id", id).maybeSingle();
  if (!data) throw new Error("Document niet gevonden");
  if (data.status !== "ready") return { id, name: data.name, status: data.status, error: data.error, text: "" };
  const start = Math.max(0, Math.floor(offset));
  const len = Math.min(Math.max(1000, Math.floor(length)), 30_000);
  const text = String(data.text ?? "").slice(start, start + len);
  return { id, name: data.name, total_chars: data.text_chars, offset: start, next_offset: start + text.length < data.text_chars ? start + text.length : null, text };
}

/** Eenvoudig zoeken in alle documenten van de gebruiker, met fragmenten rond de treffers. */
export async function searchDocuments(userId: string, query: string, db: SupabaseClient = createAdminClient()) {
  const q = query.replace(/[%_]/g, "").trim().slice(0, 100);
  if (!q) return [];
  const { data } = await db.from("documents").select("id, name, text").eq("user_id", userId).eq("status", "ready")
    .ilike("text", `%${q}%`).limit(10);
  return (data ?? []).map((d: any) => {
    const text = String(d.text ?? "");
    const i = text.toLowerCase().indexOf(q.toLowerCase());
    return { id: d.id, name: d.name, snippet: text.slice(Math.max(0, i - 200), i + q.length + 300) };
  });
}

export async function pinnedDocuments(userId: string, db: SupabaseClient = createAdminClient()) {
  const { data } = await db.from("documents").select("id, name, text").eq("user_id", userId).eq("pinned", true)
    .eq("status", "ready").order("created_at", { ascending: true }).limit(5);
  return (data ?? []) as { id: string; name: string; text: string | null }[];
}

/** Bestandsinhoud voor een mailbijlage. Geplakte tekstdocumenten worden een .md-bestand. */
export async function loadAttachment(userId: string, id: string, db: SupabaseClient = createAdminClient()) {
  const { data } = await db.from("documents").select("name, mime, storage_path, text").eq("user_id", userId).eq("id", id).maybeSingle();
  if (!data) throw new Error("Bijlage niet gevonden");
  if (!data.storage_path) return { name: data.name, mime: "text/markdown", data: Buffer.from(String(data.text ?? ""), "utf8") };
  const { data: blob, error } = await db.storage.from(BUCKET).download(data.storage_path);
  if (error || !blob) throw new Error("Bijlage niet gevonden in de opslag");
  return { name: data.name, mime: data.mime, data: Buffer.from(await blob.arrayBuffer()) };
}

export async function deleteDocument(userId: string, id: string, db: SupabaseClient = createAdminClient()) {
  const { data } = await db.from("documents").delete().eq("user_id", userId).eq("id", id).select("name, storage_path").maybeSingle();
  if (!data) return null;
  if (data.storage_path) await db.storage.from(BUCKET).remove([data.storage_path]);
  return data as { name: string; storage_path: string | null };
}
