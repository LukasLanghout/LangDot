"use client";

import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import { railItem, RailLabel } from "./RailItem";

type Mode = "system" | "light" | "dark";

function apply(mode: Mode) {
  const root = document.documentElement;
  if (mode === "system") delete root.dataset.theme;
  else root.dataset.theme = mode;
  try {
    if (mode === "system") localStorage.removeItem("langdot-theme");
    else localStorage.setItem("langdot-theme", mode);
  } catch {
    /* opslag geblokkeerd: dan geldt de keuze alleen voor deze sessie */
  }
}

const LABEL: Record<Mode, string> = { system: "Thema: systeem", light: "Thema: licht", dark: "Thema: donker" };

/** Wisselt tussen systeem, licht en donker. Volgt het systeem zolang er niets gekozen is. */
export function ThemeToggle({ expanded = true }: { expanded?: boolean }) {
  const [mode, setMode] = useState<Mode>("system");

  useEffect(() => {
    try {
      const saved = localStorage.getItem("langdot-theme");
      if (saved === "light" || saved === "dark") setMode(saved);
    } catch {
      /* negeren */
    }
  }, []);

  function next() {
    const order: Mode[] = ["system", "light", "dark"];
    const m = order[(order.indexOf(mode) + 1) % order.length];
    setMode(m);
    apply(m);
  }

  return (
    <button type="button" onClick={next} title={`${LABEL[mode]} (klik om te wisselen)`} className={railItem}>
      <Icon name={mode === "dark" ? "moon" : mode === "light" ? "sun" : "panel"} size={18} className="shrink-0" />
      <RailLabel expanded={expanded}>{LABEL[mode]}</RailLabel>
    </button>
  );
}
