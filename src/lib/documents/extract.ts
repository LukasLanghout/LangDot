// Tekst uit bestanden halen (serverside, gratis open-source libraries).
// PDF (unpdf), Word .docx (mammoth), Excel/ODS/CSV (SheetJS), PowerPoint .pptx / OpenDocument / EPUB (jszip),
// RTF, HTML en alle tekst- en codebestanden. Afbeeldingen worden in de browser met OCR gelezen (zie client-upload).
// Audio/video worden opgeslagen maar niet gelezen.

import { htmlToText } from "@/lib/web";

export const MAX_TEXT_CHARS = 400_000;

export type Extracted = {
  status: "ready" | "unsupported" | "failed";
  text: string;
  kind: string;
  error?: string;
};

const TEXT_EXT = new Set([
  "txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "xml", "yaml", "yml", "toml", "ini", "cfg", "conf", "log", "env",
  "js", "jsx", "ts", "tsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "kt", "c", "h", "cpp", "hpp", "cs", "php", "swift",
  "sql", "sh", "bash", "ps1", "bat", "css", "scss", "less", "vue", "svelte", "r", "m", "lua", "dart", "scala", "tex", "srt",
  "vtt", "ics", "vcf", "eml", "svg", "gitignore", "dockerfile",
]);
const SHEET_EXT = new Set(["xlsx", "xlsm", "xlsb", "xls", "ods", "numbers"]);

export function extensionOf(name: string) {
  const base = name.toLowerCase().split(/[\\/]/).pop() ?? "";
  return base.includes(".") ? base.split(".").pop()! : base;
}

function clip(text: string) {
  const clean = text.replace(/\u0000/g, "").replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{4,}/g, "\n\n\n").trim();
  return clean.length > MAX_TEXT_CHARS ? `${clean.slice(0, MAX_TEXT_CHARS)}\n…[afgekapt]` : clean;
}

function decodeUtf8(buf: Buffer) {
  return buf.toString("utf8").replace(/^﻿/, "");
}

/** Ziet deze buffer eruit als leesbare tekst? (weinig controle- of vervangingstekens) */
export function looksLikeText(buf: Buffer) {
  const sample = buf.subarray(0, 8192).toString("utf8");
  if (!sample.length) return false;
  let bad = 0;
  for (const ch of sample) {
    const c = ch.charCodeAt(0);
    if (ch === "�" || (c < 32 && c !== 9 && c !== 10 && c !== 13)) bad++;
  }
  return bad / sample.length < 0.03;
}

