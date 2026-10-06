"use client";

import { useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Schedule } from "@/lib/types";
import { DAY_LABELS, computeNextRun, describeDays, formatInZone } from "@/lib/schedule";

function ScheduleRow({ s, onUpdate, onDelete }: {
  s: Schedule;
  onUpdate: (s: Schedule, patch: Partial<Schedule>) => Promise<void>;
  onDelete: (s: Schedule) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [time, setTime] = useState(s.time_of_day);
  const [days, setDays] = useState<number[]>(s.days);

  return (
    <li className={`rounded-lg border border-line bg-panel-2 p-3 ${s.active ? "" : "opacity-60"}`}>
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm">{s.title}</div>
          <div className="text-xs text-muted mt-0.5">
            {describeDays(s.days)} om {s.time_of_day} · {s.timezone}
          </div>
          <div className="text-xs text-muted">
            Volgende: {s.active ? formatInZone(s.next_run_at, s.timezone) : "uitgeschakeld"}
          </div>
        </div>
        <label className="flex items-center gap-1.5 text-xs cursor-pointer select-none">
          <input type="checkbox" checked={s.active} onChange={() => onUpdate(s, { active: !s.active })} className="accent-[var(--color-accent)]" />
          aan
        </label>
      </div>
      <div className="text-[13px] mt-2 text-muted line-clamp-3">“{s.prompt}”</div>
      {s.auto_send && (
        <div className="mt-2 flex items-center gap-2 text-xs rounded-lg border border-accent/40 bg-accent/10 px-2 py-1">
          <span>🔁 Mailt automatisch naar {s.auto_send_to}</span>
          <button
            onClick={() => confirm("Toestemming intrekken? Daarna krijg je per mail weer een goedkeuringskaart.") && onUpdate(s, { auto_send: false })}
            className="ml-auto text-muted hover:text-bad"
          >
            intrekken
          </button>
        </div>
      )}

      {editing ? (
        <div className="mt-3 space-y-2">
          <div className="flex gap-1 flex-wrap">
            {DAY_LABELS.map((label, i) => {
              const d = i + 1;
              const on = days.includes(d);
              return (
                <button key={d} type="button" onClick={() => setDays(on ? days.filter((x) => x !== d) : [...days, d])}
                  className={`w-8 h-7 text-xs rounded border ${on ? "border-accent bg-accent/20" : "border-line text-muted"}`}>
                  {label}
                </button>
              );
            })}
          </div>
          <div className="flex gap-2 items-center">
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)}
              className="bg-panel border border-line rounded px-2 py-1 text-sm" />
            <button
              disabled={!days.length}
              onClick={async () => { await onUpdate(s, { time_of_day: time, days: [...days].sort() }); setEditing(false); }}
              className="rounded bg-accent text-white px-2.5 py-1 text-xs disabled:opacity-40"
            >
              Opslaan
            </button>
            <button onClick={() => setEditing(false)} className="text-xs text-muted hover:text-fg">Annuleren</button>
          </div>
        </div>
      ) : (
        <div className="mt-2 flex gap-3 justify-end text-xs text-muted">
          <button onClick={() => setEditing(true)} className="hover:text-fg">wijzig tijd/dagen</button>
          <button onClick={() => confirm(`Schema "${s.title}" verwijderen?`) && onDelete(s)} className="hover:text-bad">verwijder</button>
        </div>
      )}
    </li>
  );
}

export function SchedulePanel({ userId, schedules }: { userId: string; schedules: Schedule[] }) {
  const supabase = useMemo(() => createClient(), []);
  const [error, setError] = useState<string | null>(null);

  async function update(s: Schedule, patch: Partial<Schedule>) {
    const merged = { ...s, ...patch };
    const next_run_at = merged.active ? computeNextRun(merged.days, merged.time_of_day, merged.timezone) : s.next_run_at;
    const { error } = await supabase.from("dot_schedules").update({ ...patch, next_run_at }).eq("id", s.id);
    if (error) return setError(error.message);
    await supabase.from("dot_audit").insert({ user_id: userId, actor: "user", action: "schedule_updated", input: { id: s.id, ...patch } });
  }

  async function remove(s: Schedule) {
    const { error } = await supabase.from("dot_schedules").delete().eq("id", s.id);
    if (error) return setError(error.message);
    await supabase.from("dot_audit").insert({ user_id: userId, actor: "user", action: "schedule_deleted", input: { id: s.id, title: s.title } });
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted">
        Terugkerende check-ins. Maak ze hieronder, of vraag het in de chat.
      </p>
      <NewSchedule />
      {error && <p className="text-bad text-xs">{error}</p>}
      {schedules.length === 0 ? (
        <p className="text-sm text-muted">Nog geen geplande check-ins.</p>
      ) : (
        <ul className="space-y-2">
          {schedules.map((s) => <ScheduleRow key={s.id} s={s} onUpdate={update} onDelete={remove} />)}
        </ul>
      )}
    </div>
  );
}


