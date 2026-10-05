// Supabase-implementatie van ActionStore en de standaard-afhankelijkheden voor uitvoeren.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { logAudit } from "@/lib/audit";
import { getAccessToken } from "@/lib/connectors/store";
import { sendGmail } from "@/lib/connectors/gmail";
import { createCalendarEvent } from "@/lib/connectors/calendar";
import { loadAttachment } from "@/lib/documents/store";
import type { ActionStore, ExecDeps, PendingAction } from "@/lib/actions";

export function supabaseActionStore(db: SupabaseClient = createAdminClient()): ActionStore {
  return {
    async get(id, userId) {
      const { data } = await db.from("pending_actions").select("*").eq("id", id).eq("user_id", userId).maybeSingle();
      return (data as PendingAction | null) ?? null;
    },
    async create({ userId, taskId, type, payload }) {
      const { data, error } = await db.from("pending_actions")
        .insert({ user_id: userId, task_id: taskId, type, payload, status: "pending" })
        .select("*").single();
      if (error) throw new Error(`pending_actions insert: ${error.message}`);
      return data as PendingAction;
    },
    async transition(id, userId, from, to, patch = {}) {
      const { data } = await db.from("pending_actions")
        .update({ ...patch, status: to })
        .eq("id", id).eq("user_id", userId).eq("status", from)
        .select("*").maybeSingle();
      return (data as PendingAction | null) ?? null;
    },
    async update(id, userId, patch) {
      await db.from("pending_actions").update(patch).eq("id", id).eq("user_id", userId);
    },
    async countExecutedSince(userId, since, type) {
      const { count } = await db.from("pending_actions")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId).eq("type", type).eq("status", "executed").gte("executed_at", since.toISOString());
      return count ?? 0;
    },
  };
}

export function defaultExecDeps(db: SupabaseClient = createAdminClient()): ExecDeps {
  return {
    store: supabaseActionStore(db),
    getAccessToken: (userId, provider) => getAccessToken(userId, provider, db),
    send: (token, payload, files) => sendGmail(token, { ...payload, gmailDraftId: payload.gmail_draft_id ?? null }, files),
    loadAttachment: (userId, documentId) => loadAttachment(userId, documentId, db),
    createEvent: (token, payload) => createCalendarEvent(token, payload),
    grantAutoSend: async (userId, payload) => {
      const { data } = await db.from("dot_schedules")
        .update({ auto_send: true, auto_send_to: payload.to, auto_send_granted_at: new Date().toISOString() })
        .eq("user_id", userId).in("id", payload.schedules.map((s) => s.id))
        .select("id");
      return data?.length ?? 0;
    },
    audit: (entry) => logAudit(db, { ...entry, actor: "system" }),
  };
}
