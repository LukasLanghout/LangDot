"use client";

import { useState, type ReactNode } from "react";
import { DotAvatar, DEFAULT_LOOK, COLORS, type DotStatus } from "@/components/DotAvatar";
import { Icon, ICON_NAMES } from "@/components/Icon";
import { ThemeToggle } from "@/components/ThemeToggle";
import { SourceChips, StatusBadge, Switch, Spinner, btn, chip, field, iconBtn } from "@/components/ui";
import type { TaskStatus } from "@/lib/types";

// Alle bouwstenen op één pagina, in het huidige thema. Wissel met de knop rechtsboven tussen licht en donker.

const TOKENS: [string, string, string][] = [
  ["bg", "bg-bg", "Achtergrond"],
  ["panel", "bg-panel", "Kaarten, invoer"],
  ["panel-2", "bg-panel-2", "Subtiele vlakken, hover"],
  ["line", "bg-line", "Randen"],
  ["faint", "bg-faint", "Tertiaire tekst"],
  ["muted", "bg-muted", "Secundaire tekst"],
  ["fg", "bg-fg", "Primaire tekst"],
  ["accent", "bg-accent", "Gevulde knoppen (AA)"],
  ["accent-soft", "bg-accent-soft", "Dot, indicatoren"],
  ["ok", "bg-ok", "Gelukt"],
  ["warn", "bg-warn", "Let op"],
  ["bad", "bg-bad", "Fout"],
  ["info", "bg-info", "Informatie"],
];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-4">
      <h2 className="serif text-[24px] leading-tight border-b border-line pb-2">{title}</h2>
      {children}
    </section>
  );
}

