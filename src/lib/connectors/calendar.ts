// Google Calendar REST API (scope calendar.events). Alleen serverside.

import { ConnectorError } from "./errors";
import type { EventPayload } from "@/lib/actions";

const API = "https://www.googleapis.com/calendar/v3";

async function calFetch(token: string, path: string, init: { method?: string; body?: string } = {}) {
  const res = await fetch(`${API}${path}`, {
    method: init.method ?? "GET",
    body: init.body,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (res.status === 401) throw new ConnectorError("needs_reauth", "calendar 401");
  if (!res.ok) {
    const json = await res.json().catch(() => null);
    // Reden van Google (bv. accessNotConfigured = Calendar API staat uit, insufficientPermissions = scope ontbreekt).
    const reason = json?.error?.errors?.[0]?.reason ?? json?.error?.status ?? "";
    throw new ConnectorError("provider_error", `calendar ${res.status} ${reason}`);
  }
  return res.status === 204 ? null : res.json();
}

export type CalendarEventSummary = {
  id: string;
  summary: string;
  start: string;
  end: string;
  all_day: boolean;
  location: string | null;
  attendees: number;
  status: string;
};

/** Afspraken in de primaire agenda tussen `from` en `to` (ISO). */
export async function listCalendarEvents(token: string, opts: { from: string; to: string; query?: string; max?: number }) {
  const params = new URLSearchParams({
    timeMin: opts.from,
    timeMax: opts.to,
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: String(Math.min(opts.max ?? 25, 50)),
  });
  if (opts.query) params.set("q", opts.query);
  const json = await calFetch(token, `/calendars/primary/events?${params}`);
  return ((json?.items ?? []) as any[]).map((e): CalendarEventSummary => ({
    id: String(e.id),
    summary: String(e.summary ?? "(geen titel)"),
    start: String(e.start?.dateTime ?? e.start?.date ?? ""),
    end: String(e.end?.dateTime ?? e.end?.date ?? ""),
    all_day: !e.start?.dateTime,
    location: e.location ? String(e.location) : null,
    attendees: Array.isArray(e.attendees) ? e.attendees.length : 0,
    status: String(e.status ?? ""),
  }));
}

/**
 * Maakt een afspraak in de primaire agenda. Alleen aangeroepen vanuit executePendingAction(),
 * dus pas na de klik van de gebruiker. Met genodigden verstuurt Google de uitnodigingen.
 */
export async function createCalendarEvent(token: string, p: EventPayload): Promise<string> {
  const attendees = p.attendees ?? [];
  const body = {
    summary: p.summary,
    location: p.location ?? undefined,
    description: p.description ?? undefined,
    start: { dateTime: p.start, timeZone: p.time_zone },
    end: { dateTime: p.end, timeZone: p.time_zone },
    attendees: attendees.map((email) => ({ email })),
  };
  const json = await calFetch(token, `/calendars/primary/events?sendUpdates=${attendees.length ? "all" : "none"}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return String(json.id);
}
