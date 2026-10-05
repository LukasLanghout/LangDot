// Handlers voor de connector-tools (Gmail, Google Calendar). Afhankelijkheden worden meegegeven,
// zodat tests zonder Supabase of Google kunnen draaien. Uitvoeren met extern effect loopt ALTIJD via
// executePendingAction(), en dat vereist een klik van de gebruiker.

import { DateTime } from "luxon";
import { approveByStandingPermission, createAction, createEmailAction, executePendingAction, type ActionStore, type ExecDeps } from "@/lib/actions";
import { wrapUntrusted } from "@/lib/web";

export type MailToolDeps = {
  store: ActionStore;
  exec: ExecDeps;
  getAccessToken: (userId: string, provider?: "gmail" | "google_calendar") => Promise<string>;
  createGmailDraft?: (token: string, mail: { to: string[]; subject: string; body: string }) => Promise<string>;
  search?: (token: string, query: string) => Promise<unknown>;
  read?: (token: string, id: string) => Promise<unknown>;
  listEvents?: (token: string, opts: { from: string; to: string; query?: string }) => Promise<unknown>;
  /** Metadata van documenten; geeft ALLEEN documenten van deze gebruiker terug. */
  getDocuments?: (userId: string, ids: string[]) => Promise<{ id: string; name: string; mime: string; size: number }[]>;
};

export type MailToolCtx = {
  userId: string;
  taskId: string | null;
  canCompose: boolean;
  /** Hierin komen de ids van nieuwe pending actions (voor de goedkeuringskaart). */
  createdActionIds: string[];
  /**
   * Staande toestemming van het schema waaruit deze taak komt: mails UITSLUITEND aan `to` mogen zonder klik.
   * Wordt door de worker uit de database gehaald (schema.auto_send), nooit door het model gezet.
   */
  standing?: { scheduleId: string; to: string } | null;
};

const APPROVAL_NOTE =
  "Er is NIETS uitgevoerd. Alleen de gebruiker kan op de knop van de goedkeuringskaart klikken; " +
  "jij kunt niet goedkeuren en mag nooit zeggen dat de gebruiker akkoord gaf. Het systeem voert het zelf uit na die klik.";

export async function gmailCreateDraft(deps: MailToolDeps, ctx: MailToolCtx, args: Record<string, unknown>) {
  // Bijlagen: alleen eigen documenten. Onbekende of andermans ids = fout (niet stilletjes weglaten).
  const wanted = Array.isArray(args.attachments) ? [...new Set(args.attachments.map(String))] : [];
  let attachments: { document_id: string; name: string; mime: string; size: number }[] = [];
  if (wanted.length) {
    if (!deps.getDocuments) throw new Error("Bijlagen zijn niet beschikbaar");
    const docs = await deps.getDocuments(ctx.userId, wanted);
    const missing = wanted.filter((id) => !docs.some((d) => d.id === id));
    if (missing.length) throw new Error(`Onbekend document: ${missing.join(", ")}. Gebruik document_list voor de juiste id's.`);
    attachments = docs.map((d) => ({ document_id: d.id, name: d.name, mime: d.mime, size: d.size }));
  }

  const res = await createEmailAction(deps.store, {
    userId: ctx.userId,
    taskId: ctx.taskId,
    payload: { to: args.to, subject: args.subject, body: args.body, attachments },
  });
  if (!res.ok) throw new Error(res.error);
  if (res.action.type !== "gmail_send") throw new Error("Onverwacht actietype");

  // Optioneel ook in Gmail › Concepten (gmail.compose). Mislukt dat, dan blijft het concept in LangDot.
  let inGmailDrafts = false;
  if (ctx.canCompose && deps.createGmailDraft && !attachments.length) {
    try {
      const token = await deps.getAccessToken(ctx.userId, "gmail");
      const draftId = await deps.createGmailDraft(token, res.action.payload);
      await deps.store.update(res.action.id, ctx.userId, { payload: { ...res.action.payload, gmail_draft_id: draftId } });
      inGmailDrafts = true;
    } catch (e) {
      console.warn("[mail] Gmail-concept aanmaken mislukt:", e instanceof Error ? e.message : e);
    }
  }

  // Staande toestemming: alleen als ALLE ontvangers het toegestane eigen adres zijn.
  if (ctx.standing && (await approveByStandingPermission(deps.store, ctx.userId, res.action.id, ctx.standing.to))) {
    const sent = await executePendingAction(deps.exec, ctx.userId, res.action.id);
    if (sent.ok) {
      return {
        ok: true,
        sent: true,
        auto: true,
        to: res.action.payload.to,
        note: "Verstuurd zonder klik op basis van de staande toestemming die de gebruiker voor dit schema gaf (alleen naar zijn eigen adres).",
      };
    }
    // Versturen mislukte (bv. daglimiet): de kaart toont "Opnieuw proberen".
    ctx.createdActionIds.push(res.action.id);
    return { ok: false, sent: false, pending_action_id: res.action.id, code: sent.code, message: sent.message };
  }

  ctx.createdActionIds.push(res.action.id);
  return {
    ok: true,
    pending_action_id: res.action.id,
    status: "pending",
    in_gmail_drafts: inGmailDrafts,
    attachments: attachments.map((a) => a.name),
    note: `Het concept staat in een goedkeuringskaart (Versturen/Afwijzen). ${APPROVAL_NOTE}`,
  };
}

