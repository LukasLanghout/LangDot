import { after } from "next/server";
import { getUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runChat, type ChatEvent } from "@/lib/agent/chat";
import { runWorker } from "@/lib/agent/worker";
import { logAudit } from "@/lib/audit";
import { LlmError, userSafeMessage } from "@/lib/llm-errors";
import { getDocuments } from "@/lib/documents/store";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  const started = Date.now();
  const user = await getUser();
  if (!user) return Response.json({ error: "Niet ingelogd" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const requestedDocs: string[] = Array.isArray(body?.document_ids) ? body.document_ids.map(String).slice(0, 5) : [];
  const db = createAdminClient();
  // Alleen eigen documenten; andermans of onbekende id's vallen weg.
  const docs = requestedDocs.length ? await getDocuments(user.id, requestedDocs, db) : [];
  const typed = typeof body?.message === "string" ? body.message.trim().slice(0, 4000) : "";
  const message = typed || (docs.length ? "Bekijk de bijgevoegde documenten." : "");
  if (!message) return Response.json({ error: "Leeg bericht" }, { status: 400 });

  const { data: saved, error } = await db
    .from("dot_messages")
    .insert({
      user_id: user.id,
      role: "user",
      content: message,
      meta: docs.length ? { documents: docs.map((d) => ({ id: d.id, name: d.name })) } : {},
    })
    .select("id")
    .single();
  if (error) {
    console.error("[chat] bericht opslaan mislukt", error.message);
    return Response.json({ error: "Je bericht kon niet worden opgeslagen." }, { status: 500 });
  }
  await logAudit(db, { userId: user.id, actor: "user", action: "chat_message", input: message.slice(0, 500) });

  // Na de chat (en na het sluiten van de stream) de worker aftrappen als er een taak is aangemaakt.
  let resolveDone: (createdTask: boolean) => void = () => {};
  const chatDone = new Promise<boolean>((r) => (resolveDone = r));
  after(async () => {
    if (await chatDone) await runWorker({ userId: user.id, deadline: started + 55_000 });
  });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: ChatEvent) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
        } catch {
          // Client is weg; we maken het antwoord toch af en slaan het op.
        }
      };
      send({ t: "user", id: saved.id });
      let createdTask = false;
      try {
        const result = await runChat({ db, userId: user.id, userMessageId: saved.id, userText: message, documentIds: docs.map((d) => d.id), signal: req.signal, send });
        createdTask = result.createdTask;
        const text = result.text.trim() || "…";
        const { data: reply } = await db
          .from("dot_messages")
          .insert({ user_id: user.id, role: "assistant", content: text, reply_to: saved.id, meta: result.meta ?? {} })
          .select("id")
          .single();
        send({ t: "done", id: reply?.id ?? null, text, meta: result.meta });
      } catch (e) {
        if (req.signal.aborted) {
          // De gebruiker drukte op Stop: geen fout, wel een nette afsluiting zodat vraag en antwoord gepaard blijven.
          await db.from("dot_messages").insert({ user_id: user.id, role: "assistant", content: "Gestopt op jouw verzoek.", reply_to: saved.id, meta: {} });
          return;
        }
        // Details alleen in de serverlog; de gebruiker krijgt een nette melding zonder API-fouten of modelnamen.
        console.error("[chat] mislukt:", e instanceof LlmError ? `${e.kind}: ${e.detail}` : e);
        const safe = userSafeMessage(e);
        send({ t: "error", message: safe });
        // Ook een mislukt antwoord opslaan, zodat vraag en antwoord in de history gepaard blijven.
        await db.from("dot_messages").insert({
          user_id: user.id,
          role: "assistant",
          content: `⚠ ${safe}`,
          reply_to: saved.id,
          meta: { kind: "error" },
        });
      } finally {
        try {
          controller.close();
        } catch {
          /* al gesloten */
        }
        resolveDone(createdTask);
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache, no-transform" },
  });
}
