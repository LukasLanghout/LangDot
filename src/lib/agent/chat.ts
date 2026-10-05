import type { SupabaseClient } from "@supabase/supabase-js";
import { complete, type ChatMessage } from "@/lib/llm";
import { ACTIVITY_TOOLS, chatTools, executeTool, parseArgs, type ToolContext } from "./tools";
import { chatSystemPrompt, loadAgentContext } from "./prompts";
import type { Message, Step } from "@/lib/types";
import { readDocument } from "@/lib/documents/store";
import { createAction } from "@/lib/actions";
import { supabaseActionStore } from "@/lib/actions-store";
import { wrapUntrusted } from "@/lib/web";

export type ChatEvent =
  | { t: "user"; id: string }
  | { t: "text"; d: string }
  | { t: "tool"; name: string }
  /** Nieuwe ronde na tool-calls: de tussentekst van de vorige ronde vervalt. */
  | { t: "reset" }
  | { t: "done"; id: string | null; text: string; meta: Message["meta"] }
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

const ATTACH_MAX_EACH = 25_000;
const ATTACH_MAX_TOTAL = 50_000;

/** Tekst van bijgevoegde documenten, als onbetrouwbare data achter het bericht. Langere stukken via document_read. */
async function attachedDocuments(db: SupabaseClient, userId: string, ids: string[]) {
  if (!ids.length) return "";
  let budget = ATTACH_MAX_TOTAL;
  const parts: string[] = [];
  for (const id of ids) {
    const doc = await readDocument(userId, id, 0, ATTACH_MAX_EACH, db).catch(() => null);
    if (!doc) continue;
    const text = String(doc.text ?? "").slice(0, Math.max(0, budget));
    budget -= text.length;
    parts.push(wrapUntrusted(`document:${doc.name}`, {
      id, name: doc.name, text,
      status: "status" in doc ? doc.status : "ready",
      note: "error" in doc && doc.error ? doc.error : undefined,
      more: "next_offset" in doc && doc.next_offset ? `nog meer tekst: document_read met offset ${doc.next_offset}` : undefined,
    }));
  }
  return parts.length ? `\n\n[Bijgevoegde documenten]\n${parts.join("\n")}` : "";
}

/** Eén chatbeurt: history laden, tool-loop draaien, tekst live streamen. */
export async function runChat(opts: {
  db: SupabaseClient;
  userId: string;
  userMessageId: string;
  userText: string;
  /** Bij dit bericht gevoegde documenten (al gecontroleerd: van deze gebruiker). */
  documentIds?: string[];
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
    { role: "user", content: opts.userText + (await attachedDocuments(db, userId, opts.documentIds ?? [])) },
  ];

  const toolCtx: ToolContext = { db, userId, taskId: null, origin: "chat", gmail: ctx.gmail, calendar: ctx.calendar, createdActionIds: [] };
  const activity = new ChatActivity(db, userId, opts.userText);
  const tools = chatTools(toolCtx);
  // Het antwoord is de tekst van de LAATSTE ronde. Modellen schrijven vaak al tekst vóór een tool-call
  // en herhalen die daarna; die tussentekst plakken we er dus niet voor (dat gaf dubbele antwoorden).
  let roundText = "";
  let interimText = "";

  try {
    for (let round = 0; round <= MAX_ROUNDS; round++) {
      const last = round === MAX_ROUNDS;
      roundText = "";
      const result = await complete({
        messages,
        tools,
        toolChoice: last ? "none" : "auto", // laatste ronde: afronden zonder tools
        userId,
        onText: (d) => {
          if (!roundText && interimText) send({ t: "reset" });
          roundText += d;
          send({ t: "text", d });
        },
      });

      // Opgeschoonde tekst van deze ronde (zonder redenering of dubbeling) i.p.v. de ruwe stream.
      if (roundText.trim() || result.content) roundText = result.content;
      if (!result.toolCalls.length || last) break;
      if (roundText.trim()) interimText = roundText;

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
    }
  } catch (e) {
    const text = roundText || interimText;
    await activity.finish({ text, actionIds: [], failed: "De chatbeurt is mislukt." });
    throw e;
  }

  // Gaf de laatste ronde geen tekst, dan blijft de tussentekst het antwoord.
  const text = roundText.trim() || interimText.trim();

  // Gevraagd om automatisch naar jezelf te mailen: één toestemmingskaart voor alle schema's van deze beurt.
  if (toolCtx.autoSendSchedules?.length && ctx.gmail.email) {
    const consent = await createAction(supabaseActionStore(db), {
      userId,
      taskId: null,
      type: "schedule_auto_send",
      payload: { to: ctx.gmail.email, schedules: toolCtx.autoSendSchedules },
    });
    if (consent.ok) toolCtx.createdActionIds.push(consent.action.id);
    else console.warn("[chat] toestemmingskaart maken mislukt:", consent.error);
  }
  await activity.finish({ text, actionIds: toolCtx.createdActionIds });

  const meta: Message["meta"] = toolCtx.createdActionIds.length
    ? { kind: "approval", action_ids: toolCtx.createdActionIds }
    : toolCtx.connectRequest
      ? { kind: "connect", provider: toolCtx.connectRequest }
      : null;

  return { text, createdTask: !!toolCtx.createdTask, meta };
}
