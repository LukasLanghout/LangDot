"use client";

import { useState } from "react";

type Check = { name: string; ok: boolean | null; detail: string; fix?: string };

/** Zelfdiagnose: laat zien welke instelling, migratie of verbinding niet in orde is, en hoe je het oplost. */
export function DiagnosePanel() {
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    const r = await fetch("/api/diagnose").then((x) => x.json()).catch(() => null);
    setChecks(r?.checks ?? [{ name: "Diagnose", ok: false, detail: "kon niet worden uitgevoerd" }]);
    setBusy(false);
  }

  const failed = checks?.filter((c) => c.ok === false).length ?? 0;

  return (
    <div className="rounded-2xl border border-line bg-panel p-4">
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <h2 className="font-semibold">Diagnose</h2>
          <p className="text-sm text-muted">Werkt iets niet? Controleer instellingen, database en verbindingen.</p>
        </div>
        <button onClick={run} disabled={busy} className="rounded-lg border border-line px-4 py-2 text-sm hover:bg-panel-2 disabled:opacity-50">
          {busy ? "Bezig…" : checks ? "Opnieuw" : "Controleer"}
        </button>
      </div>
      {checks && (
        <>
          <p className={`text-sm mt-3 ${failed ? "text-warn" : "text-ok"}`}>
            {failed ? `${failed} ${failed === 1 ? "probleem" : "problemen"} gevonden.` : "Alles in orde."}
          </p>
          <ul className="mt-2 space-y-1.5 text-sm">
            {checks.map((c) => (
              <li key={c.name} className="flex gap-2">
                <span className={c.ok === true ? "text-ok" : c.ok === false ? "text-bad" : "text-muted"}>
                  {c.ok === true ? "✓" : c.ok === false ? "✕" : "○"}
                </span>
                <div className="min-w-0">
                  <span className="font-medium">{c.name}</span> <span className="text-muted">· {c.detail}</span>
                  {c.ok === false && c.fix && <div className="text-xs text-warn">{c.fix}</div>}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
