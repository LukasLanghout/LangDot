"use client";

import { useEffect, useRef, useState } from "react";
import type { Message, Profile, Task } from "@/lib/types";
import { DotAvatar } from "./DotAvatar";
import { Markdown, QuestionOptions, StatusBadge, formatTime } from "./ui";

const TOOL_LABELS: Record<string, string> = {
  web_search: "zoekt op het web",
  web_fetch: "leest een pagina",
  memory_read: "kijkt in het geheugen",
  memory_write: "onthoudt iets",
  create_task: "maakt een taak",
  cancel_task: "annuleert een taak",
  create_schedule: "plant een check-in",
  draft_message: "schrijft een concept",
};

type Streaming = { text: string; tools: string[]; error?: string };

export function Chat({
  profile,
  messages,
  tasks,
  onMessage,
}: {
  profile: Profile;
  messages: Message[];
  tasks: Task[];
  onMessage: (m: Message) => void;
}) {
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState<Streaming | null>(null);
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, streaming?.text, streaming?.tools.length]);

  const taskById = new Map(tasks.map((t) => [t.id, t]));
  // Toon knoppen alleen bij de laatste vraag van een taak die nog op antwoord wacht.
  const lastQuestionId = new Map<string, string>();
  for (const m of messages) if (m.meta?.kind === "question" && m.task_id) lastQuestionId.set(m.task_id, m.id);

  async function send(text: string) {
    if (!text.trim() || sending) return;
    setSending(true);
    setInput("");
    setStreaming({ text: "", tools: [] });
    const now = () => new Date().toISOString();
    let full = "";

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
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
            onMessage({ id: ev.id, user_id: profile.user_id, role: "user", content: text, task_id: null, meta: null, created_at: now() });
          } else if (ev.t === "text") {
            full += ev.d;
            setStreaming((s) => (s ? { ...s, text: s.text + ev.d } : s));
          } else if (ev.t === "tool") {
            setStreaming((s) => (s ? { ...s, tools: [...s.tools, ev.name] } : s));
          } else if (ev.t === "done") {
            if (ev.id) {
              onMessage({ id: ev.id, user_id: profile.user_id, role: "assistant", content: full.trim() || "…", task_id: null, meta: null, created_at: now() });
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

          {messages.map((m) => {
            const task = m.task_id ? taskById.get(m.task_id) : undefined;
            const isOpenQuestion =
              m.meta?.kind === "question" && task?.status === "needs_input" && lastQuestionId.get(task.id) === m.id;
            if (m.role === "user") {
              return (
                <div key={m.id} className="flex justify-end">
                  <div className="max-w-[85%] rounded-2xl rounded-br-md bg-accent/20 border border-accent/30 px-4 py-2.5 whitespace-pre-wrap break-words">
                    {m.meta?.kind === "answer" && <div className="text-[11px] text-muted mb-0.5">antwoord op vraag</div>}
                    {m.content}
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
                        <span>{m.meta.kind === "question" ? "Beslissing nodig" : m.meta.kind === "task_done" ? "Taak afgerond" : "Taak"}</span>
                        <StatusBadge status={task.status} />
                      </div>
                    )}
                    <Markdown text={m.content} />
                    {isOpenQuestion && task && <QuestionOptions task={task} />}
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
        className="border-t border-line p-3"
      >
        <div className="max-w-2xl mx-auto flex gap-2 items-end">
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
            disabled={sending || !input.trim()}
            className="rounded-xl bg-accent text-white px-4 py-2.5 font-medium disabled:opacity-40 hover:brightness-110"
          >
            Stuur
          </button>
        </div>
      </form>
    </>
  );
}