function xmlText(xml: string) {
  return xml
    .replace(/<\/(text:p|text:h|w:p|a:p|p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ");
}

function rtfToText(rtf: string) {
  return rtf
    .replace(/\\par[d]?/g, "\n")
    .replace(/\{\\\*[^{}]*\}/g, "")
    .replace(/\\'([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\[a-z]+-?\d* ?/gi, "")
    .replace(/[{}]/g, "");
}

async function pdf(buf: Buffer) {
  const { extractText, getDocumentProxy } = (await import("unpdf")) as any;
  const doc = await getDocumentProxy(new Uint8Array(buf));
  const { text, totalPages } = await extractText(doc, { mergePages: false });
  const pages: string[] = Array.isArray(text) ? text.map((p: unknown) => String(p ?? "")) : [String(text ?? "")];
  // Paginamarkeringen zodat de dot kan citeren ("cv.pdf, pagina 2").
  const t = pages.map((p, i) => `[pagina ${i + 1}]\n${p.trim()}`).join("\n\n");
  if (!pages.some((p) => p.trim())) {
    return { status: "unsupported" as const, text: "", kind: "pdf", error: `PDF zonder tekstlaag (${totalPages} pagina's, waarschijnlijk gescand)` };
  }
  return { status: "ready" as const, text: t, kind: "pdf" };
}

async function docx(buf: Buffer) {
  const mod: any = await import("mammoth");
  const mammoth = mod.default ?? mod;
  const r = await mammoth.extractRawText({ buffer: buf });
  return { status: "ready" as const, text: String(r.value ?? ""), kind: "docx" };
}

async function sheet(buf: Buffer) {
  const mod: any = await import("xlsx");
  const XLSX = mod.default ?? mod;
  const wb = XLSX.read(buf, { type: "buffer" });
  const parts = (wb.SheetNames as string[]).map((n) => `## Blad: ${n}\n${XLSX.utils.sheet_to_csv(wb.Sheets[n])}`);
  return { status: "ready" as const, text: parts.join("\n\n"), kind: "spreadsheet" };
}

async function zip(buf: Buffer) {
  const mod: any = await import("jszip");
  const JSZip = mod.default ?? mod;
  return JSZip.loadAsync(buf);
}

async function pptx(buf: Buffer) {
  const z = await zip(buf);
  const slides = Object.keys(z.files)
    .filter((f: string) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a: string, b: string) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
  const out: string[] = [];
  for (const [i, f] of slides.entries()) {
    const xml: string = await z.file(f).async("string");
    const runs = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => m[1]);
    out.push(`## Dia ${i + 1}\n${xmlText(runs.join(" "))}`);
  }
  return { status: "ready" as const, text: out.join("\n\n"), kind: "pptx" };
}

async function openDocument(buf: Buffer) {
  const z = await zip(buf);
  const content = z.file("content.xml");
  if (!content) throw new Error("geen content.xml");
  return { status: "ready" as const, text: xmlText(await content.async("string")), kind: "opendocument" };
}

async function epub(buf: Buffer) {
  const z = await zip(buf);
  const files = Object.keys(z.files).filter((f: string) => /\.(x?html?)$/i.test(f)).sort();
  const parts: string[] = [];
  for (const f of files) parts.push(htmlToText(await z.file(f).async("string")));
  return { status: "ready" as const, text: parts.join("\n\n"), kind: "epub" };
}

async function zipListing(buf: Buffer) {
  const z = await zip(buf);
  const names = Object.keys(z.files).slice(0, 500);
  return { status: "ready" as const, text: `Zip-archief met ${Object.keys(z.files).length} bestanden:\n${names.join("\n")}`, kind: "zip" };
}

/** Haalt tekst uit een bestand. Gooit nooit: fouten komen terug als status "failed". */
export async function extractText(buf: Buffer, name: string, mime: string): Promise<Extracted> {
  const ext = extensionOf(name);
  const type = (mime || "").toLowerCase();
  try {
    let r: Extracted;
    if (ext === "pdf" || type === "application/pdf") r = await pdf(buf);
    else if (ext === "docx" || type.includes("wordprocessingml")) r = await docx(buf);
    else if (SHEET_EXT.has(ext) || type.includes("spreadsheet") || type.includes("ms-excel")) r = await sheet(buf);
    else if (ext === "pptx" || type.includes("presentationml")) r = await pptx(buf);
    else if (["odt", "odp", "odg"].includes(ext) || type.includes("opendocument")) r = await openDocument(buf);
    else if (ext === "epub" || type === "application/epub+zip") r = await epub(buf);
    else if (ext === "rtf" || type.includes("rtf")) r = { status: "ready", text: rtfToText(decodeUtf8(buf)), kind: "rtf" };
    else if (["html", "htm", "xhtml"].includes(ext) || type.includes("html")) r = { status: "ready", text: htmlToText(decodeUtf8(buf)), kind: "html" };
    else if (type.startsWith("image/")) r = { status: "unsupported", text: "", kind: "image", error: "Afbeelding zonder herkende tekst" };
    else if (type.startsWith("audio/") || type.startsWith("video/")) {
      r = { status: "unsupported", text: "", kind: "media", error: "Audio en video kan de dot (nog) niet lezen" };
    } else if (ext === "zip" || type === "application/zip") r = await zipListing(buf);
    else if (ext === "doc" || ext === "ppt") {
      r = { status: "unsupported", text: "", kind: ext, error: "Oud Office-formaat; sla het op als .docx of .pptx" };
    } else if (TEXT_EXT.has(ext) || type.startsWith("text/") || type.includes("json") || type.includes("xml") || looksLikeText(buf)) {
      r = { status: "ready", text: decodeUtf8(buf), kind: "text" };
    } else {
      r = { status: "unsupported", text: "", kind: "binary", error: "Onbekend bestandstype" };
    }
    if (r.status === "ready" && !r.text.trim()) return { status: "unsupported", text: "", kind: r.kind, error: "Geen tekst gevonden in dit bestand" };
    return { ...r, text: clip(r.text) };
  } catch (e) {
    console.warn(`[documents] extractie ${ext} mislukt:`, e instanceof Error ? e.message : e);
    return { status: "failed", text: "", kind: ext || "onbekend", error: "Het bestand kon niet worden gelezen (beschadigd of beveiligd?)" };
  }
}
