"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PROVIDERS, type ProviderInfo } from "@/lib/connectors/registry";
import type { ConnectorRow } from "@/lib/types";
import { formatTime } from "./ui";

const ERRORS: Record<string, string> = {
  state: "De koppeling kon niet veilig worden afgerond (sessie verlopen of ongeldige link). Probeer het opnieuw.",
  denied: "Je hebt geen toestemming gegeven. Er is niets gekoppeld.",
  scopes: "Zonder toestemming om mail te versturen kan de dot Gmail niet gebruiken. Probeer opnieuw en laat dat vinkje aan.",
  exchange: "Google gaf een fout bij het koppelen. Probeer het opnieuw.",
  config: "Gmail-koppeling is op de server nog niet ingesteld (Google-client ontbreekt).",
  unknown_provider: "Onbekende dienst.",
};

function Card({ info, connector }: { info: ProviderInfo; connector?: ConnectorRow }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = connector && connector.status !== "revoked";
  const soon = info.status === "coming_soon";

  async function disconnect() {
    if (!confirm(`${info.label} ontkoppelen? De dot kan dan geen mail meer versturen of lezen.`)) return;
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

  return (
    <div className={`rounded-2xl border p-4 ${soon ? "border-line/60 opacity-60" : "border-line bg-panel"}`}>
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-xl bg-panel-2 flex items-center justify-center text-lg" aria-hidden>
          {info.id === "gmail" ? "✉" : info.id === "google_calendar" ? "📅" : "📁"}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="font-semibold">{info.label}</h2>
            {soon && <span className="text-[11px] px-2 py-0.5 rounded-full bg-line text-muted">Binnenkort</span>}
            {active && connector?.status === "active" && <span className="text-[11px] px-2 py-0.5 rounded-full bg-ok/15 text-ok">Verbonden</span>}
            {active && connector?.status === "needs_reauth" && <span className="text-[11px] px-2 py-0.5 rounded-full bg-warn/20 text-warn">Opnieuw verbinden nodig</span>}
          </div>
          <p className="text-sm text-muted mt-0.5">{info.description}</p>
          {active && (
            <p className="text-sm mt-2">
              Verbonden als <strong>{connector?.account_email ?? "onbekend account"}</strong>
              <span className="text-muted"> · laatst gebruikt: {connector?.last_used_at ? formatTime(connector?.last_used_at ?? "") : "nog niet"}</span>
            </p>
          )}
        </div>
      </div>

      {!soon && (
        <div className="grid sm:grid-cols-2 gap-3 mt-4 text-sm">
          <div>
            <div className="text-xs text-muted mb-1">Wat de dot wél kan</div>
            <ul className="space-y-1">{info.can.map((c) => <li key={c}>✓ {c}</li>)}</ul>
          </div>
          <div>
            <div className="text-xs text-muted mb-1">Wat de dot níet kan</div>
            <ul className="space-y-1">{info.cannot.map((c) => <li key={c}>✕ {c}</li>)}</ul>
          </div>
        </div>
      )}

      {error && <p className="text-bad text-sm mt-3">{error}</p>}

      {!soon && (
        <div className="flex gap-2 mt-4">
          {(!active || connector?.status === "needs_reauth") && info.connectPath && (
            // Gewone link: de browser moet naar Google navigeren (geen fetch).
            <a href={info.connectPath} className="rounded-lg bg-accent text-white px-4 py-2 text-sm font-medium hover:brightness-110">
              {active ? "Opnieuw verbinden" : "Verbinden"}
            </a>
          )}
          {active && (
            <button onClick={disconnect} disabled={busy} className="rounded-lg border border-line px-4 py-2 text-sm hover:bg-panel-2 disabled:opacity-50">
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
    <main className="min-h-full px-4 py-8">
      <div className="max-w-2xl mx-auto space-y-4">
        <div className="flex items-center gap-3">
          <Link href="/" className="text-sm text-muted hover:text-fg">← Terug naar je dot</Link>
        </div>
        <h1 className="text-2xl font-semibold">Verbindingen</h1>
        <p className="text-sm text-muted">
          Koppel je eigen accounts. Je dot vraagt altijd eerst jouw goedkeuring voordat hij iets namens je verstuurt.
          Je kunt een verbinding op elk moment ontkoppelen.
        </p>
        {connected && <div className="rounded-lg border border-ok/40 bg-ok/10 text-ok text-sm px-3 py-2">Verbonden! Je dot kan nu met Gmail werken.</div>}
        {error && <div className="rounded-lg border border-bad/40 bg-bad/10 text-bad text-sm px-3 py-2">{ERRORS[error] ?? "Er ging iets mis bij het koppelen."}</div>}
        {PROVIDERS.map((p) => <Card key={p.id} info={p} connector={connectors.find((c) => c.provider === p.id)} />)}
      </div>
    </main>
  );
}
