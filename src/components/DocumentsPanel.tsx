"use client";

import { useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { formatBytes, uploadDocument } from "@/lib/documents/client-upload";
import type { DocumentRow } from "@/lib/types";
import { formatTime } from "./ui";

const STATUS: Record<DocumentRow["status"], { label: string; cls: string }> = {
  ready: { label: "leesbaar", cls: "bg-ok/15 text-ok" },
  unsupported: { label: "niet leesbaar", cls: "bg-warn/20 text-warn" },
  failed: { label: "mislukt", cls: "bg-bad/15 text-bad" },
};

export function DocumentsPanel({ userId, documents }: { userId: string; documents: DocumentRow[] }) {
  const supabase = useMemo(() => createClient(), []);
  const fileRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteName, setPasteName] = useState("Over mij");
  const [pasteText, setPasteText] = useState("");
  const [pastePinned, setPastePinned] = useState(true);

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setError(null);
    for (const file of Array.from(files)) {
      try {
        await uploadDocument(supabase, userId, file, (s) => setStatus(`${file.name}: ${s}`));
      } catch (e) {
        setError(`${file.name}: ${e instanceof Error ? e.message : "mislukt"}`);
      }
    }
    setStatus(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function savePaste(e: React.FormEvent) {
    e.preventDefault();
    if (!pasteText.trim()) return;
    setStatus("opslaan…");
    const res = await fetch("/api/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: pasteName, text: pasteText, pinned: pastePinned }),
    });
    setStatus(null);
    if (!res.ok) return setError((await res.json().catch(() => null))?.error ?? "Opslaan mislukt");
    setPasteText("");
    setPasteOpen(false);
  }

  async function togglePin(d: DocumentRow) {
    await fetch(`/api/documents/${d.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pinned: !d.pinned }),
    });
  }

  async function remove(d: DocumentRow) {
    if (!confirm(`"${d.name}" verwijderen?`)) return;
    await fetch(`/api/documents/${d.id}`, { method: "DELETE" });
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted">
        Documenten die je dot kan lezen en als bijlage kan meesturen. PDF, Word, Excel, PowerPoint, tekst, code en
        afbeeldingen (tekst wordt herkend). <strong>Vastgezet</strong> = gaat altijd mee als achtergrond, bijvoorbeeld een profiel over jezelf.
      </p>

      <div className="flex gap-2 flex-wrap">
        <button onClick={() => fileRef.current?.click()} className="rounded-lg bg-accent text-white px-3 py-1.5 text-sm font-medium hover:brightness-110">
          📎 Bestand toevoegen
        </button>
        <button onClick={() => setPasteOpen((v) => !v)} className="rounded-lg border border-line px-3 py-1.5 text-sm hover:bg-panel-2">
          ✎ Tekst plakken
        </button>
        <input ref={fileRef} type="file" multiple className="hidden" onChange={(e) => upload(e.target.files)} />
      </div>

      {pasteOpen && (
        <form onSubmit={savePaste} className="rounded-lg border border-line p-2.5 space-y-2">
          <input value={pasteName} onChange={(e) => setPasteName(e.target.value)} placeholder="Naam"
            className="w-full rounded bg-panel-2 border border-line px-2 py-1.5 text-sm outline-none focus:border-accent" />
          <textarea value={pasteText} onChange={(e) => setPasteText(e.target.value)} rows={8} placeholder="Plak hier je tekst…"
            className="w-full rounded bg-panel-2 border border-line px-2 py-1.5 text-sm outline-none focus:border-accent" />
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={pastePinned} onChange={(e) => setPastePinned(e.target.checked)} />
            Vastzetten (altijd meenemen)
          </label>
          <button disabled={!pasteText.trim()} className="rounded bg-accent text-white px-3 py-1 text-sm disabled:opacity-40">Opslaan</button>
        </form>
      )}

      {status && <p className="text-xs text-muted">⏳ {status}</p>}
      {error && <p className="text-xs text-bad">{error}</p>}

      {documents.length === 0 ? (
        <p className="text-sm text-muted">Nog geen documenten.</p>
      ) : (
        <ul className="space-y-2">
          {documents.map((d) => (
            <li key={d.id} className={`rounded-lg border p-2.5 ${d.pinned ? "border-accent/50 bg-accent/5" : "border-line bg-panel-2"}`}>
              <div className="flex items-center gap-2">
                <span className="font-medium text-sm truncate flex-1" title={d.name}>{d.pinned && "📌 "}{d.name}</span>
                <span className={`text-[11px] px-1.5 rounded-full ${STATUS[d.status].cls}`}>{STATUS[d.status].label}</span>
              </div>
              <div className="text-[11px] text-muted mt-0.5">
                {d.storage_path ? formatBytes(d.size) : "geplakte tekst"} · {d.text_chars.toLocaleString("nl-NL")} tekens · {formatTime(d.created_at)}
              </div>
              {d.error && <div className="text-[11px] text-warn">{d.error}</div>}
              <div className="flex gap-3 justify-end text-xs text-muted mt-1">
                {d.status === "ready" && (
                  <button onClick={() => togglePin(d)} className="hover:text-fg">{d.pinned ? "losmaken" : "vastzetten"}</button>
                )}
                <button onClick={() => remove(d)} className="hover:text-bad">verwijder</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
