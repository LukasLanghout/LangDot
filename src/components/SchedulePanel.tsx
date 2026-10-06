"use client";

import { useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Schedule } from "@/lib/types";
import { DAY_LABELS, computeNextRun, describeDays, formatInZone } from "@/lib/schedule";
import { btn, chip, field, Switch, textBtn } from "./ui";
import { Icon } from "./Icon";

function DayPicker({ days, onChange }: { days: number[]; onChange: (d: number[]) => void }) {
  return (
    <div className="flex gap-1.5 flex-wrap" role="group" aria-label="Dagen">
      {DAY_LABELS.map((label, i) => {
        const d = i + 1;
        const on = days.includes(d);
        return (
          <button
            key={d}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(on ? days.filter((x) => x !== d) : [...days, d])}
            className={`${chip(on)} !px-0 w-11 sm:w-10 justify-center`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

function ScheduleRow({ s, onUpdate, onDelete }: {
  s: Schedule;
  onUpdate: (s: Schedule, patch: Partial<Schedule>) => Promise<void>;
  onDelete: (s: Schedule) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [time, setTime] = useState(s.time_of_day);
  const [days, setDays] = useState<number[]>(s.days);

  return (
    <li className={`rounded-2xl border border-line bg-panel p-3.5 ${s.active ? "" : "opacity-70"}`}>
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="font-medium text-[15px]">{s.title}</div>
          <div className="text-[13px] text-faint mt-0.5">
            {describeDays(s.days)} om {s.time_of_day} · {s.timezone}
          </div>
          <div className="text-[13px] text-faint">
            Volgende: {s.active ? formatInZone(s.next_run_at, s.timezone) : "uitgeschakeld"}
          </div>
        </div>
        <Switch checked={s.active} onChange={(v) => onUpdate(s, { active: v })} label={`${s.title} ${s.active ? "uitzetten" : "aanzetten"}`} />
      </div>
      <div className="text-[14px] mt-2 text-muted line-clamp-3">&ldquo;{s.prompt}&rdquo;</div>
      {s.auto_send && (
        <div className="mt-2.5 flex items-center gap-2 text-[13px] rounded-xl border border-line bg-panel-2 px-3 py-2">
          <Icon name="repeat" size={14} className="shrink-0 text-faint" />
          <span className="min-w-0">Mailt automatisch naar {s.auto_send_to}</span>
          <button
            onClick={() => confirm("Toestemming intrekken? Daarna krijg je per mail weer een goedkeuringskaart.") && onUpdate(s, { auto_send: false })}
            className={`${textBtn} ml-auto shrink-0 hover:!text-bad`}
          >
            Intrekken
          </button>
        </div>
      )}

      {editing ? (
        <div className="mt-3 space-y-2.5">
          <DayPicker days={days} onChange={setDays} />
          <div className="flex gap-2 items-center">
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} aria-label="Tijd" className={`${field} !w-auto`} />
            <button
              disabled={!days.length}
              onClick={async () => { await onUpdate(s, { time_of_day: time, days: [...days].sort() }); setEditing(false); }}
              className={btn.primary}
            >
              Opslaan
            </button>
            <button onClick={() => setEditing(false)} className={btn.ghost}>Annuleren</button>
          </div>
        </div>
      ) : (
        <div className="mt-2 flex gap-1 justify-end">
          <button onClick={() => setEditing(true)} className={textBtn}>Wijzig tijd of dagen</button>
          <button onClick={() => confirm(`Schema "${s.title}" verwijderen?`) && onDelete(s)} className={`${textBtn} hover:!text-bad`}>Verwijder</button>
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
    <div className="space-y-4">
      <p className="text-[14px] text-muted">
        Terugkerende check-ins. Maak ze hieronder, of vraag het in de chat.
      </p>
      <NewSchedule />
      {error && <p className="text-bad text-[13px]">{error}</p>}
      {schedules.length === 0 ? (
        <p className="text-[15px] text-muted">Nog geen geplande check-ins.</p>
      ) : (
        <ul className="space-y-2.5">
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

const BRIEF_PROMPT =
  "Maak een korte dagbrief: wat staat er vandaag in mijn agenda, welke ongelezen of belangrijke mails in mijn persoonlijke Gmail vragen aandacht, " +
  "en welke openstaande taken heb ik. Noem alleen wat je in mijn agenda en mail vindt, en zeg erbij dat je mijn werkmail niet ziet.";

const RECAP_PROMPT =
  "Maak een korte avondrecap: wat is er vandaag gedaan op basis van mijn afgeronde taken en agenda, wat staat er morgen op de planning, " +
  "en wat blijft liggen. Houd het kort en noem alleen wat je kunt terugvinden.";

type Preset = { id: string; label: string; title: string; prompt: string; times: string; days: number[]; auto: boolean };
const PRESETS: Preset[] = [
  { id: "news", label: "Technieuws", title: "Technieuws", prompt: NEWS_PROMPT, times: "08:20, 12:30", days: [1, 2, 3, 4, 5], auto: true },
  { id: "brief", label: "Dagbrief", title: "Dagbrief", prompt: BRIEF_PROMPT, times: "07:45", days: [1, 2, 3, 4, 5], auto: false },
  { id: "recap", label: "Avondrecap", title: "Avondrecap", prompt: RECAP_PROMPT, times: "18:00", days: [1, 2, 3, 4, 5], auto: false },
];

/** Nieuw schema, los van het taalmodel. De schakelaar is de toestemming om automatisch naar jezelf te mailen. */
function NewSchedule() {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(PRESETS[0].title);
  const [prompt, setPrompt] = useState(PRESETS[0].prompt);
  const [times, setTimes] = useState(PRESETS[0].times);
  const [days, setDays] = useState<number[]>(PRESETS[0].days);
  const [auto, setAuto] = useState(PRESETS[0].auto);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  function applyPreset(p: Preset) {
    setTitle(p.title);
    setPrompt(p.prompt);
    setTimes(p.times);
    setDays(p.days);
    setAuto(p.auto);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const list = times.split(/[,\s]+/).map((t) => t.trim()).filter(Boolean);
    if (!list.length) return setMsg({ ok: false, text: "Vul minstens één tijd in, bijvoorbeeld 08:20." });
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
        <button onClick={() => { setOpen(true); setMsg(null); }} className={btn.primary}>
          <Icon name="plus" size={16} />
          Nieuw schema
        </button>
        {msg && <p className={`text-[13px] mt-2 ${msg.ok ? "text-ok" : "text-bad"}`}>{msg.text}</p>}
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="rounded-2xl border border-line bg-panel p-3.5 space-y-3">
      <div className="flex gap-1.5 flex-wrap" role="group" aria-label="Voorbeelden">
        {PRESETS.map((p) => (
          <button key={p.id} type="button" onClick={() => applyPreset(p)} className={chip(title === p.title)}>
            {p.label}
          </button>
        ))}
      </div>
      <label className="block">
        <span className="text-[13px] text-faint">Naam</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} className={field} />
      </label>
      <label className="block">
        <span className="text-[13px] text-faint">Wat moet de dot doen?</span>
        <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={5} className={field} />
      </label>
      <label className="block">
        <span className="text-[13px] text-faint">Tijden (Amsterdam), meerdere met een komma</span>
        <input value={times} onChange={(e) => setTimes(e.target.value)} placeholder="08:20, 12:30" className={field} />
      </label>
      <DayPicker days={days} onChange={setDays} />
      <div className="flex items-start gap-3 rounded-xl border border-line bg-panel-2 px-3.5 py-3">
        <Switch checked={auto} onChange={setAuto} label="Resultaat automatisch naar mezelf mailen" />
        <div className="text-[14px]">
          Mail het resultaat automatisch naar mij, zonder per keer goedkeuren.
          <span className="block text-[13px] text-faint mt-0.5">Alleen naar het adres van je verbonden Gmail. Intrekken kan hier altijd.</span>
        </div>
      </div>
      {msg && <p className={`text-[13px] ${msg.ok ? "text-ok" : "text-bad"}`}>{msg.text}</p>}
      <div className="flex gap-2">
        <button disabled={busy || !title.trim() || !prompt.trim() || !days.length} className={btn.primary}>
          {busy ? "Aanmaken…" : "Aanmaken"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className={btn.ghost}>Annuleren</button>
      </div>
    </form>
  );
}
