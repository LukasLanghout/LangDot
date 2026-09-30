// Gmail REST API. Alleen serverside; krijgt een access token van store.getAccessToken().

import { ConnectorError } from "./errors";
import { htmlToText } from "@/lib/web";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

export type OutgoingMail = { to: string[]; subject: string; body: string };

function assertHeaderSafe(v: string) {
  if (/[\r\n]/.test(v)) throw new ConnectorError("provider_error", "header bevat regeleinde");
}

function encodeHeader(v: string) {
  assertHeaderSafe(v);
  return /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, "utf8").toString("base64")}?=`;
}

/** Bouwt een RFC 2822-bericht (text/plain, UTF-8) en geeft het base64url-gecodeerd terug. */
export function buildRawMessage(mail: OutgoingMail) {
  mail.to.forEach(assertHeaderSafe);
  const body = Buffer.from(mail.body, "utf8").toString("base64").replace(/.{1,76}/g, "$&\r\n");
  const lines = [
    `To: ${mail.to.join(", ")}`,
    `Subject: ${encodeHeader(mail.subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    body,
  ];
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}

async function gmailFetch(token: string, path: string, init: { method?: string; body?: string } = {}) {
  const res = await fetch(`${API}${path}`, {
    method: init.method ?? "GET",
    body: init.body,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (res.status === 401) throw new ConnectorError("needs_reauth", "gmail 401");
  if (!res.ok) {
    const json = await res.json().catch(() => null);
    throw new ConnectorError("provider_error", `gmail ${res.status} ${json?.error?.status ?? ""}`);
  }
  return res.status === 204 ? null : res.json();
}

/** Zet een concept in Gmail › Concepten (scope gmail.compose). */
export async function createGmailDraft(token: string, mail: OutgoingMail): Promise<string> {
  const json = await gmailFetch(token, "/drafts", {
    method: "POST",
    body: JSON.stringify({ message: { raw: buildRawMessage(mail) } }),
  });
  return String(json.id);
}

/**
 * Verstuurt een mail. Bestaat er een Gmail-concept, dan wordt dat eerst bijgewerkt met de
 * (mogelijk bewerkte) goedgekeurde tekst en daarna verstuurd, zodat er geen oud concept achterblijft.
 */
export async function sendGmail(token: string, mail: OutgoingMail & { gmailDraftId?: string | null }): Promise<string> {
  const raw = buildRawMessage(mail);
  if (mail.gmailDraftId) {
    try {
      await gmailFetch(token, `/drafts/${encodeURIComponent(mail.gmailDraftId)}`, {
        method: "PUT",
        body: JSON.stringify({ id: mail.gmailDraftId, message: { raw } }),
      });
      const sent = await gmailFetch(token, "/drafts/send", { method: "POST", body: JSON.stringify({ id: mail.gmailDraftId }) });
      return String(sent.id);
    } catch (e) {
      if (e instanceof ConnectorError && e.code === "needs_reauth") throw e;
      // Concept bestaat niet meer (bv. door de gebruiker verwijderd): gewoon direct versturen.
    }
  }
  const sent = await gmailFetch(token, "/messages/send", { method: "POST", body: JSON.stringify({ raw }) });
  return String(sent.id);
}

export type MailSummary = { id: string; from: string; subject: string; date: string; snippet: string };

export async function searchGmail(token: string, query: string, max = 5): Promise<MailSummary[]> {
  const list = await gmailFetch(token, `/messages?q=${encodeURIComponent(query)}&maxResults=${Math.min(max, 10)}`);
  const ids: string[] = (list?.messages ?? []).map((m: any) => String(m.id));
  const out: MailSummary[] = [];
  for (const id of ids) {
    const m = await gmailFetch(
      token,
      `/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
    );
    const h = (name: string) => (m?.payload?.headers ?? []).find((x: any) => String(x.name).toLowerCase() === name)?.value ?? "";
    out.push({ id, from: h("from"), subject: h("subject"), date: h("date"), snippet: String(m?.snippet ?? "") });
  }
  return out;
}

function findText(part: any): string {
  if (!part) return "";
  const data = part.body?.data ? Buffer.from(String(part.body.data), "base64url").toString("utf8") : "";
  if (part.mimeType === "text/plain" && data) return data;
  for (const p of part.parts ?? []) {
    const t = findText(p);
    if (t) return t;
  }
  if (part.mimeType === "text/html" && data) return htmlToText(data);
  return "";
}

export async function readGmail(token: string, id: string) {
  const m = await gmailFetch(token, `/messages/${encodeURIComponent(id)}?format=full`);
  const h = (name: string) => (m?.payload?.headers ?? []).find((x: any) => String(x.name).toLowerCase() === name)?.value ?? "";
  return {
    id,
    from: h("from"),
    to: h("to"),
    subject: h("subject"),
    date: h("date"),
    text: findText(m?.payload).slice(0, 6000),
  };
}
