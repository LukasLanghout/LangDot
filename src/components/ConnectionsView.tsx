"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BLIND_SPOTS, PROVIDERS, type ProviderInfo } from "@/lib/connectors/registry";
import type { ConnectorRow } from "@/lib/types";
import { btn, formatTime } from "./ui";
import { DiagnosePanel } from "./DiagnosePanel";
import { Icon } from "./Icon";

const ERRORS: Record<string, string> = {
  state: "De koppeling kon niet veilig worden afgerond (sessie verlopen of ongeldige link). Probeer het opnieuw.",
  denied: "Je hebt geen toestemming gegeven. Er is niets gekoppeld.",
  scopes: "Je hebt een benodigd recht uitgevinkt (mail versturen of afspraken beheren). Probeer opnieuw en laat dat vinkje aan.",
  exchange: "Google gaf een fout bij het koppelen. Probeer het opnieuw.",
  config: "De Google-koppeling is op de server nog niet ingesteld (Google-client ontbreekt).",
  unknown_provider: "Onbekende dienst.",
};

function Card({ info, connector }: { info: ProviderInfo; connector?: ConnectorRow }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = connector && connector.status !== "revoked";
  const soon = info.status === "coming_soon";

  async function disconnect() {
    if (!confirm(`${info.label} ontkoppelen? De dot kan deze dienst dan niet meer gebruiken.`)) return;
    setBusy(true);
    setError(null);
    const res = await fetch("/api/connectors/google/disconnect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: info.id }),
    });
    if (!res.ok) setError("Ontkoppelen mislukte. Probeer het opnieuw.");
    setBusy(false);
    router.refresh();
  }

  const statusLabel = soon
    ? { text: "Binnenkort", dot: "bg-faint" }
    : active && connector?.status === "needs_reauth"
      ? { text: "Opnieuw verbinden nodig", dot: "bg-warn" }
      : active
        ? { text: "Verbonden", dot: "bg-ok" }
        : null;

  return (
    <div className={`rounded-2xl border p-5 ${soon ? "border-line opacity-70" : "border-line bg-panel"}`} style={soon ? undefined : { boxShadow: "var(--shadow-card)" }}>
      <div className="flex items-start gap-3.5">
        <div className="w-10 h-10 rounded-xl bg-panel-2 flex items-center justify-center text-muted shrink-0" aria-hidden>
          <Icon name={info.id === "gmail" ? "mail" : info.id === "google_calendar" ? "calendar" : "folder"} size={20} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 flex-wrap">
            <h2 className="serif text-[20px] leading-tight">{info.label}</h2>
            {statusLabel && (
              <span className="inline-flex items-center gap-1.5 text-[13px] text-muted">
                <span className={`w-1.5 h-1.5 rounded-full ${statusLabel.dot}`} aria-hidden />
                {statusLabel.text}
              </span>
            )}
          </div>
          <p className="text-[15px] text-muted mt-0.5">{info.description}</p>
          {active && (
            <p className="text-[14px] mt-2">
              Verbonden als <strong className="font-medium">{connector?.account_email ?? "onbekend account"}</strong>
              <span className="text-faint"> · laatst gebruikt: {connector?.last_used_at ? formatTime(connector.last_used_at) : "nog niet"}</span>
            </p>
          )}
        </div>
      </div>

      {!soon && (
        <div className="grid sm:grid-cols-2 gap-4 mt-5 text-[14px]">
          <div>
            <div className="text-[13px] text-faint mb-1.5">Wat de dot wél kan</div>
            <ul className="space-y-1.5">
              {info.can.map((c) => (
                <li key={c} className="flex gap-2"><Icon name="check" size={15} className="text-ok mt-1 shrink-0" /><span>{c}</span></li>
              ))}
            </ul>
          </div>
          <div>
            <div className="text-[13px] text-faint mb-1.5">Wat de dot níet kan</div>
            <ul className="space-y-1.5">
              {info.cannot.map((c) => (
                <li key={c} className="flex gap-2"><Icon name="x" size={15} className="text-faint mt-1 shrink-0" /><span className="text-muted">{c}</span></li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {error && <p className="text-bad text-[14px] mt-3">{error}</p>}

      {!soon && (
        <div className="flex gap-2 mt-5">
          {(!active || connector?.status === "needs_reauth") && info.connectPath && (
            // Gewone link: de browser moet naar Google navigeren (geen fetch).
            <a href={info.connectPath} className={btn.primary}>
              {active ? "Opnieuw verbinden" : "Verbinden"}
            </a>
          )}
          {active && (
            <button onClick={disconnect} disabled={busy} className={btn.secondary}>
              {busy ? "Ontkoppelen…" : "Ontkoppelen"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function ConnectionsView({ connectors, connected, error }: { connectors: ConnectorRow[]; connected: string | null; error: string | null }) {
  return (
    <main className="min-h-full px-4 py-8 sm:py-12">
      <div className="max-w-2xl mx-auto space-y-5">
        <Link href="/" className="inline-flex items-center gap-1.5 text-[14px] text-muted hover:text-fg min-h-11 sm:min-h-0">
          <Icon name="chevron-left" size={16} />
          Terug naar je dot
        </Link>
        <h1 className="serif text-[34px] leading-tight">Verbindingen</h1>
        <p className="text-[15px] text-muted">
          Koppel je eigen accounts. Je dot vraagt altijd eerst jouw goedkeuring voordat hij iets namens je verstuurt, tenzij je dat zelf voor een schema hebt aangezet.
          Je kunt een verbinding op elk moment ontkoppelen.
        </p>
        {connected && (
          <div role="status" className="rounded-xl border border-line bg-panel px-4 py-3 text-[14px] flex items-center gap-2">
            <Icon name="check" size={16} className="text-ok shrink-0" />
            Verbonden. Je dot kan nu met {PROVIDERS.find((p) => p.id === connected)?.label ?? "deze dienst"} werken.
          </div>
        )}
        {error && (
          <div role="alert" className="rounded-xl border border-line bg-panel px-4 py-3 text-[14px] flex items-start gap-2">
            <Icon name="alert" size={16} className="text-bad mt-0.5 shrink-0" />
            {ERRORS[error] ?? "Er ging iets mis bij het koppelen."}
          </div>
        )}
        {PROVIDERS.map((p) => <Card key={p.id} info={p} connector={connectors.find((c) => c.provider === p.id)} />)}
        <div className="rounded-2xl border border-line bg-panel p-5">
          <h2 className="serif text-[20px] leading-tight">Wat de dot bewust niet ziet</h2>
          <p className="text-[15px] text-muted mt-1">
            Dit is een ontwerpkeuze: de dot ziet alleen je persoonlijke Gmail en Agenda. Gaat een vraag over werk, stage of school,
            dan zegt hij dat meteen, en kun je de tekst plakken of de mail doorsturen naar je Gmail.
          </p>
          <ul className="mt-3 space-y-1.5 text-[14px]">
            {BLIND_SPOTS.map((b) => (
              <li key={b} className="flex gap-2"><Icon name="x" size={15} className="text-faint mt-1 shrink-0" /><span className="text-muted">{b}</span></li>
            ))}
          </ul>
        </div>
        <DiagnosePanel />
      </div>
    </main>
  );
}
