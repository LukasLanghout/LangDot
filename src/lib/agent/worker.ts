import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { chat, RateLimitError, type ChatMessage } from "@/lib/groq";
import { logAudit } from "@/lib/audit";
import { computeNextRun } from "@/lib/schedule";
import type { Option, Schedule, Step, Task } from "@/lib/types";
import { executeTool, parseArgs, PLAN_TOOL, WORKER_TOOLS, type ToolContext } from "./tools";
import { loadAgentContext, plannerPrompt, stepBrief, summaryPrompt, workerSystemPrompt } from "./prompts";

// ─────────────────────────────────────────────────────────────────────────────
// De worker is stateless: elke aanroep pakt werk op uit Postgres, doet een paar
// stappen binnen een tijdsbudget en laat de rest voor de volgende tick.
// Een lock (locked_until) voorkomt dat twee ticks dezelfde taak tegelijk doen.
// ─────────────────────────────────────────────────────────────────────────────

const LOCK_MS = 120_000;
const MAX_TOOL_ROUNDS = 6;
const MAX_ATTEMPTS = 3;

const nowIso = () => new Date().toISOString();

export async function runWorker(opts: { userId?: string; deadline?: number } = {}) {
  const deadline = opts.deadline ?? Date.now() + 45_000;
  const db = createAdminClient();
  const stats = { schedulesFired: 0, stepsRun: 0, errors: 0 };

  try {
    stats.schedulesFired = await fireDueSchedules(db, opts.userId);
  } catch (e) {
    console.error("schedules failed", e);
    stats.errors++;
  }

  while (Date.now() < deadline - 8_000) {
    const task = await claimNextTask(db, opts.userId);
    if (!task) break;
    try {
      await advanceTask(db, task, deadline);
      stats.stepsRun++;
    } catch (e) {
      stats.errors++;
      if (e instanceof RateLimitError) {
        // Geen echte fout: de taak wacht tot de limiet voorbij is, zonder poging te verbruiken.
        await db.from("dot_tasks")
          .update({ locked_until: new Date(Date.now() + Math.min(e.retryAfterMs, 30 * 60_000)).toISOString(), error: e.message })
          .eq("id", task.id).eq("status", "running");
        await logAudit(db, { userId: task.user_id, actor: "system", action: "rate_limited", taskId: task.id, output: e.message });
        break; // andere taken lopen nu ook tegen de limiet aan
      }
      await handleFailure(db, task, e);
    }
  }
  return stats;
}

// ───────────────────────────── Schedules ─────────────────────────────

async function fireDueSchedules(db: SupabaseClient, userId?: string) {
  let q = db.from("dot_schedules").select("*").eq("active", true).lte("next_run_at", nowIso()).limit(20);
  if (userId) q = q.eq("user_id", userId);
  const { data } = await q;
  let fired = 0;

  for (const s of (data ?? []) as Schedule[]) {
    const next = computeNextRun(s.days, s.time_of_day, s.timezone, new Date(Date.now() + 1000));
    // Conditionele update = claim: alleen de tick die next_run_at nog ongewijzigd ziet, vuurt.
    const { data: claimed } = await db.from("dot_schedules")
      .update({ next_run_at: next, last_run_at: nowIso() })
      .eq("id", s.id).eq("next_run_at", s.next_run_at!)
      .select("id").maybeSingle();
    if (!claimed) continue;

    const { data: profile } = await db.from("dot_profiles").select("paused").eq("user_id", s.user_id).maybeSingle();
    if (profile?.paused) {
      await logAudit(db, { userId: s.user_id, actor: "system", action: "schedule_skipped_paused", input: { schedule_id: s.id, title: s.title } });
      continue;
    }

    const { data: task } = await db.from("dot_tasks").insert({
      user_id: s.user_id,
      title: s.title,
      instructions: s.prompt,
      source: "schedule",
      schedule_id: s.id,
    }).select("id").single();

    await logAudit(db, {
      userId: s.user_id, actor: "system", action: "schedule_fired", taskId: task?.id ?? null,
      input: { schedule_id: s.id, title: s.title }, output: { next_run_at: next },
    });
    fired++;
  }
  return fired;
}

// ───────────────────────────── Claimen ─────────────────────────────

async function claimNextTask(db: SupabaseClient, userId?: string): Promise<Task | null> {
  const now = nowIso();
  const unlocked = `locked_until.is.null,locked_until.lt.${now}`;

  let q = db.from("dot_tasks").select("id, user_id").in("status", ["pending", "running"])
    .or(unlocked).order("created_at", { ascending: true }).limit(10);
  if (userId) q = q.eq("user_id", userId);
  const { data: candidates } = await q;
  if (!candidates?.length) return null;

  const userIds = [...new Set(candidates.map((c) => c.user_id as string))];
  const { data: paused } = await db.from("dot_profiles").select("user_id").in("user_id", userIds).eq("paused", true);
  const pausedSet = new Set((paused ?? []).map((p) => p.user_id as string));

  for (const c of candidates) {
    if (pausedSet.has(c.user_id)) continue;
    const { data } = await db.from("dot_tasks")
      .update({ status: "running", locked_until: new Date(Date.now() + LOCK_MS).toISOString() })
      .eq("id", c.id).in("status", ["pending", "running"]).or(unlocked)
      .select("*").maybeSingle();
    if (data) return data as Task;
  }
  return null;
}

