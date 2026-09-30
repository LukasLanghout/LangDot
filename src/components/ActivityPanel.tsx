"use client";

import { useState } from "react";
import type { ActionRow, Task } from "@/lib/types";
import { Markdown, QuestionOptions, StatusBadge, formatTime } from "./ui";
import { ApprovalCard } from "./ApprovalCard";

function StepIcon({ status }: { status: string }) {
  if (status === "done") return <span className="text-ok">✓</span>;
  if (status === "running") return <span className="text-accent animate-pulse">●</span>;
  return <span className="text-muted">○</span>;
}

function TaskCard({ task, actions }: { task: Task; actions: ActionRow[] }) {
  const active = task.status === "pending" || task.status === "running" || task.status === "needs_input";
  const [open, setOpen] = useState(active);
  const [cancelling, setCancelling] = useState(false);
  const steps = Array.isArray(task.steps) ? task.steps : [];
  const doneCount = steps.filter((s) => s.status === "done").length;

  async function cancel() {
    if (!confirm(`Taak "${task.title}" annuleren?`)) return;
    setCancelling(true);
    await fetch(`/api/tasks/${task.id}/cancel`, { method: "POST" });
    setCancelling(false);
  }

  return (
    <div className={`rounded-xl border p-3 ${task.status === "needs_input" ? "border-warn/50 bg-warn/5" : "border-line bg-panel-2"}`}>
      <div className="flex items-start gap-2">
        <button onClick={() => setOpen((o) => !o)} className="flex-1 min-w-0 text-left">
          <div className="font-medium text-sm leading-snug">
            {task.source === "schedule" && <span title="Geplande check-in">📅 </span>}
            {task.source === "chat_turn" && <span title="Vanuit de chat">💬 </span>}
            {task.title}
          </div>
          <div className="text-[11px] text-muted mt-0.5">
            {formatTime(task.created_at)}
            {steps.length > 0 && ` · ${doneCount}/${steps.length} stappen`}
          </div>
        </button>
        <StatusBadge status={task.status} />
      </div>

      {steps.length > 0 && (
        <div className="h-1 bg-line rounded-full mt-2 overflow-hidden">
          <div className="h-full bg-accent transition-all" style={{ width: `${(doneCount / steps.length) * 100}%` }} />
        </div>
      )}

      {task.status === "needs_input" && task.question && !task.pending_action && (
        <div className="mt-3 text-sm">
          <div className="font-medium">{task.question}</div>
          <QuestionOptions task={task} />
        </div>
      )}

      {/* Mails die op goedkeuring wachten: altijd zichtbaar, ook als de kaart is ingeklapt. */}
      {actions.filter((a) => a.status === "pending").map((a) => (
        <div key={a.id} className="mt-3"><ApprovalCard action={a} /></div>
      ))}

      {open && (
        <div className="mt-3 space-y-2 text-sm">
          {steps.length === 0 && task.status === "running" && <div className="text-muted text-xs">Plan maken…</div>}
          {steps.length === 0 && task.status === "pending" && <div className="text-muted text-xs">Staat in de wachtrij.</div>}
          <ol className="space-y-1.5">
            {steps.map((s, i) => (
              <li key={i} className="flex gap-2">
                <StepIcon status={s.status} />
                <div className="min-w-0">
                  <div className={s.status === "done" ? "text-muted" : ""}>{s.title}</div>
                  {s.note && s.status !== "done" && <div className="text-[11px] text-muted">{s.note}</div>}
                </div>
              </li>
            ))}
          </ol>
          {actions.filter((a) => a.status !== "pending").map((a) => <ApprovalCard key={a.id} action={a} />)}
          {task.result && (
            <div className="rounded-lg bg-bg/40 border border-line p-2.5 text-[13px]">
              <Markdown text={task.result} />
            </div>
          )}
          {task.error && task.status !== "done" && <div className="text-xs text-bad">Fout: {task.error}</div>}
        </div>
      )}

      {active && (
        <div className="mt-2 flex justify-end">
          <button onClick={cancel} disabled={cancelling} className="text-xs text-muted hover:text-bad disabled:opacity-50">
            {cancelling ? "Annuleren…" : "Annuleer taak"}
          </button>
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
    <div className="space-y-4">
      {paused && (
        <div className="rounded-lg border border-warn/40 bg-warn/10 text-warn text-sm px-3 py-2">
          Achtergrondwerk staat op pauze. Chatten kan gewoon.
        </div>
      )}
      <section>
        <h2 className="text-xs uppercase tracking-wide text-muted mb-2">Actief</h2>
        {active.length === 0 ? (
          <p className="text-sm text-muted">Geen lopende taken. Geef je dot een opdracht in de chat.</p>
        ) : (
          <div className="space-y-2">{active.map((t) => <TaskCard key={t.id} task={t} actions={actionsByTask(t.id)} />)}</div>
        )}
      </section>
      {finished.length > 0 && (
        <section>
          <h2 className="text-xs uppercase tracking-wide text-muted mb-2">Afgerond</h2>
          <div className="space-y-2">{finished.map((t) => <TaskCard key={t.id} task={t} actions={actionsByTask(t.id)} />)}</div>
        </section>
      )}
    </div>
  );
}
