export type DotLook = { shape: string; color: string; eyes: string; accessory: string };
export type DotStatus = "idle" | "busy" | "waiting";

export const SHAPES = [
  { id: "circle", label: "Rond" },
  { id: "square", label: "Blokje" },
  { id: "blob", label: "Druppel" },
  { id: "ghost", label: "Spookje" },
];
export const EYES = [
  { id: "round", label: "Rond" },
  { id: "happy", label: "Blij" },
  { id: "sleepy", label: "Slaperig" },
  { id: "star", label: "Sterren" },
  { id: "wink", label: "Knipoog" },
];
export const ACCESSORIES = [
  { id: "none", label: "Geen" },
  { id: "hat", label: "Hoge hoed" },
  { id: "glasses", label: "Bril" },
  { id: "bow", label: "Strik" },
  { id: "antenna", label: "Antenne" },
  { id: "crown", label: "Kroon" },
];
// Gedempte, warme kleuren; terracotta is de standaard.
export const COLORS = ["#C96442", "#D9A27A", "#8FA37E", "#7E9CB5", "#B493A8", "#C98A80", "#A39E94"];
export const DEFAULT_LOOK: DotLook = { shape: "circle", color: COLORS[0], eyes: "round", accessory: "none" };

const INK = "#3A2F2A"; // zacht bruin in plaats van zwart: geen harde contouren

function Body({ shape, color }: { shape: string; color: string }) {
  switch (shape) {
    case "square":
      return <rect x="20" y="26" width="80" height="80" rx="26" fill={color} />;
    case "blob":
      return <path d="M60 22 C90 22 104 46 102 72 C100 98 82 108 60 108 C36 108 18 97 18 72 C18 44 32 22 60 22 Z" fill={color} />;
    case "ghost":
      return <path d="M22 66 A38 38 0 0 1 98 66 L98 106 L85 97 L72 106 L60 97 L48 106 L35 97 L22 106 Z" fill={color} />;
    default:
      return <circle cx="60" cy="66" r="42" fill={color} />;
  }
}

function Star({ cx, cy }: { cx: number; cy: number }) {
  const pts = Array.from({ length: 10 }, (_, i) => {
    const r = i % 2 === 0 ? 7 : 3;
    const a = (Math.PI / 5) * i - Math.PI / 2;
    return `${cx + r * Math.cos(a)},${cy + r * Math.sin(a)}`;
  }).join(" ");
  return <polygon points={pts} fill={INK} />;
}

function Eyes({ eyes }: { eyes: string }) {
  const stroke = { stroke: INK, strokeWidth: 3.5, strokeLinecap: "round" as const, fill: "none" };
  switch (eyes) {
    case "happy":
      return (
        <g>
          <path d="M39 67 Q46 58 53 67" {...stroke} />
          <path d="M67 67 Q74 58 81 67" {...stroke} />
        </g>
      );
    case "sleepy":
      return (
        <g>
          <path d="M39 64 Q46 70 53 64" {...stroke} />
          <path d="M67 64 Q74 70 81 64" {...stroke} />
        </g>
      );
    case "star":
      return (
        <g>
          <Star cx={46} cy={64} />
          <Star cx={74} cy={64} />
        </g>
      );
    case "wink":
      return (
        <g>
          <circle cx="46" cy="64" r="5.5" fill={INK} />
          <path d="M67 66 Q74 60 81 66" {...stroke} />
        </g>
      );
    default:
      return (
        <g className="dot-eyes">
          <circle cx="46" cy="64" r="5.5" fill={INK} />
          <circle cx="74" cy="64" r="5.5" fill={INK} />
        </g>
      );
  }
}

function Accessory({ accessory }: { accessory: string }) {
  switch (accessory) {
    case "hat":
      return (
        <g>
          <rect x="40" y="4" width="40" height="24" rx="4" fill="#4A3F38" />
          <rect x="40" y="20" width="40" height="5" fill="#C9A04B" opacity="0.85" />
          <rect x="28" y="26" width="64" height="6" rx="3" fill="#4A3F38" />
        </g>
      );
    case "glasses":
      return (
        <g stroke={INK} strokeWidth="2.5" fill="rgba(255,255,255,0.22)">
          <circle cx="46" cy="64" r="11" />
          <circle cx="74" cy="64" r="11" />
          <path d="M57 64H63" fill="none" />
        </g>
      );
    case "bow":
      return (
        <g fill="#C2706B">
          <path d="M78 30 L92 20 L94 38 Z" />
          <path d="M78 30 L64 22 L66 38 Z" />
          <circle cx="79" cy="30" r="4" fill="#A85A56" />
        </g>
      );
    case "antenna":
      return (
        <g>
          <path d="M60 25 V10" stroke="#4A3F38" strokeWidth="2.5" strokeLinecap="round" />
          <circle cx="60" cy="8" r="5" fill="#C9A04B" />
        </g>
      );
    case "crown":
      return <path d="M38 30 L42 12 L52 24 L60 8 L68 24 L78 12 L82 30 Z" fill="#D2A94F" stroke="#B08A35" strokeWidth="1.2" />;
    default:
      return null;
  }
}

const STATUS_LABEL: Record<DotStatus, string> = { idle: "beschikbaar", busy: "bezig", waiting: "wacht op jou" };

/**
 * De dot. Zachte vlakke kleuren, rustig ademend, af en toe knipperend.
 * `status`: idle (stil), busy (zachte puls), waiting (accent: wacht op jou). `busy` is een alias voor status="busy".
 */
export function DotAvatar({
  look,
  size = 96,
  busy = false,
  status,
  breathe = true,
}: {
  look: DotLook;
  size?: number;
  busy?: boolean;
  status?: DotStatus;
  breathe?: boolean;
}) {
  const s: DotStatus | null = status ?? (busy ? "busy" : null);
  const spot = Math.max(8, Math.round(size * 0.15));
  return (
    <span className="relative inline-block shrink-0" style={{ width: size, height: size }} title={s ? STATUS_LABEL[s] : undefined}>
      <svg viewBox="0 0 120 120" width={size} height={size} className={breathe ? "dot-breathe" : undefined} role="img" aria-label="Dot avatar">
        <ellipse cx="60" cy="114" rx="30" ry="3.5" fill="currentColor" opacity="0.08" />
        <Body shape={look.shape} color={look.color} />
        <ellipse cx="40" cy="80" rx="6" ry="3.5" fill="#fff" opacity="0.22" />
        <ellipse cx="80" cy="80" rx="6" ry="3.5" fill="#fff" opacity="0.22" />
        <Eyes eyes={look.eyes} />
        <path d="M54 82 Q60 87 66 82" stroke={INK} strokeWidth="3" strokeLinecap="round" fill="none" />
        <Accessory accessory={look.accessory} />
      </svg>
      {s && (
        <span
          aria-hidden
          className={`absolute rounded-full border-2 ${s === "busy" ? "pulse-dot" : ""}`}
          style={{
            width: spot,
            height: spot,
            right: Math.round(size * 0.04),
            bottom: Math.round(size * 0.08),
            borderColor: "var(--c-bg)",
            background: s === "waiting" ? "var(--c-accent)" : s === "busy" ? "var(--c-fg-3)" : "var(--c-ok)",
          }}
        />
      )}
    </span>
  );
}

export function toHandle(name: string) {
  const slug = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return `@${slug || "mijn"}-dot`;
}
