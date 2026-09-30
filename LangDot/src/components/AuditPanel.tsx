"use client";

import { useState } from "react";
import type { AuditEntry } from "@/lib/types";
import { formatTime } from "./ui";

const ACTOR_CLS: Record<string, string> = {
  agent: "bg-accent/20 text-accent",
  user: "bg-ok/15 text-ok",
  system: "bg-line text-muted",
};

function Entry({ e }: { e: AuditEntry }) {
  const [open, setOpen] = useState(false);
  const hasDetail = e.input != null || e.output != null;
  return (
    <li className="border-b border-line/60 py-2">
      <button onClick={() => hasDetail && setOpen((o) => !o)} className="w-full text-left flex items-center gap-2 text-xs">
        <span className={`px-1.5 rounded-full ${ACTOR_CLS[e.actor] ?? ""}`}>{e.actor}</span>
        <span className="font-medium text-fg">{e.tool ?? e.action}</span>
        {e.tool && <span className="text-muted">{e.action}</span>}
        <span className="ml-auto text-muted whitespace-nowrap">{formatTime(e.created_at)}</span>
      </button>
      {open && (
        <pre className="mt-2 text-[11px] bg-bg/60 border border-line rounded p-2 overflow-x-auto whitespace-pre-wrap break-all max-h-64">
          {e.input != null && `input: ${JSON.stringify(e.input, null, 2)}\n`}
          {e.output != null && `output: ${JSON.stringify(e.output, null, 2)}`}
        </pre>
      )}
    </li>
  );
}

export function AuditPanel({ entries }: { entries: AuditEntry[] }) {
  const [actor, setActor] = useState<"all" | "agent" | "user" | "system">("all");
  const shown = actor === "all" ? entries : entries.filter((e) => e.actor === actor);
  return (
    <div>
      <p className="text-xs text-muted mb-2">Elke tool-call van je dot en elke actie van jou. Alleen-lezen.</p>
      <div className="flex gap-1 text-xs mb-2">
        {(["all", "agent", "user", "system"] as const).map((a) => (
          <button key={a} onClick={() => setActor(a)}
            className={`px-2 py-1 rounded-full border ${actor === a ? "border-accent text-fg" : "border-line text-muted"}`}>
            {a === "all" ? "alles" : a}
          </button>
        ))}
      </div>
      {shown.length === 0 ? <p className="text-sm text-muted">Nog niets gelogd.</p> : <ul>{shown.map((e) => <Entry key={e.id} e={e} />)}</ul>}
    </div>
  );
}
