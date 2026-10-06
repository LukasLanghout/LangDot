"use client";

import { useState } from "react";
import type { Memory, MemoryKind } from "@/lib/types";
import { btn, chip, field, formatTime, textBtn } from "./ui";
import { Icon } from "./Icon";

const KINDS: { id: MemoryKind; label: string }[] = [
  { id: "preference", label: "Voorkeur" },
  { id: "decision", label: "Beslissing" },
  { id: "work", label: "Lopend werk" },
  { id: "fact", label: "Feit" },
];
const kindLabel = (k: string) => KINDS.find((x) => x.id === k)?.label ?? k;

function MemoryRow({ memory, onSave, onDelete }: {
  memory: Memory;
  onSave: (m: Memory, content: string, kind: MemoryKind) => Promise<void>;
  onDelete: (m: Memory) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(memory.content);
  const [kind, setKind] = useState<MemoryKind>(memory.kind);

  if (editing) {
    return (
      <li className="rounded-2xl border border-accent-soft/60 bg-panel p-3.5 space-y-2.5">
        <select value={kind} onChange={(e) => setKind(e.target.value as MemoryKind)} aria-label="Soort notitie" className={`${field} !w-auto`}>
          {KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
        </select>
        <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={3} aria-label="Inhoud" className={field} />
        <div className="flex gap-2 justify-end">
          <button onClick={() => { setEditing(false); setContent(memory.content); setKind(memory.kind); }} className={btn.ghost}>Annuleren</button>
          <button
            onClick={async () => { await onSave(memory, content.trim(), kind); setEditing(false); }}
            disabled={!content.trim()}
            className={btn.primary}
          >
            Opslaan
          </button>
        </div>
      </li>
    );
  }

  return (
    <li className="group rounded-2xl border border-line bg-panel p-3.5">
      <div className="flex items-center gap-2 text-[13px] text-faint mb-1">
        <span>{kindLabel(memory.kind)}</span>
        <span aria-hidden>·</span>
        <span>{formatTime(memory.updated_at)}</span>
        <span className="ml-auto flex gap-1 opacity-100 lg:opacity-0 lg:group-hover:opacity-100 lg:group-focus-within:opacity-100 transition-opacity">
          <button onClick={() => setEditing(true)} className={textBtn} aria-label="Notitie bewerken">Bewerk</button>
          <button onClick={() => confirm("Notitie verwijderen?") && onDelete(memory)} className={`${textBtn} hover:!text-bad`} aria-label="Notitie verwijderen">Verwijder</button>
        </span>
      </div>
      <div className="text-[15px] whitespace-pre-wrap">{memory.content}</div>
    </li>
  );
}

export function MemoryPanel({ memories, cauraFleet }: { memories: Memory[]; cauraFleet: string | null }) {
  const [newContent, setNewContent] = useState("");
  const [newKind, setNewKind] = useState<MemoryKind>("preference");
  const [filter, setFilter] = useState<MemoryKind | "all">("all");
  const [error, setError] = useState<string | null>(null);
  // Meteen uit de lijst halen bij verwijderen; niet wachten op realtime (voorkomt dubbel klikken).
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  // Via de server: die houdt het audit-log bij en synchroniseert met Caura.
  async function api(method: "POST" | "PATCH" | "DELETE", body?: unknown, query = "") {
    setError(null);
    const res = await fetch(`/api/memories${query}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      setError((await res.json().catch(() => null))?.error ?? `Mislukt (HTTP ${res.status})`);
      return false;
    }
    return true;
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const content = newContent.trim();
    if (!content) return;
    if (await api("POST", { kind: newKind, content })) setNewContent("");
  }

  async function save(m: Memory, content: string, kind: MemoryKind) {
    await api("PATCH", { id: m.id, content, kind });
  }

  async function remove(m: Memory) {
    setError(null);
    setHidden((h) => new Set(h).add(m.id));
    const res = await fetch(`/api/memories?id=${encodeURIComponent(m.id)}`, { method: "DELETE" });
    // 404 = al verwijderd: prima. Andere fout: terugzetten en melden.
    if (!res.ok && res.status !== 404) {
      setHidden((h) => {
        const n = new Set(h);
        n.delete(m.id);
        return n;
      });
      setError((await res.json().catch(() => null))?.error ?? `Verwijderen mislukt (HTTP ${res.status})`);
    }
  }

  const visible = memories.filter((m) => !hidden.has(m.id));
  const shown = filter === "all" ? visible : visible.filter((m) => m.kind === filter);

  return (
    <div className="space-y-4">
      <p className="text-[14px] text-muted">
        Wat je dot over je onthoudt. Hij schrijft hier zelf in, en gebruikt het in elk gesprek en elke taak.
      </p>
      {cauraFleet && (
        <p className="text-[13px] rounded-xl border border-line bg-panel-2 px-3.5 py-2.5 text-muted">
          Gedeeld via Caura, fleet <code className="break-all text-fg">{cauraFleet}</code>. Andere dots of agents die in deze fleet schrijven, delen deze kennis.
        </p>
      )}

      <form onSubmit={add} className="rounded-2xl border border-line bg-panel p-3.5 space-y-2.5">
        <textarea value={newContent} onChange={(e) => setNewContent(e.target.value)} rows={2} placeholder="Nieuwe notitie…" aria-label="Nieuwe notitie" className={field} />
        <div className="flex gap-2 items-center">
          <select value={newKind} onChange={(e) => setNewKind(e.target.value as MemoryKind)} aria-label="Soort notitie" className={`${field} !w-auto`}>
            {KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
          </select>
          <button disabled={!newContent.trim()} className={`${btn.primary} ml-auto`}>
            <Icon name="plus" size={15} />
            Toevoegen
          </button>
        </div>
      </form>

      <div className="flex gap-1.5 flex-wrap" role="group" aria-label="Filter op soort">
        {[{ id: "all" as const, label: "Alles" }, ...KINDS].map((k) => (
          <button key={k.id} onClick={() => setFilter(k.id)} aria-pressed={filter === k.id} className={chip(filter === k.id)}>
            {k.label}
          </button>
        ))}
      </div>

      {error && <p className="text-bad text-[13px]">{error}</p>}
      {shown.length === 0 ? (
        <p className="text-[15px] text-muted">Nog niets onthouden.</p>
      ) : (
        <ul className="space-y-2.5">
          {shown.map((m) => <MemoryRow key={m.id} memory={m} onSave={save} onDelete={remove} />)}
        </ul>
      )}
    </div>
  );
}
