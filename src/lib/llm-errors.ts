// Fouten van de LLM-laag. `message` is ALTIJD veilig om aan de gebruiker te tonen
// (geen ruwe API-fouten, geen modelnamen). Details staan in `detail` en gaan alleen naar de serverlog.

export type LlmErrorKind = "rate_limit" | "unavailable" | "budget" | "config" | "model_mismatch" | "bad_request";

const USER_MESSAGES: Record<LlmErrorKind, string> = {
  rate_limit: "Het is even erg druk bij het taalmodel. Probeer het over een paar minuten opnieuw.",
  unavailable: "Het taalmodel is nu niet bereikbaar. Probeer het zo nog eens.",
  budget: "Het dagelijkse tegoed van je dot is op. Morgen kan hij weer verder.",
  config: "De dot kan zijn taalmodel niet gebruiken door een instellingsfout. De beheerder kan dit in de serverlog zien.",
  model_mismatch: "Het antwoord kwam niet van het ingestelde taalmodel en is daarom geweigerd. Probeer het later opnieuw.",
  bad_request: "Het taalmodel kon dit verzoek niet verwerken. Probeer het anders te formuleren.",
};

export class LlmError extends Error {
  constructor(public kind: LlmErrorKind, public detail: string) {
    super(USER_MESSAGES[kind]);
    this.name = "LlmError";
  }
}

/** Veilige tekst voor de gebruiker, voor elke fout. */
export function userSafeMessage(e: unknown) {
  return e instanceof LlmError ? e.message : "Er ging iets mis. Probeer het zo nog eens.";
}
