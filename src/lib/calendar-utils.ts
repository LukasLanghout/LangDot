// Deterministische agenda-berekeningen: conflicten en vrije tijd. Het model rekent hier nooit zelf aan.

import { DateTime } from "luxon";

export type CalEvent = { id: string; summary: string; start: string; end: string; all_day: boolean; status?: string };

const ms = (iso: string) => new Date(iso).getTime();

/** Afspraken die elkaar overlappen (hele-dag-afspraken en geannuleerde afspraken tellen niet mee). */
export function findConflicts(events: CalEvent[]) {
  const timed = events
    .filter((e) => !e.all_day && e.status !== "cancelled" && ms(e.end) > ms(e.start))
    .sort((a, b) => ms(a.start) - ms(b.start));
  const out: { a: string; b: string; overlap_minutes: number }[] = [];
  for (let i = 0; i < timed.length; i++) {
    for (let j = i + 1; j < timed.length; j++) {
      if (ms(timed[j].start) >= ms(timed[i].end)) break;
      const overlap = Math.min(ms(timed[i].end), ms(timed[j].end)) - ms(timed[j].start);
      if (overlap > 0) out.push({ a: timed[i].summary, b: timed[j].summary, overlap_minutes: Math.round(overlap / 60_000) });
    }
  }
  return out;
}

export type Slot = { start: string; end: string; minutes: number };

/**
 * Vrije blokken van minstens `minMinutes` binnen werktijden (standaard 09:00 tot 18:00, ma t/m vr) tussen `from` en `to`.
 * Alle tijden in `zone`.
 */
export function freeSlots(
  events: CalEvent[],
  opts: { from: string; to: string; minMinutes: number; zone?: string; dayStart?: string; dayEnd?: string; weekdaysOnly?: boolean },
): Slot[] {
  const zone = opts.zone ?? "Europe/Amsterdam";
  const [sh, sm] = (opts.dayStart ?? "09:00").split(":").map(Number);
  const [eh, em] = (opts.dayEnd ?? "18:00").split(":").map(Number);
  const busy = events
    .filter((e) => !e.all_day && e.status !== "cancelled" && ms(e.end) > ms(e.start))
    .map((e) => [ms(e.start), ms(e.end)] as const)
    .sort((a, b) => a[0] - b[0]);

  const slots: Slot[] = [];
  const last = DateTime.fromISO(opts.to, { zone }).startOf("day");
  for (let day = DateTime.fromISO(opts.from, { zone }).startOf("day"); day <= last; day = day.plus({ days: 1 })) {
    if (opts.weekdaysOnly !== false && day.weekday > 5) continue;
    let cursor = Math.max(day.set({ hour: sh, minute: sm }).toMillis(), ms(opts.from));
    const end = Math.min(day.set({ hour: eh, minute: em }).toMillis(), ms(opts.to));
    for (const [bs, be] of busy) {
      if (be <= cursor || bs >= end) continue;
      if (bs - cursor >= opts.minMinutes * 60_000) slots.push(toSlot(cursor, bs, zone));
      cursor = Math.max(cursor, be);
    }
    if (end - cursor >= opts.minMinutes * 60_000) slots.push(toSlot(cursor, end, zone));
  }
  return slots;
}

function toSlot(a: number, b: number, zone: string): Slot {
  return {
    start: DateTime.fromMillis(a, { zone }).toISO()!,
    end: DateTime.fromMillis(b, { zone }).toISO()!,
    minutes: Math.round((b - a) / 60_000),
  };
}
