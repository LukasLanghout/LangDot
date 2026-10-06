import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { complete, type ChatMessage, type CompleteOptions } from "@/lib/llm";
import { LlmError, userSafeMessage } from "@/lib/llm-errors";
import { logAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/push";
import { describeAction, type ActionLike } from "@/lib/actions";
import { computeNextRun } from "@/lib/schedule";
import type { Option, Schedule, Step, Task } from "@/lib/types";
import { executeTool, parseArgs, PLAN_TOOL, workerTools, type ToolContext } from "./tools";
import { loadAgentContext, plannerPrompt, stepBrief, summaryPrompt, workerSystemPrompt } from "./prompts";

// ─────────────────────────────────────────────────────────────────────────────
// De worker is stateless: elke aanroep pakt werk op uit Postgres, doet een paar
// stappen binnen een tijdsbudget en laat de rest voor de volgende tick.
// Een lock (locked_until) voorkomt dat twee ticks dezelfde taak tegelijk doen.
// ─────────────────────────────────────────────────────────────────────────────

const LOCK_MS = 120_000;
const MAX_TOOL_ROUNDS = 6;
const MAX_ATTEMPTS = 3;
/** Minimale resterende tijd om aan een modelaanroep te beginnen (een reasoning-model doet er 20-30 s over). */
const MIN_MS_PER_LLM_CALL = 25_000;
const ACTION_TTL_DAYS = 7;

/** Maximaal aantal LLM-aanroepen per taak, zodat een lus nooit eindeloos tokens verbrandt. */
export function maxTaskSteps() {
  const n = Number(process.env.MAX_TASK_STEPS);
  return Number.isFinite(n) && n > 0 ? n : 40;
}

class StepLimitError extends Error {
  constructor() {
    super("Deze taak heeft het maximum aantal stappen bereikt en is gestopt.");
  }
}

const nowIso = () => new Date().toISOString();

/** Rustige melding voor tijdelijke onderbrekingen; de dot probeert het vanzelf opnieuw. */
function waitingNote(kind: string) {
  if (kind === "budget") return "Wacht: het dagelijkse tegoed is op. Gaat vanzelf verder zodra er ruimte is.";
  if (kind === "rate_limit") return "Even wachten: het taalmodel is druk. De dot probeert het zo vanzelf opnieuw.";
  return "Even wachten: het taalmodel reageerde niet. De dot probeert het over een minuut vanzelf opnieuw.";
}

export async function runWorker(opts: { userId?: string; deadline?: number } = {}) {
  const deadline = opts.deadline ?? Date.now() + 45_000;
  const db = createAdminClient();
  const stats = { schedulesFired: 0, stepsRun: 0, errors: 0, actionsExpired: 0 };

  try {
    stats.schedulesFired = await fireDueSchedules(db, opts.userId);
  } catch (e) {
    console.error("[worker] schedules mislukt", e);
    stats.errors++;
  }
  try {
    stats.actionsExpired = await expireOldActions(db, opts.userId);
  } catch (e) {
    console.error("[worker] verlopen acties opruimen mislukt", e);
  }

  while (Date.now() < deadline - 8_000) {
    const task = await claimNextTask(db, opts.userId);
    if (!task) break;
    try {
      await advanceTask(db, task, deadline);
      stats.stepsRun++;
    } catch (e) {
      stats.errors++;
      if (e instanceof LlmError && (e.kind === "rate_limit" || e.kind === "unavailable" || e.kind === "budget")) {
        // Geen fout van de taak zelf: wachten zonder poging te verbruiken.
        // Budget: elke 15 minuten opnieuw kijken (kost geen tokens). Verhoogt de gebruiker het budget, dan gaat de
        // taak vanzelf verder; anders start het nieuwe budget na middernacht.
        const until = new Date(Date.now() + (e.kind === "budget" ? 15 : e.kind === "unavailable" ? 1 : 5) * 60_000);
        await db.from("dot_tasks").update({ locked_until: until.toISOString(), error: waitingNote(e.kind) })
          .eq("id", task.id).eq("status", "running");
        await logAudit(db, { userId: task.user_id, actor: "system", action: `waiting_${e.kind}`, taskId: task.id, output: e.message });
        break;
      }
      await handleFailure(db, task, e);
    }
  }
  return stats;
}

// ───────────────────────────── Schedules & opruimen ─────────────────────────────

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

/** Concepten die na een week nog niet beoordeeld zijn, vervallen (en hun taak wordt geannuleerd). */
async function expireOldActions(db: SupabaseClient, userId?: string) {
  const cutoff = new Date(Date.now() - ACTION_TTL_DAYS * 86_400_000).toISOString();
  let q = db.from("pending_actions").update({ status: "expired", decided_at: nowIso() })
    .eq("status", "pending").lt("created_at", cutoff);
  if (userId) q = q.eq("user_id", userId);
  const { data } = await q.select("id, task_id, user_id");
  for (const a of data ?? []) {
    if (a.task_id) {
      await db.from("dot_tasks").update({ status: "cancelled", error: "Goedkeuring verlopen", locked_until: null })
        .eq("id", a.task_id).eq("status", "needs_input");
    }
    await logAudit(db, { userId: a.user_id, actor: "system", action: "action_expired", taskId: a.task_id, input: { action_id: a.id } });
  }
  return data?.length ?? 0;
}

// ───────────────────────────── Claimen ─────────────────────────────

async function claimNextTask(db: SupabaseClient, userId?: string): Promise<Task | null> {
  const now = nowIso();
  const unlocked = `locked_until.is.null,locked_until.lt.${now}`;

  // chat_turn-taken zijn het logboek van een chatbeurt; die voert de worker nooit uit.
  let q = db.from("dot_tasks").select("id, user_id").in("status", ["pending", "running"])
    .neq("source", "chat_turn").or(unlocked).order("created_at", { ascending: true }).limit(10);
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

/** LLM-aanroep binnen een taak: telt mee voor de stappenlimiet en het tokenbudget. */
async function taskComplete(db: SupabaseClient, task: Task, opts: CompleteOptions, deadline?: number) {
  if ((task.step_count ?? 0) >= maxTaskSteps()) throw new StepLimitError();
  // Met een deadline: de aanroep krijgt precies de tijd die de tick nog heeft (zodat Vercel hem niet hard afkapt),
  // en probeert niet opnieuw; de volgende tick hervat vanaf de tussenstand.
  const timeoutMs = deadline ? Math.max(10_000, deadline - Date.now() - 4_000) : undefined;
  const result = await complete({ ...opts, userId: task.user_id, ...(deadline ? { timeoutMs, noRetry: true } : {}) });
  // Pas na een geslaagde aanroep tellen: een afgebroken of mislukte poging telt niet mee.
  task.step_count = (task.step_count ?? 0) + 1;
  await db.from("dot_tasks").update({ step_count: task.step_count }).eq("id", task.id);
  return result;
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
  const res = await taskComplete(db, task, {
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
  await saveRunning(db, task, { steps, current_step: 0, locked_until: null, error: null });
  await logAudit(db, { userId: task.user_id, actor: "agent", action: "plan", taskId: task.id, output: { steps: titles } });
}

async function executeStep(db: SupabaseClient, task: Task, deadline: number) {
  const index = task.current_step;
  const steps: Step[] = [...task.steps];
  steps[index] = { ...steps[index], status: "running" };
  await saveRunning(db, task, { steps });
  task = { ...task, steps };

  const ctx = await loadAgentContext(db, task.user_id);
  const toolCtx: ToolContext = {
    db, userId: task.user_id, taskId: task.id, origin: "worker", gmail: ctx.gmail, calendar: ctx.calendar, createdActionIds: [],
    standing: await standingPermission(db, task, ctx.gmail.email),
    // Alleen de laatste stap, of een stap die zelf over mailen gaat, mag een mail opstellen/versturen.
    dedupeLinks: task.source === "schedule",
    allowMailTools: index === steps.length - 1 || /mail|stuur|verstuur|concept|opstel|bericht/i.test(steps[index]?.title ?? ""),
  };
  const tools = workerTools(toolCtx);
  const messages: ChatMessage[] = [
    { role: "system", content: workerSystemPrompt(ctx) },
    { role: "user", content: stepBrief(task, index) },
  ];

  // Hervatten: een vorige tick kan halverwege deze stap zijn gestopt (tijdsbudget). De tussenstand staat in `scratch`,
  // zodat we niet telkens opnieuw beginnen (dat verbrandde alle stappen: 25 aanroepen, stap 0 nooit klaar).
  const saved = (task as Task & { scratch?: Scratch | null }).scratch;
  let startRound = 0;
  let timeouts = 0;
  if (saved && saved.step === index && Array.isArray(saved.messages)) {
    messages.push(...saved.messages);
    startRound = Math.min(Number(saved.rounds) || 0, MAX_TOOL_ROUNDS);
    timeouts = Number(saved.timeouts) || 0;
  }
  const keepProgress = (round: number) => saveScratch(db, task.id, { step: index, rounds: round, messages: messages.slice(2), timeouts });
  // Past een modelaanroep telkens niet in de tijd van één tick (lange mail), maak de opdracht dan korter.
  if (timeouts >= 2 && !messages.some((m) => m.role === "user" && String(m.content).startsWith("SNELLER:"))) {
    messages.push({
      role: "user",
      content: "SNELLER: je vorige pogingen duurden te lang. Schrijf nu een KORTE versie: maximaal 6 items, één zin per item, bron als link. Geen lange redenering.",
    });
  }

  for (let round = startRound; round < MAX_TOOL_ROUNDS; round++) {
    // Een modelaanroep kan 20 tot 30 seconden duren; begin er alleen aan als er genoeg tijd over is.
    if (Date.now() > deadline - MIN_MS_PER_LLM_CALL) {
      await keepProgress(round);
      await saveRunning(db, task, { locked_until: null });
      return;
    }
    const stop = await stopReason(db, task);
    if (stop === "cancelled") return;
    if (stop === "paused") {
      await saveRunning(db, task, { locked_until: null });
      return;
    }

    let res: Awaited<ReturnType<typeof taskComplete>>;
    try {
      res = await taskComplete(db, task, { messages, tools, temperature: 0.3, maxTokens: timeouts >= 2 ? 2500 : 6000 }, deadline);
    } catch (e) {
      // Onze eigen tijdslimiet bereikt (de tick is bijna om): geen fout, de volgende tick hervat deze ronde.
      if (e instanceof LlmError && e.kind === "unavailable" && /time(d)? ?out/i.test(e.detail) && Date.now() >= deadline - 8_000) {
        timeouts++;
        await keepProgress(round);
        await saveRunning(db, task, { locked_until: null });
        return;
      }
      throw e;
    }
    if (res.truncated && res.toolCalls.length) {
      // Afgekapt midden in een tool-aanroep: de (nu onschadelijke) aanroep levert een melding op; het model probeert korter.
      console.warn(`[worker] antwoord afgekapt bij max_tokens (taak ${task.id}, ronde ${round})`);
    }
    if (!res.toolCalls.length) {
      return completeStep(db, task, index, res.content || "Stap afgerond.");
    }

    messages.push({ role: "assistant", content: res.content || null, tool_calls: res.toolCalls });
    for (const call of res.toolCalls) {
      const name = call.function.name;
      if ((name === "complete_step" || name === "ask_user") && (parseArgs(call.function.arguments) ?? {}).__invalid) {
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: "Je aanroep was ongeldig of afgekapt. Probeer het opnieuw met een kortere tekst." }) });
        continue;
      }
      if (name === "complete_step" || name === "ask_user") {
        const args = parseArgs(call.function.arguments) ?? {};
        await logAudit(db, { userId: task.user_id, actor: "agent", action: "tool_call", tool: name, taskId: task.id, input: args });
        if (name === "complete_step") return completeStep(db, task, index, String(args.result ?? "Stap afgerond."));
        return askUser(db, task, args);
      }
      const out = await executeTool(toolCtx, name, call.function.arguments);
      messages.push({ role: "tool", tool_call_id: call.id, content: out });
      // Een voorstel (mail of afspraak) stopt de stap: de taak wacht op de klik van de gebruiker.
      if (toolCtx.createdActionIds.length) return awaitApproval(db, task, toolCtx.createdActionIds);
    }
    await keepProgress(round + 1);
  }

  // Tool-budget op: laat het model afronden met wat het heeft (alleen als er tijd is; anders volgende tick).
  if (Date.now() > deadline - MIN_MS_PER_LLM_CALL) {
    await keepProgress(MAX_TOOL_ROUNDS);
    await saveRunning(db, task, { locked_until: null });
    return;
  }
  messages.push({ role: "user", content: "Je tool-budget voor deze stap is op. Vat nu het resultaat van deze stap samen." });
  const final = await taskComplete(db, task, { messages, tools, toolChoice: "none", maxTokens: 3000 }, deadline);
  return completeStep(db, task, index, final.content || "Stap afgerond (tool-budget op).");
}

