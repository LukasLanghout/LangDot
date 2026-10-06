// Capability manifest: wat de dot WEL en NIET kan zien. Wordt in elke prompt gezet, en de server dwingt de
// waarschuwing bij werk-onderwerpen zelf af (niet afhankelijk van het model).

import type { CalendarCapabilities, GmailCapabilities } from "@/lib/connectors/store";
import { BLIND_SPOTS } from "@/lib/connectors/registry";

type ManifestCtx = {
  gmail: GmailCapabilities;
  calendar: CalendarCapabilities;
  documents: { recent: unknown[] };
};

export function capabilityManifest(ctx: ManifestCtx) {
  const g = ctx.gmail;
  const c = ctx.calendar;
  const gmailLine =
    g.status === "active"
      ? `Gmail (persoonlijk${g.email ? `, ${g.email}` : ""}): verbonden. Doorzoeken en lezen: ${g.canRead ? "ja" : "nee"}. Versturen: alleen na klik op een goedkeuringskaart.`
      : g.status === "needs_reauth"
        ? "Gmail (persoonlijk): verbinding verlopen, moet opnieuw verbonden worden."
        : "Gmail (persoonlijk): NIET verbonden.";
  const calLine =
    c.status === "active"
      ? `Google Agenda (persoonlijk${c.email ? `, ${c.email}` : ""}): verbonden. Bekijken: ja. Afspraak voorstellen: ${c.canWrite ? "ja, na klik" : "nee"}. Wijzigen of annuleren: nee.`
      : c.status === "needs_reauth"
        ? "Google Agenda (persoonlijk): verbinding verlopen."
        : "Google Agenda (persoonlijk): NIET verbonden.";

  return `## Bronnen die je kunt raadplegen (capability manifest)
- ${gmailLine}
- ${calLine}
- Google Drive: NIET gekoppeld (komt later).
- Documenten die de gebruiker zelf uploadde of plakte: ${ctx.documents.recent.length ? "ja (zie lijst hieronder)" : "nog geen"}.
- Het web: via web_search en web_fetch.
## Bewust NIET zichtbaar voor jou
${BLIND_SPOTS.map((b) => `- ${b}`).join("\n")}`;
}

/** Regels voor bronvermelding, eerlijkheid over beperkingen en fouten. Shared door alle prompts. */
export const SOURCE_RULES = `
## Bronnen en beperkingen (harde regels)
- Gaat een vraag over mail, agenda of bestanden die waarschijnlijk in een NIET-gekoppelde bron staan (werk, stage, school:
  Lancyr, Fontys, Innova, Outlook, collega's of begeleiders daar), zeg dan in de EERSTE zin: "Ik zie alleen je persoonlijke Gmail
  en Agenda, niet je werkmail." Zoek daarna wel in wat je wél ziet (bv. in Gmail naar doorgestuurde mails) en label wat je vond
  als "alleen persoonlijke mail". Bied daarna een route aan: "plak de tekst van de mail hier" of "stuur hem door naar je Gmail".
- Elke feitelijke claim over mail, agenda of web noemt de bron en, waar dat kan, de datum of tijd (bv. "volgens je Gmail van 3 okt").
- Vind je niets, zeg dan "niet gevonden in [bron]" (bv. "niet gevonden in je persoonlijke Gmail") en NIET "er is niets".
- Toon de gebruiker nooit je redenering, tussenstappen of Engelse tussenzinnen; alleen het eindantwoord, in het Nederlands.
- Mislukt een tool: maximaal 2 nieuwe pogingen, elke keer met een andere aanpak (andere zoekterm, andere bron).
  Daarna kort en eerlijk melden wat mislukte, zonder technische details.
- Bij onduidelijkheid: stel maximaal één verduidelijkende vraag; kies anders een verstandige standaard en benoem die.
- Gebruik je web_search, sluit dan af met een korte brontabel (| Bron | Datum | Betrouwbaarheid |), met als betrouwbaarheid
  hoog (officiële of grote nieuwsbron), middel of laag (blog of onbekende site).
- Citeer documenten met naam en pagina, dia of blad (bv. "cv.pdf, pagina 2").`;

// ───────────────────────── Werk-onderwerpen ─────────────────────────

const WORK_RE = /\b(lancyr|fontys|innova|outlook|werkmail|stagebegeleider|stagebegeleiding|portflow|stagemail)\b/i;

export const WORK_NOTICE =
  "Ik zie alleen je persoonlijke Gmail en Agenda, niet je werkmail (Outlook) of je Lancyr-, Fontys- en Innova-accounts.";

export const WORK_ROUTE =
  "Plak de tekst van de mail of afspraak hier in de chat, of stuur hem door naar je Gmail; dan kan ik ermee verder.";

export function isWorkTopic(text: string) {
  return WORK_RE.test(text);
}

/**
 * Deterministische eerste zin bij werk-vragen. Geeft "" als de vraag niet over werk gaat, of als het antwoord de
 * beperking al in het begin noemt.
 */
export function workPrefix(userText: string, answer: string) {
  if (!isWorkTopic(userText)) return "";
  if (/werkmail|outlook/i.test(answer.slice(0, 300))) return "";
  return `${WORK_NOTICE} ${WORK_ROUTE}`;
}
