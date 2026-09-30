export type ConnectorErrorCode = "not_connected" | "needs_reauth" | "config" | "provider_error";

const MESSAGES: Record<ConnectorErrorCode, string> = {
  not_connected: "Deze dienst is nog niet verbonden. Verbind hem via Verbindingen.",
  needs_reauth: "De verbinding is verlopen. Verbind de dienst opnieuw via Verbindingen.",
  config: "Deze koppeling is op de server nog niet ingesteld.",
  provider_error: "De dienst gaf een fout. Probeer het later opnieuw.",
};

/** Fout van een connector. `message` is veilig voor de gebruiker; `detail` alleen voor de serverlog. */
export class ConnectorError extends Error {
  constructor(public code: ConnectorErrorCode, public detail = "") {
    super(MESSAGES[code]);
    this.name = "ConnectorError";
  }
}
