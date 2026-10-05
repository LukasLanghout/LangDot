"use client";

import { useEffect, useState } from "react";
import type { ActionRow } from "@/lib/types";
import { formatTime } from "./ui";

const TZ = "Europe/Amsterdam";

const STATUS: Record<ActionRow["status"], { label: string; cls: string }> = {
  pending: { label: "wacht op jou", cls: "bg-warn/20 text-warn" },
  approved: { label: "goedgekeurd, niet uitgevoerd", cls: "bg-warn/20 text-warn" },
  executed: { label: "uitgevoerd", cls: "bg-ok/15 text-ok" },
  rejected: { label: "afgewezen", cls: "bg-line text-muted" },
  expired: { label: "verlopen", cls: "bg-line text-muted" },
};

/** ISO met offset → "2026-10-02T14:00" voor <input type="datetime-local"> (in Europe/Amsterdam). */
function toLocalInput(iso: string) {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(d);
  return parts.replace(" ", "T");
}

function formatRange(startIso: string, endIso: string) {
  const s = new Date(startIso);
  const e = new Date(endIso);
  const day = s.toLocaleDateString("nl-NL", { weekday: "short", day: "numeric", month: "short", timeZone: TZ });
  const t = (d: Date) => d.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
  const sameDay = s.toLocaleDateString("nl-NL", { timeZone: TZ }) === e.toLocaleDateString("nl-NL", { timeZone: TZ });
  return sameDay ? `${day}, ${t(s)}–${t(e)}` : `${day} ${t(s)} – ${e.toLocaleDateString("nl-NL", { day: "numeric", month: "short", timeZone: TZ })} ${t(e)}`;
}

const input = "w-full rounded bg-panel border border-line px-2 py-1 outline-none focus:border-accent";

type ConsentRow = Extract<ActionRow, { type: "schedule_auto_send" }>;
type ProposalRow = Exclude<ActionRow, { type: "schedule_auto_send" }>;

const DAY = ["ma", "di", "wo", "do", "vr", "za", "zo"];
const days = (d: number[]) => (d.join(",") === "1,2,3,4,5" ? "werkdagen" : d.length === 7 ? "elke dag" : d.map((x) => DAY[x - 1]).join(", "));

/** Goedkeuringskaart. Alleen een klik hier kan iets met extern effect laten gebeuren. */
export function ApprovalCard({ action }: { action: ActionRow }) {
  return action.type === "schedule_auto_send" ? <ConsentCard action={action} /> : <ProposalCard action={action} />;
}

/** Eenmalige toestemming om vanuit schema's automatisch naar jezelf te mailen. */
function ConsentCard({ action }: { action: ConsentRow }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = action.status === "pending";

  async function call(kind: "approve" | "reject") {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/actions/${action.id}/${kind}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const json = await res.json().catch(() => null);
    if (!res.ok || json?.ok === false) setError(json?.error ?? "Dat lukte niet.");
    setBusy(false);
  }

  return (
    <div className={`rounded-xl border p-3 text-sm ${pending ? "border-warn/50 bg-warn/5" : "border-line bg-panel-2"}`}>
      <div className="flex items-center gap-2 mb-2">
        <span className="font-medium">🔁 Automatisch mailen naar jezelf</span>
        <span className={`text-[11px] px-2 py-0.5 rounded-full ${action.status === "executed" ? "bg-ok/15 text-ok" : STATUS[action.status].cls}`}>
          {action.status === "executed" ? "toegestaan" : STATUS[action.status].label}
        </span>
      </div>
      <p>
        Mag je dot op deze momenten <strong>zonder per keer te vragen</strong> een mail sturen naar <strong>{action.payload.to}</strong>?
      </p>
      <ul className="mt-1.5 space-y-0.5">
        {action.payload.schedules.map((s) => (
          <li key={s.id}>• {s.title}: {days(s.days)} om {s.time_of_day}</li>
        ))}
      </ul>
      <p className="text-xs text-muted mt-2">
        Alleen naar dit eigen adres. Mails aan anderen krijgen altijd een goedkeuringskaart. Intrekken kan altijd onder Gepland.
      </p>
      {error && <p className="text-bad text-xs mt-2">{error}</p>}
      {pending && (
        <div className="flex gap-2 mt-3">
          <button onClick={() => call("approve")} disabled={busy} className="rounded-lg bg-accent text-white px-4 py-1.5 font-medium hover:brightness-110 disabled:opacity-50">
            Toestaan
          </button>
          <button onClick={() => call("reject")} disabled={busy} className="rounded-lg border border-line px-4 py-1.5 hover:bg-panel disabled:opacity-50">
            Afwijzen
          </button>
        </div>
      )}
    </div>
  );
}

