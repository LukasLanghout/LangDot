import { after } from "next/server";
import { getUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runChat, type ChatEvent } from "@/lib/agent/chat";
import { runWorker } from "@/lib/agent/worker";
import { logAudit } from "@/lib/audit";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  const started = Date.now();
  const user = await getUser();
  if (!user) return Response.json({ error: "Niet ingelogd" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const message = typeof body?.message === "string" ? body.message.trim().slice(0, 4000) : "";
  if (!message) return Response.json({ error: "Leeg bericht" }, { status: 400 });

  const db = createAdminClient();
  const { data: saved, error } = await db
    .from("dot_messages")
    .insert({ user_id: user.id, role: "user", content: message })
    .select("id")
    .single();
  if (error) return Response.json({ error: error.message }, { status: 500 });
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
        const result = await runChat({ db, userId: user.id, send });
        createdTask = result.createdTask;
        const text = result.text.trim() || "…";
        const { data: reply } = await db
          .from("dot_messages")
          .insert({ user_id: user.id, role: "assistant", content: text })
          .select("id")
          .single();
        send({ t: "done", id: reply?.id ?? null });
      } catch (e) {
        console.error("chat failed", e);
        send({ t: "error", message: e instanceof Error ? e.message : "Er ging iets mis" });
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