/** Schrijft taakvelden weg zolang de taak nog 'running' is (dus niet als hij intussen geannuleerd is). */
async function saveRunning(db: SupabaseClient, task: Task, fields: Record<string, unknown>) {
  await db.from("dot_tasks").update({ ...fields, updated_at: nowIso() }).eq("id", task.id).eq("status", "running");
}

async function stopReason(db: SupabaseClient, task: Task): Promise<"cancelled" | "paused" | null> {
  const [{ data: t }, { data: p }] = await Promise.all([
    db.from("dot_tasks").select("status").eq("id", task.id).single(),
    db.from("dot_profiles").select("paused").eq("user_id", task.user_id).single(),
  ]);
  if (!t || t.status !== "running") return "cancelled";
  if (p?.paused) return "paused";
  return null;
}

// ───────────────────────────── Taak-loop ─────────────────────────────

async function advanceTask(db: SupabaseClient, task: Task, deadline: number) {
  const steps = Array.isArray(task.steps) ? task.steps : [];
  if (!steps.length) return planTask(db, task);
  if (task.current_step < steps.length) return executeStep(db, task, deadline);
  return finalizeTask(db, task);
}

async function planTask(db: SupabaseClient, task: Task) {
  const ctx = await loadAgentContext(db, task.user_id);
  const res = await chat({
    messages: [
      { role: "system", content: plannerPrompt(ctx) },
      { role: "user", content: `Taak: ${task.title}\n\nInstructies:\n${task.instructions || "(geen)"}` },
    ],
    tools: [PLAN_TOOL],
    toolChoice: { type: "function", function: { name: "set_plan" } },
    temperature: 0.2,
  });

  const args = parseArgs(res.toolCalls[0]?.function.arguments ?? "");
  let titles: string[] = Array.isArray(args?.steps) ? args!.steps.map((s: unknown) => String(s).slice(0, 200)).filter(Boolean) : [];
  if (!titles.length) titles = [task.title];

  const steps: Step[] = titles.slice(0, 6).map((title) => ({ title, status: "pending" }));
  await saveRunning(db, task, { steps, current_step: 0, locked_until: null });
  await logAudit(db, { userId: task.user_id, actor: "agent", action: "plan", taskId: task.id, output: { steps: titles } });
}

async function executeStep(db: SupabaseClient, task: Task, deadline: number) {
  const index = task.current_step;
  const steps: Step[] = [...task.steps];
  steps[index] = { ...steps[index], status: "running" };
  await saveRunning(db, task, { steps });
  task = { ...task, steps };

  const ctx = await loadAgentContext(db, task.user_id);
  const toolCtx: ToolContext = { db, userId: task.user_id, taskId: task.id, origin: "worker" };
  const messages: ChatMessage[] = [
    { role: "system", content: workerSystemPrompt(ctx) },
    { role: "user", content: stepBrief(task, index) },
  ];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (Date.now() > deadline - 6_000) {
      // Tijd op: lock vrijgeven, de volgende tick begint deze stap opnieuw.
      await saveRunning(db, task, { locked_until: null });
      return;
    }
    const stop = await stopReason(db, task);
    if (stop === "cancelled") return;
    if (stop === "paused") {
      await saveRunning(db, task, { locked_until: null });
      return;
    }

    const res = await chat({ messages, tools: WORKER_TOOLS, temperature: 0.3 });
    if (!res.toolCalls.length) {
      return completeStep(db, task, index, res.content || "Stap afgerond.");
    }

    messages.push({ role: "assistant", content: res.content || null, tool_calls: res.toolCalls });
    for (const call of res.toolCalls) {
      const name = call.function.name;
      if (name === "complete_step" || name === "ask_user") {
        const args = parseArgs(call.function.arguments) ?? {};
        await logAudit(db, { userId: task.user_id, actor: "agent", action: "tool_call", tool: name, taskId: task.id, input: args });
        if (name === "complete_step") return completeStep(db, task, index, String(args.result ?? "Stap afgerond."));
        return askUser(db, task, args);
      }
      const out = await executeTool(toolCtx, name, call.function.arguments);
      messages.push({ role: "tool", tool_call_id: call.id, content: out });
    }
  }

  // Tool-budget op: laat het model afronden met wat het heeft.
  messages.push({ role: "user", content: "Je tool-budget voor deze stap is op. Vat nu het resultaat van deze stap samen." });
  const final = await chat({ messages, tools: WORKER_TOOLS, toolChoice: "none" });
  return completeStep(db, task, index, final.content || "Stap afgerond (tool-budget op).");
}

