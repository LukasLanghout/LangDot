"use client";

import { useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Memory, MemoryKind } from "@/lib/types";
import { formatTime } from "./ui";

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
      <li className="rounded-lg border border-accent/50 bg-panel-2 p-2.5 space-y-2">
        <select value={kind} onChange={(e) => setKind(e.target.value as MemoryKind)} className="bg-panel border border-line rounded px-2 py-1 text-xs">
          {KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
        </select>
        <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={3}
          className="w-full rounded bg-panel border border-line px-2 py-1.5 text-sm outline-none focus:border-accent" />
        <div className="flex gap-2 justify-end text-xs">
          <button onClick={() => { setEditing(false); setContent(memory.content); setKind(memory.kind); }} className="text-muted hover:text-fg">Annuleren</button>
          <button
            onClick={async () => { await onSave(memory, content.trim(), kind); setEditing(false); }}
            disabled={!content.trim()}
            className="rounded bg-accent text-white px-2.5 py-1 disabled:opacity-50"
          >
            Opslaan
          </button>
        </div>
      </li>
    );
  }

  return (
    <li className="group rounded-lg border border-line bg-panel-2 p-2.5">
      <div className="flex items-center gap-2 text-[11px] text-muted mb-1">
        <span className="px-1.5 rounded-full bg-line">{kindLabel(memory.kind)}</span>
        <span>{formatTime(memory.updated_at)}</span>
        <span className="ml-auto flex gap-2 opacity-100 lg:opacity-0 group-hover:opacity-100">
          <button onClick={() => setEditing(true)} className="hover:text-fg">bewerk</button>
          <button onClick={() => confirm("Notitie verwijderen?") && onDelete(memory)} className="hover:text-bad">verwijder</button>
        </span>
      </div>
      <div className="text-sm whitespace-pre-wrap">{memory.content}</div>
    </li>
  );
}

export function MemoryPanel({ userId, memories }: { userId: string; memories: Memory[] }) {
  const supabase = useMemo(() => createClient(), []);
  const [newContent, setNewContent] = useState("");
  const [newKind, setNewKind] = useState<MemoryKind>("preference");
  const [filter, setFilter] = useState<MemoryKind | "all">("all");
  const [error, setError] = useState<string | null>(null);

  const audit = (action: string, input: unknown) =>
    supabase.from("dot_audit").insert({ user_id: userId, actor: "user", action, input });

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const content = newContent.trim();
    if (!content) return;
    const { error } = await supabase.from("dot_memories").insert({ user_id: userId, kind: newKind, content });
    if (error) return setError(error.message);
    await audit("memory_added", { kind: newKind, content });
    setNewContent("");
  }

  async function save(m: Memory, content: string, kind: MemoryKind) {
    const { error } = await supabase.from("dot_memories")
      .update({ content, kind, updated_at: new Date().toISOString() }).eq("id", m.id);
    if (error) return setError(error.message);
    await audit("memory_edited", { id: m.id, before: m.content, after: content, kind });
  }

  async function remove(m: Memory) {
    const { error } = await supabase.from("dot_memories").delete().eq("id", m.id);
    if (error) return setError(error.message);
    await audit("memory_deleted", { id: m.id, content: m.content });
  }

  const shown = filter === "all" ? memories : memories.filter((m) => m.kind === filter);

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted">
        Wat je dot over je onthoudt. Hij schrijft hier zelf in, en gebruikt het in elk gesprek en elke taak.
      </p>

      <form onSubmit={add} className="rounded-lg border border-line p-2.5 space-y-2">
        <textarea value={newContent} onChange={(e) => setNewContent(e.target.value)} rows={2} placeholder="Nieuwe notitie…"
          className="w-full rounded bg-panel-2 border border-line px-2 py-1.5 text-sm outline-none focus:border-accent" />
        <div className="flex gap-2 items-center">
          <select value={newKind} onChange={(e) => setNewKind(e.target.value as MemoryKind)} className="bg-panel-2 border border-line rounded px-2 py-1 text-xs">
            {KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
          </select>
          <button disabled={!newContent.trim()} className="ml-auto rounded bg-accent text-white px-3 py-1 text-sm disabled:opacity-40">Toevoegen</button>
        </div>
      </form>

      <div className="flex gap-1 flex-wrap text-xs">
        {[{ id: "all" as const, label: "Alles" }, ...KINDS].map((k) => (
          <button key={k.id} onClick={() => setFilter(k.id)}
            className={`px-2 py-1 rounded-full border ${filter === k.id ? "border-accent text-fg" : "border-line text-muted"}`}>
            {k.label}
          </button>
        ))}
      </div>

      {error && <p className="text-bad text-xs">{error}</p>}
      {shown.length === 0 ? (
        <p className="text-sm text-muted">Nog niets onthouden.</p>
      ) : (
        <ul className="space-y-2">
          {shown.map((m) => <MemoryRow key={m.id} memory={m} onSave={save} onDelete={remove} />)}
        </ul>
      )}
    </div>
  );
}
