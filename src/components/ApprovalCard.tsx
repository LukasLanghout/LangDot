"use client";

import { useEffect, useState } from "react";
import type { ActionRow } from "@/lib/types";
import { Icon, type IconName } from "./Icon";
import { btn, field, formatTime } from "./ui";

const TZ = "Europe/Amsterdam";

type ConsentRow = Extract<ActionRow, { type: "schedule_auto_send" }>;
type DeleteRow = Extract<ActionRow, { type: "schedule_delete" }>;
type ProposalRow = Exclude<ActionRow, { type: "schedule_auto_send" | "schedule_delete" }>;

const DAY = ["ma", "di", "wo", "do", "vr", "za", "zo"];
const days = (d: number[]) => (d.join(",") === "1,2,3,4,5" ? "werkdagen" : d.length === 7 ? "elke dag" : d.map((x) => DAY[x - 1]).join(", "));

/** ISO met offset → "2026-10-02T14:00" voor <input type="datetime-local"> (in Europe/Amsterdam). */
function toLocalInput(iso: string) {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(iso));
  return parts.replace(" ", "T");
}

function formatRange(startIso: string, endIso: string) {
  const s = new Date(startIso);
  const e = new Date(endIso);
  const day = s.toLocaleDateString("nl-NL", { weekday: "long", day: "numeric", month: "long", timeZone: TZ });
  const t = (d: Date) => d.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
  const sameDay = s.toLocaleDateString("nl-NL", { timeZone: TZ }) === e.toLocaleDateString("nl-NL", { timeZone: TZ });
  return sameDay ? `${day}, ${t(s)} tot ${t(e)}` : `${day} ${t(s)} tot ${e.toLocaleDateString("nl-NL", { day: "numeric", month: "long", timeZone: TZ })} ${t(e)}`;
}

/** Na de keuze: één compacte, grijze regel met een vinkje. */
function Decided({ icon, text, time }: { icon: IconName; text: string; time?: string | null }) {
  return (
    <div className="flex items-center gap-2.5 rounded-xl bg-panel-2 px-3.5 py-2.5 text-[14px] text-muted">
      <Icon name={icon} size={16} className="shrink-0" />
      <span className="min-w-0 truncate">{text}</span>
      {time && <time className="ml-auto text-[13px] text-faint shrink-0">{formatTime(time)}</time>}
    </div>
  );
}

function Shell({ label, icon, children }: { label: string; icon: IconName; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-line bg-panel p-4" style={{ boxShadow: "var(--shadow-card)" }}>
      <div className="flex items-center gap-2 text-[13px] text-muted mb-3">
        <Icon name={icon} size={15} />
        <span>{label}</span>
      </div>
      {children}
    </div>
  );
}

/** Goedkeuringskaart. Alleen een klik hier kan iets met extern effect laten gebeuren. */
export function ApprovalCard({ action }: { action: ActionRow }) {
  if (action.type === "schedule_auto_send") return <ConsentCard action={action} />;
  if (action.type === "schedule_delete") return <DeleteCard action={action} />;
  return <ProposalCard action={action} />;
}

