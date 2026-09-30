"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import type { AuditEntry, Draft, Memory, Message, Profile, Schedule, Task } from "@/lib/types";
import { DotAvatar } from "./DotAvatar";
import { Chat } from "./Chat";
import { ActivityPanel } from "./ActivityPanel";
import { MemoryPanel } from "./MemoryPanel";
import { SchedulePanel } from "./SchedulePanel";
import { AuditPanel } from "./AuditPanel";

type Initial = {
  messages: Message[];
  tasks: Task[];
  memories: Memory[];
  schedules: Schedule[];
  drafts: Draft[];
  audit: AuditEntry[];
};

type Tab = "activity" | "memory" | "scheduled" | "audit";
type Row = { id: string | number };

/** Voegt een rij toe of vervangt hem (op id), en sorteert. */
function upsert<T extends Row>(list: T[], row: T, sort: (a: T, b: T) => number, cap = 500): T[] {
  const i = list.findIndex((x) => x.id === row.id);
  const next = i >= 0 ? list.map((x, j) => (j === i ? { ...x, ...row } : x)) : [...list, row];
  return next.sort(sort).slice(0, cap);
}

const byCreatedAsc = (a: { created_at: string }, b: { created_at: string }) => a.created_at.localeCompare(b.created_at);
const byCreatedDesc = (a: { created_at: string }, b: { created_at: string }) => b.created_at.localeCompare(a.created_at);
const byUpdatedDesc = (a: { updated_at: string }, b: { updated_at: string }) => b.updated_at.localeCompare(a.updated_at);

