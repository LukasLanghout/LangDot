// Provider-laag voor het taalmodel. De rest van de app praat ALLEEN met `complete()`.
// Huidige provider: GonkaRouter (OpenAI-compatibel) via het officiële `openai`-pakket.
//
// Regels:
// - Uitsluitend GONKA_MODEL, plus GONKA_FALLBACK_MODELS als die expliciet gezet is (standaard leeg).
// - Strikt vastgepind: een antwoord waarvan het geserveerde model afwijkt, wordt geweigerd.
// - Retry met exponentiële backoff bij 429, 5xx en timeouts (max 3 keer).
// - Fouten naar de gebruiker zijn altijd LlmError (nette tekst); details alleen in de serverlog.
// - Tokenverbruik per gebruiker wordt bijgehouden en begrensd (zie budget.ts).

import OpenAI from "openai";
import { LlmError, type LlmErrorKind } from "@/lib/llm-errors";
import { checkBudget, recordUsage, type Usage } from "@/lib/budget";

export { LlmError } from "@/lib/llm-errors";
export type { Usage } from "@/lib/budget";

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type ToolDef = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

export type ToolChoice = "auto" | "none" | "required" | { type: "function"; function: { name: string } };

export type CompleteOptions = {
  messages: ChatMessage[];
  tools?: ToolDef[];
  toolChoice?: ToolChoice;
  temperature?: number;
  maxTokens?: number;
  /** Als gezet: streaming, tekst komt live binnen via deze callback. */
  onText?: (delta: string) => void;
  /** Voor het tokenbudget. Zonder userId geen budgetcontrole. */
  userId?: string | null;
};

export type CompleteResult = { content: string; toolCalls: ToolCall[]; usage: Usage; model: string };

// ───────────────────────────── Config ─────────────────────────────

export function llmConfig() {
  const model = (process.env.GONKA_MODEL || "MiniMaxAI/MiniMax-M2.7").trim();
  return {
    apiKey: process.env.GONKA_API_KEY || "",
    baseURL: (process.env.GONKA_BASE_URL || "https://api.gonkarouter.io/v1").trim(),
    model,
    fallbacks: (process.env.GONKA_FALLBACK_MODELS || "")
      .split(",").map((s) => s.trim()).filter((m) => m && m !== model),
  };
}

let client: OpenAI | null = null;

function getClient() {
  const cfg = llmConfig();
  if (!cfg.apiKey) throw new LlmError("config", "GONKA_API_KEY ontbreekt");
  if (!client) client = new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL, timeout: 60_000, maxRetries: 0 });
  return client;
}

// ───────────────────────────── Modelcontrole ─────────────────────────────

let modelCheck: Promise<void> | null = null;

/**
 * Controleert (één keer per serverinstantie) via GET /models dat GONKA_MODEL en eventuele
 * fallbacks bestaan. Kiest NOOIT zelf een ander model.
 */
export function verifyModels(): Promise<void> {
  if (!modelCheck) {
    modelCheck = (async () => {
      const cfg = llmConfig();
      let ids: Set<string>;
      try {
        const list: any = await getClient().models.list();
        ids = new Set(((list?.data ?? []) as { id: string }[]).map((m) => m.id));
      } catch (e) {
        if (e instanceof LlmError) throw e;
        // Controle zelf lukte niet (netwerk): niet blokkeren, volgende aanroep probeert opnieuw.
        console.warn("[llm] GET /models kon niet worden opgehaald:", describe(e));
        modelCheck = null;
        return;
      }
      for (const m of [cfg.model, ...cfg.fallbacks]) {
        if (!ids.has(m)) {
          console.error(`[llm] Model "${m}" staat niet in GET /models (${[...ids].join(", ")}). Controleer GONKA_MODEL / GONKA_FALLBACK_MODELS.`);
          throw new LlmError("config", `model ${m} niet beschikbaar`);
        }
      }
    })();
  }
  return modelCheck;
}

function sameModel(requested: string, served: string | undefined | null) {
  return !served || served.trim().toLowerCase() === requested.trim().toLowerCase();
}

function assertModel(requested: string, served: string | undefined | null) {
  if (!sameModel(requested, served)) {
    console.error(`[llm] Model-afwijking: gevraagd "${requested}", geserveerd "${served}". Antwoord geweigerd.`);
    throw new LlmError("model_mismatch", `requested ${requested}, served ${served}`);
  }
}

// ───────────────────────────── <think>-filter ─────────────────────────────
// Sommige modellen zetten hun redenering in de content. Getest met MiniMax-M2.7 via GonkaRouter:
//  - zonder tools:  "<think>…</think>\n\nAntwoord"
//  - mét tools:     "<think>…\n\n\nAntwoord"   (de sluittag ontbreekt; 3+ regelovergangen scheiden)
// Een think-blok eindigt daarom bij </think> óf bij de eerste reeks van 3+ regelovergangen.
// Losse </think>-tags worden altijd verwijderd. De redenering komt nooit bij de gebruiker.