export default function StyleguidePage() {
  const [on, setOn] = useState(true);
  const [filter, setFilter] = useState("alles");
  const statuses: DotStatus[] = ["idle", "busy", "waiting"];
  const taskStatuses: TaskStatus[] = ["pending", "running", "needs_input", "done", "failed", "cancelled"];

  return (
    <main className="max-w-3xl mx-auto px-4 py-10 space-y-12">
      <header className="flex items-start gap-4">
        <div className="flex-1">
          <h1 className="serif text-[38px] leading-tight">Styleguide</h1>
          <p className="text-muted text-[15px] mt-1">De bouwstenen van LangDot in het huidige thema. Wissel rechts tussen systeem, licht en donker.</p>
        </div>
        <div className="w-44"><ThemeToggle expanded /></div>
      </header>

      <Section title="Kleuren">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {TOKENS.map(([name, cls, use]) => (
            <div key={name} className="rounded-xl border border-line bg-panel p-3">
              <div className={`h-10 rounded-lg border border-line ${cls}`} />
              <div className="text-[14px] font-medium mt-2">{name}</div>
              <div className="text-[13px] text-faint">{use}</div>
            </div>
          ))}
        </div>
        <p className="text-[13px] text-faint">
          Bewuste afwijking: tertiaire tekst en de gevulde accentkleur zijn iets donkerder (licht) of lichter (donker) dan het ontwerp,
          omdat de oorspronkelijke waarden geen contrast van 4,5:1 halen.
        </p>
      </Section>

      <Section title="Typografie">
        <div className="space-y-3">
          <div className="serif text-[34px] leading-tight">Goedemorgen.</div>
          <div className="serif text-[20px]">Koppen en antwoorden van de dot staan in een serif (Newsreader).</div>
          <p className="text-[15.5px]">Interface en lopende tekst staan in Inter, 15,5 px met een regelhoogte van 1,55.</p>
          <p className="text-[14px] text-muted">Secundaire tekst, 14 px.</p>
          <p className="text-[13px] text-faint">Kleine tekst en tijden, 13 px.</p>
        </div>
      </Section>

      <Section title="Knoppen">
        <div className="flex flex-wrap items-center gap-3">
          <button className={btn.primary}>Primair</button>
          <button className={btn.secondary}>Secundair</button>
          <button className={btn.ghost}>Tekst</button>
          <button className={btn.primary} disabled>Uitgeschakeld</button>
          <button className={iconBtn} aria-label="Meldingen"><Icon name="bell" size={19} /></button>
          <span className="w-10 h-10 rounded-full bg-accent text-on-accent inline-flex items-center justify-center" aria-hidden><Icon name="send" size={18} /></span>
        </div>
      </Section>

      <Section title="Invoer en keuzes">
        <div className="space-y-3 max-w-sm">
          <input className={field} placeholder="Tekstveld" aria-label="Voorbeeld tekstveld" />
          <div className="flex items-center gap-3">
            <Switch checked={on} onChange={setOn} label="Voorbeeldschakelaar" />
            <span className="text-[14px]">{on ? "Aan" : "Uit"}</span>
          </div>
          <div className="flex gap-1.5 flex-wrap" role="group" aria-label="Voorbeeldfilter">
            {["alles", "voorkeur", "feit"].map((f) => (
              <button key={f} onClick={() => setFilter(f)} aria-pressed={filter === f} className={chip(filter === f)}>{f}</button>
            ))}
          </div>
          <div className="flex items-center gap-2 text-[14px] text-muted"><Spinner /> Bezig met laden</div>
        </div>
      </Section>

      <Section title="Status">
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {taskStatuses.map((s) => <StatusBadge key={s} status={s} />)}
        </div>
      </Section>

      <Section title="De dot">
        <div className="flex flex-wrap items-end gap-8">
          {statuses.map((s) => (
            <div key={s} className="flex flex-col items-center gap-2">
              <DotAvatar look={DEFAULT_LOOK} size={72} status={s} />
              <span className="text-[13px] text-faint">{s === "idle" ? "rustig" : s === "busy" ? "bezig" : "wacht op jou"}</span>
            </div>
          ))}
          {COLORS.map((c) => (
            <DotAvatar key={c} look={{ ...DEFAULT_LOOK, color: c }} size={44} />
          ))}
        </div>
      </Section>

      <Section title="Berichten">
        <div className="space-y-4">
          <div className="flex justify-end">
            <div className="max-w-[80%] rounded-[18px] bg-panel-2 px-4 py-2.5 text-[15.5px]">Wat staat er morgen in mijn agenda?</div>
          </div>
          <div className="serif text-[18px] leading-relaxed">
            Morgen heb je om 10:00 een gesprek met je stagebegeleider en om 14:30 een tandartsafspraak.
          </div>
          <SourceChips text="Bron: https://www.nu.nl/tech en https://tweakers.net/nieuws" />
        </div>
      </Section>

      <Section title="Goedkeuringskaart">
        <div className="rounded-2xl border border-line bg-panel p-4 space-y-3 max-w-md" style={{ boxShadow: "var(--shadow-card)" }}>
          <div className="flex items-center gap-2 text-[13px] text-faint"><Icon name="mail" size={15} /> Mail versturen</div>
          <div>
            <div className="font-medium">Technieuws van vandaag</div>
            <div className="text-[14px] text-muted">Aan lukas@voorbeeld.nl</div>
          </div>
          <p className="text-[14px] text-muted line-clamp-3">Hierbij de belangrijkste ontwikkelingen van vandaag, kort samengevat met bronnen.</p>
          <div className="flex items-center gap-2">
            <button className={btn.primary}>Versturen</button>
            <button className={btn.ghost}>Afwijzen</button>
          </div>
        </div>
        <p className="text-[13px] text-faint">Voorbeeld met dezelfde opbouw als de echte kaart; de echte kaart staat in de chat en het activiteitenpaneel.</p>
      </Section>

      <Section title="Iconen">
        <div className="grid grid-cols-4 sm:grid-cols-6 gap-3">
          {ICON_NAMES.map((n) => (
            <div key={n} className="flex flex-col items-center gap-1.5 rounded-xl border border-line bg-panel py-3">
              <Icon name={n} size={20} />
              <span className="text-[12px] text-faint">{n}</span>
            </div>
          ))}
        </div>
      </Section>
    </main>
  );
}