const NEWS_PROMPT =
  "Zoek het laatste tech-nieuws van vandaag en gisteren (AI, tech en business): minimaal 8 items, zo uitgebreid mogelijk. " +
  "Per item: titel, datum, samenvatting van 2 tot 3 zinnen en de bron als link. Prioriteer grote aankondigingen, productlanceringen, " +
  "funding rounds, overnames en beleid. Noem alleen wat je in zoekresultaten vond.";

/** Nieuw schema, los van het taalmodel. Het vinkje is de toestemming om automatisch naar jezelf te mailen. */
function NewSchedule() {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("Technieuws");
  const [prompt, setPrompt] = useState(NEWS_PROMPT);
  const [times, setTimes] = useState("08:20, 12:30");
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [auto, setAuto] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const list = times.split(/[,\s]+/).map((t) => t.trim()).filter(Boolean);
    if (!list.length) return setMsg({ ok: false, text: "Vul minstens één tijd in, bv. 08:20." });
    setBusy(true);
    setMsg(null);
    const created: string[] = [];
    for (const time of list) {
      const res = await fetch("/api/schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: list.length > 1 ? `${title} ${time}` : title,
          prompt,
          days,
          time,
          timezone: "Europe/Amsterdam",
          auto_send_to_self: auto,
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setMsg({ ok: false, text: `${time}: ${json?.error ?? "mislukt"}${created.length ? ` (al aangemaakt: ${created.join(", ")})` : ""}` });
        setBusy(false);
        return;
      }
      created.push(time);
    }
    setMsg({ ok: true, text: `Aangemaakt: ${created.join(" en ")}.${auto ? " De resultaten worden automatisch naar je gemaild." : ""}` });
    setBusy(false);
    setOpen(false);
  }

  if (!open) {
    return (
      <div>
        <button onClick={() => { setOpen(true); setMsg(null); }} className="rounded-lg bg-accent text-white px-3 py-1.5 text-sm font-medium hover:brightness-110">
          + Nieuw schema
        </button>
        {msg && <p className={`text-xs mt-2 ${msg.ok ? "text-ok" : "text-bad"}`}>{msg.text}</p>}
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="rounded-lg border border-line p-3 space-y-2.5">
      <label className="block">
        <span className="text-xs text-muted">Naam</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} className="w-full rounded bg-panel-2 border border-line px-2 py-1.5 text-sm outline-none focus:border-accent" />
      </label>
      <label className="block">
        <span className="text-xs text-muted">Wat moet de dot doen?</span>
        <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={5} className="w-full rounded bg-panel-2 border border-line px-2 py-1.5 text-sm outline-none focus:border-accent" />
      </label>
      <label className="block">
        <span className="text-xs text-muted">Tijden (Amsterdam), meerdere met komma</span>
        <input value={times} onChange={(e) => setTimes(e.target.value)} placeholder="08:20, 12:30" className="w-full rounded bg-panel-2 border border-line px-2 py-1.5 text-sm outline-none focus:border-accent" />
      </label>
      <div className="flex gap-1 flex-wrap">
        {DAY_LABELS.map((label, i) => {
          const d = i + 1;
          const on = days.includes(d);
          return (
            <button key={d} type="button" onClick={() => setDays(on ? days.filter((x) => x !== d) : [...days, d])}
              className={`w-9 h-7 text-xs rounded border ${on ? "border-accent bg-accent/20" : "border-line text-muted"}`}>
              {label}
            </button>
          );
        })}
      </div>
      <label className="flex items-start gap-2 text-sm rounded-lg border border-accent/40 bg-accent/10 px-2.5 py-2">
        <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} className="mt-0.5" />
        <span>
          Mail het resultaat <strong>automatisch naar mij</strong>, zonder per keer goedkeuren.
          <span className="block text-xs text-muted">Alleen naar het adres van je verbonden Gmail. Intrekken kan hier altijd.</span>
        </span>
      </label>
      {msg && <p className={`text-xs ${msg.ok ? "text-ok" : "text-bad"}`}>{msg.text}</p>}
      <div className="flex gap-2">
        <button disabled={busy || !title.trim() || !prompt.trim() || !days.length} className="rounded-lg bg-accent text-white px-3 py-1.5 text-sm font-medium disabled:opacity-40">
          {busy ? "Aanmaken…" : "Aanmaken"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="text-sm text-muted hover:text-fg">Annuleren</button>
      </div>
    </form>
  );
}