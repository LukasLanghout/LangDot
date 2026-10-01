// Register van connectors. Nieuwe diensten (Calendar, Drive, Microsoft) komen hier bij:
// een ProviderInfo voor de UI, en een OAuth-implementatie in een eigen module (zie google.ts).
// Dit bestand bevat geen geheimen en mag ook in de browser gebruikt worden.

export type ProviderId = "gmail" | "google_calendar" | "google_drive";

export type ProviderInfo = {
  id: ProviderId;
  label: string;
  description: string;
  status: "available" | "coming_soon";
  /** Wat de dot met deze verbinding WEL kan, in gewone taal. */
  can: string[];
  /** Wat de dot NIET kan. */
  cannot: string[];
  connectPath?: string;
};

export const PROVIDERS: ProviderInfo[] = [
  {
    id: "gmail",
    label: "Gmail",
    description: "Laat je dot mails voor je opstellen, versturen na jouw klik, en je mail doorzoeken.",
    status: "available",
    can: [
      "Een mail opstellen; je ziet hem eerst in een goedkeuringskaart",
      "Een mail versturen, maar alleen nadat jij op Versturen klikt",
      "Een concept ook in Gmail › Concepten zetten",
      "Je mail doorzoeken en lezen als je daarom vraagt",
    ],
    cannot: [
      "Mail versturen zonder jouw klik",
      "Mail verwijderen of je Gmail-instellingen wijzigen",
      "Meer dan het daglimiet aan mails of ontvangers per mail versturen",
    ],
    connectPath: "/api/connectors/google/start?provider=gmail",
  },
  {
    id: "google_calendar",
    label: "Google Calendar",
    description: "Laat je dot je agenda kennen en afspraken voor je inplannen na jouw klik.",
    status: "available",
    can: [
      "Je afspraken bekijken (\"wat staat er morgen?\", vrije tijd zoeken)",
      "Een afspraak voorstellen; je ziet hem eerst in een goedkeuringskaart",
      "De afspraak inplannen en uitnodigingen sturen, alleen nadat jij op Inplannen klikt",
    ],
    cannot: [
      "Afspraken inplannen of uitnodigingen sturen zonder jouw klik",
      "Bestaande afspraken wijzigen of verwijderen",
      "Je agenda-instellingen of deelrechten aanpassen",
    ],
    connectPath: "/api/connectors/google/start?provider=google_calendar",
  },
  {
    id: "google_drive",
    label: "Google Drive",
    description: "Documenten zoeken en lezen.",
    status: "coming_soon",
    can: [],
    cannot: [],
  },
];

export function providerInfo(id: string) {
  return PROVIDERS.find((p) => p.id === id);
}
