"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { uploadDocument } from "@/lib/documents/client-upload";
import type { ActionRow, Message, Profile, Task } from "@/lib/types";
import { DotAvatar } from "./DotAvatar";
import { Icon } from "./Icon";
import { ApprovalCard } from "./ApprovalCard";
import { Markdown, QuestionOptions, SourceChips, Spinner, btn, dayLabel, dayOf, formatTime } from "./ui";

const TOOL_LABELS: Record<string, string> = {
  web_search: "zoekt op het web",
  web_fetch: "leest een pagina",
  memory_read: "kijkt in het geheugen",
  memory_write: "onthoudt iets",
  create_task: "start een taak",
  cancel_task: "annuleert een taak",
  create_schedule: "plant een check-in",
  list_schedules: "kijkt naar je schema's",
  update_schedule: "past een schema aan",
  pause_schedule: "pauzeert een schema",
  run_now: "start een schema",
  delete_schedule: "stelt voor een schema te verwijderen",
  gmail_create_draft: "stelt een mail op",
  gmail_send: "verstuurt een goedgekeurde mail",
  gmail_search: "doorzoekt je mail",
  gmail_read: "leest een mail",
  request_connection: "vraagt om een verbinding",
  calendar_list_events: "kijkt in je agenda",
  calendar_free_slots: "zoekt vrije tijd",
  calendar_create_event: "stelt een afspraak voor",
  document_list: "bekijkt je documenten",
  document_read: "leest een document",
  document_search: "zoekt in je documenten",
  calculate: "rekent",
  datetime: "kijkt op de kalender",
};

type Streaming = { text: string; tools: string[]; error?: string };

/** Bijlage in het invoerveld, tijdens en na het uploaden. */
type Pending = { key: string; name: string; status: string; id?: string; failed?: boolean };

/**
 * Chronologisch, maar een antwoord staat altijd direct onder het bericht waar het bij hoort
 * (reply_to), ook als er intussen andere berichten (bv. van achtergrondtaken) zijn binnengekomen.
 */
function orderMessages(messages: Message[]) {
  const ids = new Set(messages.map((m) => m.id));
  const replies = new Map<string, Message[]>();
  for (const m of messages) {
    if (m.reply_to && ids.has(m.reply_to)) replies.set(m.reply_to, [...(replies.get(m.reply_to) ?? []), m]);
  }
  const out: Message[] = [];
  for (const m of messages) {
    if (m.reply_to && ids.has(m.reply_to)) continue;
    out.push(m, ...(replies.get(m.id) ?? []));
  }
  return out;
}

function greetingNow() {
  const h = Number(new Intl.DateTimeFormat("nl-NL", { hour: "numeric", hourCycle: "h23", timeZone: "Europe/Amsterdam" }).format(new Date())) % 24;
  return h < 6 ? "Goedenacht." : h < 12 ? "Goedemorgen." : h < 18 ? "Goedemiddag." : "Goedenavond.";
}

const KIND_LABEL: Record<string, string> = {
  question: "Wacht op jouw keuze",
  approval: "Wacht op jouw klik",
  task_done: "Taak afgerond",
  task_failed: "Taak mislukt",
};

/** Eén regel over wat de dot aan het doen is, inklapbaar als er meerdere stappen zijn. */
function ToolLine({ name, tools, active }: { name: string; tools: string[]; active: boolean }) {
  const [open, setOpen] = useState(false);
  const last = tools[tools.length - 1];
  return (
    <div className="text-[13px] text-faint mb-2">
      <button type="button" onClick={() => setOpen((o) => !o)} className="inline-flex items-center gap-2 hover:text-muted transition-colors" aria-expanded={open}>
        {active && <Spinner size={13} />}
        <span>{active ? `${name} ${TOOL_LABELS[last] ?? "werkt eraan"}…` : `${tools.length} ${tools.length === 1 ? "stap" : "stappen"}`}</span>
        {active && tools.length > 1 && <span>· {tools.length} stappen</span>}
        {tools.length > 1 && <Icon name="chevron-down" size={13} className={open ? "rotate-180 transition-transform" : "transition-transform"} />}
      </button>
      {open && (
        <ul className="mt-1.5 ml-5 space-y-0.5">
          {tools.map((t, i) => <li key={i}>{name} {TOOL_LABELS[t] ?? t}</li>)}
        </ul>
      )}
    </div>
  );
}

