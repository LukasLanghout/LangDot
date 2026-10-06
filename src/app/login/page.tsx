"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { DotAvatar, DEFAULT_LOOK } from "@/components/DotAvatar";
import { btn, field } from "@/components/ui";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "error" | "info"; text: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const supabase = createClient();
    try {
      if (mode === "signin") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        router.replace("/");
        router.refresh();
      } else {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
        });
        if (error) throw error;
        if (data.session) {
          router.replace("/create");
          router.refresh();
        } else {
          setMsg({ kind: "info", text: "Check je mail en klik op de bevestigingslink." });
        }
      }
    } catch (err) {
      setMsg({ kind: "error", text: err instanceof Error ? err.message : "Er ging iets mis" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-full flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center gap-3 mb-9">
          <DotAvatar look={DEFAULT_LOOK} size={84} />
          <h1 className="serif text-[34px] leading-tight">LangDot</h1>
          <p className="text-muted text-[15px] text-center">Je persoonlijke agent die doorwerkt als jij er niet bent.</p>
        </div>

        <form onSubmit={submit} className="bg-panel border border-line rounded-3xl p-6 space-y-4" style={{ boxShadow: "var(--shadow-card)" }}>
          <label className="block">
            <span className="text-[13px] text-faint">E-mail</span>
            <input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} className={`${field} mt-1`} />
          </label>
          <label className="block">
            <span className="text-[13px] text-faint">Wachtwoord</span>
            <input
              type="password"
              required
              minLength={6}
              autoComplete={mode === "signin" ? "current-password" : "new-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={`${field} mt-1`}
            />
          </label>
          {msg && <p role={msg.kind === "error" ? "alert" : "status"} className={`text-[14px] ${msg.kind === "error" ? "text-bad" : "text-muted"}`}>{msg.text}</p>}
          <button disabled={busy} className={`${btn.primary} w-full`}>
            {busy ? "Even geduld…" : mode === "signin" ? "Inloggen" : "Account maken"}
          </button>
        </form>

        <button onClick={() => setMode(mode === "signin" ? "signup" : "signin")} className="block mx-auto mt-4 text-[14px] text-muted hover:text-fg min-h-11 px-2">
          {mode === "signin" ? "Nog geen account? Aanmelden" : "Al een account? Inloggen"}
        </button>
      </div>
    </main>
  );
}
