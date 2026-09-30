// Pending actions: alles met extern effect (nu: een mail versturen) loopt hierlangs.
// De goedkeuring wordt HIER in code afgedwongen, niet in de prompt:
//   - alleen approveAction() zet status op "approved", en die wordt alleen aangeroepen vanuit een
//     route met de sessie van de ingelogde gebruiker (een klik op "Versturen");
//   - executePendingAction() verstuurt alleen als de actie bij deze gebruiker hoort, "approved" is en
//     nog niet is uitgevoerd, en claimt de actie atomisch zodat hij nooit twee keer verstuurd wordt.
// Deze module praat niet rechtstreeks met Supabase (zie actions-store.ts), zodat hij testbaar is.

import { DateTime } from "luxon";
import { ConnectorError } from "@/lib/connectors/errors";

export type ActionStatus = "pending" | "approved" | "rejected" | "executed" | "expired";

export type EmailPayload = { to: string[]; subject: string; body: string; gmail_draft_id?: string | null };

export type PendingAction = {
  id: string;
  user_id: string;
  task_id: string | null;
  type: "gmail_send";
  payload: EmailPayload;
  status: ActionStatus;
  error: string | null;
  result: Record<string, unknown> | null;
  created_at: string;
  decided_at: string | null;
  executed_at: string | null;
};

export interface ActionStore {
  get(id: string, userId: string): Promise<PendingAction | null>;
  create(input: { userId: string; taskId: string | null; payload: EmailPayload }): Promise<PendingAction>;
  /** Conditionele statusovergang (from → to). Geeft null als de actie niet (meer) in `from` stond. */
  transition(id: string, userId: string, from: ActionStatus, to: ActionStatus, patch?: Partial<PendingAction>): Promise<PendingAction | null>;
  update(id: string, userId: string, patch: Partial<PendingAction>): Promise<void>;
  countExecutedSince(userId: string, since: Date): Promise<number>;
}

export function actionLimits() {
  const num = (v: string | undefined, d: number) => (Number(v) > 0 ? Number(v) : d);
  return {
    maxPerDay: num(process.env.MAX_EMAILS_PER_DAY, 20),
    maxRecipients: num(process.env.MAX_RECIPIENTS_PER_EMAIL, 5),
  };
}

const EMAIL_RE = /^[^\s@<>(),;:"\[\]]+@[^\s@<>(),;:"\[\]]+\.[a-z]{2,}$/i;

export type Validation = { ok: true; payload: EmailPayload } | { ok: false; error: string };

export function validateEmailPayload(input: { to?: unknown; subject?: unknown; body?: unknown; gmail_draft_id?: unknown }): Validation {
  const { maxRecipients } = actionLimits();
  const rawTo = Array.isArray(input.to) ? input.to : typeof input.to === "string" ? input.to.split(/[,;]/) : [];
  const to = [...new Set(rawTo.map((x) => String(x).trim()).filter(Boolean))];
  if (!to.length) return { ok: false, error: "Geen ontvanger opgegeven." };
  if (to.length > maxRecipients) return { ok: false, error: `Maximaal ${maxRecipients} ontvangers per mail.` };
  const bad = to.find((a) => !EMAIL_RE.test(a));
  if (bad) return { ok: false, error: `Ongeldig e-mailadres: ${bad}` };

  const subject = typeof input.subject === "string" ? input.subject.trim() : "";
  if (/[\r\n]/.test(subject)) return { ok: false, error: "Onderwerp mag geen regeleinde bevatten." };
  if (subject.length > 250) return { ok: false, error: "Onderwerp is te lang." };

  const body = typeof input.body === "string" ? input.body.replace(/\r\n/g, "\n").trim() : "";
  if (!body) return { ok: false, error: "De mail heeft geen tekst." };
  if (body.length > 20_000) return { ok: false, error: "De mail is te lang." };

  const gmailDraftId = typeof input.gmail_draft_id === "string" ? input.gmail_draft_id : null;
  return { ok: true, payload: { to, subject, body, gmail_draft_id: gmailDraftId } };
}

export async function createEmailAction(store: ActionStore, input: { userId: string; taskId: string | null; payload: unknown }) {
  const v = validateEmailPayload((input.payload ?? {}) as Record<string, unknown>);
  if (!v.ok) return v;
  const action = await store.create({ userId: input.userId, taskId: input.taskId, payload: v.payload });
  return { ok: true as const, action };
}