export function stripThink(text: string) {
  let t = text.replace(/<think>[\s\S]*?<\/think>/g, "");
  const open = t.indexOf("<think>");
  if (open >= 0) {
    const rest = t.slice(open + 7);
    const m = rest.match(/\n{3,}/);
    t = t.slice(0, open) + (m && m.index !== undefined ? rest.slice(m.index + m[0].length) : "");
  }
  return t.split("</think>").join("").trim();
}

function partialSuffix(s: string, tag: string) {
  for (let k = Math.min(tag.length - 1, s.length); k > 0; k--) if (tag.startsWith(s.slice(-k))) return k;
  return 0;
}

/** Streaming-variant van stripThink: werkt ook als tags of regelovergangen over chunks verdeeld zijn. */
export class ThinkFilter {
  private buf = "";
  private inThink = false;
  private started = false;

  push(chunk: string): string {
    this.buf += chunk;
    let out = "";
    for (;;) {
      if (this.inThink) {
        const close = this.buf.indexOf("</think>");
        const nl = this.buf.search(/\n{3,}/);
        if (close >= 0 && (nl < 0 || close < nl)) {
          this.buf = this.buf.slice(close + 8);
          this.inThink = false;
          continue;
        }
        if (nl >= 0) {
          const run = /^\n+/.exec(this.buf.slice(nl))![0].length;
          if (nl + run === this.buf.length) {
            this.buf = this.buf.slice(nl); // de reeks regelovergangen kan nog doorlopen: wachten
            break;
          }
          this.buf = this.buf.slice(nl + run);
          this.inThink = false;
          continue;
        }
        this.buf = this.buf.slice(-7); // genoeg om een half binnengekomen "</think>" of "\n\n" te herkennen
        break;
      }

      this.buf = this.buf.split("</think>").join("");
      const start = this.buf.indexOf("<think>");
      if (start < 0) {
        const keep = Math.max(partialSuffix(this.buf, "<think>"), partialSuffix(this.buf, "</think>"));
        out += this.buf.slice(0, this.buf.length - keep);
        this.buf = this.buf.slice(this.buf.length - keep);
        break;
      }
      out += this.buf.slice(0, start);
      this.buf = this.buf.slice(start + 7);
      this.inThink = true;
    }
    return this.trimStart(out);
  }

  flush(): string {
    const rest = this.inThink ? "" : this.buf.split("</think>").join("");
    this.buf = "";
    return this.trimStart(rest);
  }

  private trimStart(s: string) {
    if (this.started) return s;
    const t = s.replace(/^\s+/, "");
    if (t) this.started = true;
    return t;
  }
}
// ───────────────────────────── Fouten & retry ─────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function describe(e: unknown) {
  if (e instanceof LlmError) return `${e.kind}: ${e.detail}`;
  const any = e as any;
  return `${any?.name ?? "Error"}${any?.status ? ` ${any.status}` : ""}: ${String(any?.message ?? e).slice(0, 500)}`;
}

function headerValue(headers: any, name: string): string | null {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  return headers[name] ?? headers[name.toLowerCase()] ?? null;
}

type Classified = { kind: LlmErrorKind; retryable: boolean; retryAfterMs?: number };

export function classify(e: unknown): Classified {
  if (e instanceof LlmError) return { kind: e.kind, retryable: false };
  const any = e as any;
  const name = String(any?.name ?? any?.constructor?.name ?? "");
  const status = typeof any?.status === "number" ? any.status : undefined;

  if (/timeout/i.test(name) || /timed? ?out/i.test(String(any?.message ?? ""))) return { kind: "unavailable", retryable: true };
  if (status === undefined && /connection/i.test(name)) return { kind: "unavailable", retryable: true };
  if (status === 429) {
    const ra = Number(headerValue(any?.headers, "retry-after"));
    return { kind: "rate_limit", retryable: true, retryAfterMs: Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined };
  }
  if (status !== undefined && status >= 500) return { kind: "unavailable", retryable: true };
  if (status === 401 || status === 403 || status === 404) return { kind: "config", retryable: false };
  if (status === 400 || status === 422) return { kind: "bad_request", retryable: false };
  return { kind: "unavailable", retryable: false };
}

const MAX_RETRIES = 3;

async function withRetry<T>(fn: () => Promise<T>, canRetry: () => boolean): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const c = classify(e);
      if (!c.retryable || attempt >= MAX_RETRIES || !canRetry()) throw e;
      const wait = c.retryAfterMs ?? Math.min(1000 * 2 ** attempt, 8000) + Math.floor(Math.random() * 300);
      if (wait > 20_000) throw e; // lange limiet: niet blijven hangen
      console.warn(`[llm] poging ${attempt + 1} mislukt (${describe(e)}), opnieuw over ${wait} ms`);
      await sleep(wait);
    }
  }
}

