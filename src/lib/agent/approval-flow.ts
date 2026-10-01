import type { SupabaseClient } from "@supabase/supabase-js";
import { describeAction, type PendingAction } from "@/lib/actions";
import type { Step, Task } from "@/lib/types";

/**
 * Laat de taak verdergaan nadat de gebruiker een voorstel (mail of afspraak) heeft uitgevoerd of afgewezen.
 * - chat_turn-taak: direct afsluiten (klaar of geannuleerd).
 * - achtergrondtaak: uitkomst vastleggen bij de huidige stap en terug in de wachtrij.
 * Geeft true als de worker afgetrapt moet worden.
 */
export async function continueAfterDecision(db: SupabaseClient, action: PendingAction, outcome: "done" | "rejected") {
  if (!action.task_id) return false;
  const { data } = await db.from("dot_tasks").select("*").eq("id", action.task_id).eq("user_id", action.user_id).maybeSingle();
  const task = data as Task | null;
  if (!task || task.status !== "needs_input") return false;

  const what = describeAction(action);
  const verb = action.type === "gmail_send" ? "verstuurd" : "ingepland";
  const steps: Step[] = [...(task.steps ?? [])];
  const now = new Date().toISOString();

  if (task.source === "chat_turn") {
    const last = steps.length - 1;
    if (last >= 0) {
      steps[last] = { ...steps[last], status: "done", title: outcome === "done" ? `${verb[0].toUpperCase()}${verb.slice(1)} na jouw goedkeuring` : "Afgewezen door jou" };
    }
    await db.from("dot_tasks").update({
      status: outcome === "done" ? "done" : "cancelled",
      result: outcome === "done" ? `${what[0].toUpperCase()}${what.slice(1)}: ${verb}.` : `${what[0].toUpperCase()}${what.slice(1)}: afgewezen, niets gedaan.`,
      steps,
      current_step: steps.length,
      question: null,
      pending_action: null,
      updated_at: now,
    }).eq("id", task.id).eq("status", "needs_input");
    return false;
  }

  const idx = Math.min(task.current_step, steps.length - 1);
  if (idx >= 0 && steps[idx]) {
    steps[idx] = {
      ...steps[idx],
      qa: [
        ...(steps[idx].qa ?? []),
        {
          question: `Goedkeuring voor ${what}`,
          answer: outcome === "done" ? `${verb[0].toUpperCase()}${verb.slice(1)} na klik van de gebruiker.` : "Afgewezen door de gebruiker; NIET uitgevoerd.",
          approved: outcome === "done",
        },
      ],
    };
  }
  await db.from("dot_tasks").update({
    status: "pending",
    steps,
    question: null,
    pending_action: null,
    locked_until: null,
    updated_at: now,
  }).eq("id", task.id).eq("status", "needs_input");
  return true;
}
