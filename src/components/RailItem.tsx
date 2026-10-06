import type { ReactNode } from "react";

/** Eén regel in de zijbalk: icoon in een vaste kolom, label alleen als de balk uitgeklapt is. */
export const railItem =
  "w-full h-11 sm:h-10 flex items-center gap-3 rounded-xl px-[11px] text-[14px] text-muted hover:text-fg hover:bg-panel-2 transition-colors whitespace-nowrap overflow-hidden";

export function RailLabel({ expanded, children }: { expanded: boolean; children: ReactNode }) {
  return expanded ? <span className="min-w-0 truncate">{children}</span> : <span className="sr-only">{children}</span>;
}
