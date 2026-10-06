// Gmail REST API. Alleen serverside; krijgt een access token van store.getAccessToken().

import { ConnectorError } from "./errors";
import { htmlToText } from "@/lib/web";
import { markdownToHtml } from "@/lib/mail-format";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

export type OutgoingMail = { to: string[]; subject: string; body: string };
export type MailFile = { name: string; mime: string; data: Buffer };

function assertHeaderSafe(v: string) {
  if (/[\r\n]/.test(v)) throw new ConnectorError("provider_error", "header bevat regeleinde");
}

function encodeHeader(v: string) {
  assertHeaderSafe(v);
  return /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, "utf8").toString("base64")}?=`;
}

const b64lines = (buf: Buffer) => buf.toString("base64").replace(/.{1,76}/g, "$&\r\n");

/** Bestandsnaam voor de Content-Disposition (RFC 2231 voor niet-ASCII). */
function filenameParam(name: string) {
  const safe = name.replace(/[\r\n"\\]/g, "_");
  return /^[\x20-\x7e]*$/.test(safe) ? `filename="${safe}"` : `filename*=UTF-8''${encodeURIComponent(safe)}`;
}

/**
 * Bouwt een RFC 2822-bericht. De tekst gaat mee als platte tekst én als nette HTML (Markdown → HTML),
 * zodat de mail in elke mailapp goed leesbaar is. Met bijlagen: multipart/mixed eromheen.
 */
export function buildMime(mail: OutgoingMail, files: MailFile[] = []) {
  mail.to.forEach(assertHeaderSafe);
  const headers = [`To: ${mail.to.join(", ")}`, `Subject: ${encodeHeader(mail.subject)}`, "MIME-Version: 1.0"];
  const stamp = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  const alt = `langdot_alt_${stamp}`;

  const bodyParts = [
    `--${alt}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64lines(Buffer.from(mail.body, "utf8")),
    `--${alt}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64lines(Buffer.from(markdownToHtml(mail.body), "utf8")),
    `--${alt}--`,
  ];
  const altHeader = `Content-Type: multipart/alternative; boundary="${alt}"`;

  if (!files.length) return [...headers, altHeader, "", ...bodyParts, ""].join("\r\n");

  const mixed = `langdot_mix_${stamp}`;
  const parts = [...headers, `Content-Type: multipart/mixed; boundary="${mixed}"`, "", `--${mixed}`, altHeader, "", ...bodyParts];
  for (const f of files) {
    const mime = /^[\w.+-]+\/[\w.+-]+$/.test(f.mime) ? f.mime : "application/octet-stream";
    parts.push(
      `--${mixed}`,
      `Content-Type: ${mime}`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; ${filenameParam(f.name)}`,
      "",
      b64lines(f.data),
    );
  }
  parts.push(`--${mixed}--`, "");
  return parts.join("\r\n");
}
export function buildRawMessage(mail: OutgoingMail, files: MailFile[] = []) {
  return Buffer.from(buildMime(mail, files), "utf8").toString("base64url");
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

/** Zet een concept in Gmail › Concepten (scope gmail.compose). Alleen voor mails zonder bijlagen. */
export async function createGmailDraft(token: string, mail: OutgoingMail): Promise<string> {
  const json = await gmailFetch(token, "/drafts", {
    method: "POST",
    body: JSON.stringify({ message: { raw: buildRawMessage(mail) } }),
  });
  return String(json.id);
}

/** Versturen via het upload-endpoint (tot 35 MB), nodig voor bijlagen. */
async function sendViaUpload(token: string, mime: string) {
  const res = await fetch("https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "message/rfc822" },
    body: mime,
  });
  if (res.status === 401) throw new ConnectorError("needs_reauth", "gmail 401");
  if (!res.ok) {
    const json = await res.json().catch(() => null);
    throw new ConnectorError("provider_error", `gmail upload ${res.status} ${json?.error?.status ?? ""}`);
  }
  return String((await res.json()).id);
}

/**
 * Verstuurt een mail. Met bijlagen via het upload-endpoint. Zonder bijlagen en met een Gmail-concept:
 * concept eerst bijwerken met de (mogelijk bewerkte) goedgekeurde tekst en dan versturen.
 */
export async function sendGmail(
  token: string,
  mail: OutgoingMail & { gmailDraftId?: string | null },
  files: MailFile[] = [],
): Promise<string> {
  if (files.length) return sendViaUpload(token, buildMime(mail, files));
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
