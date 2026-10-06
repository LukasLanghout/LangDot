// Aanvullende tools: schema's beheren, rekenen en datum/tijd. De uitkomst komt uit code, niet uit het model.

import type { SupabaseClient } from "@supabase/supabase-js";
import { DateTime } from "luxon";
import type { ToolDef } from "@/lib/llm";
import { calculate } from "./calc";
import { computeNextRun, describeDays, formatInZone, isValidTime, isValidZone } from "@/lib/schedule";
import { createAction } from "@/lib/actions";
import { supabaseActionStore } from "@/lib/actions-store";

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[] = []): ToolDef {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required } } };
}

export const SCHEDULE_TOOLS: ToolDef[] = [
  tool("list_schedules", "Toon alle geplande check-ins met id, tijden, status en de volgende run.", {}),
  tool(
    "update_schedule",
    "Pas een bestaand schema aan (naam, opdracht, dagen of tijd). Wijzigt NIET de toestemming om automatisch te mailen.",
    {
      id: { type: "string" },
      title: { type: "string" },
      prompt: { type: "string" },
      days: { type: "array", items: { type: "integer", minimum: 1, maximum: 7 } },
      time: { type: "string", description: "HH:MM" },
    },
    ["id"],
  ),
  tool("pause_schedule", "Zet een schema aan of uit zonder het te verwijderen.", { id: { type: "string" }, active: { type: "boolean", description: "false = pauzeren, true = hervatten" } }, ["id", "active"]),
  tool("run_now", "Start een schema nu meteen één keer (de volgende geplande run blijft gewoon staan).", { id: { type: "string" } }, ["id"]),
  tool("delete_schedule", "Verwijder een schema. De gebruiker krijgt een goedkeuringskaart; pas na zijn klik is het weg.", { id: { type: "string" } }, ["id"]),
];

export const UTILITY_TOOLS: ToolDef[] = [
  tool(
    "calculate",
    "Reken exact (nooit uit je hoofd). Ondersteunt + - * / % ^ haakjes, x% (procent), sqrt, abs, round, floor, ceil, min en max " +
      "(argumenten met ; bv. max(3;4)). Voorbeeld: 15% van 240 → 240*15%.",
    { expression: { type: "string" } },
    ["expression"],
  ),
  tool(
    "datetime",
    "Datum en tijd uit code. op=now (actuele tijd), add (datum plus/min een aantal dagen/uren/…), diff (verschil tussen twee datums), weekday (welke dag van de week).",
    {
      op: { type: "string", enum: ["now", "add", "diff", "weekday"] },
      date: { type: "string", description: "ISO-datum of -tijd; standaard nu" },
      other: { type: "string", description: "Tweede datum voor diff" },
      amount: { type: "number" },
      unit: { type: "string", enum: ["minutes", "hours", "days", "weeks", "months"] },
      timezone: { type: "string", description: "Standaard Europe/Amsterdam" },
    },
    ["op"],
  ),
];

const str = (v: unknown, max = 4000) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export function runCalculate(a: Record<string, any>) {
  const expression = str(a.expression, 300);
  return { expression, result: calculate(expression) };
}

export function runDatetime(a: Record<string, any>, nowMs = Date.now()) {
  const zone = str(a.timezone, 64) || "Europe/Amsterdam";
  if (!isValidZone(zone)) throw new Error("Onbekende tijdzone");
  const parse = (v: unknown) => {
    const s = str(v, 64);
    const d = s ? DateTime.fromISO(s, { zone }) : DateTime.fromMillis(nowMs, { zone });
    if (!d.isValid) throw new Error("Ongeldige datum");
    return d;
  };
  const fmt = (d: DateTime) => ({ iso: d.toISO(), leesbaar: d.setLocale("nl").toFormat("cccc d LLLL yyyy, HH:mm"), weekdag: d.setLocale("nl").toFormat("cccc") });
  const op = str(a.op, 20);
  if (op === "now") return { timezone: zone, ...fmt(DateTime.fromMillis(nowMs, { zone })) };
  if (op === "weekday") return fmt(parse(a.date));
  if (op === "add") {
    const unit = ["minutes", "hours", "days", "weeks", "months"].includes(a.unit) ? a.unit : "days";
    const amount = Number(a.amount);
    if (!Number.isFinite(amount)) throw new Error("amount ontbreekt");
    return fmt(parse(a.date).plus({ [unit]: amount }));
  }
  if (op === "diff") {
    const from = parse(a.date);
    const to = parse(a.other);
    const diff = to.diff(from, ["days", "hours", "minutes"]);
    return {
      van: from.toISO(),
      tot: to.toISO(),
      dagen: Math.floor(diff.days),
      uren: Math.floor(diff.hours),
      minuten: Math.round(diff.minutes),
      totaal_uren: Math.round((to.toMillis() - from.toMillis()) / 360_000) / 10,
    };
  }
  throw new Error("Onbekende op");
}

