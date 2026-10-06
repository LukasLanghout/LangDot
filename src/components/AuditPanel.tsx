"use client";

import { useState } from "react";
import type { AuditEntry } from "@/lib/types";
import { btn, chip, field, formatTime } from "./ui";
import { Icon } from "./Icon";

const ACTOR_LABEL: Record<string, string> = { agent: "dot", user: "jij", system: "systeem" };

function Entry({ e }: { e: AuditEntry }) {
  const [open, setOpen] = useState(false);
  const hasDetail = e.input != null || e.output != null;
  return (
    <li className="border-b border-line py-2.5">
      <button
        onClick={() => hasDetail && setOpen((o) => !o)}
        aria-expanded={hasDetail ? open : undefined}
        className="w-full text-left flex items-center gap-2 text-[14px] min-h-11 sm:min-h-0"
      >
        <span className="text-[13px] text-faint w-14 shrink-0">{ACTOR_LABEL[e.actor] ?? e.actor}</span>
        <span className="font-medium text-fg truncate">{e.tool ?? e.action}</span>
        {e.tool && <span className="text-faint truncate">{e.action}</span>}
        <span className="ml-auto text-[13px] text-faint whitespace-nowrap">{formatTime(e.created_at)}</span>
      </button>
      {open && (
        <pre className="mt-2 text-[12px] bg-bg border border-line rounded-xl p-3 overflow-x-auto whitespace-pre-wrap break-all max-h-64">
          {e.input != null && `input: ${JSON.stringify(e.input, null, 2)}\n`}
          {e.output != null && `output: ${JSON.stringify(e.output, null, 2)}`}
        </pre>
      )}
    </li>
  );
}

export function AuditPanel({ entries }: { entries: AuditEntry[] }) {
  const [actor, setActor] = useState<"all" | "agent" | "user" | "system">("all");
  const [q, setQ] = useState("");
  const byActor = actor === "all" ? entries : entries.filter((e) => e.actor === actor);
  const needle = q.trim().toLowerCase();
  const shown = needle ? byActor.filter((e) => `${e.tool ?? ""} ${e.action}`.toLowerCase().includes(needle)) : byActor;

  /** Exporteert wat nu in beeld is als JSON-bestand. Alleen lokaal, er gaat niets naar een server. */
  function exportJson() {
    const blob = new Blob([JSON.stringify(shown, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `langdot-audit-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-3">
      <p className="text-[14px] text-muted">Elke tool-call van je dot en elke actie van jou. Alleen-lezen.</p>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Zoek op tool of actie" aria-label="Zoek in het log" className={field} />
      <div className="flex gap-1.5 flex-wrap items-center" role="group" aria-label="Filter op wie">
        {(["all", "agent", "user", "system"] as const).map((a) => (
          <button key={a} onClick={() => setActor(a)} aria-pressed={actor === a} className={chip(actor === a)}>
            {a === "all" ? "Alles" : ACTOR_LABEL[a]}
          </button>
        ))}
        <button onClick={exportJson} disabled={shown.length === 0} className={`${btn.ghost} ml-auto !h-8`} title="Exporteer wat je nu ziet">
          <Icon name="download" size={15} />
          Exporteer
        </button>
      </div>
      {shown.length === 0 ? <p className="text-[15px] text-muted">Niets gevonden.</p> : <ul>{shown.map((e) => <Entry key={e.id} e={e} />)}</ul>}
    </div>
  );
}
