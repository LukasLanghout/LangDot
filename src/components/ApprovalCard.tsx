"use client";

import { useEffect, useState } from "react";
import type { ActionRow } from "@/lib/types";
import { formatTime } from "./ui";

const STATUS: Record<ActionRow["status"], { label: string; cls: string }> = {
  pending: { label: "wacht op jou", cls: "bg-warn/20 text-warn" },
  approved: { label: "goedgekeurd, niet verstuurd", cls: "bg-warn/20 text-warn" },
  executed: { label: "verstuurd", cls: "bg-ok/15 text-ok" },
  rejected: { label: "afgewezen", cls: "bg-line text-muted" },
  expired: { label: "verlopen", cls: "bg-line text-muted" },
};

/** Goedkeuringskaart voor een mail. Alleen een klik hier kan een mail laten versturen. */
export function ApprovalCard({ action }: { action: ActionRow }) {
  const [to, setTo] = useState(action.payload.to.join(", "));
  const [subject, setSubject] = useState(action.payload.subject);
  const [body, setBody] = useState(action.payload.body);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<null | "send" | "reject" | "retry">(null);
  const [error, setError] = useState<string | null>(null);

  // Realtime-updates van buitenaf (bv. vanuit het andere paneel) overnemen zolang we niet bewerken.
  useEffect(() => {
    if (editing) return;
    setTo(action.payload.to.join(", "));
    setSubject(action.payload.subject);
    setBody(action.payload.body);
  }, [action.payload, editing]);

  const s = STATUS[action.status];
  const pending = action.status === "pending";

  async function call(kind: "approve" | "reject" | "execute") {
    setBusy(kind === "approve" ? "send" : kind === "reject" ? "reject" : "retry");
    setError(null);
    const res = await fetch(`/api/actions/${action.id}/${kind}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: kind === "approve" ? JSON.stringify({ to, subject, body }) : undefined,
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || json?.ok === false) setError(json?.error ?? "Dat lukte niet. Probeer het opnieuw.");
    else setEditing(false);
    setBusy(null);
  }

  return (
    <div className={`rounded-xl border p-3 text-sm ${pending ? "border-warn/50 bg-warn/5" : "border-line bg-panel-2"}`}>
      <div className="flex items-center gap-2 mb-2">
        <span className="font-medium">✉ Mail</span>
        <span className={`text-[11px] px-2 py-0.5 rounded-full ${s.cls}`}>{s.label}</span>
        {action.executed_at && action.status === "executed" && (
          <span className="text-[11px] text-muted">{formatTime(action.executed_at)}</span>
        )}
        {pending && !editing && (
          <button onClick={() => setEditing(true)} className="ml-auto text-xs text-muted hover:text-fg">bewerken</button>
        )}
      </div>

      {editing ? (
        <div className="space-y-2">
          <label className="block">
            <span className="text-[11px] text-muted">Aan (komma-gescheiden)</span>
            <input value={to} onChange={(e) => setTo(e.target.value)} className="w-full rounded bg-panel border border-line px-2 py-1 outline-none focus:border-accent" />
          </label>
          <label className="block">
            <span className="text-[11px] text-muted">Onderwerp</span>
            <input value={subject} onChange={(e) => setSubject(e.target.value)} className="w-full rounded bg-panel border border-line px-2 py-1 outline-none focus:border-accent" />
          </label>
          <label className="block">
            <span className="text-[11px] text-muted">Tekst</span>
            <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={8} className="w-full rounded bg-panel border border-line px-2 py-1.5 outline-none focus:border-accent" />
          </label>
        </div>
      ) : (
        <div className="space-y-1">
          <div><span className="text-muted">Aan:</span> {to}</div>
          <div><span className="text-muted">Onderwerp:</span> {subject || <em className="text-muted">(geen)</em>}</div>
          <div className="mt-2 whitespace-pre-wrap rounded-lg bg-bg/40 border border-line p-2.5 max-h-72 overflow-y-auto">{body}</div>
        </div>
      )}

      {action.error && action.status === "approved" && <p className="text-bad text-xs mt-2">{action.error}</p>}
      {error && <p className="text-bad text-xs mt-2">{error}</p>}

      {pending && (
        <div className="flex gap-2 mt-3">
          <button
            onClick={() => call("approve")}
            disabled={!!busy}
            className="rounded-lg bg-accent text-white px-4 py-1.5 font-medium hover:brightness-110 disabled:opacity-50"
          >
            {busy === "send" ? "Versturen…" : "Versturen"}
          </button>
          <button onClick={() => call("reject")} disabled={!!busy} className="rounded-lg border border-line px-4 py-1.5 hover:bg-panel disabled:opacity-50">
            {busy === "reject" ? "Afwijzen…" : "Afwijzen"}
          </button>
          {editing && (
            <button onClick={() => setEditing(false)} disabled={!!busy} className="ml-auto text-xs text-muted hover:text-fg">
              klaar met bewerken
            </button>
          )}
        </div>
      )}

      {action.status === "approved" && (
        <div className="flex gap-2 mt-3 items-center">
          <button onClick={() => call("execute")} disabled={!!busy} className="rounded-lg bg-accent text-white px-4 py-1.5 font-medium disabled:opacity-50">
            {busy === "retry" ? "Versturen…" : "Opnieuw proberen"}
          </button>
          <a href="/connections" className="text-xs text-muted hover:text-fg">Verbindingen</a>
        </div>
      )}
    </div>
  );
}