async function completeStep(db: SupabaseClient, task: Task, index: number, result: string) {
  const steps: Step[] = [...task.steps];
  steps[index] = { ...steps[index], status: "done", result: result.slice(0, 4000) };
  await saveRunning(db, task, { steps, current_step: index + 1, locked_until: null });
  await logAudit(db, { userId: task.user_id, actor: "agent", action: "step_done", taskId: task.id, input: { step: index + 1, title: steps[index].title } });
}

async function askUser(db: SupabaseClient, task: Task, args: Record<string, any>) {
  const question = String(args.question ?? "").trim().slice(0, 1000) || "Hoe wil je dat ik verder ga?";
  let options: Option[] = Array.isArray(args.options)
    ? args.options
        .map((o: any) => (typeof o === "string" ? { label: o, approves: false } : { label: String(o?.label ?? ""), approves: o?.approves === true }))
        .filter((o: Option) => o.label.trim())
        .slice(0, 4)
    : [];
  if (options.length < 2) options = [{ label: "Ja, ga door", approves: true }, { label: "Nee", approves: false }];

  // Hoort de vraag bij een concept? Dan tonen we het concept erbij en onthouden we de actie.
  let pendingAction: { type: "approve_draft"; draft_id: string } | null = null;
  let draftText = "";
  if (typeof args.draft_id === "string" && args.draft_id) {
    const { data: draft } = await db.from("dot_drafts").select("*")
      .eq("id", args.draft_id).eq("user_id", task.user_id).maybeSingle();
    if (draft) {
      pendingAction = { type: "approve_draft", draft_id: draft.id };
      draftText =
        `\n\n---\n**Concept (${draft.channel})**` +
        (draft.recipient ? `\nAan: ${draft.recipient}` : "") +
        (draft.subject ? `\nOnderwerp: ${draft.subject}` : "") +
        `\n\n${draft.body}`;
    }
  }

  await saveRunning(db, task, {
    status: "needs_input",
    question,
    options,
    pending_action: pendingAction,
    answer: null,
    locked_until: null,
  });
  await db.from("dot_messages").insert({
    user_id: task.user_id,
    role: "assistant",
    content: `**${task.title}** — ${question}${draftText}`,
    task_id: task.id,
    meta: { kind: "question", options },
  });
}

async function finalizeTask(db: SupabaseClient, task: Task) {
  const ctx = await loadAgentContext(db, task.user_id);
  const results = task.steps.map((s, i) => `### Stap ${i + 1}: ${s.title}\n${s.result ?? ""}`).join("\n\n");
  const { data: drafts } = await db.from("dot_drafts").select("id, channel, recipient, subject, status")
    .eq("task_id", task.id).eq("user_id", task.user_id);

  const res = await chat({
    messages: [
      { role: "system", content: summaryPrompt(ctx) },
      {
        role: "user",
        content: `Taak: ${task.title}\nInstructies: ${task.instructions}\n\n${results}\n\nConcepten: ${JSON.stringify(drafts ?? [])}`,
      },
    ],
    temperature: 0.4,
  });
  const summary = res.content.trim() || "Taak afgerond.";

  const { data: done } = await db.from("dot_tasks")
    .update({ status: "done", result: summary, locked_until: null, updated_at: nowIso() })
    .eq("id", task.id).eq("status", "running").select("id").maybeSingle();
  if (!done) return; // intussen geannuleerd

  await db.from("dot_messages").insert({
    user_id: task.user_id,
    role: "assistant",
    content: summary,
    task_id: task.id,
    meta: { kind: "task_done" },
  });
  await logAudit(db, { userId: task.user_id, actor: "agent", action: "task_done", taskId: task.id, output: summary });
}

async function handleFailure(db: SupabaseClient, task: Task, e: unknown) {
  const message = e instanceof Error ? e.message : String(e);
  console.error("task failed", task.id, message);
  const attempts = (task.attempts ?? 0) + 1;

  if (attempts >= MAX_ATTEMPTS) {
    await db.from("dot_tasks")
      .update({ status: "failed", error: message.slice(0, 1000), attempts, locked_until: null, updated_at: nowIso() })
      .eq("id", task.id).eq("status", "running");
    await db.from("dot_messages").insert({
      user_id: task.user_id,
      role: "assistant",
      content: `Het lukte me niet om **${task.title}** af te ronden: ${message.slice(0, 300)}`,
      task_id: task.id,
      meta: { kind: "task_failed" },
    });
  } else {
    // Backoff: over een minuut opnieuw proberen.
    await db.from("dot_tasks")
      .update({ attempts, error: message.slice(0, 1000), locked_until: new Date(Date.now() + 60_000).toISOString() })
      .eq("id", task.id).eq("status", "running");
  }
  await logAudit(db, { userId: task.user_id, actor: "system", action: "task_error", taskId: task.id, output: { attempts, message } });
}
