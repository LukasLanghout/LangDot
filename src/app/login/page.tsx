"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { DotAvatar } from "@/components/DotAvatar";

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
        <div className="flex flex-col items-center gap-3 mb-8">
          <DotAvatar look={{ shape: "circle", color: "#8b7bff", eyes: "round", accessory: "antenna" }} size={88} busy />
          <h1 className="text-2xl font-semibold">LangDot</h1>
          <p className="text-muted text-sm text-center">Je persoonlijke agent die doorwerkt als jij er niet bent.</p>
        </div>

        <form onSubmit={submit} className="bg-panel border border-line rounded-2xl p-5 space-y-3">
          <label className="block">
            <span className="text-xs text-muted">E-mail</span>
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 w-full rounded-lg bg-panel-2 border border-line px-3 py-2 outline-none focus:border-accent"
            />
          </label>
          <label className="block">
            <span className="text-xs text-muted">Wachtwoord</span>
            <input
              type="password"
              required
              minLength={6}
              autoComplete={mode === "signin" ? "current-password" : "new-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full rounded-lg bg-panel-2 border border-line px-3 py-2 outline-none focus:border-accent"
            />
          </label>
          {msg && <p className={`text-sm ${msg.kind === "error" ? "text-bad" : "text-ok"}`}>{msg.text}</p>}
          <button
            disabled={busy}
            className="w-full rounded-lg bg-accent text-white font-medium py-2 disabled:opacity-50 hover:brightness-110"
          >
            {busy ? "Even geduld…" : mode === "signin" ? "Inloggen" : "Account maken"}
          </button>
        </form>

        <button
          onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
          className="block mx-auto mt-4 text-sm text-muted hover:text-fg"
        >
          {mode === "signin" ? "Nog geen account? Aanmelden" : "Al een account? Inloggen"}
        </button>
      </div>
    </main>
  );
}
