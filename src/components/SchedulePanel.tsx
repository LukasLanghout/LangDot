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
        Terugkerende check-ins. Maak ze in de chat, bv. <em>“check elke werkdag om 9:00 Amsterdam tijd mijn agenda-nieuws”</em>.
      </p>
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
