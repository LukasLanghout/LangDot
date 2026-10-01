import type { ActionStatus, ActionStore, ExecDeps, PendingAction } from "@/lib/actions";
import type { MailToolDeps } from "@/lib/agent/mail-tools";
import type { ToolContext } from "@/lib/agent/tools";

/** In-memory ActionStore met dezelfde semantiek als de Supabase-versie (conditionele overgangen). */
export function memoryStore(): ActionStore & { rows: PendingAction[] } {
  const rows: PendingAction[] = [];
  let n = 0;
  return {
    rows,
    async get(id, userId) {
      return rows.find((r) => r.id === id && r.user_id === userId) ?? null;
    },
    async create({ userId, taskId, type, payload }) {
      const row = {
        id: `act_${++n}`,
        user_id: userId,
        task_id: taskId,
        type,
        payload,
        status: "pending",
        error: null,
        result: null,
        created_at: new Date().toISOString(),
        decided_at: null,
        executed_at: null,
      } as PendingAction;
      rows.push(row);
      return row;
    },
    async transition(id, userId, from: ActionStatus, to: ActionStatus, patch = {}) {
      const r = rows.find((x) => x.id === id && x.user_id === userId && x.status === from);
      if (!r) return null;
      Object.assign(r, patch, { status: to });
      return { ...r };
    },
    async update(id, userId, patch) {
      const r = rows.find((x) => x.id === id && x.user_id === userId);
      if (r) Object.assign(r, patch);
    },
    async countExecutedSince(userId, since, type) {
      return rows.filter((r) => r.user_id === userId && r.type === type && r.status === "executed" && r.executed_at && new Date(r.executed_at) >= since).length;
    },
  };
}

export function execDeps(
  store: ActionStore,
  sent: { token: string; to: string[]; subject: string }[] = [],
  events: { token: string; summary: string; attendees: string[] }[] = [],
): ExecDeps {
  return {
    store,
    getAccessToken: async (_userId, provider) => `token-${provider}`,
    send: async (token, payload) => {
      sent.push({ token, to: payload.to, subject: payload.subject });
      return `msg_${sent.length}`;
    },
    createEvent: async (token, payload) => {
      events.push({ token, summary: payload.summary, attendees: payload.attendees ?? [] });
      return `evt_${events.length}`;
    },
  };
}

export function mailDeps(
  store: ActionStore,
  sent: { token: string; to: string[]; subject: string }[] = [],
  events: { token: string; summary: string; attendees: string[] }[] = [],
): MailToolDeps {
  return {
    store,
    exec: execDeps(store, sent, events),
    getAccessToken: async () => "test-token",
    listEvents: async () => [{ id: "e1", summary: "Tandarts", start: "2026-10-02T09:00:00+02:00", end: "2026-10-02T09:30:00+02:00" }],
  };
}

/** Minimale nep-Supabase: alleen audit-inserts (executeTool logt elke call). */
export function fakeDb(auditLog: unknown[] = []) {
  return {
    from: () => ({
      insert: async (row: unknown) => {
        auditLog.push(row);
        return { error: null };
      },
    }),
  } as any;
}

export function toolCtx(overrides: Partial<ToolContext> & { mailDeps: MailToolDeps }): ToolContext {
  return {
    db: fakeDb(),
    userId: "user-1",
    taskId: null,
    origin: "chat",
    gmail: { status: "active", email: "me@example.com", canSend: true, canCompose: false, canRead: false },
    calendar: { status: "none", email: null, canWrite: false },
    createdActionIds: [],
    ...overrides,
  };
}

export const liveModel = !!process.env.GONKA_API_KEY;
