import type { SupabaseClient } from "@supabase/supabase-js";
import { complete, type ChatMessage } from "@/lib/llm";
import { ACTIVITY_TOOLS, chatTools, executeTool, parseArgs, type ToolContext } from "./tools";
import { chatSystemPrompt, loadAgentContext } from "./prompts";
import type { Message, Step } from "@/lib/types";

export type ChatEvent =
  | { t: "user"; id: string }
  | { t: "text"; d: string }
  | { t: "tool"; name: string }
  | { t: "done"; id: string | null; meta: Message["meta"] }
  | { t: "error"; message: string };

const MAX_ROUNDS = 5;
/** Lange oude berichten inkorten: scheelt veel tokens per beurt. */
const MAX_HISTORY_CHARS = 1500;
const clip = (s: string, n = MAX_HISTORY_CHARS) => (s.length > n ? `${s.slice(0, n)} …[ingekort]` : s);
const NO_REPLY = "(Op dit bericht is geen antwoord gegeven. Niet meer oppakken tenzij de gebruiker erom vraagt.)";

/**
 * Zet de opgeslagen berichten om naar model-history. Een gebruikersbericht zonder antwoord
 * (fout, dubbel verstuurd) krijgt een expliciete "geen antwoord"-regel, zodat het model het
 * oude verzoek niet alsnog oppakt in plaats van het nieuwe bericht te beantwoorden.
 */
export function toHistory(rows: { role: string; content: string }[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of rows) {
    const prev = out[out.length - 1];
    if (m.role === "user") {
      if (prev?.role === "user") out.push({ role: "assistant", content: NO_REPLY });
      out.push({ role: "user", content: clip(m.content) });
    } else {
      out.push({ role: "assistant", content: clip(m.content) });
    }
  }
  if (out[out.length - 1]?.role === "user") out.push({ role: "assistant", content: NO_REPLY });
  return out;
}

function stepTitle(name: string, args: Record<string, any> | null) {
  const a = args ?? {};
  switch (name) {
    case "web_search": return `Zoeken: ${String(a.query ?? "").slice(0, 80)}`;
    case "web_fetch": return `Pagina lezen: ${String(a.url ?? "").slice(0, 80)}`;
    case "gmail_create_draft": return `Mail opstellen aan ${(Array.isArray(a.to) ? a.to : [a.to ?? ""]).join(", ").slice(0, 80)}`;
    case "gmail_send": return "Goedgekeurde mail versturen";
    case "gmail_search": return `Mail doorzoeken: ${String(a.query ?? "").slice(0, 80)}`;
    case "gmail_read": return "Mail lezen";
    case "calendar_list_events": return "Agenda bekijken";
    case "calendar_create_event": return `Afspraak voorstellen: ${String(a.summary ?? "").slice(0, 80)}`;
    default: return name;
  }
}

/**
 * Chat-beurten met zichtbaar werk (zoeken, mail) verschijnen als taak in Activity (source "chat_turn").
 * De worker pakt deze taken nooit op; ze worden hier afgesloten.
 */
class ChatActivity {
  taskId: string | null = null;
  private steps: Step[] = [];
  constructor(private db: SupabaseClient, private userId: string, private title: string) {}

  async step(title: string) {
    if (!this.taskId) {
      const { data } = await this.db.from("dot_tasks").insert({
        user_id: this.userId,
        title: clip(this.title, 90),
        instructions: this.title,
        source: "chat_turn",
        status: "running",
        steps: [],
      }).select("id").single();
      this.taskId = data?.id ?? null;
    }
    this.steps.push({ title, status: "done" });
    if (this.taskId) await this.db.from("dot_tasks").update({ steps: this.steps, updated_at: new Date().toISOString() }).eq("id", this.taskId);
  }

  async finish(p: { text: string; actionIds: string[]; failed?: string }) {
    if (!this.taskId) return;
    const update: Record<string, unknown> = { updated_at: new Date().toISOString(), current_step: this.steps.length };
    if (p.failed) {
      Object.assign(update, { status: "failed", error: p.failed });
    } else if (p.actionIds.length) {
      this.steps.push({ title: "Wachten op jouw goedkeuring", status: "running" });
      Object.assign(update, {
        status: "needs_input",
        steps: this.steps,
        current_step: this.steps.length - 1,
        question: "Goedkeuring nodig",
        pending_action: { type: "approval", action_id: p.actionIds[0] },
      });
    } else {
      Object.assign(update, { status: "done", result: clip(p.text, 2000) });
    }
    await this.db.from("dot_tasks").update(update).eq("id", this.taskId);
  }
}

/** Eén chatbeurt: history laden, tool-loop draaien, tekst live streamen. */
export async function runChat(opts: {
  db: SupabaseClient;
  userId: string;
  userMessageId: string;
  userText: string;
  send: (e: ChatEvent) => void;
}): Promise<{ text: string; createdTask: boolean; meta: Message["meta"] }> {
  const { db, userId, send } = opts;
  const ctx = await loadAgentContext(db, userId);

  const { data: history } = await db
    .from("dot_messages")
    .select("role, content")
    .eq("user_id", userId)
    .neq("id", opts.userMessageId)
    .order("created_at", { ascending: false })
    .limit(16);

  const messages: ChatMessage[] = [
    { role: "system", content: chatSystemPrompt(ctx) },
    ...toHistory(((history ?? []) as { role: string; content: string }[]).reverse()),
    // Het huidige bericht staat altijd als laatste, ook als de worker net iets heeft gepost.
    { role: "user", content: opts.userText },
  ];

  const toolCtx: ToolContext = { db, userId, taskId: null, origin: "chat", gmail: ctx.gmail, calendar: ctx.calendar, createdActionIds: [] };
  const activity = new ChatActivity(db, userId, opts.userText);
  const tools = chatTools(toolCtx);
  let text = "";

  try {
    for (let round = 0; round <= MAX_ROUNDS; round++) {
      const last = round === MAX_ROUNDS;
      const result = await complete({
        messages,
        tools,
        toolChoice: last ? "none" : "auto", // laatste ronde: afronden zonder tools
        userId,
        onText: (d) => {
          text += d;
          send({ t: "text", d });
        },
      });

      if (!result.toolCalls.length || last) break;

      messages.push({ role: "assistant", content: result.content || null, tool_calls: result.toolCalls });
      for (const call of result.toolCalls) {
        const name = call.function.name;
        send({ t: "tool", name });
        if (ACTIVITY_TOOLS.has(name)) {
          await activity.step(stepTitle(name, parseArgs(call.function.arguments)));
          toolCtx.taskId = activity.taskId;
        }
        const out = await executeTool(toolCtx, name, call.function.arguments);
        messages.push({ role: "tool", tool_call_id: call.id, content: out });
      }
      if (text && !text.endsWith("\n")) {
        text += "\n\n";
        send({ t: "text", d: "\n\n" });
      }
    }
  } catch (e) {
    await activity.finish({ text, actionIds: [], failed: "De chatbeurt is mislukt." });
    throw e;
  }

  await activity.finish({ text, actionIds: toolCtx.createdActionIds });

  const meta: Message["meta"] = toolCtx.createdActionIds.length
    ? { kind: "approval", action_ids: toolCtx.createdActionIds }
    : toolCtx.connectRequest
      ? { kind: "connect", provider: toolCtx.connectRequest }
      : null;

  return { text, createdTask: !!toolCtx.createdTask, meta };
}