export function Chat({
  profile,
  messages,
  tasks,
  actions,
  onMessage,
}: {
  profile: Profile;
  messages: Message[];
  tasks: Task[];
  actions: ActionRow[];
  onMessage: (m: Message) => void;
}) {
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState<Streaming | null>(null);
  const [sending, setSending] = useState(false);
  const [attachments, setAttachments] = useState<Pending[]>([]);
  const [dragging, setDragging] = useState(false);
  const [greeting, setGreeting] = useState("Hallo.");
  const [lastSent, setLastSent] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const supabase = useMemo(() => createClient(), []);
  const uploading = attachments.some((a) => !a.id && !a.failed);
  const canSend = (input.trim().length > 0 || attachments.some((a) => a.id)) && !sending && !uploading;

  useEffect(() => setGreeting(greetingNow()), []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, streaming?.text, streaming?.tools.length]);

  function autoGrow(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  }

  async function addFiles(files: FileList | File[] | null) {
    for (const file of Array.from(files ?? [])) {
      const key = `${Date.now()}-${Math.random()}`;
      setAttachments((l) => [...l, { key, name: file.name, status: "voorbereiden…" }]);
      const update = (patch: Partial<Pending>) => setAttachments((l) => l.map((a) => (a.key === key ? { ...a, ...patch } : a)));
      try {
        const doc = await uploadDocument(supabase, profile.user_id, file, (s) => update({ status: s }));
        update({ id: doc.id, status: doc.status === "ready" ? "klaar" : doc.error ?? "niet leesbaar" });
      } catch (e) {
        update({ failed: true, status: e instanceof Error ? e.message : "mislukt" });
      }
    }
    if (fileRef.current) fileRef.current.value = "";
  }

  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const actionById = new Map(actions.map((a) => [a.id, a]));
  const ordered = orderMessages(messages);
  // Toon knoppen alleen bij de laatste vraag van een taak die nog op antwoord wacht.
  const lastQuestionId = new Map<string, string>();
  for (const m of messages) if (m.meta?.kind === "question" && m.task_id) lastQuestionId.set(m.task_id, m.id);

  function stop() {
    abortRef.current?.abort();
  }

  async function retryTask(id: string) {
    await fetch(`/api/tasks/${id}/retry`, { method: "POST" });
  }

  async function send(text: string) {
    const documentIds = attachments.filter((a) => a.id).map((a) => a.id!);
    const documents = attachments.filter((a) => a.id).map((a) => ({ id: a.id!, name: a.name }));
    if ((!text.trim() && !documentIds.length) || sending || uploading) return;
    setSending(true);
    setLastSent(text);
    setInput("");
    setAttachments([]);
    if (inputRef.current) inputRef.current.style.height = "auto";
    setStreaming({ text: "", tools: [] });
    const now = () => new Date().toISOString();
    let full = "";
    let userMessageId: string | null = null;
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, document_ids: documentIds }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => null);
        throw new Error(err?.error ?? "Dat lukte niet. Probeer het nog eens.");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          const ev = JSON.parse(line);
          if (ev.t === "user") {
            userMessageId = ev.id;
            onMessage({ id: ev.id, user_id: profile.user_id, role: "user", content: text || "Bekijk de bijgevoegde documenten.", task_id: null, meta: documents.length ? { documents } : null, created_at: now() });
          } else if (ev.t === "text") {
            full += ev.d;
            setStreaming((s) => (s ? { ...s, text: s.text + ev.d } : s));
          } else if (ev.t === "reset") {
            full = "";
            setStreaming((s) => (s ? { ...s, text: "" } : s));
          } else if (ev.t === "tool") {
            setStreaming((s) => (s ? { ...s, tools: [...s.tools, ev.name] } : s));
          } else if (ev.t === "done") {
            if (ev.id) {
              onMessage({ id: ev.id, user_id: profile.user_id, role: "assistant", content: (typeof ev.text === "string" && ev.text.trim()) || full.trim() || "…", task_id: null, reply_to: userMessageId, meta: ev.meta ?? null, created_at: now() });
            }
            setStreaming(null);
          } else if (ev.t === "error") {
            setStreaming((s) => ({ text: s?.text ?? "", tools: s?.tools ?? [], error: ev.message }));
          }
        }
      }
    } catch (e) {
      if (ctrl.signal.aborted) setStreaming(null); // gestopt door de gebruiker
      else setStreaming({ text: full, tools: [], error: e instanceof Error ? e.message : "Dat lukte niet. Probeer het nog eens." });
    } finally {
      abortRef.current = null;
      setSending(false);
      inputRef.current?.focus();
    }
  }

  const empty = messages.length === 0 && !streaming;

  return (
    <div
      className="relative flex-1 min-h-0 flex flex-col"
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
      onDrop={(e) => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files); }}
    >
      {dragging && (
        <div className="absolute inset-3 z-20 rounded-2xl border border-dashed border-accent-soft bg-bg/80 flex items-center justify-center text-muted pointer-events-none">
          Zet je bestand hier neer
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="mx-auto w-full max-w-[720px] px-5 pt-8 pb-40">
          {empty && (
            <div className="min-h-[55vh] flex flex-col items-center justify-center text-center fade-up">
              <DotAvatar look={profile} size={104} />
              <h1 className="serif text-[32px] leading-tight mt-6">{greeting}</h1>
              <p className="text-muted mt-2">Waar kan ik mee helpen?</p>
              <button onClick={() => send("Wat staat er vandaag in mijn agenda?")} className={`${btn.secondary} mt-6`}>
                Wat staat er vandaag in mijn agenda?
              </button>
            </div>
          )}

          <div className="space-y-6">
            {ordered.map((m, i) => {
              const prev = ordered[i - 1];
              const newDay = !prev || dayOf(prev.created_at) !== dayOf(m.created_at);
              const task = m.task_id ? taskById.get(m.task_id) : undefined;
              const isOpenQuestion = m.meta?.kind === "question" && task?.status === "needs_input" && lastQuestionId.get(task.id) === m.id;
              const firstOfRun = m.role === "assistant" && (!prev || prev.role !== "assistant" || newDay);
              const kindLabel = m.meta?.kind ? KIND_LABEL[m.meta.kind] : undefined;

              return (
                <div key={m.id} className="fade-up">
                  {newDay && (
                    <div className="flex justify-center my-4">
                      <span className="text-[13px] text-faint">{dayLabel(m.created_at)}</span>
                    </div>
                  )}

                  {m.role === "user" ? (
                    <div className="group flex flex-col items-end">
                      <div className="max-w-[85%] rounded-[18px] bg-panel-2 px-4 py-2.5 whitespace-pre-wrap break-words">
                        {m.meta?.kind === "answer" && <div className="text-[13px] text-faint mb-0.5">antwoord op vraag</div>}
                        {m.content}
                        {!!m.meta?.documents?.length && (
                          <div className="mt-1.5 flex flex-wrap gap-1.5">
                            {m.meta.documents.map((d) => (
                              <span key={d.id} className="inline-flex items-center gap-1 text-[13px] rounded-full bg-panel border border-line px-2 py-0.5 text-muted">
                                <Icon name="paperclip" size={12} />{d.name}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                      <time className="text-[12px] text-faint mt-1 opacity-0 group-hover:opacity-100 transition-opacity" title={new Date(m.created_at).toLocaleString("nl-NL", { timeZone: "Europe/Amsterdam" })}>
                        {formatTime(m.created_at)}
                      </time>
                    </div>
                  ) : (
                    <div className="group flex gap-3">
                      <div className="w-8 shrink-0 pt-1">{firstOfRun && <DotAvatar look={profile} size={28} breathe={false} />}</div>
                      <div className="min-w-0 flex-1">
                        {kindLabel && <div className="text-[13px] text-faint mb-1">{kindLabel}</div>}
                        <div className={isOpenQuestion ? "rounded-2xl border border-line bg-panel px-4 py-3" : ""}>
                          <Markdown text={m.content} serif />
                          <SourceChips text={m.content} />
                          {isOpenQuestion && task && <QuestionOptions task={task} />}
                          {(m.meta?.action_ids ?? []).map((id) => {
                            const a = actionById.get(id);
                            return a ? <div key={id} className="mt-4"><ApprovalCard action={a} /></div> : null;
                          })}
                          {m.meta?.kind === "connect" && (
                            // Gewone link: de browser moet naar het toestemmingsscherm van Google navigeren.
                            <a
                              href={`/api/connectors/google/start?provider=${m.meta.provider === "google_calendar" ? "google_calendar" : "gmail"}`}
                              className={`${btn.primary} mt-3`}
                            >
                              {m.meta.provider === "google_calendar" ? "Google Agenda verbinden" : "Gmail verbinden"}
                            </a>
                          )}
                          {m.meta?.kind === "task_failed" && task && (task.status === "failed" || task.status === "cancelled") && task.source !== "chat_turn" && (
                            <button onClick={() => retryTask(task.id)} className={`${btn.secondary} mt-3`}>
                              <Icon name="retry" size={15} />Opnieuw proberen
                            </button>
                          )}
                        </div>
                        <time className="block text-[12px] text-faint mt-1 opacity-0 group-hover:opacity-100 transition-opacity" title={new Date(m.created_at).toLocaleString("nl-NL", { timeZone: "Europe/Amsterdam" })}>
                          {formatTime(m.created_at)}
                        </time>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}

            {streaming && (
              <div className="flex gap-3 fade-up">
                <div className="w-8 shrink-0 pt-1"><DotAvatar look={profile} size={28} status="busy" breathe={false} /></div>
                <div className="min-w-0 flex-1">
                  {streaming.tools.length > 0 && <ToolLine name={profile.name} tools={streaming.tools} active={!streaming.error && !streaming.text} />}
                  {streaming.text ? (
                    <div className={streaming.error ? "" : "streaming"}><Markdown text={streaming.text} serif /></div>
                  ) : !streaming.error && streaming.tools.length === 0 ? (
                    <div className="flex gap-1.5 py-2" aria-label="Aan het nadenken">
                      {[0, 1, 2].map((i) => <span key={i} className="w-1.5 h-1.5 rounded-full bg-faint pulse-dot" style={{ animationDelay: `${i * 0.2}s` }} />)}
                    </div>
                  ) : null}
                  {streaming.error && (
                    <p className="text-[15px] text-muted mt-1">
                      {streaming.error}{" "}
                      {lastSent && (
                        <button onClick={() => { setStreaming(null); send(lastSent); }} className="text-accent underline underline-offset-4 hover:text-[var(--c-accent-hover)]">
                          Opnieuw proberen
                        </button>
                      )}
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
          <div ref={bottomRef} />
        </div>
      </div>

      {/* Zwevend invoerveld */}
      <form
        onSubmit={(e) => { e.preventDefault(); send(input); }}
        className="absolute inset-x-0 bottom-0 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-6 pointer-events-none bg-gradient-to-t from-bg via-bg/80 to-transparent"
      >
        <div className="mx-auto w-full max-w-[720px] pointer-events-auto">
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-2">
              {attachments.map((a) => (
                <span key={a.key} className={`inline-flex items-center gap-1.5 text-[13px] rounded-full border px-2.5 h-7 glass ${a.failed ? "border-bad/50 text-bad" : "border-line text-muted"}`}>
                  <Icon name="paperclip" size={13} />
                  <span className="max-w-[12rem] truncate">{a.name}</span>
                  <span className="text-faint">{a.status}</span>
                  <button type="button" onClick={() => setAttachments((l) => l.filter((x) => x.key !== a.key))} className="hover:text-fg" aria-label={`Verwijder bijlage ${a.name}`}>
                    <Icon name="x" size={13} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="glass rounded-3xl border border-line flex items-end gap-1 p-2">
            <input ref={fileRef} type="file" multiple className="hidden" onChange={(e) => addFiles(e.target.files)} />
            <button type="button" onClick={() => fileRef.current?.click()} className="inline-flex items-center justify-center w-11 h-11 sm:w-10 sm:h-10 rounded-full text-faint hover:text-fg hover:bg-panel-2 transition-colors" aria-label="Bestand toevoegen" title="Bestand toevoegen (of sleep het hierheen)">
              <Icon name="paperclip" size={19} />
            </button>
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => { setInput(e.target.value); autoGrow(e.target); }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  if (canSend) send(input);
                }
              }}
              rows={1}
              placeholder={`Bericht aan ${profile.name}`}
              aria-label={`Bericht aan ${profile.name}`}
              className="flex-1 min-w-0 resize-none bg-transparent outline-none py-2.5 px-1 text-[16px] leading-snug max-h-[168px] placeholder:text-faint"
            />
            {sending ? (
              <button type="button" onClick={stop} className="inline-flex items-center justify-center w-11 h-11 sm:w-10 sm:h-10 rounded-full bg-panel-2 text-fg hover:bg-line transition-colors" aria-label="Stop" title="Stop">
                <Icon name="stop" size={17} />
              </button>
            ) : (
              <button
                disabled={!canSend}
                className="inline-flex items-center justify-center w-11 h-11 sm:w-10 sm:h-10 rounded-full bg-accent text-on-accent hover:bg-[var(--c-accent-hover)] disabled:bg-panel-2 disabled:text-faint transition-colors"
                aria-label="Versturen"
                title="Versturen"
              >
                <Icon name="send" size={18} />
              </button>
            )}
          </div>
        </div>
      </form>
    </div>
  );
}