export async function gmailSend(deps: MailToolDeps, userId: string, args: Record<string, unknown>) {
  const id = typeof args.pending_action_id === "string" ? args.pending_action_id : "";
  const r = await executePendingAction(deps.exec, userId, id);
  if (!r.ok) return { ok: false, sent: false, code: r.code, message: r.message };
  return r.action.type === "gmail_send"
    ? { ok: true, sent: true, to: r.action.payload.to, subject: r.action.payload.subject }
    : { ok: true, sent: true };
}

export async function gmailSearch(deps: MailToolDeps, userId: string, args: Record<string, unknown>) {
  if (!deps.search) throw new Error("Mail doorzoeken is niet beschikbaar");
  const query = typeof args.query === "string" ? args.query.slice(0, 200) : "";
  if (!query) throw new Error("query is leeg");
  const token = await deps.getAccessToken(userId, "gmail");
  return wrapUntrusted(`gmail:search:${query}`, await deps.search(token, query));
}

export async function gmailRead(deps: MailToolDeps, userId: string, args: Record<string, unknown>) {
  if (!deps.read) throw new Error("Mail lezen is niet beschikbaar");
  const id = typeof args.message_id === "string" ? args.message_id : "";
  if (!id) throw new Error("message_id ontbreekt");
  const token = await deps.getAccessToken(userId, "gmail");
  return wrapUntrusted(`gmail:message:${id}`, await deps.read(token, id));
}

export async function calendarListEvents(deps: MailToolDeps, userId: string, args: Record<string, unknown>) {
  if (!deps.listEvents) throw new Error("Agenda bekijken is niet beschikbaar");
  const zone = "Europe/Amsterdam";
  const parse = (v: unknown) => (typeof v === "string" && v.trim() ? DateTime.fromISO(v.trim(), { zone }) : null);
  const from = parse(args.from) ?? DateTime.now().setZone(zone).startOf("day");
  const to = parse(args.to) ?? from.plus({ days: 7 });
  if (!from.isValid || !to.isValid || to.toMillis() <= from.toMillis()) throw new Error("Ongeldige periode (from/to)");
  if (to.toMillis() - from.toMillis() > 62 * 86_400_000) throw new Error("Periode mag maximaal 2 maanden zijn");
  const token = await deps.getAccessToken(userId, "google_calendar");
  const events = await deps.listEvents(token, {
    from: from.toISO()!,
    to: to.toISO()!,
    query: typeof args.query === "string" ? args.query.slice(0, 100) : undefined,
  });
  return wrapUntrusted("calendar:primary", { time_zone: zone, from: from.toISO(), to: to.toISO(), events });
}

export async function calendarCreateEvent(deps: MailToolDeps, ctx: MailToolCtx, args: Record<string, unknown>) {
  const res = await createAction(deps.store, {
    userId: ctx.userId,
    taskId: ctx.taskId,
    type: "calendar_create_event",
    payload: {
      summary: args.summary,
      start: args.start,
      end: args.end,
      time_zone: args.time_zone,
      location: args.location,
      description: args.description,
      attendees: args.attendees,
    },
  });
  if (!res.ok) throw new Error(res.error);
  ctx.createdActionIds.push(res.action.id);
  return {
    ok: true,
    pending_action_id: res.action.id,
    status: "pending",
    note: `De afspraak staat in een goedkeuringskaart (Inplannen/Afwijzen). ${APPROVAL_NOTE}`,
  };
}