function toLlmError(e: unknown): LlmError {
  if (e instanceof LlmError) return e;
  return new LlmError(classify(e).kind, describe(e));
}

// ───────────────────────────── Aanroepen ─────────────────────────────

function params(model: string, opts: CompleteOptions) {
  const p: Record<string, unknown> = {
    model,
    messages: opts.messages,
    temperature: opts.temperature ?? 0.4,
    max_tokens: opts.maxTokens ?? 2048,
  };
  if (opts.tools?.length) {
    p.tools = opts.tools;
    p.tool_choice = opts.toolChoice ?? "auto";
  }
  return p;
}

function normalizeCalls(calls: any[]): ToolCall[] {
  return calls
    .filter((c) => c && c.function?.name)
    .map((c, i) => ({
      id: c.id || `call_${Date.now()}_${i}`,
      type: "function" as const,
      function: { name: String(c.function.name), arguments: String(c.function.arguments ?? "") },
    }));
}

function estimateTokens(text: string) {
  return Math.ceil(text.length / 4);
}

function toUsage(raw: any, opts: CompleteOptions, output: string): Usage {
  if (raw && typeof raw.total_tokens === "number") {
    return {
      promptTokens: Number(raw.prompt_tokens ?? 0),
      completionTokens: Number(raw.completion_tokens ?? 0),
      totalTokens: Number(raw.total_tokens),
    };
  }
  // Provider gaf geen usage: schatten, zodat het budget toch werkt.
  const promptTokens = estimateTokens(JSON.stringify(opts.messages));
  const completionTokens = estimateTokens(output);
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
}

async function once(model: string, opts: CompleteOptions): Promise<CompleteResult> {
  const res: any = await getClient().chat.completions.create(params(model, opts) as any);
  assertModel(model, res?.model);
  const msg = res?.choices?.[0]?.message ?? {};
  const content = stripThink(typeof msg.content === "string" ? msg.content : "");
  const toolCalls = normalizeCalls(Array.isArray(msg.tool_calls) ? msg.tool_calls : []);
  return { content, toolCalls, usage: toUsage(res?.usage, opts, content + JSON.stringify(toolCalls)), model: res?.model ?? model };
}

async function streamOnce(model: string, opts: CompleteOptions, state: { emitted: boolean }): Promise<CompleteResult> {
  const stream: any = await getClient().chat.completions.create({
    ...params(model, opts),
    stream: true,
    stream_options: { include_usage: true },
  } as any);

  const filter = new ThinkFilter();
  const calls: any[] = [];
  let content = "";
  let usage: any = null;
  let served: string | undefined;

  const emit = (text: string) => {
    if (!text) return;
    content += text;
    state.emitted = true;
    opts.onText!(text);
  };

  for await (const chunk of stream as AsyncIterable<any>) {
    if (!served && chunk?.model) {
      served = chunk.model;
      assertModel(model, served); // vóór er tekst naar de gebruiker gaat
    }
    if (chunk?.usage) usage = chunk.usage;
    const delta = chunk?.choices?.[0]?.delta;
    if (!delta) continue;
    if (typeof delta.content === "string" && delta.content) emit(filter.push(delta.content));
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const i: number = typeof tc.index === "number" ? tc.index : calls.length;
        if (!calls[i]) calls[i] = { id: "", function: { name: "", arguments: "" } };
        if (tc.id) calls[i].id = tc.id;
        if (tc.function?.name && !calls[i].function.name) calls[i].function.name = tc.function.name;
        if (tc.function?.arguments) calls[i].function.arguments += tc.function.arguments;
      }
    }
  }
  emit(filter.flush());

  const toolCalls = normalizeCalls(calls);
  return { content: content.trim(), toolCalls, usage: toUsage(usage, opts, content + JSON.stringify(toolCalls)), model: served ?? model };
}

/**
 * Eén chat completion (met tools), streaming als `onText` is meegegeven.
 * Gooit altijd een LlmError met een nette gebruikersmelding.
 */
export async function complete(opts: CompleteOptions): Promise<CompleteResult> {
  const cfg = llmConfig();
  await verifyModels();
  if (opts.userId) await checkBudget(opts.userId);

  let lastError: unknown = null;
  const state = { emitted: false };

  for (const model of [cfg.model, ...cfg.fallbacks]) {
    try {
      const result = await withRetry(
        () => (opts.onText ? streamOnce(model, opts, state) : once(model, opts)),
        () => !state.emitted, // nooit opnieuw proberen als de gebruiker al tekst zag
      );
      if (opts.userId) {
        await recordUsage(opts.userId, result.usage).catch((e) => console.error("[llm] usage opslaan mislukt:", describe(e)));
      }
      return result;
    } catch (e) {
      lastError = e;
      console.error(`[llm] ${model} faalde: ${describe(e)}`);
      if (state.emitted) break;
    }
  }
  throw toLlmError(lastError);
}
