export type DotLook = { shape: string; color: string; eyes: string; accessory: string };

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
export const COLORS = ["#8b7bff", "#ff7eb6", "#3ecf8e", "#4cc9f0", "#f5b942", "#ff6b6b", "#c0c0d0"];

const INK = "#1b1b2a";

function Body({ shape, color }: { shape: string; color: string }) {
  switch (shape) {
    case "square":
      return <rect x="20" y="26" width="80" height="80" rx="24" fill={color} />;
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
  const stroke = { stroke: INK, strokeWidth: 4, strokeLinecap: "round" as const, fill: "none" };
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
          <circle cx="46" cy="64" r="6" fill={INK} />
          <path d="M67 66 Q74 60 81 66" {...stroke} />
        </g>
      );
    default:
      return (
        <g className="dot-eyes">
          <circle cx="46" cy="64" r="6" fill={INK} />
          <circle cx="74" cy="64" r="6" fill={INK} />
          <circle cx="48" cy="62" r="2" fill="#fff" />
          <circle cx="76" cy="62" r="2" fill="#fff" />
        </g>
      );
  }
}

function Accessory({ accessory, color }: { accessory: string; color: string }) {
  switch (accessory) {
    case "hat":
      return (
        <g>
          <rect x="40" y="4" width="40" height="24" rx="3" fill={INK} />
          <rect x="40" y="20" width="40" height="5" fill={color} opacity="0.8" />
          <rect x="28" y="26" width="64" height="6" rx="3" fill={INK} />
        </g>
      );
    case "glasses":
      return (
        <g stroke={INK} strokeWidth="3" fill="rgba(255,255,255,0.25)">
          <circle cx="46" cy="64" r="11" />
          <circle cx="74" cy="64" r="11" />
          <path d="M57 64 H63" fill="none" />
        </g>
      );
    case "bow":
      return (
        <g fill="#ff4f8b">
          <path d="M78 30 L92 20 L94 38 Z" />
          <path d="M78 30 L64 22 L66 38 Z" />
          <circle cx="79" cy="30" r="4" fill="#d6336c" />
        </g>
      );
    case "antenna":
      return (
        <g>
          <path d="M60 25 V9" stroke={INK} strokeWidth="3" strokeLinecap="round" />
          <circle cx="60" cy="8" r="5" fill="#f5b942" />
        </g>
      );
    case "crown":
      return <path d="M38 30 L42 12 L52 24 L60 8 L68 24 L78 12 L82 30 Z" fill="#f5b942" stroke="#c98f12" strokeWidth="1.5" />;
    default:
      return null;
  }
}

export function DotAvatar({ look, size = 96, busy = false }: { look: DotLook; size?: number; busy?: boolean }) {
  return (
    <svg
      viewBox="0 0 120 120"
      width={size}
      height={size}
      className={busy ? "dot-busy" : undefined}
      role="img"
      aria-label="Dot avatar"
    >
      <ellipse cx="60" cy="114" rx="30" ry="4" fill="#000" opacity="0.25" />
      <Body shape={look.shape} color={look.color} />
      <ellipse cx="40" cy="80" rx="6" ry="3.5" fill="#ff8fab" opacity="0.45" />
      <ellipse cx="80" cy="80" rx="6" ry="3.5" fill="#ff8fab" opacity="0.45" />
      <Eyes eyes={look.eyes} />
      <path d="M54 82 Q60 87 66 82" stroke={INK} strokeWidth="3" strokeLinecap="round" fill="none" />
      <Accessory accessory={look.accessory} color={look.color} />
    </svg>
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
