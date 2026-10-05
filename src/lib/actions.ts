// Pending actions: alles met extern effect loopt hierlangs (nu: mail versturen, afspraak inplannen).
// De goedkeuring wordt HIER in code afgedwongen, niet in de prompt:
//   - alleen approveAction() zet status op "approved", en die wordt alleen aangeroepen vanuit een
//     route met de sessie van de ingelogde gebruiker (een klik op Versturen/Inplannen);
//   - executePendingAction() voert alleen uit als de actie bij deze gebruiker hoort, "approved" is en
//     nog niet is uitgevoerd, en claimt de actie atomisch zodat hij nooit twee keer uitgevoerd wordt.
// Deze module praat niet rechtstreeks met Supabase (zie actions-store.ts), zodat hij testbaar is.

import { DateTime, IANAZone } from "luxon";
import { ConnectorError } from "@/lib/connectors/errors";

export type ActionStatus = "pending" | "approved" | "rejected" | "executed" | "expired";
export type ActionType = "gmail_send" | "calendar_create_event" | "schedule_auto_send";

/** Bijlage = een document van de gebruiker (alleen metadata; de inhoud wordt pas bij versturen geladen). */
export type Attachment = { document_id: string; name: string; mime: string; size: number };

export type EmailPayload = {
  to: string[];
  subject: string;
  body: string;
  gmail_draft_id?: string | null;
  attachments?: Attachment[];
};

export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

export type EventPayload = {
  summary: string;
  /** ISO 8601 met offset, bv. 2026-10-02T14:00:00.000+02:00 */
  start: string;
  end: string;
  time_zone: string;
  location?: string | null;
  description?: string | null;
  /** Genodigden krijgen pas een uitnodiging als de gebruiker op Inplannen klikt. */
  attendees?: string[];
};

/**
 * Eenmalige toestemming: vanuit deze schema's mag de dot voortaan zonder per-keer-goedkeuring mailen,
 * maar UITSLUITEND naar `to` (het eigen, via OAuth geverifieerde Gmail-adres van de gebruiker).
 */
export type AutoSendPayload = {
  to: string;
  schedules: { id: string; title: string; days: number[]; time_of_day: string; timezone: string }[];
};

type Base = {
  id: string;
  user_id: string;
  task_id: string | null;
  status: ActionStatus;
  error: string | null;
  result: Record<string, unknown> | null;
  created_at: string;
  decided_at: string | null;
  executed_at: string | null;
  /** "user" = klik op de kaart, "standing" = staande toestemming van een schema. */
  approved_by?: string | null;
};

export type PendingAction =
  | (Base & { type: "gmail_send"; payload: EmailPayload })
  | (Base & { type: "calendar_create_event"; payload: EventPayload })
  | (Base & { type: "schedule_auto_send"; payload: AutoSendPayload });

type AnyPayload = EmailPayload | EventPayload | AutoSendPayload;
type Patch = Partial<Omit<Base, "id" | "user_id">> & { payload?: AnyPayload };

export interface ActionStore {
  get(id: string, userId: string): Promise<PendingAction | null>;
  create(input: { userId: string; taskId: string | null; type: ActionType; payload: AnyPayload }): Promise<PendingAction>;
  /** Conditionele statusovergang (from → to). Geeft null als de actie niet (meer) in `from` stond. */
  transition(id: string, userId: string, from: ActionStatus, to: ActionStatus, patch?: Patch): Promise<PendingAction | null>;
  update(id: string, userId: string, patch: Patch): Promise<void>;
  countExecutedSince(userId: string, since: Date, type: ActionType): Promise<number>;
}

const num = (v: string | undefined, d: number) => (Number(v) > 0 ? Number(v) : d);

export function actionLimits() {
  return {
    maxPerDay: num(process.env.MAX_EMAILS_PER_DAY, 20),
    maxRecipients: num(process.env.MAX_RECIPIENTS_PER_EMAIL, 5),
    maxEventsPerDay: num(process.env.MAX_EVENTS_PER_DAY, 20),
  };
}