/**
 * Staande toestemming voor deze taak: alleen als de taak uit een schema komt waarop de gebruiker
 * zelf auto_send heeft toegestaan, en het toegestane adres nog steeds zijn verbonden Gmail-adres is.
 */
async function standingPermission(db: SupabaseClient, task: Task, gmailEmail: string | null) {
  if (task.source !== "schedule" || !task.schedule_id || !gmailEmail) return null;
  const { data } = await db.from("dot_schedules").select("id, auto_send, auto_send_to")
    .eq("id", task.schedule_id).eq("user_id", task.user_id).maybeSingle();
  if (!data?.auto_send || !data.auto_send_to) return null;
  if (String(data.auto_send_to).toLowerCase() !== gmailEmail.toLowerCase()) return null;
  return { scheduleId: data.id as string, to: String(data.auto_send_to) };
}

type Scratch = { step: number; rounds: number; messages: ChatMessage[]; timeouts?: number };

/** Tussenstand van een stap bewaren/wissen. Aparte update: bestaat de kolom niet (migratie 0007), dan faalt alleen dit. */
async function saveScratch(db: SupabaseClient, taskId: string, scratch: Scratch | null) {
  const { error } = await db.from("dot_tasks").update({ scratch }).eq("id", taskId).eq("status", "running");
  if (error && scratch) console.warn("[worker] tussenstand bewaren mislukt (migratie 0007 uitgevoerd?):", error.message);
}

