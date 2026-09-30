import type { SupabaseClient } from "@supabase/supabase-js";
import { chat, chatStream, type ChatMessage } from "@/lib/groq";
import { CHAT_TOOLS, executeTool, type ToolContext } from "./tools";
import { chatSystemPrompt, loadAgentContext } from "./prompts";

export type ChatEvent =
  | { t: "user"; id: string }
  | { t: "text"; d: string }
  | { t: "tool"; name: string }
  | { t: "done"; id: string | null }
  | { t: "error"; message: string };

const MAX_ROUNDS = 6;

/** Eén chatbeurt: history laden, tool-loop draaien, tekst live streamen. */
/**
 * Zet de opgeslagen berichten om naar model-history. Een gebruikersbericht zonder antwoord
 * (fout, dubbel verstuurd) krijgt een expliciete "geen antwoord"-regel, zodat het model het
 * oude verzoek niet alsnog oppakt in plaats van het nieuwe bericht te beantwoorden.
 */
function toHistory(rows: { role: string; content: string }[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of rows) {
    const prev = out[out.length - 1];
    if (m.role === "user") {
      if (prev?.role === "user") {
        out.push({ role: "assistant", content: "(Op dit bericht is geen antwoord gegeven. Niet meer oppakken tenzij de gebruiker erom vraagt.)" });
      }
      out.push({ role: "user", content: m.content });
    } else {
      out.push({ role: "assistant", content: m.content });
    }
  }
  return out;
}

export async function runChat(opts: {
  db: SupabaseClient;
  userId: string;
  userMessageId: string;
  userText: string;
  send: (e: ChatEvent) => void;
}): Promise<{ text: string; createdTask: boolean }> {
  const { db, userId, send } = opts;
  const ctx = await loadAgentContext(db, userId);

  const { data: history } = await db
    .from("dot_messages")
    .select("role, content")
    .eq("user_id", userId)
    .neq("id", opts.userMessageId)
    .order("created_at", { ascending: false })
    .limit(30);

  const past = toHistory(((history ?? []) as { role: string; content: string }[]).reverse());
  if (past[past.length - 1]?.role === "user") {
    past.push({ role: "assistant", content: "(Op dit bericht is geen antwoord gegeven. Niet meer oppakken tenzij de gebruiker erom vraagt.)" });
  }

  const messages: ChatMessage[] = [
    { role: "system", content: chatSystemPrompt(ctx) },
    ...past,
    // Het huidige bericht staat altijd als laatste, ook als de worker net iets heeft gepost.
    { role: "user", content: opts.userText },
  ];

  const toolCtx: ToolContext = { db, userId, taskId: null, origin: "chat" };
  let text = "";

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const result = await chatStream({ messages, tools: CHAT_TOOLS }, (d) => {
      text += d;
      send({ t: "text", d });
    });

    if (!result.toolCalls.length) return { text, createdTask: !!toolCtx.createdTask };

    messages.push({ role: "assistant", content: result.content || null, tool_calls: result.toolCalls });
    for (const call of result.toolCalls) {
      send({ t: "tool", name: call.function.name });
      const out = await executeTool(toolCtx, call.function.name, call.function.arguments);
      messages.push({ role: "tool", tool_call_id: call.id, content: out });
    }
    if (text && !text.endsWith("\n")) {
      text += "\n\n";
      send({ t: "text", d: "\n\n" });
    }
  }

  // Te veel tool-rondes: forceer een afsluitend antwoord zonder tools.
  const final = await chat({ messages, tools: CHAT_TOOLS, toolChoice: "none" });
  text += final.content;
  send({ t: "text", d: final.content });
  return { text, createdTask: !!toolCtx.createdTask };
}
