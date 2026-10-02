import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AppShell } from "@/components/AppShell";
import { cauraEnabled, fleetFor } from "@/lib/caura";
import type { ActionRow, AuditEntry, DocumentRow, Memory, Message, Profile, Schedule, Task } from "@/lib/types";
import { calendarCapabilities, gmailCapabilities } from "@/lib/connectors/store";

export const dynamic = "force-dynamic";

export default async function Home() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase.from("dot_profiles").select("*").eq("user_id", user.id).maybeSingle();
  if (!profile) redirect("/create");

  const [messages, tasks, memories, schedules, actions, audit, gmail, calendar, documents] = await Promise.all([
    supabase.from("dot_messages").select("*").order("created_at", { ascending: false }).limit(100),
    supabase.from("dot_tasks").select("*").order("created_at", { ascending: false }).limit(50),
    supabase.from("dot_memories").select("*").order("updated_at", { ascending: false }),
    supabase.from("dot_schedules").select("*").order("created_at", { ascending: true }),
    supabase.from("pending_actions").select("*").order("created_at", { ascending: false }).limit(50),
    supabase.from("dot_audit").select("*").order("created_at", { ascending: false }).limit(150),
    gmailCapabilities(user.id).catch(() => null),
    calendarCapabilities(user.id).catch(() => null),
    supabase.from("documents").select("id, user_id, name, mime, size, storage_path, text_chars, status, error, pinned, created_at").order("created_at", { ascending: false }).limit(100),
  ]);

  return (
    <AppShell
      userId={user.id}
      cauraFleet={cauraEnabled() ? fleetFor(user.id) : null}
      reauthNeeded={[gmail?.status === "needs_reauth" ? "Gmail" : null, calendar?.status === "needs_reauth" ? "Google Agenda" : null].filter((x): x is string => !!x)}
      initialProfile={profile as Profile}
      initial={{
        messages: ((messages.data ?? []) as Message[]).reverse(),
        tasks: (tasks.data ?? []) as Task[],
        memories: (memories.data ?? []) as Memory[],
        schedules: (schedules.data ?? []) as Schedule[],
        actions: (actions.data ?? []) as ActionRow[],
        documents: (documents.data ?? []) as DocumentRow[],
        audit: (audit.data ?? []) as AuditEntry[],
      }}
    />
  );
}
