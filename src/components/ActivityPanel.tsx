"use client";

import { useState } from "react";
import type { ActionRow, Task } from "@/lib/types";
import { Markdown, QuestionOptions, StatusBadge, formatTime, btn } from "./ui";
import { ApprovalCard } from "./ApprovalCard";
import { Icon } from "./Icon";

function StepIcon({ status }: { status: string }) {
  if (status === "done") return <Icon name="check" size={14} className="text-ok mt-0.5 shrink-0" />;
  if (status === "running") return <span className="w-3.5 h-3.5 mt-0.5 shrink-0 flex items-center justify-center"><span className="w-1.5 h-1.5 rounded-full bg-accent-soft pulse-dot" /></span>;
  return <span className="w-3.5 h-3.5 mt-0.5 shrink-0 flex items-center justify-center"><span className="w-1.5 h-1.5 rounded-full border border-faint" /></span>;
}

function TaskCard({ task, actions }: { task: Task; actions: ActionRow[] }) {
  const active = task.status === "pending" || task.status === "running" || task.status === "needs_input";
  const [open, setOpen] = useState(active);
  const [cancelling, setCancelling] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const steps = Array.isArray(task.steps) ? task.steps : [];
  const doneCount = steps.filter((s) => s.status === "done").length;
  const canRetry = task.status === "failed" || task.status === "cancelled";

  async function cancel() {
    if (!confirm(`Taak "${task.title}" annuleren?`)) return;
    setCancelling(true);
    await fetch(`/api/tasks/${task.id}/cancel`, { method: "POST" });
    setCancelling(false);
  }

  async function retry() {
    setRetrying(true);
    setRetryError(null);
    const res = await fetch(`/api/tasks/${task.id}/retry`, { method: "POST" });
    if (!res.ok) setRetryError((await res.json().catch(() => null))?.error ?? "Opnieuw proberen lukte niet.");
    setRetrying(false);
  }

  return (
    <div className={`rounded-2xl border p-3.5 ${task.status === "needs_input" ? "border-accent-soft/60 bg-accent-soft/10" : "border-line bg-panel"}`}>
      <div className="flex items-start gap-2">
        <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex-1 min-w-0 text-left">
          <div className="font-medium text-[15px] leading-snug flex items-start gap-1.5">
            {task.source === "schedule" && <Icon name="repeat" size={14} className="text-faint mt-1 shrink-0" />}
            {task.source === "chat_turn" && <Icon name="activity" size={14} className="text-faint mt-1 shrink-0" />}
            <span className="min-w-0">{task.title}</span>
          </div>
          <div className="text-[13px] text-faint mt-0.5">
            {formatTime(task.created_at)}
            {steps.length > 0 && ` · ${doneCount}/${steps.length} stappen`}
          </div>
        </button>
        <StatusBadge status={task.status} />
      </div>

      {steps.length > 0 && (
        <div className="h-1 bg-line rounded-full mt-2.5 overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={doneCount} aria-label="Voortgang">
          <div className="h-full bg-accent-soft transition-all" style={{ width: `${(doneCount / steps.length) * 100}%` }} />
        </div>
      )}

      {task.status === "needs_input" && task.question && !task.pending_action && (
        <div className="mt-3 text-[15px]">
          <div className="font-medium">{task.question}</div>
          <QuestionOptions task={task} />
        </div>
      )}

      {/* Mails die op goedkeuring wachten: altijd zichtbaar, ook als de kaart is ingeklapt. */}
      {actions.filter((a) => a.status === "pending").map((a) => (
        <div key={a.id} className="mt-3"><ApprovalCard action={a} /></div>
      ))}

      {open && (
        <div className="mt-3 space-y-2.5 text-[15px]">
          {steps.length === 0 && task.status === "running" && <div className="text-faint text-[13px]">Plan maken…</div>}
          {steps.length === 0 && task.status === "pending" && <div className="text-faint text-[13px]">Staat in de wachtrij.</div>}
          <ol className="space-y-2">
            {steps.map((s, i) => (
              <li key={i} className="flex gap-2">
                <StepIcon status={s.status} />
                <div className="min-w-0">
                  <div className={s.status === "done" ? "text-muted" : ""}>{s.title}</div>
                  {s.note && s.status !== "done" && <div className="text-[13px] text-faint">{s.note}</div>}
                </div>
              </li>
            ))}
          </ol>
          {actions.filter((a) => a.status !== "pending").map((a) => <ApprovalCard key={a.id} action={a} />)}
          {task.result && (
            <div className="rounded-xl bg-bg border border-line p-3 text-[14px]">
              <Markdown text={task.result} />
            </div>
          )}
          {task.error && task.status !== "done" && (
            task.status === "failed" || task.status === "cancelled"
              ? <div className="text-[13px] text-bad">Fout: {task.error}</div>
              : <div className="text-[13px] text-muted flex items-center gap-1.5"><Icon name="clock" size={14} className="shrink-0" />{task.error}</div>
          )}
        </div>
      )}

      {(active || canRetry) && (
        <div className="mt-2 flex items-center justify-end gap-2">
          {retryError && <span className="text-[13px] text-bad mr-auto">{retryError}</span>}
          {canRetry && (
            <button onClick={retry} disabled={retrying} className={btn.secondary}>
              <Icon name="retry" size={15} />
              {retrying ? "Bezig…" : "Opnieuw proberen"}
            </button>
          )}
          {active && (
            <button onClick={cancel} disabled={cancelling} className="text-[13px] text-muted hover:text-bad disabled:opacity-50 min-h-11 sm:min-h-0 px-1">
              {cancelling ? "Annuleren…" : "Annuleer taak"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function ActivityPanel({ tasks, actions, paused }: { tasks: Task[]; actions: ActionRow[]; paused: boolean }) {
  const order = { needs_input: 0, running: 1, pending: 2 } as Record<string, number>;
  const active = tasks.filter((t) => t.status in order).sort((a, b) => order[a.status] - order[b.status]);
  const finished = tasks.filter((t) => !(t.status in order));
  const actionsByTask = (id: string) => actions.filter((a) => a.task_id === id);

  return (
    <div className="space-y-5">
      {paused && (
        <div className="rounded-xl border border-line bg-panel-2 text-muted text-[14px] px-3.5 py-2.5 flex items-center gap-2">
          <Icon name="pause" size={15} className="shrink-0" />
          Achtergrondwerk staat op pauze. Chatten kan gewoon.
        </div>
      )}
      <section>
        <h3 className="text-[13px] font-medium text-faint mb-2">Actief</h3>
        {active.length === 0 ? (
          <p className="text-[15px] text-muted">Geen lopende taken. Geef je dot een opdracht in de chat.</p>
        ) : (
          <div className="space-y-2.5">{active.map((t) => <TaskCard key={t.id} task={t} actions={actionsByTask(t.id)} />)}</div>
        )}
      </section>
      {finished.length > 0 && (
        <section>
          <h3 className="text-[13px] font-medium text-faint mb-2">Afgerond</h3>
          <div className="space-y-2.5">{finished.map((t) => <TaskCard key={t.id} task={t} actions={actionsByTask(t.id)} />)}</div>
        </section>
      )}
    </div>
  );
}
