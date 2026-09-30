import { DateTime } from "luxon";
import { createAdminClient } from "@/lib/supabase/admin";
import { LlmError } from "@/lib/llm-errors";

// Dagelijks tokenbudget per gebruiker (dag = kalenderdag in Europe/Amsterdam).

export type Usage = { promptTokens: number; completionTokens: number; totalTokens: number };

export interface UsageStore {
  get(userId: string, day: string): Promise<number>;
  add(userId: string, day: string, usage: Usage): Promise<void>;
}

export function dailyTokenBudget() {
  const n = Number(process.env.DAILY_TOKEN_BUDGET);
  return Number.isFinite(n) && n > 0 ? n : 200_000;
}

export function budgetDay(now: Date = new Date()) {
  return DateTime.fromJSDate(now).setZone("Europe/Amsterdam").toISODate()!;
}

export const supabaseUsageStore: UsageStore = {
  async get(userId, day) {
    const { data, error } = await createAdminClient()
      .from("dot_usage").select("total_tokens").eq("user_id", userId).eq("day", day).maybeSingle();
    if (error) throw new Error(`usage read: ${error.message}`);
    return Number(data?.total_tokens ?? 0);
  },
  async add(userId, day, u) {
    const { error } = await createAdminClient().rpc("dot_add_usage", {
      p_user: userId,
      p_day: day,
      p_prompt: u.promptTokens,
      p_completion: u.completionTokens,
    });
    if (error) throw new Error(`usage write: ${error.message}`);
  },
};

/** Gooit LlmError("budget") als de gebruiker vandaag al over zijn budget zit. */
export async function checkBudget(userId: string, store: UsageStore = supabaseUsageStore, now = new Date()) {
  const used = await store.get(userId, budgetDay(now));
  if (used >= dailyTokenBudget()) {
    throw new LlmError("budget", `user ${userId} used ${used} of ${dailyTokenBudget()} tokens`);
  }
  return used;
}

export async function recordUsage(userId: string, usage: Usage, store: UsageStore = supabaseUsageStore, now = new Date()) {
  await store.add(userId, budgetDay(now), usage);
}
