export type TaskStatus = "pending" | "running" | "needs_input" | "done" | "cancelled" | "failed";

export type QA = { question: string; answer: string; approved?: boolean };

export type Step = {
  title: string;
  status: "pending" | "running" | "done";
  result?: string;
  note?: string;
  qa?: QA[];
};

/** Antwoordoptie van een keuzevraag (ask_user). Keuzevragen keuren nooit iets goed. */
export type Option = { label: string };

/** Koppeling van een taak aan een actie die op goedkeuring wacht ("gmail_send" = oude rijen). */
export type PendingAction = { type: "approval" | "gmail_send"; action_id: string } | null;

type ActionBase = {
  id: string;
  user_id: string;
  task_id: string | null;
  status: "pending" | "approved" | "rejected" | "executed" | "expired";
  error: string | null;
  result: Record<string, unknown> | null;
  created_at: string;
  decided_at: string | null;
  executed_at: string | null;
  approved_by?: string | null;
};

export type ActionRow =
  | (ActionBase & {
      type: "gmail_send";
      payload: {
        to: string[];
        subject: string;
        body: string;
        gmail_draft_id?: string | null;
        attachments?: { document_id: string; name: string; mime: string; size: number }[];
      };
    })
  | (ActionBase & {
      type: "calendar_create_event";
      payload: {
        summary: string;
        start: string;
        end: string;
        time_zone: string;
        location?: string | null;
        description?: string | null;
        attendees?: string[];
      };
    })
  | (ActionBase & {
      type: "schedule_auto_send";
      payload: { to: string; schedules: { id: string; title: string; days: number[]; time_of_day: string; timezone: string }[] };
    });

export type ConnectorRow = {
  id: string;
  provider: string;
  account_email: string | null;
  scopes: string[];
  status: "active" | "needs_reauth" | "revoked";
  last_used_at: string | null;
  created_at: string;
};

export type Profile = {
  user_id: string;
  name: string;
  handle: string;
  shape: string;
  color: string;
  eyes: string;
  accessory: string;
  paused: boolean;
  created_at: string;
  updated_at: string;
};

export type Task = {
  id: string;
  user_id: string;
  title: string;
  instructions: string;
  status: TaskStatus;
  steps: Step[];
  current_step: number;
  question: string | null;
  options: Option[] | null;
  answer: string | null;
  pending_action: PendingAction;
  result: string | null;
  error: string | null;
  source: string;
  schedule_id: string | null;
  attempts: number;
  step_count?: number;
  locked_until: string | null;
  created_at: string;
  updated_at: string;
};

export type Message = {
  id: string;
  user_id: string;
  role: "user" | "assistant";
  content: string;
  task_id: string | null;
  reply_to?: string | null;
  meta: {
    kind?: "question" | "task_done" | "task_failed" | "answer" | "approval" | "connect" | "error";
    options?: Option[];
    action_ids?: string[];
    provider?: string;
    documents?: { id: string; name: string }[];
  } | null;
  created_at: string;
};

export type MemoryKind = "preference" | "decision" | "work" | "fact";

export type Memory = {
  id: string;
  user_id: string;
  kind: MemoryKind;
  content: string;
  created_at: string;
  updated_at: string;
};

export type Schedule = {
  id: string;
  user_id: string;
  title: string;
  prompt: string;
  days: number[];
  time_of_day: string;
  timezone: string;
  active: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  created_at: string;
  /** Staande toestemming: automatisch mailen naar auto_send_to (eigen adres) zonder per-keer-goedkeuring. */
  auto_send?: boolean;
  auto_send_to?: string | null;
  auto_send_granted_at?: string | null;
};

export type AuditEntry = {
  id: number;
  user_id: string;
  actor: "agent" | "user" | "system";
  action: string;
  tool: string | null;
  task_id: string | null;
  input: unknown;
  output: unknown;
  created_at: string;
};

export const ACTIVE_STATUSES: TaskStatus[] = ["pending", "running", "needs_input"];

export type DocumentRow = {
  id: string;
  user_id: string;
  name: string;
  mime: string;
  size: number;
  storage_path: string | null;
  text_chars: number;
  status: "ready" | "unsupported" | "failed";
  error: string | null;
  pinned: boolean;
  created_at: string;
};