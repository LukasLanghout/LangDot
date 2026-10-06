"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { Profile } from "@/lib/types";
import { ACCESSORIES, COLORS, DEFAULT_LOOK, DotAvatar, EYES, SHAPES, toHandle, type DotLook } from "./DotAvatar";
import { btn, chip, field } from "./ui";

function Choice({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active} className={`${chip(active)} !h-10 sm:!h-9 !px-3.5`}>
      {label}
    </button>
  );
}

export function DotEditor({ userId, existing }: { userId: string; existing: Profile | null }) {
  const router = useRouter();
  const [name, setName] = useState(existing?.name ?? "");
  const [look, setLook] = useState<DotLook>({
    shape: existing?.shape ?? DEFAULT_LOOK.shape,
    color: existing?.color ?? DEFAULT_LOOK.color,
    eyes: existing?.eyes ?? DEFAULT_LOOK.eyes,
    accessory: existing?.accessory ?? DEFAULT_LOOK.accessory,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (patch: Partial<DotLook>) => setLook((l) => ({ ...l, ...patch }));
  const handle = toHandle(name);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const { error } = await supabase.from("dot_profiles").upsert({
      user_id: userId,
      name: name.trim().slice(0, 40),
      handle,
      ...look,
      updated_at: new Date().toISOString(),
    });
    if (error) {
      setError(error.message);
      setBusy(false);
      return;
    }
    await supabase.from("dot_audit").insert({
      user_id: userId,
      actor: "user",
      action: existing ? "dot_updated" : "dot_created",
      input: { name: name.trim(), handle, ...look },
    });
    router.replace("/");
    router.refresh();
  }

  return (
    <main className="min-h-full flex items-center justify-center px-4 py-10">
      <form onSubmit={save} className="w-full max-w-2xl bg-panel border border-line rounded-3xl p-6 sm:p-8 grid gap-8 sm:grid-cols-[200px_1fr]" style={{ boxShadow: "var(--shadow-card)" }}>
        <div className="flex flex-col items-center gap-3 sm:pt-6">
          <DotAvatar look={look} size={140} />
          <div className="text-center">
            <div className="serif text-[24px] leading-tight">{name.trim() || "Naamloos"}</div>
            <div className="text-faint text-[14px]">{handle}</div>
          </div>
        </div>

        <div className="space-y-5">
          <h1 className="serif text-[30px] leading-tight">{existing ? "Pas je dot aan" : "Maak je dot"}</h1>

          <label className="block">
            <span className="text-[13px] text-faint">Naam</span>
            <input required maxLength={40} value={name} onChange={(e) => setName(e.target.value)} placeholder="bijvoorbeeld Pixel" className={`${field} mt-1`} />
          </label>

          <fieldset>
            <legend className="text-[13px] text-faint mb-2">Vorm</legend>
            <div className="flex flex-wrap gap-2">
              {SHAPES.map((s) => <Choice key={s.id} label={s.label} active={look.shape === s.id} onClick={() => set({ shape: s.id })} />)}
            </div>
          </fieldset>

          <fieldset>
            <legend className="text-[13px] text-faint mb-2">Kleur</legend>
            <div className="flex flex-wrap items-center gap-2.5">
              {COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={`Kleur ${c}`}
                  aria-pressed={look.color === c}
                  onClick={() => set({ color: c })}
                  className="w-9 h-9 sm:w-8 sm:h-8 rounded-full transition-shadow"
                  style={{ background: c, boxShadow: look.color === c ? "0 0 0 2px var(--c-bg), 0 0 0 4px var(--c-fg-3)" : "none" }}
                />
              ))}
              <input
                type="color"
                value={look.color}
                onChange={(e) => set({ color: e.target.value })}
                className="w-9 h-9 sm:w-8 sm:h-8 rounded-full bg-transparent cursor-pointer"
                aria-label="Eigen kleur"
              />
            </div>
          </fieldset>

          <fieldset>
            <legend className="text-[13px] text-faint mb-2">Ogen</legend>
            <div className="flex flex-wrap gap-2">
              {EYES.map((s) => <Choice key={s.id} label={s.label} active={look.eyes === s.id} onClick={() => set({ eyes: s.id })} />)}
            </div>
          </fieldset>

          <fieldset>
            <legend className="text-[13px] text-faint mb-2">Accessoire</legend>
            <div className="flex flex-wrap gap-2">
              {ACCESSORIES.map((s) => <Choice key={s.id} label={s.label} active={look.accessory === s.id} onClick={() => set({ accessory: s.id })} />)}
            </div>
          </fieldset>

          {error && <p className="text-bad text-[14px]">{error}</p>}

          <div className="flex gap-2 pt-2">
            <button disabled={busy || !name.trim()} className={btn.primary}>
              {busy ? "Opslaan…" : existing ? "Opslaan" : `${name.trim() || "Dot"} tot leven wekken`}
            </button>
            {existing && (
              <button type="button" onClick={() => router.push("/")} className={btn.ghost}>Annuleren</button>
            )}
          </div>
        </div>
      </form>
    </main>
  );
}
