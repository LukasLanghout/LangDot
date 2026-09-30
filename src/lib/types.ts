export type TaskStatus = "pending" | "running" | "needs_input" | "done" | "cancelled" | "failed";

export type QA = { question: string; answer: string; approved?: boolean };

export type Step = {
  title: string;
  status: "pending" | "running" | "done";
  result?: string;
  note?: string;
  qa?: QA[];
};

export type Option = { label: string; approves: boolean };

export type PendingAction = { type: "approve_draft"; draft_id: string } | null;

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
  meta: { kind?: "question" | "task_done" | "task_failed" | "answer"; options?: Option[] } | null;
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
};

export type Draft = {
  id: string;
  user_id: string;
  task_id: string | null;
  channel: string;
  recipient: string | null;
  subject: string | null;
  body: string;
  status: "draft" | "approved" | "rejected";
  created_at: string;
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
