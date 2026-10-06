"use client";

import { useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { formatBytes, uploadDocument } from "@/lib/documents/client-upload";
import type { DocumentRow } from "@/lib/types";
import { btn, field, formatTime, Spinner, Switch, textBtn } from "./ui";
import { Icon } from "./Icon";

const STATUS: Record<DocumentRow["status"], { label: string; dot: string }> = {
  ready: { label: "leesbaar", dot: "bg-ok" },
  unsupported: { label: "niet leesbaar", dot: "bg-warn" },
  failed: { label: "mislukt", dot: "bg-bad" },
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
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [retrying, setRetrying] = useState<string | null>(null);

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

  async function retry(d: DocumentRow) {
    setRetrying(d.id);
    setError(null);
    const res = await fetch(`/api/documents/${d.id}/retry`, { method: "POST" });
    if (!res.ok) setError((await res.json().catch(() => null))?.error ?? `"${d.name}" opnieuw lezen lukte niet.`);
    setRetrying(null);
  }

  async function remove(d: DocumentRow) {
    if (!confirm(`"${d.name}" verwijderen?`)) return;
    setHidden((h) => new Set(h).add(d.id));
    const res = await fetch(`/api/documents/${d.id}`, { method: "DELETE" });
    if (!res.ok && res.status !== 404) {
      setHidden((h) => {
        const n = new Set(h);
        n.delete(d.id);
        return n;
      });
      setError(`"${d.name}" verwijderen mislukt.`);
    }
  }

  const visibleDocs = documents.filter((d) => !hidden.has(d.id));

  return (
    <div className="space-y-4">
      <p className="text-[14px] text-muted">
        Documenten die je dot kan lezen en als bijlage kan meesturen: PDF, Word, Excel, PowerPoint, tekst, code en
        afbeeldingen (tekst wordt herkend). Vastgezet betekent dat het altijd als achtergrond meegaat, bijvoorbeeld een profiel over jezelf.
      </p>

      <div className="flex gap-2 flex-wrap">
        <button onClick={() => fileRef.current?.click()} className={btn.primary}>
          <Icon name="paperclip" size={16} />
          Bestand toevoegen
        </button>
        <button onClick={() => setPasteOpen((v) => !v)} aria-expanded={pasteOpen} className={btn.secondary}>
          <Icon name="pencil" size={16} />
          Tekst plakken
        </button>
        <input ref={fileRef} type="file" multiple className="hidden" onChange={(e) => upload(e.target.files)} />
      </div>

      {pasteOpen && (
        <form onSubmit={savePaste} className="rounded-2xl border border-line bg-panel p-3.5 space-y-2.5">
          <input value={pasteName} onChange={(e) => setPasteName(e.target.value)} placeholder="Naam" aria-label="Naam" className={field} />
          <textarea value={pasteText} onChange={(e) => setPasteText(e.target.value)} rows={8} placeholder="Plak hier je tekst…" aria-label="Tekst" className={field} />
          <div className="flex items-center gap-3 text-[14px]">
            <Switch checked={pastePinned} onChange={setPastePinned} label="Vastzetten" />
            <span>Vastzetten (altijd meenemen)</span>
          </div>
          <button disabled={!pasteText.trim()} className={btn.primary}>Opslaan</button>
        </form>
      )}

      {status && <p className="text-[13px] text-muted flex items-center gap-2"><Spinner />{status}</p>}
      {error && <p className="text-[13px] text-bad">{error}</p>}

      {visibleDocs.length === 0 ? (
        <p className="text-[15px] text-muted">Nog geen documenten.</p>
      ) : (
        <ul className="space-y-2.5">
          {visibleDocs.map((d) => (
            <li key={d.id} className={`rounded-2xl border p-3.5 ${d.pinned ? "border-accent-soft/60 bg-accent-soft/10" : "border-line bg-panel"}`}>
              <div className="flex items-center gap-2">
                {d.pinned && <Icon name="pin" size={14} className="text-faint shrink-0" />}
                <span className="font-medium text-[15px] truncate flex-1" title={d.name}>{d.name}</span>
                <span className="inline-flex items-center gap-1.5 text-[13px] text-muted whitespace-nowrap">
                  <span className={`w-1.5 h-1.5 rounded-full ${STATUS[d.status].dot}`} aria-hidden />
                  {STATUS[d.status].label}
                </span>
              </div>
              <div className="text-[13px] text-faint mt-0.5">
                {d.storage_path ? formatBytes(d.size) : "geplakte tekst"} · {d.text_chars.toLocaleString("nl-NL")} tekens · {formatTime(d.created_at)}
              </div>
              {d.error && <div className="text-[13px] text-muted mt-1">{d.error}</div>}
              <div className="flex gap-1 justify-end mt-1.5">
                {d.status !== "ready" && d.storage_path && (
                  <button onClick={() => retry(d)} disabled={retrying === d.id} className={textBtn}>
                    {retrying === d.id ? "Bezig…" : "Opnieuw lezen"}
                  </button>
                )}
                {d.status === "ready" && (
                  <button onClick={() => togglePin(d)} className={textBtn}>{d.pinned ? "Losmaken" : "Vastzetten"}</button>
                )}
                <button onClick={() => remove(d)} className={`${textBtn} hover:!text-bad`}>Verwijder</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
