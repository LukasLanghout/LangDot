"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Task, TaskStatus } from "@/lib/types";

// ───────────────────────── Tijd ─────────────────────────
// Vaste tijdzone: de server (UTC) en de browser moeten exact dezelfde tekst renderen (anders hydration-fout #418).
const TZ = "Europe/Amsterdam";
const dayKey = (d: Date) => d.toLocaleDateString("nl-NL", { timeZone: TZ });

export function formatTime(iso: string) {
  const d = new Date(iso);
  const sameDay = dayKey(d) === dayKey(new Date());
  return d.toLocaleString(
    "nl-NL",
    sameDay
      ? { hour: "2-digit", minute: "2-digit", timeZone: TZ }
      : { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: TZ },
  );
}

/** "Vandaag", "Gisteren" of "dinsdag 6 oktober" voor datumscheidingen in de chat. */
export function dayLabel(iso: string) {
  const d = new Date(iso);
  const today = dayKey(new Date());
  const yesterday = dayKey(new Date(Date.now() - 86_400_000));
  const k = dayKey(d);
  if (k === today) return "Vandaag";
  if (k === yesterday) return "Gisteren";
  return d.toLocaleDateString("nl-NL", { weekday: "long", day: "numeric", month: "long", timeZone: TZ });
}

export const dayOf = dayKey;

// ───────────────────────── Knoppen (tokens) ─────────────────────────
// Hoogte 36 (desktop) of 44 (mobiel, tikdoel), radius 12, focusring uit globals.css.
const BTN = "inline-flex items-center justify-center gap-2 rounded-xl text-sm font-medium px-4 h-11 sm:h-9 transition-colors disabled:opacity-40 disabled:pointer-events-none";
export const btn = {
  primary: `${BTN} bg-accent text-on-accent hover:bg-[var(--c-accent-hover)]`,
  secondary: `${BTN} border border-line bg-panel text-fg hover:bg-panel-2`,
  ghost: `${BTN} text-muted hover:text-fg hover:bg-panel-2`,
};

/** Kleine icoonknop met minimaal 44 px tikdoel op mobiel. */
export const iconBtn = "inline-flex items-center justify-center rounded-lg w-11 h-11 sm:w-9 sm:h-9 text-muted hover:text-fg hover:bg-panel-2 transition-colors";

export const field =
  "w-full rounded-xl bg-panel border border-line px-3 py-2 text-[15px] text-fg placeholder:text-faint outline-none focus:border-accent-soft transition-colors";

// ───────────────────────── Status ─────────────────────────
const STATUS: Record<TaskStatus, { label: string; dot: string }> = {
  pending: { label: "in de wachtrij", dot: "bg-faint" },
  running: { label: "bezig", dot: "bg-accent-soft pulse-dot" },
  needs_input: { label: "wacht op jou", dot: "bg-accent-soft" },
  done: { label: "klaar", dot: "bg-ok" },
  cancelled: { label: "geannuleerd", dot: "bg-faint" },
  failed: { label: "mislukt", dot: "bg-bad" },
};

/** Gedempte status: alleen een gekleurd punt en tekst, geen gekleurd vlak. */
export function StatusBadge({ status }: { status: TaskStatus }) {
  const s = STATUS[status] ?? STATUS.pending;
  return (
    <span className="inline-flex items-center gap-1.5 text-[13px] text-muted whitespace-nowrap">
      <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} aria-hidden />
      {s.label}
    </span>
  );
}

