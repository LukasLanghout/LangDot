import { after } from "next/server";
import { getUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runWorker } from "@/lib/agent/worker";
import { logAudit } from "@/lib/audit";
import type { Option, Step, Task } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const started = Date.now();
  const { id } = await params;
  const user = await getUser();
  if (!user) return Response.json({ error: "Niet ingelogd" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const answer = typeof body?.answer === "string" ? body.answer.trim().slice(0, 2000) : "";
  if (!answer) return Response.json({ error: "Leeg antwoord" }, { status: 400 });

  const db = createAdminClient();
  const { data } = await db.from("dot_tasks").select("*").eq("id", id).eq("user_id", user.id).maybeSingle();
  const task = data as Task | null;
  if (!task) return Response.json({ error: "Taak niet gevonden" }, { status: 404 });
  if (task.status !== "needs_input") return Response.json({ error: "Deze taak wacht niet op een antwoord" }, { status: 409 });

  // Alleen een expliciet gekozen optie met approves=true telt als goedkeuring. Vrije tekst nooit.
  const chosen = (task.options ?? []).find((o: Option) => o.label === answer);
  const approved = chosen?.approves === true;

  if (task.pending_action?.type === "approve_draft") {
    await db.from("dot_drafts")
      .update({ status: approved ? "approved" : "rejected" })
      .eq("id", task.pending_action.draft_id).eq("user_id", user.id);
  }

  const steps: Step[] = [...(task.steps ?? [])];
  const idx = Math.min(task.current_step, steps.length - 1);
  if (idx >= 0 && steps[idx]) {
    steps[idx] = {
      ...steps[idx],
      qa: [
        ...(steps[idx].qa ?? []),
        { question: task.question ?? "", answer, ...(task.pending_action ? { approved } : {}) },
      ],
    };
  }

  const { data: updated } = await db.from("dot_tasks").update({
    status: "pending",
    steps,
    answer,
    question: null,
    options: null,
    pending_action: null,
    locked_until: null,
    updated_at: new Date().toISOString(),
  }).eq("id", task.id).eq("status", "needs_input").select("id").maybeSingle();
  if (!updated) return Response.json({ error: "Al beantwoord" }, { status: 409 });

  await db.from("dot_messages").insert({
    user_id: user.id, role: "user", content: answer, task_id: task.id, meta: { kind: "answer" },
  });
  await logAudit(db, {
    userId: user.id, actor: "user", action: task.pending_action ? (approved ? "approved" : "rejected") : "answered",
    taskId: task.id, input: { question: task.question, answer }, output: task.pending_action ?? null,
  });

  after(() => runWorker({ userId: user.id, deadline: started + 55_000 }).then(() => undefined));
  return Response.json({ ok: true, approved });
}
