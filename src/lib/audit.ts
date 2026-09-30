import type { SupabaseClient } from "@supabase/supabase-js";

type AuditInput = {
  userId: string;
  actor: "agent" | "user" | "system";
  action: string;
  tool?: string | null;
  taskId?: string | null;
  input?: unknown;
  output?: unknown;
};

/** Houdt audit-regels klein: lange strings/objecten worden afgekapt. */
function compact(value: unknown, max = 2000): unknown {
  if (value === undefined || value === null) return null;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text.length <= max) return value;
  return { truncated: true, preview: text.slice(0, max) };
}

/** Schrijft één regel naar het audit-log. Faalt nooit hard: loggen mag de agent niet breken. */
export async function logAudit(db: SupabaseClient, entry: AuditInput) {
  const { error } = await db.from("dot_audit").insert({
    user_id: entry.userId,
    actor: entry.actor,
    action: entry.action,
    tool: entry.tool ?? null,
    task_id: entry.taskId ?? null,
    input: compact(entry.input),
    output: compact(entry.output),
  });
  if (error) console.error("audit insert failed", error.message);
}