export function Spinner({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className="spin text-faint" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

/** Schakelaar in iOS-stijl. */
export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative shrink-0 w-[42px] h-[26px] rounded-full transition-colors disabled:opacity-40 ${checked ? "bg-accent" : "bg-line"}`}
    >
      <span
        className="absolute top-[3px] left-[3px] w-5 h-5 rounded-full bg-white shadow-sm transition-transform"
        style={{ transform: checked ? "translateX(16px)" : "none", transitionTimingFunction: "var(--ease-calm)" }}
      />
    </button>
  );
}

// ───────────────────────── Keuzevraag ─────────────────────────

/** Antwoordknoppen voor een taak die op de gebruiker wacht. */
export function QuestionOptions({ task }: { task: Task }) {
  const [busy, setBusy] = useState(false);
  const [custom, setCustom] = useState("");
  const [showCustom, setShowCustom] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function answer(text: string) {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/tasks/${task.id}/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer: text }),
    });
    if (!res.ok) setError((await res.json().catch(() => null))?.error ?? "Dat lukte niet. Probeer het nog eens.");
    setBusy(false);
  }

  return (
    <div className="mt-3 space-y-2">
      <div className="flex flex-wrap gap-2">
        {(task.options ?? []).map((o, i) => (
          <button key={o.label} disabled={busy} onClick={() => answer(o.label)} className={i === 0 ? btn.primary : btn.secondary}>
            {o.label}
          </button>
        ))}
        <button onClick={() => setShowCustom((v) => !v)} className={btn.ghost}>Ander antwoord</button>
      </div>
      {showCustom && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (custom.trim()) answer(custom.trim());
          }}
          className="flex gap-2"
        >
          <input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="Typ je antwoord" aria-label="Eigen antwoord" className={field} />
          <button disabled={busy || !custom.trim()} className={btn.secondary}>Stuur</button>
        </form>
      )}
      {error && <p className="text-bad text-sm">{error}</p>}
    </div>
  );
}

// ───────────────────────── Markdown ─────────────────────────

/** Markdown (tabellen, lijsten, links; geen ruwe HTML). `serif` = leest als een brief (antwoorden van de dot). */
export function Markdown({ text, serif = false }: { text: string; serif?: boolean }) {
  return (
    <div className={`msg ${serif ? "msg-dot" : ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
          table: ({ node: _node, ...props }) => (
            <div className="table-wrap">
              <table {...props} />
            </div>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

// ───────────────────────── Bronnen ─────────────────────────

export type Source = { domain: string; url: string };

/** Unieke bronnen (per domein) uit de links in een antwoord. */
export function extractSources(text: string, max = 6): Source[] {
  const urls = text.match(/https?:\/\/[^\s<>()\[\]"']+[^\s<>()\[\]"'.,;:!?]/g) ?? [];
  const seen = new Set<string>();
  const out: Source[] = [];
  for (const url of urls) {
    try {
      const domain = new URL(url).hostname.replace(/^www\./, "");
      if (seen.has(domain)) continue;
      seen.add(domain);
      out.push({ domain, url });
      if (out.length >= max) break;
    } catch {
      /* ongeldige url: overslaan */
    }
  }
  return out;
}

/** Kleine chips met favicon en domein onder een antwoord met bronnen. */
export function SourceChips({ text }: { text: string }) {
  const sources = extractSources(text);
  if (sources.length < 1) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-1.5" aria-label="Bronnen">
      {sources.map((s) => (
        <a
          key={s.domain}
          href={s.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-full border border-line bg-panel px-2.5 h-7 text-[13px] text-muted hover:text-fg hover:bg-panel-2 transition-colors"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(s.domain)}&sz=32`}
            alt=""
            width={14}
            height={14}
            className="rounded-sm"
            referrerPolicy="no-referrer"
            loading="lazy"
          />
          {s.domain}
        </a>
      ))}
    </div>
  );
}

/** Filterchip: gedempt, actief = accentrand. */
export const chip = (active: boolean) =>
  `inline-flex items-center rounded-full border px-3 h-8 text-[13px] transition-colors ${active ? "border-accent-soft bg-accent-soft/15 text-fg" : "border-line text-muted hover:text-fg hover:bg-panel-2"}`;

/** Kleine tekstknop in kaarten (bewerk, verwijder, enz.). */
export const textBtn = "text-[13px] text-muted hover:text-fg transition-colors min-h-11 sm:min-h-0 px-1";
