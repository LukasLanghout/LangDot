// Regels voor geheugen: alleen wat de gebruiker letterlijk zegt of bevestigt, met bron en datum.

export type MemorySource = "gezegd" | "afgeleid" | "handmatig";

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").replace(/[.,!?;:"'“”‘’]/g, "").trim();

/** Staat `evidence` (de letterlijke woorden van de gebruiker) echt in zijn laatste bericht? */
export function evidenceMatches(evidence: string, userText: string) {
  const e = norm(evidence);
  if (e.length < 2) return false;
  return norm(userText).includes(e);
}

/** Zet het bronlabel voor de inhoud, zodat het in het Geheugen-paneel en de prompt zichtbaar is. */
export function labelMemory(source: MemorySource, content: string, now: Date, tz = "Europe/Amsterdam") {
  const date = new Intl.DateTimeFormat("sv-SE", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const clean = content.replace(/^\[(gezegd|handmatig|afgeleid)[^\]]*\]\s*/i, "").trim();
  if (source === "handmatig") return `[handmatig, ${date}, kan verouderd zijn] ${clean}`;
  return `[gezegd ${date}] ${clean}`;
}

export type MemoryDecision =
  | { ok: true; content: string }
  | { ok: false; reason: "inferred" | "no_evidence" | "no_user_message" | "bad_source"; message: string };

/** Beslist of een geheugennotitie opgeslagen mag worden, en met welk label. */
export function decideMemoryWrite(
  input: { source?: unknown; evidence?: unknown; content: string },
  userText: string | undefined,
  now = new Date(),
): MemoryDecision {
  const source = input.source;
  if (source !== "gezegd" && source !== "afgeleid" && source !== "handmatig") {
    return { ok: false, reason: "bad_source", message: 'Geef source mee: "gezegd" (letterlijk door de gebruiker gezegd of bevestigd), "handmatig" of "afgeleid".' };
  }
  if (source === "afgeleid") {
    return {
      ok: false,
      reason: "inferred",
      message: "Niet opgeslagen: dit is afgeleid, geen feit. Vraag de gebruiker eerst 'Klopt het dat …?' en sla het pas op na zijn bevestiging.",
    };
  }
  if (!userText) {
    return { ok: false, reason: "no_user_message", message: "Niet opgeslagen: er is geen bericht van de gebruiker waarop dit gebaseerd kan zijn." };
  }
  const evidence = typeof input.evidence === "string" ? input.evidence : "";
  if (!evidenceMatches(evidence, userText)) {
    return {
      ok: false,
      reason: "no_evidence",
      message: "Niet opgeslagen: evidence moet de letterlijke woorden van de gebruiker uit zijn laatste bericht zijn (bij een bevestiging: zijn 'ja').",
    };
  }
  return { ok: true, content: labelMemory(source, input.content, now) };
}