function ProposalCard({ action }: { action: ProposalRow }) {
  const isMail = action.type === "gmail_send";
  const [fields, setFields] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<null | "go" | "reject" | "retry">(null);
  const [error, setError] = useState<string | null>(null);

  // Waarden uit de actie overnemen (ook bij realtime-updates), behalve tijdens bewerken.
  useEffect(() => {
    if (editing) return;
    if (action.type === "gmail_send") {
      setFields({ to: action.payload.to.join(", "), subject: action.payload.subject, body: action.payload.body });
    } else {
      setFields({
        summary: action.payload.summary,
        start: toLocalInput(action.payload.start),
        end: toLocalInput(action.payload.end),
        location: action.payload.location ?? "",
        description: action.payload.description ?? "",
        attendees: (action.payload.attendees ?? []).join(", "),
      });
    }
  }, [action, editing]);

  const set = (k: string) => (e: { target: { value: string } }) => setFields((f) => ({ ...f, [k]: e.target.value }));
  const s = STATUS[action.status];
  const pending = action.status === "pending";
  const goLabel = isMail ? "Versturen" : "Inplannen";

  async function call(kind: "approve" | "reject" | "execute") {
    setBusy(kind === "approve" ? "go" : kind === "reject" ? "reject" : "retry");
    setError(null);
    const payload = isMail
      ? { to: fields.to, subject: fields.subject, body: fields.body }
      : {
          summary: fields.summary,
          start: fields.start,
          end: fields.end,
          time_zone: TZ,
          location: fields.location,
          description: fields.description,
          attendees: fields.attendees,
        };
    const res = await fetch(`/api/actions/${action.id}/${kind}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: kind === "approve" ? JSON.stringify(payload) : undefined,
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || json?.ok === false) setError(json?.error ?? "Dat lukte niet. Probeer het opnieuw.");
    else setEditing(false);
    setBusy(null);
  }

  return (
    <div className={`rounded-xl border p-3 text-sm ${pending ? "border-warn/50 bg-warn/5" : "border-line bg-panel-2"}`}>
      <div className="flex items-center gap-2 mb-2">
        <span className="font-medium">{isMail ? "✉ Mail" : "📅 Afspraak"}</span>
        <span className={`text-[11px] px-2 py-0.5 rounded-full ${s.cls}`}>
          {action.status === "executed" ? (isMail ? "verstuurd" : "ingepland") : s.label}
        </span>
        {action.executed_at && action.status === "executed" && <span className="text-[11px] text-muted">{formatTime(action.executed_at)}</span>}
        {pending && !editing && (
          <button onClick={() => setEditing(true)} className="ml-auto text-xs text-muted hover:text-fg">bewerken</button>
        )}
      </div>

      {editing ? (
        isMail ? (
          <div className="space-y-2">
            <label className="block"><span className="text-[11px] text-muted">Aan (komma-gescheiden)</span><input value={fields.to ?? ""} onChange={set("to")} className={input} /></label>
            <label className="block"><span className="text-[11px] text-muted">Onderwerp</span><input value={fields.subject ?? ""} onChange={set("subject")} className={input} /></label>
            <label className="block"><span className="text-[11px] text-muted">Tekst</span><textarea value={fields.body ?? ""} onChange={set("body")} rows={8} className={input} /></label>
          </div>
        ) : (
          <div className="space-y-2">
            <label className="block"><span className="text-[11px] text-muted">Titel</span><input value={fields.summary ?? ""} onChange={set("summary")} className={input} /></label>
            <div className="grid grid-cols-2 gap-2">
              <label className="block"><span className="text-[11px] text-muted">Start</span><input type="datetime-local" value={fields.start ?? ""} onChange={set("start")} className={input} /></label>
              <label className="block"><span className="text-[11px] text-muted">Eind</span><input type="datetime-local" value={fields.end ?? ""} onChange={set("end")} className={input} /></label>
            </div>
            <label className="block"><span className="text-[11px] text-muted">Locatie</span><input value={fields.location ?? ""} onChange={set("location")} className={input} /></label>
            <label className="block"><span className="text-[11px] text-muted">Genodigden (komma-gescheiden, krijgen een uitnodiging)</span><input value={fields.attendees ?? ""} onChange={set("attendees")} className={input} /></label>
            <label className="block"><span className="text-[11px] text-muted">Omschrijving</span><textarea value={fields.description ?? ""} onChange={set("description")} rows={3} className={input} /></label>
          </div>
        )
      ) : action.type === "gmail_send" ? (
        <div className="space-y-1">
          <div><span className="text-muted">Aan:</span> {action.payload.to.join(", ")}</div>
          <div><span className="text-muted">Onderwerp:</span> {action.payload.subject || <em className="text-muted">(geen)</em>}</div>
          <div className="mt-2 whitespace-pre-wrap rounded-lg bg-bg/40 border border-line p-2.5 max-h-72 overflow-y-auto">{action.payload.body}</div>
          {!!action.payload.attachments?.length && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {action.payload.attachments.map((a) => (
                <span key={a.document_id} className="text-xs rounded-full border border-line px-2 py-0.5">
                  📎 {a.name} <span className="text-muted">({Math.max(1, Math.round(a.size / 1024))} KB)</span>
                </span>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-1">
          <div className="font-medium">{action.payload.summary}</div>
          <div><span className="text-muted">Wanneer:</span> {formatRange(action.payload.start, action.payload.end)}</div>
          {action.payload.location && <div><span className="text-muted">Waar:</span> {action.payload.location}</div>}
          {!!action.payload.attendees?.length && (
            <div><span className="text-muted">Genodigden:</span> {action.payload.attendees.join(", ")} <span className="text-[11px] text-muted">(krijgen een uitnodiging)</span></div>
          )}
          {action.payload.description && <div className="mt-1 whitespace-pre-wrap text-muted">{action.payload.description}</div>}
        </div>
      )}

      {action.error && action.status === "approved" && <p className="text-bad text-xs mt-2">{action.error}</p>}
      {error && <p className="text-bad text-xs mt-2">{error}</p>}

      {pending && (
        <div className="flex gap-2 mt-3">
          <button onClick={() => call("approve")} disabled={!!busy} className="rounded-lg bg-accent text-white px-4 py-1.5 font-medium hover:brightness-110 disabled:opacity-50">
            {busy === "go" ? `${goLabel}…` : goLabel}
          </button>
          <button onClick={() => call("reject")} disabled={!!busy} className="rounded-lg border border-line px-4 py-1.5 hover:bg-panel disabled:opacity-50">
            {busy === "reject" ? "Afwijzen…" : "Afwijzen"}
          </button>
          {editing && (
            <button onClick={() => setEditing(false)} disabled={!!busy} className="ml-auto text-xs text-muted hover:text-fg">klaar met bewerken</button>
          )}
        </div>
      )}

      {action.status === "approved" && (
        <div className="flex gap-2 mt-3 items-center">
          <button onClick={() => call("execute")} disabled={!!busy} className="rounded-lg bg-accent text-white px-4 py-1.5 font-medium disabled:opacity-50">
            {busy === "retry" ? `${goLabel}…` : "Opnieuw proberen"}
          </button>
          <a href="/connections" className="text-xs text-muted hover:text-fg">Verbindingen</a>
        </div>
      )}
    </div>
  );
}