function useDecide(id: string) {
  const [busy, setBusy] = useState<null | "go" | "reject" | "retry">(null);
  const [error, setError] = useState<string | null>(null);
  async function call(kind: "approve" | "reject" | "execute", body?: unknown) {
    setBusy(kind === "approve" ? "go" : kind === "reject" ? "reject" : "retry");
    setError(null);
    const res = await fetch(`/api/actions/${id}/${kind}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: kind === "approve" ? JSON.stringify(body ?? {}) : undefined,
    });
    const json = await res.json().catch(() => null);
    const failed = !res.ok || json?.ok === false;
    if (failed) setError(json?.error ?? "Dat lukte niet. Probeer het opnieuw.");
    setBusy(null);
    return !failed;
  }
  return { busy, error, call };
}

/** Eenmalige toestemming om vanuit schema's automatisch naar jezelf te mailen. */
function ConsentCard({ action }: { action: ConsentRow }) {
  const { busy, error, call } = useDecide(action.id);
  if (action.status === "executed") return <Decided icon="check" text={`Automatisch mailen naar ${action.payload.to} staat aan`} time={action.executed_at} />;
  if (action.status === "rejected" || action.status === "expired") return <Decided icon="x" text="Automatisch mailen niet toegestaan" time={action.decided_at} />;

  return (
    <Shell label="Toestemming" icon="repeat">
      <p className="text-[15px]">
        Mag je dot op deze momenten <strong className="font-semibold">zonder per keer te vragen</strong> een mail sturen naar{" "}
        <strong className="font-semibold">{action.payload.to}</strong>?
      </p>
      <ul className="mt-2 space-y-0.5 text-[15px] text-muted">
        {action.payload.schedules.map((s) => (
          <li key={s.id}>{s.title}: {days(s.days)} om {s.time_of_day}</li>
        ))}
      </ul>
      <p className="text-[13px] text-faint mt-3">
        Alleen naar dit eigen adres. Mails aan anderen krijgen altijd een kaart. Intrekken kan onder Gepland.
      </p>
      {error && <p className="text-bad text-sm mt-2">{error}</p>}
      <div className="flex items-center gap-2 mt-4">
        <button onClick={() => call("approve")} disabled={!!busy} className={btn.primary}>Toestaan</button>
        <button onClick={() => call("reject")} disabled={!!busy} className={btn.ghost}>Afwijzen</button>
      </div>
    </Shell>
  );
}

/** Goedkeuring voor het verwijderen van een schema. */
function DeleteCard({ action }: { action: DeleteRow }) {
  const { busy, error, call } = useDecide(action.id);
  if (action.status === "executed") return <Decided icon="check" text={`Schema "${action.payload.title}" verwijderd`} time={action.executed_at} />;
  if (action.status === "rejected" || action.status === "expired") return <Decided icon="x" text={`Schema "${action.payload.title}" blijft staan`} time={action.decided_at} />;

  return (
    <Shell label="Schema verwijderen" icon="trash">
      <p className="text-[15px] font-medium">{action.payload.title}</p>
      <p className="text-[14px] text-muted">{action.payload.when}</p>
      {error && <p className="text-bad text-sm mt-2">{error}</p>}
      <div className="flex items-center gap-2 mt-4">
        <button onClick={() => call("approve")} disabled={!!busy} className={btn.primary}>Verwijderen</button>
        <button onClick={() => call("reject")} disabled={!!busy} className={btn.ghost}>Behouden</button>
      </div>
    </Shell>
  );
}

function ProposalCard({ action }: { action: ProposalRow }) {
  const isMail = action.type === "gmail_send";
  const [fields, setFields] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState(false);
  const { busy, error, call } = useDecide(action.id);

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
  const goLabel = isMail ? "Versturen" : "Inplannen";

  // Afgehandeld: compact en grijs.
  if (action.status === "executed") {
    return action.type === "gmail_send"
      ? <Decided icon="check" text={`Verstuurd aan ${action.payload.to.join(", ")}: ${action.payload.subject}`} time={action.executed_at} />
      : <Decided icon="check" text={`Ingepland: ${action.payload.summary}`} time={action.executed_at} />;
  }
  if (action.status === "rejected") {
    return <Decided icon="x" text={action.type === "gmail_send" ? `Afgewezen: mail aan ${action.payload.to.join(", ")}` : `Afgewezen: ${action.payload.summary}`} time={action.decided_at} />;
  }
  if (action.status === "expired") return <Decided icon="clock" text="Verlopen, er is niets uitgevoerd" time={action.decided_at} />;

  const failedApproved = action.status === "approved";

  async function approve() {
    const payload = isMail
      ? { to: fields.to, subject: fields.subject, body: fields.body }
      : { summary: fields.summary, start: fields.start, end: fields.end, time_zone: TZ, location: fields.location, description: fields.description, attendees: fields.attendees };
    if (await call("approve", payload)) setEditing(false);
  }

  return (
    <Shell label={isMail ? "Mail" : "Afspraak"} icon={isMail ? "mail" : "calendar"}>
      {editing ? (
        isMail ? (
          <div className="space-y-2.5">
            <label className="block"><span className="text-[13px] text-muted">Aan (komma-gescheiden)</span><input value={fields.to ?? ""} onChange={set("to")} className={field} /></label>
            <label className="block"><span className="text-[13px] text-muted">Onderwerp</span><input value={fields.subject ?? ""} onChange={set("subject")} className={field} /></label>
            <label className="block"><span className="text-[13px] text-muted">Tekst</span><textarea value={fields.body ?? ""} onChange={set("body")} rows={9} className={field} /></label>
          </div>
        ) : (
          <div className="space-y-2.5">
            <label className="block"><span className="text-[13px] text-muted">Titel</span><input value={fields.summary ?? ""} onChange={set("summary")} className={field} /></label>
            <div className="grid grid-cols-2 gap-2">
              <label className="block"><span className="text-[13px] text-muted">Start</span><input type="datetime-local" value={fields.start ?? ""} onChange={set("start")} className={field} /></label>
              <label className="block"><span className="text-[13px] text-muted">Eind</span><input type="datetime-local" value={fields.end ?? ""} onChange={set("end")} className={field} /></label>
            </div>
            <label className="block"><span className="text-[13px] text-muted">Locatie</span><input value={fields.location ?? ""} onChange={set("location")} className={field} /></label>
            <label className="block"><span className="text-[13px] text-muted">Genodigden (komma-gescheiden)</span><input value={fields.attendees ?? ""} onChange={set("attendees")} className={field} /></label>
            <label className="block"><span className="text-[13px] text-muted">Omschrijving</span><textarea value={fields.description ?? ""} onChange={set("description")} rows={3} className={field} /></label>
          </div>
        )
      ) : action.type === "gmail_send" ? (
        // Zoals een mail eruitziet: kopregels, dan de tekst.
        <div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[15px]">
            <dt className="text-faint">Aan</dt><dd className="font-medium break-words">{action.payload.to.join(", ")}</dd>
            <dt className="text-faint">Onderwerp</dt><dd className="break-words">{action.payload.subject || <em className="text-faint">geen onderwerp</em>}</dd>
          </dl>
          <div className="border-t border-line mt-3 pt-3 whitespace-pre-wrap text-[15px] max-h-72 overflow-y-auto break-words">{action.payload.body}</div>
          {!!action.payload.attachments?.length && (
            <div className="flex flex-wrap gap-1.5 mt-3">
              {action.payload.attachments.map((a) => (
                <span key={a.document_id} className="inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 h-7 text-[13px] text-muted">
                  <Icon name="paperclip" size={13} />{a.name}<span className="text-faint">{Math.max(1, Math.round(a.size / 1024))} KB</span>
                </span>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div>
          <p className="serif text-[22px] leading-snug">{action.payload.summary}</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[15px] mt-2">
            <dt className="text-faint">Wanneer</dt><dd>{formatRange(action.payload.start, action.payload.end)}</dd>
            {action.payload.location && (<><dt className="text-faint">Waar</dt><dd>{action.payload.location}</dd></>)}
            {!!action.payload.attendees?.length && (<><dt className="text-faint">Genodigden</dt><dd className="break-words">{action.payload.attendees.join(", ")}</dd></>)}
          </dl>
          {action.payload.description && <p className="mt-2 text-[15px] text-muted whitespace-pre-wrap">{action.payload.description}</p>}
        </div>
      )}

      <p className="text-[13px] text-faint mt-3">
        {isMail
          ? "Er is nog niets verstuurd. Pas als je op Versturen klikt gaat de mail weg."
          : action.type === "calendar_create_event" && action.payload.attendees?.length
            ? "Er staat nog niets in je agenda. Pas na je klik komt de afspraak er en krijgen genodigden een uitnodiging."
            : "Er staat nog niets in je agenda. Pas na je klik komt de afspraak er."}
      </p>

      {failedApproved && action.error && <p className="text-bad text-sm mt-2">{action.error}</p>}
      {error && <p className="text-bad text-sm mt-2">{error}</p>}

      <div className="flex flex-wrap items-center gap-2 mt-4">
        {failedApproved ? (
          <>
            <button onClick={() => call("execute")} disabled={!!busy} className={btn.primary}>{busy === "retry" ? `${goLabel}…` : "Opnieuw proberen"}</button>
            <a href="/connections" className={btn.ghost}>Verbindingen</a>
          </>
        ) : (
          <>
            <button onClick={approve} disabled={!!busy} className={btn.primary}>{busy === "go" ? `${goLabel}…` : goLabel}</button>
            <button onClick={() => call("reject")} disabled={!!busy} className={btn.ghost}>{busy === "reject" ? "Afwijzen…" : "Afwijzen"}</button>
            <button onClick={() => setEditing((v) => !v)} disabled={!!busy} className={`${btn.ghost} ml-auto`}>
              <Icon name="pencil" size={15} />{editing ? "Klaar" : "Bewerken"}
            </button>
          </>
        )}
      </div>
    </Shell>
  );
}
