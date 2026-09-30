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
    async create({ userId, taskId, payload }) {
      const row: PendingAction = {
        id: `act_${++n}`,
        user_id: userId,
        task_id: taskId,
        type: "gmail_send",
        payload,
        status: "pending",
        error: null,
        result: null,
        created_at: new Date().toISOString(),
        decided_at: null,
        executed_at: null,
      };
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
    async countExecutedSince(userId, since) {
      return rows.filter((r) => r.user_id === userId && r.status === "executed" && r.executed_at && new Date(r.executed_at) >= since).length;
    },
  };
}

export function execDeps(store: ActionStore, sent: { token: string; to: string[]; subject: string }[] = []): ExecDeps {
  return {
    store,
    getAccessToken: async () => "test-token",
    send: async (token, payload) => {
      sent.push({ token, to: payload.to, subject: payload.subject });
      return `msg_${sent.length}`;
    },
  };
}

export function mailDeps(store: ActionStore, sent: { token: string; to: string[]; subject: string }[] = []): MailToolDeps {
  return { store, exec: execDeps(store, sent), getAccessToken: async () => "test-token" };
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
    createdActionIds: [],
    ...overrides,
  };
}

export const liveModel = !!process.env.GONKA_API_KEY;
