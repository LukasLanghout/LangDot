"use client";

import { useState } from "react";
import { btn } from "./ui";
import { Icon } from "./Icon";

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
    <div className="rounded-2xl border border-line bg-panel p-5">
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <h2 className="serif text-[20px] leading-tight">Diagnose</h2>
          <p className="text-[15px] text-muted mt-0.5">Werkt iets niet? Controleer instellingen, database en verbindingen.</p>
        </div>
        <button onClick={run} disabled={busy} className={btn.secondary}>
          {busy ? "Bezig…" : checks ? "Opnieuw" : "Controleer"}
        </button>
      </div>
      {checks && (
        <>
          <p className={`text-[14px] mt-4 ${failed ? "text-fg" : "text-muted"}`} role="status">
            {failed ? `${failed} ${failed === 1 ? "probleem" : "problemen"} gevonden.` : "Alles in orde."}
          </p>
          <ul className="mt-2 space-y-2 text-[14px]">
            {checks.map((c) => (
              <li key={c.name} className="flex gap-2">
                {c.ok === true ? (
                  <Icon name="check" size={15} className="text-ok mt-1 shrink-0" />
                ) : c.ok === false ? (
                  <Icon name="alert" size={15} className="text-bad mt-1 shrink-0" />
                ) : (
                  <span className="w-[15px] h-[15px] mt-1 shrink-0 flex items-center justify-center"><span className="w-1.5 h-1.5 rounded-full border border-faint" /></span>
                )}
                <div className="min-w-0">
                  <span className="font-medium">{c.name}</span> <span className="text-muted">· {c.detail}</span>
                  {c.ok === false && c.fix && <div className="text-[13px] text-muted mt-0.5">{c.fix}</div>}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
