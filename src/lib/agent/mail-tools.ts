// Handlers voor de Gmail-tools. Afhankelijkheden worden meegegeven, zodat tests zonder
// Supabase of Google kunnen draaien. Versturen loopt ALTIJD via executePendingAction().

import { createEmailAction, executePendingAction, type ActionStore, type ExecDeps } from "@/lib/actions";
import { wrapUntrusted } from "@/lib/web";

export type MailToolDeps = {
  store: ActionStore;
  exec: ExecDeps;
  getAccessToken: (userId: string) => Promise<string>;
  createGmailDraft?: (token: string, mail: { to: string[]; subject: string; body: string }) => Promise<string>;
  search?: (token: string, query: string) => Promise<unknown>;
  read?: (token: string, id: string) => Promise<unknown>;
};

export type MailToolCtx = {
  userId: string;
  taskId: string | null;
  canCompose: boolean;
  /** Hierin komen de ids van nieuwe pending actions (voor de goedkeuringskaart). */
  createdActionIds: string[];
};

export async function gmailCreateDraft(deps: MailToolDeps, ctx: MailToolCtx, args: Record<string, unknown>) {
  const res = await createEmailAction(deps.store, {
    userId: ctx.userId,
    taskId: ctx.taskId,
    payload: { to: args.to, subject: args.subject, body: args.body },
  });
  if (!res.ok) throw new Error(res.error);

  // Optioneel ook in Gmail › Concepten (gmail.compose). Mislukt dat, dan blijft het concept in LangDot.
  let inGmailDrafts = false;
  if (ctx.canCompose && deps.createGmailDraft) {
    try {
      const token = await deps.getAccessToken(ctx.userId);
      const draftId = await deps.createGmailDraft(token, res.action.payload);
      await deps.store.update(res.action.id, ctx.userId, { payload: { ...res.action.payload, gmail_draft_id: draftId } });
      inGmailDrafts = true;
    } catch (e) {
      console.warn("[mail] Gmail-concept aanmaken mislukt:", e instanceof Error ? e.message : e);
    }
  }

  ctx.createdActionIds.push(res.action.id);
  return {
    ok: true,
    pending_action_id: res.action.id,
    status: "pending",
    in_gmail_drafts: inGmailDrafts,
    note:
      "Het concept staat in een goedkeuringskaart. Er is NIETS verstuurd. Alleen de gebruiker kan op Versturen klikken; " +
      "jij kunt niet goedkeuren en mag nooit zeggen dat de gebruiker akkoord gaf. Het systeem verstuurt de mail zelf na die klik.",
  };
}

export async function gmailSend(deps: MailToolDeps, userId: string, args: Record<string, unknown>) {
  const id = typeof args.pending_action_id === "string" ? args.pending_action_id : "";
  const r = await executePendingAction(deps.exec, userId, id);
  if (r.ok) return { ok: true, sent: true, to: r.action.payload.to, subject: r.action.payload.subject };
  return { ok: false, sent: false, code: r.code, message: r.message };
}

export async function gmailSearch(deps: MailToolDeps, userId: string, args: Record<string, unknown>) {
  if (!deps.search) throw new Error("Mail doorzoeken is niet beschikbaar");
  const query = typeof args.query === "string" ? args.query.slice(0, 200) : "";
  if (!query) throw new Error("query is leeg");
  const token = await deps.getAccessToken(userId);
  return wrapUntrusted(`gmail:search:${query}`, await deps.search(token, query));
}

export async function gmailRead(deps: MailToolDeps, userId: string, args: Record<string, unknown>) {
  if (!deps.read) throw new Error("Mail lezen is niet beschikbaar");
  const id = typeof args.message_id === "string" ? args.message_id : "";
  if (!id) throw new Error("message_id ontbreekt");
  const token = await deps.getAccessToken(userId);
  return wrapUntrusted(`gmail:message:${id}`, await deps.read(token, id));
}