function dailyLimit(type: ActionType) {
  const l = actionLimits();
  return type === "gmail_send" ? l.maxPerDay : type === "calendar_create_event" ? l.maxEventsPerDay : 50;
}

const EMAIL_RE = /^[^\s@<>(),;:"\[\]]+@[^\s@<>(),;:"\[\]]+\.[a-z]{2,}$/i;

function parseAddresses(input: unknown) {
  const raw = Array.isArray(input) ? input : typeof input === "string" ? input.split(/[,;]/) : [];
  return [...new Set(raw.map((x) => String(x).trim()).filter(Boolean))];
}

// ───────────────────────────── Validatie ─────────────────────────────

export type Validation<T> = { ok: true; payload: T } | { ok: false; error: string };

export function validateEmailPayload(input: { to?: unknown; subject?: unknown; body?: unknown; gmail_draft_id?: unknown; attachments?: unknown }): Validation<EmailPayload> {
  const { maxRecipients } = actionLimits();
  const to = parseAddresses(input.to);
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

  const attachments: Attachment[] = Array.isArray(input.attachments)
    ? input.attachments
        .filter((a: any) => a && typeof a.document_id === "string" && typeof a.name === "string")
        .map((a: any) => ({
          document_id: a.document_id,
          name: String(a.name).replace(/[\r\n"\\]/g, "_").slice(0, 150),
          mime: typeof a.mime === "string" && /^[\w.+-]+\/[\w.+-]+$/.test(a.mime) ? a.mime : "application/octet-stream",
          size: Math.max(0, Number(a.size) || 0),
        }))
    : [];
  if (attachments.length > MAX_ATTACHMENTS) return { ok: false, error: `Maximaal ${MAX_ATTACHMENTS} bijlagen per mail.` };
  if (attachments.reduce((s, a) => s + a.size, 0) > MAX_ATTACHMENT_BYTES) return { ok: false, error: "Bijlagen samen mogen maximaal 15 MB zijn." };

  const gmailDraftId = typeof input.gmail_draft_id === "string" ? input.gmail_draft_id : null;
  return { ok: true, payload: { to, subject, body, gmail_draft_id: gmailDraftId, attachments } };
}

export function validateEventPayload(input: {
  summary?: unknown; start?: unknown; end?: unknown; time_zone?: unknown;
  location?: unknown; description?: unknown; attendees?: unknown;
}): Validation<EventPayload> {
  const { maxRecipients } = actionLimits();
  const summary = typeof input.summary === "string" ? input.summary.trim() : "";
  if (!summary) return { ok: false, error: "De afspraak heeft geen titel." };
  if (summary.length > 200 || /[\r\n]/.test(summary)) return { ok: false, error: "Ongeldige titel." };

  const tz = typeof input.time_zone === "string" && input.time_zone.trim() ? input.time_zone.trim() : "Europe/Amsterdam";
  if (!IANAZone.isValidZone(tz)) return { ok: false, error: "Onbekende tijdzone." };

  // Tijden zonder offset gelden in de opgegeven tijdzone.
  const parse = (v: unknown) => (typeof v === "string" ? DateTime.fromISO(v.trim(), { zone: tz }) : DateTime.invalid("leeg"));
  const start = parse(input.start);
  const end = parse(input.end);
  if (!start.isValid || !end.isValid) return { ok: false, error: "Ongeldige start- of eindtijd." };
  if (end.toMillis() <= start.toMillis()) return { ok: false, error: "De eindtijd moet na de starttijd liggen." };
  if (end.toMillis() - start.toMillis() > 14 * 86_400_000) return { ok: false, error: "Een afspraak mag maximaal 14 dagen duren." };

  const attendees = parseAddresses(input.attendees);
  if (attendees.length > maxRecipients) return { ok: false, error: `Maximaal ${maxRecipients} genodigden.` };
  const bad = attendees.find((a) => !EMAIL_RE.test(a));
  if (bad) return { ok: false, error: `Ongeldig e-mailadres: ${bad}` };

  const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
  return {
    ok: true,
    payload: {
      summary,
      start: start.toISO()!,
      end: end.toISO()!,
      time_zone: tz,
      location: text(input.location, 300),
      description: text(input.description, 5000),
      attendees,
    },
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateAutoSendPayload(input: { to?: unknown; schedules?: unknown }): Validation<AutoSendPayload> {
  const to = typeof input.to === "string" ? input.to.trim() : "";
  if (!EMAIL_RE.test(to)) return { ok: false, error: "Geen geldig eigen e-mailadres." };
  const schedules = Array.isArray(input.schedules)
    ? input.schedules
        .filter((s: any) => s && typeof s.id === "string" && UUID_RE.test(s.id))
        .map((s: any) => ({
          id: s.id,
          title: String(s.title ?? "Check-in").slice(0, 200),
          days: Array.isArray(s.days) ? s.days.map(Number).filter((d: number) => d >= 1 && d <= 7) : [],
          time_of_day: String(s.time_of_day ?? ""),
          timezone: String(s.timezone ?? "Europe/Amsterdam"),
        }))
    : [];
  if (!schedules.length || schedules.length > 10) return { ok: false, error: "Geen geldige schema's." };
  return { ok: true, payload: { to, schedules } };
}

export function validatePayload(type: ActionType, input: Record<string, unknown>): Validation<AnyPayload> {
  if (type === "gmail_send") return validateEmailPayload(input);
  if (type === "calendar_create_event") return validateEventPayload(input);
  return validateAutoSendPayload(input);
}

/** Velden die de gebruiker op de goedkeuringskaart mag aanpassen. */
const EDITABLE: Record<ActionType, string[]> = {
  gmail_send: ["to", "subject", "body"],
  calendar_create_event: ["summary", "start", "end", "location", "description", "attendees"],
  schedule_auto_send: [],
};

// ───────────────────────────── Levenscyclus ─────────────────────────────

export async function createAction(store: ActionStore, input: { userId: string; taskId: string | null; type: ActionType; payload: unknown }) {
  const v = validatePayload(input.type, (input.payload ?? {}) as Record<string, unknown>);
  if (!v.ok) return v;
  const action = await store.create({ userId: input.userId, taskId: input.taskId, type: input.type, payload: v.payload });
  return { ok: true as const, action };
}

export function createEmailAction(store: ActionStore, input: { userId: string; taskId: string | null; payload: unknown }) {
  return createAction(store, { ...input, type: "gmail_send" });
}

/** Alleen aan te roepen vanuit een route met de sessie van de ingelogde gebruiker (zijn klik). */
export async function approveAction(
  store: ActionStore,
  userId: string,
  id: string,
  edits?: Record<string, unknown>,
  now = new Date(),
) {
  const current = await store.get(id, userId);
  if (!current) return { ok: false as const, error: "Niet gevonden." };
  if (current.status !== "pending") return { ok: false as const, error: "Deze actie wacht niet (meer) op goedkeuring." };

  const merged: Record<string, unknown> = { ...current.payload };
  for (const key of EDITABLE[current.type]) {
    if (edits && edits[key] !== undefined) merged[key] = edits[key];
  }
  const v = validatePayload(current.type, merged);
  if (!v.ok) return v;

  const updated = await store.transition(id, userId, "pending", "approved", { payload: v.payload, decided_at: now.toISOString(), approved_by: "user" });
  if (!updated) return { ok: false as const, error: "Deze actie is intussen al afgehandeld." };
  return { ok: true as const, action: updated };
}

/**
 * Goedkeuring op basis van een staande toestemming (schema met auto_send). Alleen voor een mail die
 * UITSLUITEND naar het toegestane eigen adres gaat; alles anders blijft wachten op een klik.
 * De aanroeper (tools.ts) controleert dat de taak bij dat schema hoort en dat het adres het eigen Gmail-adres is.
 */
export async function approveByStandingPermission(store: ActionStore, userId: string, id: string, allowedTo: string, now = new Date()) {
  const current = await store.get(id, userId);
  if (!current || current.status !== "pending" || current.type !== "gmail_send") return false;
  const allowed = allowedTo.trim().toLowerCase();
  const to = current.payload.to.map((a) => a.trim().toLowerCase());
  if (!allowed || !to.length || to.some((a) => a !== allowed)) return false;
  const updated = await store.transition(id, userId, "pending", "approved", { decided_at: now.toISOString(), approved_by: "standing" });
  return !!updated;
}

export async function rejectAction(store: ActionStore, userId: string, id: string, now = new Date()) {
  const updated = await store.transition(id, userId, "pending", "rejected", { decided_at: now.toISOString() });
  return updated ? { ok: true as const, action: updated } : { ok: false as const, error: "Deze actie wacht niet (meer) op goedkeuring." };
}

// ───────────────────────────── Uitvoeren ─────────────────────────────

export type ExecCode =
  | "not_found" | "not_approved" | "already_executed" | "daily_limit" | "invalid"
  | "not_connected" | "needs_reauth" | "send_failed";

export type ExecResult =
  | { ok: true; action: PendingAction; externalId: string }
  | { ok: false; code: ExecCode; message: string };

export type ExecDeps = {
  store: ActionStore;
  getAccessToken: (userId: string, provider: "gmail" | "google_calendar") => Promise<string>;
  send: (token: string, payload: EmailPayload, files: { name: string; mime: string; data: Buffer }[]) => Promise<string>;
  /** Laadt de inhoud van een bijlage; alleen documenten van deze gebruiker. */
  loadAttachment?: (userId: string, documentId: string) => Promise<{ name: string; mime: string; data: Buffer }>;
  createEvent?: (token: string, payload: EventPayload) => Promise<string>;
  /** Zet auto_send aan op de schema's in de payload (alleen eigen schema's). Geeft het aantal terug. */
  grantAutoSend?: (userId: string, payload: AutoSendPayload) => Promise<number>;
  audit?: (entry: { userId: string; action: string; taskId: string | null; input: unknown; output?: unknown }) => Promise<void>;
  now?: () => Date;
};

export function startOfDay(now: Date) {
  return DateTime.fromJSDate(now).setZone("Europe/Amsterdam").startOf("day").toJSDate();
}

/** Type + payload, met behoud van de koppeling tussen beide (voor narrowing op `type`). */
export type ActionLike =
  | { type: "gmail_send"; payload: EmailPayload }
  | { type: "calendar_create_event"; payload: EventPayload }
  | { type: "schedule_auto_send"; payload: AutoSendPayload };

/** Korte, veilige omschrijving voor audit-log en taakresultaat (geen mailtekst). */
export function describeAction(a: ActionLike) {
  if (a.type === "gmail_send") {
    const n = a.payload.attachments?.length ?? 0;
    return `mail aan ${a.payload.to.join(", ")}, onderwerp "${a.payload.subject}"${n ? ` (${n} bijlage${n === 1 ? "" : "n"})` : ""}`;
  }
  if (a.type === "schedule_auto_send") {
    const times = a.payload.schedules.map((s) => s.time_of_day).join(" en ");
    return `toestemming om om ${times} automatisch te mailen naar ${a.payload.to}`;
  }
  const when = DateTime.fromISO(a.payload.start, { zone: a.payload.time_zone }).setLocale("nl").toFormat("ccc d LLL HH:mm");
  return `afspraak "${a.payload.summary}" op ${when}`;
}

const fail = (code: ExecCode, message: string): ExecResult => ({ ok: false, code, message });

/** Voert een goedgekeurde actie uit. De ENIGE plek in de app die een mail verstuurt of afspraak maakt. */
export async function executePendingAction(deps: ExecDeps, userId: string, actionId: string): Promise<ExecResult> {
  const now = deps.now?.() ?? new Date();
  const action = await deps.store.get(actionId, userId);
  if (!action) return fail("not_found", "Deze actie bestaat niet of hoort niet bij jou.");
  const noun = action.type === "gmail_send" ? "mail" : action.type === "calendar_create_event" ? "afspraak" : "toestemming";
  if (action.status === "executed") return fail("already_executed", `Deze ${noun} is al uitgevoerd.`);
  if (action.status !== "approved") {
    return fail("not_approved", `Deze ${noun} is niet goedgekeurd. Alleen de gebruiker kan goedkeuren via de knop op de kaart.`);
  }

  const v = validatePayload(action.type, action.payload as Record<string, unknown>);
  if (!v.ok) return fail("invalid", v.error);

  const limit = dailyLimit(action.type);
  const doneToday = await deps.store.countExecutedSince(userId, startOfDay(now), action.type);
  if (doneToday >= limit) return fail("daily_limit", `Het daglimiet van ${limit} is bereikt.`);

  // Atomisch claimen: approved → executed. Een tweede gelijktijdige poging krijgt null.
  const claimed = await deps.store.transition(actionId, userId, "approved", "executed", { executed_at: now.toISOString(), error: null });
  if (!claimed) return fail("already_executed", `Deze ${noun} wordt al uitgevoerd of is al uitgevoerd.`);

  try {
    let externalId: string;
    if (action.type === "gmail_send") {
      const mail = v.payload as EmailPayload;
      const files = [];
      for (const a of mail.attachments ?? []) {
        if (!deps.loadAttachment) throw new ConnectorError("config", "geen loadAttachment");
        files.push(await deps.loadAttachment(userId, a.document_id));
      }
      if (files.reduce((s, f) => s + f.data.length, 0) > MAX_ATTACHMENT_BYTES) throw new Error("Bijlagen zijn te groot");
      const token = await deps.getAccessToken(userId, "gmail");
      externalId = await deps.send(token, mail, files);
    } else if (action.type === "schedule_auto_send") {
      if (!deps.grantAutoSend) throw new ConnectorError("config", "geen grantAutoSend");
      const n = await deps.grantAutoSend(userId, v.payload as AutoSendPayload);
      if (!n) throw new Error("Geen van de schema's gevonden");
      externalId = `${n} schema's`;
    } else {
      if (!deps.createEvent) throw new ConnectorError("config", "geen createEvent");
      const token = await deps.getAccessToken(userId, "google_calendar");
      externalId = await deps.createEvent(token, v.payload as EventPayload);
    }
    const result = action.type === "gmail_send" ? { gmail_message_id: externalId } : action.type === "calendar_create_event" ? { calendar_event_id: externalId } : { granted: externalId };
    await deps.store.update(actionId, userId, { result });
    await deps.audit?.({
      userId,
      action: action.type === "gmail_send" ? "email_sent" : action.type === "calendar_create_event" ? "calendar_event_created" : "auto_send_granted",
      taskId: action.task_id,
      input: action.type === "gmail_send"
        ? {
            to: (v.payload as EmailPayload).to, subject: (v.payload as EmailPayload).subject,
            attachments: ((v.payload as EmailPayload).attachments ?? []).map((a) => a.name),
            approved_by: claimed.approved_by ?? "user", sent_at: now.toISOString(),
          }
        : action.type === "calendar_create_event"
          ? { summary: (v.payload as EventPayload).summary, start: (v.payload as EventPayload).start, attendees: (v.payload as EventPayload).attendees, created_at: now.toISOString() }
          : { to: (v.payload as AutoSendPayload).to, schedules: (v.payload as AutoSendPayload).schedules.map((s) => `${s.title} ${s.time_of_day}`), granted_at: now.toISOString() },
    });
    return { ok: true, action: { ...claimed, result } as PendingAction, externalId };
  } catch (e) {
    const code: ExecCode = e instanceof ConnectorError
      ? e.code === "needs_reauth" ? "needs_reauth" : e.code === "not_connected" ? "not_connected" : "send_failed"
      : "send_failed";
    const message = e instanceof ConnectorError ? e.message : "Uitvoeren is mislukt. Probeer het opnieuw.";
    // Terug naar approved, zodat de gebruiker het opnieuw kan proberen (bv. na opnieuw verbinden).
    await deps.store.transition(actionId, userId, "executed", "approved", { executed_at: null, error: message });
    console.error(`[actions] uitvoeren ${actionId} mislukt: ${e instanceof ConnectorError ? e.detail || e.code : String(e)}`);
    return fail(code, message);
  }
}
