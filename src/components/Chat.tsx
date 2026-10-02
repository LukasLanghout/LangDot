"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { uploadDocument } from "@/lib/documents/client-upload";
import type { ActionRow, Message, Profile, Task } from "@/lib/types";
import { DotAvatar } from "./DotAvatar";
import { Markdown, QuestionOptions, StatusBadge, formatTime } from "./ui";
import { ApprovalCard } from "./ApprovalCard";

const TOOL_LABELS: Record<string, string> = {
  web_search: "zoekt op het web",
  web_fetch: "leest een pagina",
  memory_read: "kijkt in het geheugen",
  memory_write: "onthoudt iets",
  create_task: "maakt een taak",
  cancel_task: "annuleert een taak",
  create_schedule: "plant een check-in",
  gmail_create_draft: "stelt een mail op",
  gmail_send: "verstuurt een goedgekeurde mail",
  gmail_search: "doorzoekt je mail",
  gmail_read: "leest een mail",
  request_connection: "vraagt om een verbinding",
  document_list: "bekijkt je documenten",
  document_read: "leest een document",
  document_search: "zoekt in je documenten",
  calendar_list_events: "kijkt in je agenda",
  calendar_create_event: "stelt een afspraak voor",
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
  const fileRef = useRef<HTMLInputElement>(null);
  const supabase = useMemo(() => createClient(), []);
  const uploading = attachments.some((a) => !a.id && !a.failed);

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
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, streaming?.text, streaming?.tools.length]);

  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const actionById = new Map(actions.map((a) => [a.id, a]));
  const ordered = orderMessages(messages);
  // Toon knoppen alleen bij de laatste vraag van een taak die nog op antwoord wacht.
  const lastQuestionId = new Map<string, string>();
  for (const m of messages) if (m.meta?.kind === "question" && m.task_id) lastQuestionId.set(m.task_id, m.id);

  async function send(text: string) {
    const documentIds = attachments.filter((a) => a.id).map((a) => a.id!);
    const documents = attachments.filter((a) => a.id).map((a) => ({ id: a.id!, name: a.name }));
    if ((!text.trim() && !documentIds.length) || sending || uploading) return;
    setSending(true);
    setInput("");
    setAttachments([]);
    setStreaming({ text: "", tools: [] });
    const now = () => new Date().toISOString();
    let full = "";
    let userMessageId: string | null = null;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, document_ids: documentIds }),
      });
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => null);
        throw new Error(err?.error ?? `HTTP ${res.status}`);
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
      setStreaming({ text: full, tools: [], error: e instanceof Error ? e.message : "Er ging iets mis" });
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  }

  return (
    <>
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-6">
        <div className="max-w-2xl mx-auto space-y-4">
          {messages.length === 0 && !streaming && (
            <div className="text-center text-muted py-16">
              <div className="flex justify-center mb-4">
                <DotAvatar look={profile} size={96} />
              </div>
              <p className="font-medium text-fg">Hoi! Ik ben {profile.name}.</p>
              <p className="text-sm mt-1">Geef me een opdracht, of probeer:</p>
              <div className="flex flex-wrap gap-2 justify-center mt-4">
                {[
                  "Zoek 3 goede Italiaanse restaurants in Utrecht en maak een shortlist",
                  "Check elke werkdag om 9:00 Amsterdam tijd het tech-nieuws voor me",
                  "Onthoud dat ik liever korte antwoorden krijg",
                ].map((s) => (
                  <button key={s} onClick={() => send(s)} className="text-left text-sm border border-line rounded-xl px-3 py-2 hover:bg-panel max-w-xs">
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {ordered.map((m) => {
            const task = m.task_id ? taskById.get(m.task_id) : undefined;
            const isOpenQuestion =
              m.meta?.kind === "question" && task?.status === "needs_input" && lastQuestionId.get(task.id) === m.id;
            if (m.role === "user") {
              return (
                <div key={m.id} className="flex justify-end">
                  <div className="max-w-[85%] rounded-2xl rounded-br-md bg-accent/20 border border-accent/30 px-4 py-2.5 whitespace-pre-wrap break-words">
                    {m.meta?.kind === "answer" && <div className="text-[11px] text-muted mb-0.5">antwoord op vraag</div>}
                    {m.content}
                    {!!m.meta?.documents?.length && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {m.meta.documents.map((d) => (
                          <span key={d.id} className="text-[11px] rounded-full bg-panel/60 border border-line px-2 py-0.5">📎 {d.name}</span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              );
            }
            return (
              <div key={m.id} className="flex gap-3 items-start">
                <div className="shrink-0 mt-0.5"><DotAvatar look={profile} size={28} /></div>
                <div className="min-w-0 max-w-[90%]">
                  <div className={`rounded-2xl rounded-tl-md px-4 py-2.5 break-words ${
                    isOpenQuestion ? "bg-warn/10 border border-warn/40" : "bg-panel border border-line"
                  }`}>
                    {task && m.meta?.kind && (
                      <div className="flex items-center gap-2 mb-1 text-[11px] text-muted">
                        <span>{m.meta.kind === "question" || m.meta.kind === "approval" ? "Beslissing nodig" : m.meta.kind === "task_done" ? "Taak afgerond" : "Taak"}</span>
                        <StatusBadge status={task.status} />
                      </div>
                    )}
                    <Markdown text={m.content} />
                    {isOpenQuestion && task && <QuestionOptions task={task} />}
                    {(m.meta?.action_ids ?? []).map((id) => {
                      const a = actionById.get(id);
                      return a ? <div key={id} className="mt-3"><ApprovalCard action={a} /></div> : null;
                    })}
                    {m.meta?.kind === "connect" && (
                      // Gewone link: de browser moet naar het toestemmingsscherm van Google navigeren.
                      <a
                        href={`/api/connectors/google/start?provider=${m.meta.provider === "google_calendar" ? "google_calendar" : "gmail"}`}
                        className="inline-block mt-3 rounded-lg bg-accent text-white px-4 py-2 text-sm font-medium hover:brightness-110"
                      >
                        {m.meta.provider === "google_calendar" ? "Google Agenda verbinden" : "Gmail verbinden"}
                      </a>
                    )}
                  </div>
                  <div className="text-[11px] text-muted mt-1 ml-1">{formatTime(m.created_at)}</div>
                </div>
              </div>
            );
          })}

          {streaming && (
            <div className="flex gap-3 items-start">
              <div className="shrink-0 mt-0.5"><DotAvatar look={profile} size={28} busy /></div>
              <div className="min-w-0 max-w-[90%] rounded-2xl rounded-tl-md bg-panel border border-line px-4 py-2.5 break-words">
                {streaming.tools.length > 0 && (
                  <div className="text-[11px] text-muted mb-1 space-y-0.5">
                    {streaming.tools.map((t, i) => <div key={i}>↳ {profile.name} {TOOL_LABELS[t] ?? t}…</div>)}
                  </div>
                )}
                {streaming.text ? (
                  <Markdown text={streaming.text} />
                ) : !streaming.error ? (
                  <div className="typing text-muted text-lg leading-none"><span>•</span><span>•</span><span>•</span></div>
                ) : null}
                {streaming.error && <p className="text-bad text-sm mt-1">⚠ {streaming.error}</p>}
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          addFiles(e.dataTransfer.files);
        }}
        className={`border-t border-line p-3 ${dragging ? "bg-accent/10" : ""}`}
      >
        {attachments.length > 0 && (
          <div className="max-w-2xl mx-auto flex flex-wrap gap-1.5 mb-2">
            {attachments.map((a) => (
              <span
                key={a.key}
                className={`text-xs rounded-full border px-2.5 py-1 flex items-center gap-1.5 ${
                  a.failed ? "border-bad/50 text-bad" : a.id ? "border-line" : "border-line text-muted"
                }`}
              >
                📎 <span className="max-w-[12rem] truncate">{a.name}</span>
                <span className="text-muted">· {a.status}</span>
                <button type="button" onClick={() => setAttachments((l) => l.filter((x) => x.key !== a.key))} className="hover:text-fg" aria-label="Verwijder bijlage">✕</button>
              </span>
            ))}
          </div>
        )}
        <div className="max-w-2xl mx-auto flex gap-2 items-end">
          <input ref={fileRef} type="file" multiple className="hidden" onChange={(e) => addFiles(e.target.files)} />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            title="Bestand toevoegen (of sleep het hierheen)"
            className="rounded-xl border border-line px-3 py-2.5 hover:bg-panel"
          >
            📎
          </button>
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(input);
              }
            }}
            rows={1}
            placeholder={`Bericht aan ${profile.handle}…`}
            className="flex-1 min-w-0 resize-none max-h-40 rounded-xl bg-panel border border-line px-4 py-2.5 outline-none focus:border-accent"
          />
          <button
            disabled={sending || uploading || (!input.trim() && !attachments.some((a) => a.id))}
            className="rounded-xl bg-accent text-white px-4 py-2.5 font-medium disabled:opacity-40 hover:brightness-110"
          >
            Stuur
          </button>
        </div>
      </form>
    </>
  );
}