export function AppShell({
  userId,
  initialProfile,
  initial,
  cauraFleet,
}: {
  userId: string;
  initialProfile: Profile;
  initial: Initial;
  cauraFleet: string | null;
}) {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);

  const [profile, setProfile] = useState(initialProfile);
  const [messages, setMessages] = useState(initial.messages);
  const [tasks, setTasks] = useState(initial.tasks);
  const [memories, setMemories] = useState(initial.memories);
  const [schedules, setSchedules] = useState(initial.schedules);
  const [drafts, setDrafts] = useState(initial.drafts);
  const [audit, setAudit] = useState(initial.audit);
  const [tab, setTab] = useState<Tab>("activity");
  const [mobileView, setMobileView] = useState<"chat" | "panel">("chat");
  const [live, setLive] = useState(false);

  const upsertMessage = useCallback((m: Message) => setMessages((l) => upsert(l, m, byCreatedAsc, 300)), []);

  // ── Realtime: alle tabellen van deze gebruiker live bijhouden ──
  useEffect(() => {
    let channel: RealtimeChannel | null = null;
    let cancelled = false;

    (async () => {
      const { data } = await supabase.auth.getSession();
      if (data.session) await supabase.realtime.setAuth(data.session.access_token);
      if (cancelled) return;

      const handlers: Record<string, (p: any) => void> = {
        dot_messages: (p) => p.eventType !== "DELETE" && upsertMessage(p.new as Message),
        dot_tasks: (p) =>
          p.eventType === "DELETE"
            ? setTasks((l) => l.filter((x) => x.id !== p.old.id))
            : setTasks((l) => upsert(l, p.new as Task, byCreatedDesc, 100)),
        dot_memories: (p) =>
          p.eventType === "DELETE"
            ? setMemories((l) => l.filter((x) => x.id !== p.old.id))
            : setMemories((l) => upsert(l, p.new as Memory, byUpdatedDesc)),
        dot_schedules: (p) =>
          p.eventType === "DELETE"
            ? setSchedules((l) => l.filter((x) => x.id !== p.old.id))
            : setSchedules((l) => upsert(l, p.new as Schedule, byCreatedAsc)),
        dot_drafts: (p) =>
          p.eventType === "DELETE"
            ? setDrafts((l) => l.filter((x) => x.id !== p.old.id))
            : setDrafts((l) => upsert(l, p.new as Draft, byCreatedDesc, 100)),
        dot_audit: (p) => p.eventType === "INSERT" && setAudit((l) => upsert(l, p.new as AuditEntry, byCreatedDesc, 200)),
        dot_profiles: (p) => p.eventType === "UPDATE" && setProfile((old) => ({ ...old, ...(p.new as Profile) })),
      };

      const ch = supabase.channel(`dot-${userId}`);
      for (const [table, handler] of Object.entries(handlers)) {
        ch.on("postgres_changes", { event: "*", schema: "public", table, filter: `user_id=eq.${userId}` }, handler);
        // DELETE-events zijn in Supabase niet filterbaar op kolom; die bevatten alleen de id.
        ch.on("postgres_changes", { event: "DELETE", schema: "public", table }, handler);
      }
      ch.subscribe((status) => setLive(status === "SUBSCRIBED"));
      channel = ch;
    })();

    return () => {
      cancelled = true;
      if (channel) supabase.removeChannel(channel);
    };
  }, [supabase, userId, upsertMessage]);

  // ── Worker aftrappen zolang de app open is (vangnet naast pg_cron) ──
  useEffect(() => {
    const kick = () => {
      if (document.visibilityState === "visible") fetch("/api/worker/kick", { method: "POST" }).catch(() => {});
    };
    kick();
    const t = setInterval(kick, 60_000);
    return () => clearInterval(t);
  }, []);

  const activeTasks = tasks.filter((t) => t.status === "pending" || t.status === "running");
  const waiting = tasks.filter((t) => t.status === "needs_input");
  const busy = !profile.paused && activeTasks.length > 0;

  async function togglePause() {
    const paused = !profile.paused;
    setProfile((p) => ({ ...p, paused }));
    const res = await fetch("/api/dot/pause", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paused }),
    });
    if (!res.ok) setProfile((p) => ({ ...p, paused: !paused }));
  }

  async function logout() {
    await supabase.auth.signOut();
    router.replace("/login");
    router.refresh();
  }

  const statusText = profile.paused
    ? "Gepauzeerd"
    : waiting.length
      ? `Wacht op jou (${waiting.length})`
      : activeTasks.length
        ? `Bezig met ${activeTasks.length} ${activeTasks.length === 1 ? "taak" : "taken"}`
        : "Beschikbaar";

  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: "activity", label: "Activity", count: waiting.length || undefined },
    { id: "memory", label: "Geheugen" },
    { id: "scheduled", label: "Gepland" },
    { id: "audit", label: "Audit-log" },
  ];

  return (
    <div className="h-dvh flex flex-col lg:flex-row overflow-hidden">
      {/* Linkerkolom: de dot zelf */}
      <aside className="shrink-0 lg:w-60 border-b lg:border-b-0 lg:border-r border-line bg-panel px-4 py-3 lg:py-6 flex lg:flex-col items-center gap-3 lg:gap-4">
        <div className="lg:hidden">
          <DotAvatar look={profile} size={44} busy={busy} />
        </div>
        <div className="hidden lg:block">
          <DotAvatar look={profile} size={128} busy={busy} />
        </div>
        <div className="min-w-0 flex-1 lg:flex-none lg:text-center">
          <div className="font-semibold truncate">{profile.name}</div>
          <div className="text-xs text-muted truncate">{profile.handle}</div>
          <div className="text-xs mt-1 flex items-center gap-1.5 lg:justify-center">
            <span className={`inline-block w-2 h-2 rounded-full ${profile.paused ? "bg-warn" : waiting.length ? "bg-warn" : busy ? "bg-accent" : "bg-ok"}`} />
            <span className="text-muted">{statusText}</span>
          </div>
        </div>
        <div className="flex lg:flex-col gap-2 lg:w-full">
          <button
            onClick={togglePause}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium border ${
              profile.paused ? "bg-ok/15 border-ok/40 text-ok" : "border-line hover:bg-panel-2"
            }`}
            title="Pauzeert al het achtergrondwerk. Chatten blijft mogelijk."
          >
            {profile.paused ? "▶ Hervatten" : "⏸ Pauzeren"}
          </button>
          <Link href="/create" className="hidden lg:block text-center rounded-lg px-3 py-1.5 text-sm border border-line hover:bg-panel-2">
            Uiterlijk aanpassen
          </Link>
          <button onClick={logout} className="hidden lg:block rounded-lg px-3 py-1.5 text-sm text-muted hover:text-fg">
            Uitloggen
          </button>
        </div>
        <div className="hidden lg:block mt-auto text-[11px] text-muted" title="Realtime-verbinding">
          {live ? "● live" : "○ verbinden…"}
        </div>
      </aside>

      {/* Mobiel: wissel tussen chat en paneel */}
      <div className="lg:hidden flex border-b border-line text-sm">
        {(["chat", "panel"] as const).map((v) => (
          <button
            key={v}
            onClick={() => setMobileView(v)}
            className={`flex-1 py-2 ${mobileView === v ? "text-fg border-b-2 border-accent" : "text-muted"}`}
          >
            {v === "chat" ? "Chat" : `Activiteit${waiting.length ? ` (${waiting.length})` : ""}`}
          </button>
        ))}
      </div>

      <main className={`flex-1 min-w-0 min-h-0 ${mobileView === "chat" ? "flex" : "hidden"} lg:flex flex-col`}>
        <Chat profile={profile} messages={messages} tasks={tasks} onMessage={upsertMessage} />
      </main>

      <section className={`lg:w-[420px] shrink-0 min-h-0 border-l border-line bg-panel ${mobileView === "panel" ? "flex" : "hidden"} lg:flex flex-col flex-1 lg:flex-none`}>
        <nav className="flex gap-1 px-3 pt-3 border-b border-line overflow-x-auto">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-3 py-2 text-sm whitespace-nowrap border-b-2 -mb-px ${
                tab === t.id ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg"
              }`}
            >
              {t.label}
              {t.count ? <span className="ml-1.5 text-[11px] bg-warn/20 text-warn rounded-full px-1.5">{t.count}</span> : null}
            </button>
          ))}
        </nav>
        <div className="flex-1 min-h-0 overflow-y-auto p-3">
          {tab === "activity" && <ActivityPanel tasks={tasks} drafts={drafts} paused={profile.paused} />}
          {tab === "memory" && <MemoryPanel memories={memories} cauraFleet={cauraFleet} />}
          {tab === "scheduled" && <SchedulePanel userId={userId} schedules={schedules} />}
          {tab === "audit" && <AuditPanel entries={audit} />}
        </div>
        <div className="lg:hidden flex gap-3 justify-center p-2 border-t border-line text-sm">
          <Link href="/create" className="text-muted hover:text-fg">Uiterlijk</Link>
          <button onClick={logout} className="text-muted hover:text-fg">Uitloggen</button>
        </div>
      </section>
    </div>
  );
}