async function completeStep(db: SupabaseClient, task: Task, index: number, result: string) {
  const steps: Step[] = [...task.steps];
  steps[index] = { ...steps[index], status: "done", result: result.slice(0, 4000) };
  await saveRunning(db, task, { steps, current_step: index + 1, locked_until: null, error: null });
  await saveScratch(db, task.id, null);
  await logAudit(db, { userId: task.user_id, actor: "agent", action: "step_done", taskId: task.id, input: { step: index + 1, title: steps[index].title } });
}

async function awaitApproval(db: SupabaseClient, task: Task, actionIds: string[]) {
  const { data } = await db.from("pending_actions").select("type, payload").in("id", actionIds).eq("user_id", task.user_id);
  const what = ((data ?? []) as ActionLike[]).map((a) => describeAction(a)).join("; ") || "een voorstel";

  await saveRunning(db, task, {
    status: "needs_input",
    question: "Goedkeuring nodig",
    options: null,
    pending_action: { type: "approval", action_id: actionIds[0] },
    answer: null,
    locked_until: null,
  });
  await db.from("dot_messages").insert({
    user_id: task.user_id,
    role: "assistant",
    content: `**${task.title}**: ik heb ${what} klaargezet. Kijk het na en keur goed of wijs af.`,
    task_id: task.id,
    meta: { kind: "approval", action_ids: actionIds },
  });
  await notifyUser(task.user_id, { title: "Goedkeuring nodig", body: `${task.title}: ${what}`, tag: `approval-${actionIds[0]}` });
}

