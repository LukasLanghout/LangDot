import { DateTime, IANAZone } from "luxon";

export const DAY_LABELS = ["ma", "di", "wo", "do", "vr", "za", "zo"]; // index 0 = ISO-dag 1

export function isValidTime(time: string) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(time);
}

export function isValidZone(tz: string) {
  return IANAZone.isValidZone(tz);
}

/** Eerstvolgende uitvoermoment (UTC ISO) na `from`, op één van `days` (ISO 1=ma..7=zo) om `time` in `tz`. */
export function computeNextRun(days: number[], time: string, tz: string, from: Date = new Date()): string | null {
  if (!days.length || !isValidTime(time) || !isValidZone(tz)) return null;
  const [hour, minute] = time.split(":").map(Number);
  const start = DateTime.fromJSDate(from, { zone: tz }).startOf("day");
  for (let i = 0; i < 8; i++) {
    const candidate = start.plus({ days: i }).set({ hour, minute, second: 0, millisecond: 0 });
    if (days.includes(candidate.weekday) && candidate.toMillis() > from.getTime()) {
      return candidate.toUTC().toISO();
    }
  }
  return null;
}

/** "ma–vr", "za, zo", "elke dag" … */
export function describeDays(days: number[]) {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  if (sorted.length === 7) return "elke dag";
  if (sorted.join(",") === "1,2,3,4,5") return "werkdagen (ma–vr)";
  if (sorted.join(",") === "6,7") return "weekend";
  return sorted.map((d) => DAY_LABELS[d - 1]).join(", ");
}

export function formatInZone(iso: string | null, tz: string) {
  if (!iso) return "—";
  return DateTime.fromISO(iso, { zone: tz }).setLocale("nl").toFormat("ccc d LLL, HH:mm");
}
