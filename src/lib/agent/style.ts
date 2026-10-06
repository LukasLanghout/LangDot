// Stijlvoorkeuren uit het geheugen worden in code afgedwongen, niet alleen gevraagd aan het model.
// "Liever korte antwoorden" betekent: maximaal 3 zinnen, geen emoji's en geen afsluitvraag tenzij nodig.
// Uitzondering: antwoorden met bronnen, lijsten, tabellen of code worden niet ingekort (daar gaat informatie verloren).

export type StylePrefs = { short: boolean; noEmoji: boolean; noClosingQuestion: boolean };

export function stylePrefsFrom(memories: { kind: string; content: string }[]): StylePrefs {
  const text = memories.filter((m) => m.kind === "preference").map((m) => m.content).join(" \n ").toLowerCase();
  const short = /\bkort(e|er)?\b|beknopt|bondig|in het kort/.test(text);
  return {
    short,
    noEmoji: true, // vaste ontwerpkeuze: geen emoji in antwoorden van de dot, ook zonder voorkeur
    noClosingQuestion: short || /geen\s+(afsluit|vervolg|slot)vra/.test(text),
  };
}

const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu;
const CLOSING = /\b(wil je|zal ik|kan ik|moet ik|nog iets|heb je (nog )?(vragen|meer)|laat het (me )?weten|sta ik)\b/i;

function isStructured(text: string) {
  return /```|^\s*\|.*\|/m.test(text) || /^\s*([-*]|\d+\.)\s+/m.test(text) || /^#{1,6}\s/m.test(text) || /https?:\/\//.test(text);
}

export function enforceStyle(text: string, prefs: StylePrefs): string {
  let t = text;
  if (prefs.noEmoji) t = t.replace(EMOJI, "").replace(/[ \t]{2,}/g, " ").replace(/ +\n/g, "\n").replace(/[ \t]+([.,!?;:])/g, "$1");

  if (prefs.noClosingQuestion) {
    // Laatste zin weghalen als dat een standaard-afsluitvraag is (en er daarna nog iets overblijft).
    const parts = t.trim().split(/(?<=[.!?])\s+/);
    const last = parts[parts.length - 1] ?? "";
    if (parts.length > 1 && /\?\s*$/.test(last) && CLOSING.test(last)) t = parts.slice(0, -1).join(" ");
  }

  if (prefs.short && !isStructured(t)) {
    const parts = t.trim().split(/(?<=[.!?])\s+/);
    if (parts.length > 3) t = parts.slice(0, 3).join(" ");
  }
  return t.trim();
}
