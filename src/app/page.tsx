import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AppShell } from "@/components/AppShell";
import type { AuditEntry, Draft, Memory, Message, Profile, Schedule, Task } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function Home() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase.from("dot_profiles").select("*").eq("user_id", user.id).maybeSingle();
  if (!profile) redirect("/create");

  const [messages, tasks, memories, schedules, drafts, audit] = await Promise.all([
    supabase.from("dot_messages").select("*").order("created_at", { ascending: false }).limit(100),
    supabase.from("dot_tasks").select("*").order("created_at", { ascending: false }).limit(50),
    supabase.from("dot_memories").select("*").order("updated_at", { ascending: false }),
    supabase.from("dot_schedules").select("*").order("created_at", { ascending: true }),
    supabase.from("dot_drafts").select("*").order("created_at", { ascending: false }).limit(50),
    supabase.from("dot_audit").select("*").order("created_at", { ascending: false }).limit(150),
  ]);

  return (
    <AppShell
      userId={user.id}
      initialProfile={profile as Profile}
      initial={{
        messages: ((messages.data ?? []) as Message[]).reverse(),
        tasks: (tasks.data ?? []) as Task[],
        memories: (memories.data ?? []) as Memory[],
        schedules: (schedules.data ?? []) as Schedule[],
        drafts: (drafts.data ?? []) as Draft[],
        audit: (audit.data ?? []) as AuditEntry[],
      }}
    />
  );
}
