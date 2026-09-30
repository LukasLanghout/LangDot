"use client";

import { Fragment, useState } from "react";
import type { Task, TaskStatus } from "@/lib/types";

export function formatTime(iso: string) {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return d.toLocaleString("nl-NL", sameDay ? { hour: "2-digit", minute: "2-digit" } : { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

const STATUS: Record<TaskStatus, { label: string; cls: string }> = {
  pending: { label: "wachtrij", cls: "bg-line text-muted" },
  running: { label: "bezig", cls: "bg-accent/20 text-accent" },
  needs_input: { label: "jouw beslissing", cls: "bg-warn/20 text-warn" },
  done: { label: "klaar", cls: "bg-ok/15 text-ok" },
  cancelled: { label: "geannuleerd", cls: "bg-line text-muted" },
  failed: { label: "mislukt", cls: "bg-bad/15 text-bad" },
};

export function StatusBadge({ status }: { status: TaskStatus }) {
  const s = STATUS[status] ?? STATUS.pending;
  return <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full whitespace-nowrap ${s.cls}`}>{s.label}</span>;
}

/** Antwoordknoppen voor een taak die op de gebruiker wacht. */
export function QuestionOptions({ task }: { task: Task }) {
  const [busy, setBusy] = useState(false);
  const [custom, setCustom] = useState("");
  const [showCustom, setShowCustom] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function answer(text: string) {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/tasks/${task.id}/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer: text }),
    });
    if (!res.ok) setError((await res.json().catch(() => null))?.error ?? "Mislukt");
    setBusy(false);
  }

  return (
    <div className="mt-2 space-y-2">
      <div className="flex flex-wrap gap-2">
        {(task.options ?? []).map((o) => (
          <button
            key={o.label}
            disabled={busy}
            onClick={() => answer(o.label)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium disabled:opacity-50 ${
              o.approves ? "bg-accent text-white hover:brightness-110" : "border border-line hover:bg-panel-2"
            }`}
          >
            {o.label}
          </button>
        ))}
        <button onClick={() => setShowCustom((v) => !v)} className="px-2 text-sm text-muted hover:text-fg">
          Ander antwoord…
        </button>
      </div>
      {showCustom && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (custom.trim()) answer(custom.trim());
          }}
          className="flex gap-2"
        >
          <input
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            placeholder="Typ je antwoord (telt niet als goedkeuring)"
            className="flex-1 min-w-0 rounded-lg bg-panel-2 border border-line px-3 py-1.5 text-sm outline-none focus:border-accent"
          />
          <button disabled={busy} className="rounded-lg border border-line px-3 text-sm hover:bg-panel-2">Stuur</button>
        </form>
      )}
      {error && <p className="text-bad text-xs">{error}</p>}
    </div>
  );
}

// ─────────── Mini-Markdown (veilig: bouwt React-elementen, geen innerHTML) ───────────

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

function inline(text: string, keyBase: string) {
  const parts = text.split(INLINE);
  return parts.map((p, i) => {
    const key = `${keyBase}-${i}`;
    if (!p) return null;
    if (p.startsWith("**") && p.endsWith("**") && p.length > 4) return <strong key={key}>{p.slice(2, -2)}</strong>;
    if (p.startsWith("`") && p.endsWith("`") && p.length > 2) return <code key={key}>{p.slice(1, -1)}</code>;
    const link = p.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/);
    if (link) return <a key={key} href={link[2]} target="_blank" rel="noopener noreferrer">{link[1]}</a>;
    if (/^https?:\/\//.test(p)) return <a key={key} href={p} target="_blank" rel="noopener noreferrer">{p}</a>;
    return <Fragment key={key}>{p}</Fragment>;
  });
}

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r/g, "").split("\n");
  const blocks: React.ReactNode[] = [];
  let para: string[] = [];
  let list: string[] = [];

  const flushPara = () => {
    if (!para.length) return;
    const k = `p${blocks.length}`;
    blocks.push(
      <p key={k}>
        {para.map((l, i) => (
          <Fragment key={i}>
            {i > 0 && <br />}
            {inline(l, `${k}-${i}`)}
          </Fragment>
        ))}
      </p>,
    );
    para = [];
  };
  const flushList = () => {
    if (!list.length) return;
    const k = `ul${blocks.length}`;
    blocks.push(<ul key={k}>{list.map((l, i) => <li key={i}>{inline(l, `${k}-${i}`)}</li>)}</ul>);
    list = [];
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^\s*[-*]\s+/.test(line) && !/^-{3,}$/.test(line.trim())) {
      flushPara();
      list.push(line.replace(/^\s*[-*]\s+/, ""));
    } else if (/^-{3,}$/.test(line.trim())) {
      flushPara();
      flushList();
      blocks.push(<hr key={`hr${blocks.length}`} />);
    } else if (!line.trim()) {
      flushPara();
      flushList();
    } else {
      flushList();
      const heading = line.match(/^#{1,6}\s+(.*)$/);
      para.push(heading ? `**${heading[1]}**` : line);
    }
  }
  flushPara();
  flushList();
  return <div className="msg">{blocks}</div>;
}
