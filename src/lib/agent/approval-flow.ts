import type { SupabaseClient } from "@supabase/supabase-js";
import type { PendingAction } from "@/lib/actions";
import type { Step, Task } from "@/lib/types";

/**
 * Laat de taak verdergaan nadat de gebruiker een mail heeft verstuurd of afgewezen.
 * - chat_turn-taak: direct afsluiten (klaar of geannuleerd).
 * - achtergrondtaak: uitkomst vastleggen bij de huidige stap en terug in de wachtrij.
 * Geeft true als de worker afgetrapt moet worden.
 */
export async function continueAfterDecision(db: SupabaseClient, action: PendingAction, outcome: "sent" | "rejected") {
  if (!action.task_id) return false;
  const { data } = await db.from("dot_tasks").select("*").eq("id", action.task_id).eq("user_id", action.user_id).maybeSingle();
  const task = data as Task | null;
  if (!task || task.status !== "needs_input") return false;

  const to = action.payload.to.join(", ");
  const steps: Step[] = [...(task.steps ?? [])];
  const now = new Date().toISOString();

  if (task.source === "chat_turn") {
    const last = steps.length - 1;
    if (last >= 0) steps[last] = { ...steps[last], status: "done", title: outcome === "sent" ? "Verstuurd na jouw goedkeuring" : "Afgewezen door jou" };
    await db.from("dot_tasks").update({
      status: outcome === "sent" ? "done" : "cancelled",
      result: outcome === "sent" ? `Mail verstuurd aan ${to}: "${action.payload.subject}"` : `Mail aan ${to} afgewezen; niet verstuurd.`,
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
          question: `Mail aan ${to}, onderwerp "${action.payload.subject}"`,
          answer: outcome === "sent" ? "Verstuurd na klik van de gebruiker op Versturen." : "Afgewezen door de gebruiker; NIET verstuurd.",
          approved: outcome === "sent",
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