async function askUser(db: SupabaseClient, task: Task, args: Record<string, any>) {
  const question = String(args.question ?? "").trim().slice(0, 1000) || "Hoe wil je dat ik verder ga?";
  let options: Option[] = Array.isArray(args.options)
    ? args.options
        .map((o: any) => ({ label: String(typeof o === "string" ? o : o?.label ?? "").slice(0, 80) }))
        .filter((o: Option) => o.label.trim())
        .slice(0, 4)
    : [];
  if (options.length < 2) options = [{ label: "Ja, ga door" }, { label: "Nee, stop" }];

  await saveRunning(db, task, {
    status: "needs_input",
    question,
    options,
    pending_action: null,
    answer: null,
    locked_until: null,
  });
  await db.from("dot_messages").insert({
    user_id: task.user_id,
    role: "assistant",
    content: `**${task.title}**: ${question}`,
    task_id: task.id,
    meta: { kind: "question", options },
  });
  await notifyUser(task.user_id, { title: "Je dot heeft een vraag", body: `${task.title}: ${question}`, tag: `question-${task.id}` });
}

async function finalizeTask(db: SupabaseClient, task: Task) {
  const ctx = await loadAgentContext(db, task.user_id);
  const results = task.steps.map((s, i) => `### Stap ${i + 1}: ${s.title}\n${s.result ?? ""}`).join("\n\n");
  const { data: actions } = await db.from("pending_actions").select("type, status, payload")
    .eq("task_id", task.id).eq("user_id", task.user_id);
  const proposals = ((actions ?? []) as (ActionLike & { status: string })[])
    .map((a) => ({ wat: describeAction(a), status: a.status }));

  const res = await taskComplete(db, task, {
    messages: [
      { role: "system", content: summaryPrompt(ctx) },
      {
        role: "user",
        content: `Taak: ${task.title}\nInstructies: ${task.instructions}\n\n${results}\n\nVoorstellen (mail/agenda): ${JSON.stringify(proposals)}`,
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
  await notifyUser(task.user_id, { title: "Taak klaar", body: task.title, tag: `done-${task.id}` });
}

async function handleFailure(db: SupabaseClient, task: Task, e: unknown) {
  const safe = e instanceof StepLimitError ? e.message : userSafeMessage(e);
  console.error("[worker] taak mislukt", task.id, e instanceof LlmError ? e.detail : e);
  const attempts = (task.attempts ?? 0) + 1;

  if (attempts >= MAX_ATTEMPTS || e instanceof StepLimitError) {
    await db.from("dot_tasks")
      .update({ status: "failed", error: safe, attempts, locked_until: null, updated_at: nowIso() })
      .eq("id", task.id).eq("status", "running");
    await db.from("dot_messages").insert({
      user_id: task.user_id,
      role: "assistant",
      content: `Het lukte me niet om **${task.title}** af te ronden. ${safe}`,
      task_id: task.id,
      meta: { kind: "task_failed" },
    });
    await notifyUser(task.user_id, { title: "Taak mislukt", body: task.title, tag: `failed-${task.id}` });
  } else {
    // Backoff: over een minuut opnieuw proberen.
    await db.from("dot_tasks")
      .update({ attempts, error: safe, locked_until: new Date(Date.now() + 60_000).toISOString() })
      .eq("id", task.id).eq("status", "running");
  }
  await logAudit(db, { userId: task.user_id, actor: "system", action: "task_error", taskId: task.id, output: { attempts, message: safe } });
}
