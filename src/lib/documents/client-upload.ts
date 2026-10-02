// Upload vanuit de browser: bestand rechtstreeks naar Supabase Storage (eigen map, RLS), daarna laat de
// server de tekst eruit halen. Afbeeldingen worden eerst in de browser met OCR gelezen (tesseract.js, gratis).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { DocumentRow } from "@/lib/types";

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

declare global {
  interface Window {
    Tesseract?: { recognize: (img: File | Blob, langs: string) => Promise<{ data: { text: string } }> };
  }
}

let tesseractLoading: Promise<void> | null = null;

function loadTesseract() {
  if (window.Tesseract) return Promise.resolve();
  if (!tesseractLoading) {
    tesseractLoading = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => {
        tesseractLoading = null;
        reject(new Error("OCR kon niet laden"));
      };
      document.head.appendChild(s);
    });
  }
  return tesseractLoading;
}

async function ocr(file: File) {
  await loadTesseract();
  const { data } = await window.Tesseract!.recognize(file, "nld+eng");
  return data.text;
}

function safeName(name: string) {
  return name.normalize("NFKD").replace(/[^\w.\-]+/g, "_").slice(0, 100) || "bestand";
}

export async function uploadDocument(
  supabase: SupabaseClient,
  userId: string,
  file: File,
  onStatus: (s: string) => void = () => {},
): Promise<DocumentRow> {
  if (file.size > MAX_UPLOAD_BYTES) throw new Error("Bestand is groter dan 25 MB");

  let ocrText: string | null = null;
  if (file.type.startsWith("image/")) {
    onStatus("tekst herkennen…");
    ocrText = await ocr(file).catch(() => null);
  }

  onStatus("uploaden…");
  const path = `${userId}/${crypto.randomUUID()}-${safeName(file.name)}`;
  const { error } = await supabase.storage.from("documents").upload(path, file, {
    contentType: file.type || "application/octet-stream",
    upsert: false,
  });
  if (error) throw new Error("Uploaden mislukt");

  onStatus("lezen…");
  const res = await fetch("/api/documents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, name: file.name, mime: file.type, size: file.size, ocr_text: ocrText }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.document) throw new Error(json?.error ?? "Lezen mislukt");
  return json.document as DocumentRow;
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