// ───────────────────────────── Schema's beheren ─────────────────────────────

type ScheduleRow = {
  id: string; title: string; prompt: string; days: number[]; time_of_day: string; timezone: string;
  active: boolean; next_run_at: string | null; auto_send?: boolean;
};

async function ownSchedule(db: SupabaseClient, userId: string, id: string) {
  const { data } = await db.from("dot_schedules").select("*").eq("id", id).eq("user_id", userId).maybeSingle();
  if (!data) throw new Error("Schema niet gevonden. Gebruik list_schedules voor de juiste id's.");
  return data as ScheduleRow;
}

const summary = (s: ScheduleRow) => ({
  id: s.id,
  title: s.title,
  when: `${describeDays(s.days)} om ${s.time_of_day} (${s.timezone})`,
  active: s.active,
  next_run: s.active ? formatInZone(s.next_run_at, s.timezone) : "uitgeschakeld",
  auto_mail_naar_jezelf: !!s.auto_send,
});

export async function runScheduleTool(
  ctx: { db: SupabaseClient; userId: string; origin: "chat" | "worker"; createdTask?: boolean; createdActionIds: string[] },
  name: string,
  a: Record<string, any>,
) {
  const { db, userId } = ctx;
  if (ctx.origin !== "chat") throw new Error("Schema's beheren kan alleen vanuit de chat.");

  if (name === "list_schedules") {
    const { data } = await db.from("dot_schedules").select("*").eq("user_id", userId).order("created_at", { ascending: true });
    return { schedules: ((data ?? []) as ScheduleRow[]).map(summary) };
  }

  const s = await ownSchedule(db, userId, str(a.id, 64));

  if (name === "update_schedule") {
    const patch: Record<string, unknown> = {};
    if (typeof a.title === "string" && a.title.trim()) patch.title = a.title.trim().slice(0, 200);
    if (typeof a.prompt === "string" && a.prompt.trim()) patch.prompt = a.prompt.trim().slice(0, 2000);
    if (Array.isArray(a.days)) {
      const days = [...new Set(a.days.map(Number).filter((d: number) => Number.isInteger(d) && d >= 1 && d <= 7))] as number[];
      if (!days.length) throw new Error("Geen geldige dagen");
      patch.days = days;
    }
    if (a.time !== undefined) {
      const time = str(a.time, 5);
      if (!isValidTime(time)) throw new Error("time moet HH:MM zijn");
      patch.time_of_day = time;
    }
    if (!Object.keys(patch).length) throw new Error("Niets om aan te passen");
    const merged = { ...s, ...patch } as ScheduleRow;
    patch.next_run_at = merged.active ? computeNextRun(merged.days, merged.time_of_day, merged.timezone) : s.next_run_at;
    const { data, error } = await db.from("dot_schedules").update(patch).eq("id", s.id).eq("user_id", userId).select("*").single();
    if (error || !data) throw new Error("Aanpassen mislukt");
    return { ok: true, schedule: summary(data as ScheduleRow) };
  }

  if (name === "pause_schedule") {
    const active = a.active === true;
    const next = active ? computeNextRun(s.days, s.time_of_day, s.timezone) : s.next_run_at;
    const { data, error } = await db.from("dot_schedules").update({ active, next_run_at: next }).eq("id", s.id).eq("user_id", userId).select("*").single();
    if (error || !data) throw new Error("Bijwerken mislukt");
    return { ok: true, schedule: summary(data as ScheduleRow) };
  }

  if (name === "run_now") {
    const { data: profile } = await db.from("dot_profiles").select("paused").eq("user_id", userId).maybeSingle();
    if (profile?.paused) throw new Error("Achtergrondwerk staat op pauze. Hervat eerst.");
    const { data, error } = await db.from("dot_tasks").insert({
      user_id: userId, title: s.title, instructions: s.prompt, source: "schedule", schedule_id: s.id,
    }).select("id").single();
    if (error || !data) throw new Error("Starten mislukt");
    ctx.createdTask = true;
    return { ok: true, task_id: data.id, note: "De taak is gestart en verschijnt in Activity. Het schema zelf blijft ongewijzigd." };
  }

  if (name === "delete_schedule") {
    const res = await createAction(supabaseActionStore(db), {
      userId,
      taskId: null,
      type: "schedule_delete",
      payload: { schedule_id: s.id, title: s.title, when: summary(s).when },
    });
    if (!res.ok) throw new Error(res.error);
    ctx.createdActionIds.push(res.action.id);
    return {
      ok: true,
      pending_action_id: res.action.id,
      status: "pending",
      note: "Er is NIETS verwijderd. De gebruiker krijgt een goedkeuringskaart; pas na zijn klik is het schema weg. Zeg dat niet eerder.",
    };
  }

  throw new Error(`Onbekende tool: ${name}`);
}
