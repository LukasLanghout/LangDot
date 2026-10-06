"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import type { ActionRow, AuditEntry, DocumentRow, Memory, Message, Profile, Schedule, Task } from "@/lib/types";
import { DotAvatar, type DotStatus } from "./DotAvatar";
import { Icon, type IconName } from "./Icon";
import { Chat } from "./Chat";
import { ActivityPanel } from "./ActivityPanel";
import { MemoryPanel } from "./MemoryPanel";
import { SchedulePanel } from "./SchedulePanel";
import { AuditPanel } from "./AuditPanel";
import { PushToggle } from "./PushToggle";
import { ThemeToggle } from "./ThemeToggle";
import { DocumentsPanel } from "./DocumentsPanel";
import { railItem, RailLabel } from "./RailItem";
import { iconBtn } from "./ui";

type Initial = {
  messages: Message[];
  tasks: Task[];
  memories: Memory[];
  schedules: Schedule[];
  actions: ActionRow[];
  documents: DocumentRow[];
  audit: AuditEntry[];
};

type Tab = "activity" | "memory" | "documents" | "scheduled" | "audit";
type Row = { id: string | number };

const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: "activity", label: "Activity", icon: "activity" },
  { id: "memory", label: "Geheugen", icon: "bookmark" },
  { id: "documents", label: "Documenten", icon: "file" },
  { id: "scheduled", label: "Gepland", icon: "clock" },
  { id: "audit", label: "Audit-log", icon: "shield" },
];

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
  reauthNeeded,
}: {
  userId: string;
  initialProfile: Profile;
  initial: Initial;
  cauraFleet: string | null;
  reauthNeeded: string[];
}) {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);

  const [profile, setProfile] = useState(initialProfile);
  const [messages, setMessages] = useState(initial.messages);
  const [tasks, setTasks] = useState(initial.tasks);
  const [memories, setMemories] = useState(initial.memories);
  const [schedules, setSchedules] = useState(initial.schedules);
  const [actions, setActions] = useState(initial.actions);
  const [documents, setDocuments] = useState(initial.documents);
  const [audit, setAudit] = useState(initial.audit);
  const [tab, setTab] = useState<Tab>("activity");
  const [panelOpen, setPanelOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false); // mobiel menu
  const [railHover, setRailHover] = useState(false);
  const [railPinned, setRailPinned] = useState(false);

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
        documents: (p) =>
          p.eventType === "DELETE"
            ? setDocuments((l) => l.filter((x) => x.id !== p.old.id))
            : setDocuments((l) => upsert(l, p.new as DocumentRow, byCreatedDesc, 100)),
        pending_actions: (p) =>
          p.eventType === "DELETE"
            ? setActions((l) => l.filter((x) => x.id !== p.old.id))
            : setActions((l) => upsert(l, p.new as ActionRow, byCreatedDesc, 100)),
        dot_audit: (p) => p.eventType === "INSERT" && setAudit((l) => upsert(l, p.new as AuditEntry, byCreatedDesc, 200)),
        dot_profiles: (p) => p.eventType === "UPDATE" && setProfile((old) => ({ ...old, ...(p.new as Profile) })),
      };

      const ch = supabase.channel(`dot-${userId}`);
      for (const [table, handler] of Object.entries(handlers)) {
        ch.on("postgres_changes", { event: "*", schema: "public", table, filter: `user_id=eq.${userId}` }, handler);
        // DELETE-events zijn in Supabase niet filterbaar op kolom; die bevatten alleen de id.
        ch.on("postgres_changes", { event: "DELETE", schema: "public", table }, handler);
      }
      ch.subscribe();
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

  // Escape sluit paneel en menu.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPanelOpen(false);
        setMenuOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const activeTasks = tasks.filter((t) => t.status === "pending" || t.status === "running");
  const waiting = tasks.filter((t) => t.status === "needs_input");
  const busy = !profile.paused && activeTasks.length > 0;
  const dotStatus: DotStatus = waiting.length ? "waiting" : busy ? "busy" : "idle";

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

  const expanded = railHover || railPinned;

  /** De items van de zijbalk; op desktop in de rail, op mobiel in het menu. */
  const menuItems = (open: boolean, closeAfter = false) => (
    <>
      <button
        type="button"
        onClick={() => { togglePause(); if (closeAfter) setMenuOpen(false); }}
        aria-pressed={profile.paused}
        title={profile.paused ? "Hervatten: de dot werkt weer door" : "Pauzeren: stopt al het achtergrondwerk"}
        className={railItem}
      >
        <Icon name={profile.paused ? "play" : "pause"} size={18} className={`shrink-0 ${profile.paused ? "text-accent-soft" : ""}`} />
        <RailLabel expanded={open}>{profile.paused ? "Hervatten" : "Pauzeren"}</RailLabel>
      </button>
      <PushToggle expanded={open} />
      <Link href="/connections" className={railItem} title="Verbindingen">
        <Icon name="link" size={18} className="shrink-0" />
        <RailLabel expanded={open}>Verbindingen</RailLabel>
      </Link>
      <Link href="/create" className={railItem} title="Uiterlijk aanpassen">
        <Icon name="smile" size={18} className="shrink-0" />
        <RailLabel expanded={open}>Uiterlijk</RailLabel>
      </Link>
      <ThemeToggle expanded={open} />
    </>
  );

  return (
    <div className="h-dvh flex overflow-hidden bg-bg">
      {/* Desktop: smalle rail die uitklapt bij hover of klik */}
      <div className="hidden md:block relative w-16 shrink-0">
        <aside
          onMouseEnter={() => setRailHover(true)}
          onMouseLeave={() => setRailHover(false)}
          className={`absolute inset-y-0 left-0 z-30 flex flex-col py-3 px-3 border-r border-line transition-[width] duration-200 ${expanded ? "w-60 glass" : "w-16 bg-bg"}`}
          style={{ transitionTimingFunction: "var(--ease-calm)" }}
          aria-label="Menu"
        >
          <button
            type="button"
            onClick={() => setRailPinned((v) => !v)}
            aria-label={railPinned ? "Menu inklappen" : "Menu uitklappen"}
            className="flex items-center gap-3 rounded-xl px-0.5 py-1.5 mb-3 text-left hover:bg-panel-2 transition-colors overflow-hidden"
          >
            <DotAvatar look={profile} size={36} status={dotStatus} />
            {expanded && (
              <span className="min-w-0">
                <span className="serif block text-[18px] leading-tight truncate">{profile.name}</span>
                <span className="block text-[13px] text-faint truncate">{statusText}</span>
              </span>
            )}
          </button>
          <nav className="flex flex-col gap-0.5">{menuItems(expanded)}</nav>
          <button type="button" onClick={logout} title="Uitloggen" className={`${railItem} mt-auto`}>
            <Icon name="logout" size={18} className="shrink-0" />
            <RailLabel expanded={expanded}>Uitloggen</RailLabel>
          </button>
        </aside>
      </div>

      {/* Hoofdkolom */}
      <div className="flex-1 min-w-0 flex flex-col relative">
        <header className="flex items-center gap-2 h-14 px-3 sm:px-5 shrink-0 pt-[env(safe-area-inset-top)]">
          <button type="button" onClick={() => setMenuOpen(true)} className="md:hidden flex items-center gap-2.5 rounded-xl pr-2 min-h-11" aria-label="Menu openen">
            <DotAvatar look={profile} size={34} status={dotStatus} />
            <span className="serif text-[18px]">{profile.name}</span>
          </button>
          <span className="hidden md:block text-[13px] text-faint" aria-live="polite">{statusText}</span>
          <div className="ml-auto">
            <button type="button" onClick={() => setPanelOpen((v) => !v)} className={`${iconBtn} relative`} aria-label="Activiteit, geheugen en meer" aria-expanded={panelOpen} title="Activiteit, geheugen en meer">
              <Icon name="panel" size={19} />
              {(waiting.length > 0 || activeTasks.length > 0) && (
                <span className={`absolute top-2 right-2 w-2 h-2 rounded-full border-2 border-bg ${waiting.length ? "bg-accent-soft" : "bg-faint pulse-dot"}`} aria-hidden />
              )}
            </button>
          </div>
        </header>

        {reauthNeeded.length > 0 && (
          <Link href="/connections" className="mx-auto mb-2 flex items-center gap-2 rounded-full border border-line bg-panel px-4 py-1.5 text-[14px] text-muted hover:text-fg transition-colors">
            <Icon name="alert" size={15} className="text-warn" />
            Je verbinding met {reauthNeeded.join(" en ")} is verlopen. Opnieuw verbinden
          </Link>
        )}

        <main className="flex-1 min-h-0 flex flex-col">
          <Chat profile={profile} messages={messages} tasks={tasks} actions={actions} onMessage={upsertMessage} />
        </main>
      </div>

      {/* Uitschuifpaneel rechts (op mobiel een volledig scherm) */}
      {panelOpen && (
        <>
          <button type="button" aria-label="Paneel sluiten" onClick={() => setPanelOpen(false)} className="fixed inset-0 z-40 bg-black/20 sm:bg-transparent cursor-default" />
          <section
            role="dialog"
            aria-label="Activiteit en meer"
            className="fixed z-50 inset-0 sm:inset-y-0 sm:left-auto sm:right-0 sm:w-[380px] glass sm:border-l border-line flex flex-col slide-in-up sm:slide-in-right pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
          >
            <div className="flex items-center gap-2 px-4 h-14 shrink-0">
              <div role="tablist" aria-label="Onderdelen" className="flex items-center gap-0.5 rounded-xl bg-panel-2 p-1">
                {TABS.map((t) => {
                  const active = tab === t.id;
                  return (
                    <button
                      key={t.id}
                      role="tab"
                      aria-selected={active}
                      aria-label={t.label}
                      title={t.label}
                      onClick={() => setTab(t.id)}
                      className={`relative inline-flex items-center justify-center w-11 h-10 sm:w-10 sm:h-8 rounded-lg transition-colors ${active ? "bg-panel text-fg" : "text-muted hover:text-fg"}`}
                      style={active ? { boxShadow: "var(--shadow-card)" } : undefined}
                    >
                      <Icon name={t.icon} size={17} />
                      {t.id === "activity" && waiting.length > 0 && <span className="absolute top-1 right-1.5 w-1.5 h-1.5 rounded-full bg-accent-soft" aria-hidden />}
                    </button>
                  );
                })}
              </div>
              <button type="button" onClick={() => setPanelOpen(false)} className={`${iconBtn} ml-auto`} aria-label="Sluiten">
                <Icon name="x" size={19} />
              </button>
            </div>
            <h2 className="serif text-[24px] px-5 pb-2 shrink-0">{TABS.find((t) => t.id === tab)?.label}</h2>
            <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-6">
              {tab === "activity" && <ActivityPanel tasks={tasks} actions={actions} paused={profile.paused} />}
              {tab === "memory" && <MemoryPanel memories={memories} cauraFleet={cauraFleet} />}
              {tab === "documents" && <DocumentsPanel userId={userId} documents={documents} />}
              {tab === "scheduled" && <SchedulePanel userId={userId} schedules={schedules} />}
              {tab === "audit" && <AuditPanel entries={audit} />}
            </div>
          </section>
        </>
      )}

      {/* Mobiel menu als bottom sheet */}
      {menuOpen && (
        <>
          <button type="button" aria-label="Menu sluiten" onClick={() => setMenuOpen(false)} className="fixed inset-0 z-40 bg-black/25 cursor-default md:hidden" />
          <div role="dialog" aria-label="Menu" className="fixed z-50 inset-x-0 bottom-0 md:hidden glass rounded-t-3xl border-t border-line p-3 pb-[max(1rem,env(safe-area-inset-bottom))] slide-in-up">
            <div className="flex items-center gap-3 px-2 py-2 mb-1">
              <DotAvatar look={profile} size={44} status={dotStatus} />
              <div className="min-w-0">
                <div className="serif text-[20px] leading-tight truncate">{profile.name}</div>
                <div className="text-[13px] text-faint truncate">{profile.handle} · {statusText}</div>
              </div>
              <button type="button" onClick={() => setMenuOpen(false)} className={`${iconBtn} ml-auto`} aria-label="Sluiten"><Icon name="x" size={19} /></button>
            </div>
            <nav className="flex flex-col gap-0.5">{menuItems(true, true)}</nav>
            <button type="button" onClick={logout} className={`${railItem} mt-1`}>
              <Icon name="logout" size={18} className="shrink-0" />
              <RailLabel expanded>Uitloggen</RailLabel>
            </button>
          </div>
        </>
      )}
    </div>
  );
}