/** Alleen aan te roepen vanuit een route met de sessie van de ingelogde gebruiker (zijn klik). */
export async function approveAction(
  store: ActionStore,
  userId: string,
  id: string,
  edits?: { to?: unknown; subject?: unknown; body?: unknown },
  now = new Date(),
) {
  const current = await store.get(id, userId);
  if (!current) return { ok: false as const, error: "Niet gevonden." };
  if (current.status !== "pending") return { ok: false as const, error: "Deze actie wacht niet (meer) op goedkeuring." };
  const v = validateEmailPayload({
    to: edits?.to ?? current.payload.to,
    subject: edits?.subject ?? current.payload.subject,
    body: edits?.body ?? current.payload.body,
    gmail_draft_id: current.payload.gmail_draft_id,
  });
  if (!v.ok) return v;
  const updated = await store.transition(id, userId, "pending", "approved", { payload: v.payload, decided_at: now.toISOString() });
  if (!updated) return { ok: false as const, error: "Deze actie is intussen al afgehandeld." };
  return { ok: true as const, action: updated };
}

export async function rejectAction(store: ActionStore, userId: string, id: string, now = new Date()) {
  const updated = await store.transition(id, userId, "pending", "rejected", { decided_at: now.toISOString() });
  return updated ? { ok: true as const, action: updated } : { ok: false as const, error: "Deze actie wacht niet (meer) op goedkeuring." };
}

export type ExecCode =
  | "not_found" | "not_approved" | "already_executed" | "daily_limit" | "invalid"
  | "not_connected" | "needs_reauth" | "send_failed";

export type ExecResult =
  | { ok: true; action: PendingAction; messageId: string }
  | { ok: false; code: ExecCode; message: string };

export type ExecDeps = {
  store: ActionStore;
  getAccessToken: (userId: string) => Promise<string>;
  send: (token: string, payload: EmailPayload) => Promise<string>;
  audit?: (entry: { userId: string; action: string; taskId: string | null; input: unknown; output?: unknown }) => Promise<void>;
  now?: () => Date;
};

export function startOfDay(now: Date) {
  return DateTime.fromJSDate(now).setZone("Europe/Amsterdam").startOf("day").toJSDate();
}

const fail = (code: ExecCode, message: string): ExecResult => ({ ok: false, code, message });

/** Verstuurt een goedgekeurde actie. De ENIGE plek in de app die een mail verstuurt. */
export async function executePendingAction(deps: ExecDeps, userId: string, actionId: string): Promise<ExecResult> {
  const now = deps.now?.() ?? new Date();
  const action = await deps.store.get(actionId, userId);
  if (!action) return fail("not_found", "Deze actie bestaat niet of hoort niet bij jou.");
  if (action.status === "executed") return fail("already_executed", "Deze mail is al verstuurd.");
  if (action.status !== "approved") {
    return fail("not_approved", "Deze mail is niet goedgekeurd. Alleen de gebruiker kan goedkeuren via de knop Versturen.");
  }

  const v = validateEmailPayload(action.payload);
  if (!v.ok) return fail("invalid", v.error);

  const { maxPerDay } = actionLimits();
  const sentToday = await deps.store.countExecutedSince(userId, startOfDay(now));
  if (sentToday >= maxPerDay) return fail("daily_limit", `Het daglimiet van ${maxPerDay} verstuurde mails is bereikt.`);

  // Atomisch claimen: approved → executed. Een tweede gelijktijdige poging krijgt null.
  const claimed = await deps.store.transition(actionId, userId, "approved", "executed", { executed_at: now.toISOString(), error: null });
  if (!claimed) return fail("already_executed", "Deze mail wordt al verstuurd of is al verstuurd.");

  try {
    const token = await deps.getAccessToken(userId);
    const messageId = await deps.send(token, v.payload);
    await deps.store.update(actionId, userId, { result: { gmail_message_id: messageId } });
    await deps.audit?.({
      userId,
      action: "email_sent",
      taskId: action.task_id,
      input: { to: v.payload.to, subject: v.payload.subject, sent_at: now.toISOString() },
    });
    return { ok: true, action: { ...claimed, result: { gmail_message_id: messageId } }, messageId };
  } catch (e) {
    const code: ExecCode = e instanceof ConnectorError
      ? e.code === "needs_reauth" ? "needs_reauth" : e.code === "not_connected" ? "not_connected" : "send_failed"
      : "send_failed";
    const message = e instanceof ConnectorError ? e.message : "Versturen is mislukt. Probeer het opnieuw.";
    // Terug naar approved, zodat de gebruiker het opnieuw kan proberen (bv. na opnieuw verbinden).
    await deps.store.transition(actionId, userId, "executed", "approved", { executed_at: null, error: message });
    console.error(`[actions] versturen ${actionId} mislukt: ${e instanceof ConnectorError ? e.detail || e.code : String(e)}`);
    return fail(code, message);
  }
}
