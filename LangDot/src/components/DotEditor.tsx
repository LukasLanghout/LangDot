"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { Profile } from "@/lib/types";
import { ACCESSORIES, COLORS, DotAvatar, EYES, SHAPES, toHandle, type DotLook } from "./DotAvatar";

function Choice({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1.5 rounded-lg text-sm border transition ${
        active ? "border-accent bg-accent/15 text-fg" : "border-line text-muted hover:text-fg"
      }`}
    >
      {label}
    </button>
  );
}

export function DotEditor({ userId, existing }: { userId: string; existing: Profile | null }) {
  const router = useRouter();
  const [name, setName] = useState(existing?.name ?? "");
  const [look, setLook] = useState<DotLook>({
    shape: existing?.shape ?? "circle",
    color: existing?.color ?? COLORS[0],
    eyes: existing?.eyes ?? "round",
    accessory: existing?.accessory ?? "none",
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
      <form onSubmit={save} className="w-full max-w-2xl bg-panel border border-line rounded-2xl p-6 grid gap-6 sm:grid-cols-[220px_1fr]">
        <div className="flex flex-col items-center gap-3 sm:border-r sm:border-line sm:pr-6">
          <DotAvatar look={look} size={160} busy />
          <div className="text-center">
            <div className="font-semibold text-lg">{name.trim() || "Naamloos"}</div>
            <div className="text-muted text-sm">{handle}</div>
          </div>
        </div>

        <div className="space-y-5">
          <h1 className="text-xl font-semibold">{existing ? "Pas je dot aan" : "Maak je dot"}</h1>

          <label className="block">
            <span className="text-xs text-muted">Naam</span>
            <input
              required
              maxLength={40}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="bv. Pixel"
              className="mt-1 w-full rounded-lg bg-panel-2 border border-line px-3 py-2 outline-none focus:border-accent"
            />
          </label>

          <fieldset>
            <legend className="text-xs text-muted mb-2">Vorm</legend>
            <div className="flex flex-wrap gap-2">
              {SHAPES.map((s) => <Choice key={s.id} label={s.label} active={look.shape === s.id} onClick={() => set({ shape: s.id })} />)}
            </div>
          </fieldset>

          <fieldset>
            <legend className="text-xs text-muted mb-2">Kleur</legend>
            <div className="flex flex-wrap items-center gap-2">
              {COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={`Kleur ${c}`}
                  onClick={() => set({ color: c })}
                  className={`w-8 h-8 rounded-full border-2 ${look.color === c ? "border-fg" : "border-transparent"}`}
                  style={{ background: c }}
                />
              ))}
              <input
                type="color"
                value={look.color}
                onChange={(e) => set({ color: e.target.value })}
                className="w-8 h-8 rounded-full bg-transparent cursor-pointer"
                aria-label="Eigen kleur"
              />
            </div>
          </fieldset>

          <fieldset>
            <legend className="text-xs text-muted mb-2">Ogen</legend>
            <div className="flex flex-wrap gap-2">
              {EYES.map((s) => <Choice key={s.id} label={s.label} active={look.eyes === s.id} onClick={() => set({ eyes: s.id })} />)}
            </div>
          </fieldset>

          <fieldset>
            <legend className="text-xs text-muted mb-2">Accessoire</legend>
            <div className="flex flex-wrap gap-2">
              {ACCESSORIES.map((s) => <Choice key={s.id} label={s.label} active={look.accessory === s.id} onClick={() => set({ accessory: s.id })} />)}
            </div>
          </fieldset>

          {error && <p className="text-bad text-sm">{error}</p>}

          <div className="flex gap-2 pt-2">
            <button disabled={busy || !name.trim()} className="rounded-lg bg-accent text-white font-medium px-4 py-2 disabled:opacity-50 hover:brightness-110">
              {busy ? "Opslaan…" : existing ? "Opslaan" : `${name.trim() || "Dot"} tot leven wekken`}
            </button>
            {existing && (
              <button type="button" onClick={() => router.push("/")} className="rounded-lg border border-line px-4 py-2 text-muted hover:text-fg">
                Annuleren
              </button>
            )}
          </div>
        </div>
      </form>
    </main>
  );
}
