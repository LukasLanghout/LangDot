// Minimale Groq-client (OpenAI-compatibele chat completions API) via fetch.
// Bewust zonder SDK: minder dependencies, en we hebben alleen chat + tool calls + streaming nodig.

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

export const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-20b";

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

export type ChatOptions = {
  messages: ChatMessage[];
  tools?: ToolDef[];
  toolChoice?: ToolChoice;
  temperature?: number;
  maxTokens?: number;
};

export type ChatResult = { content: string; toolCalls: ToolCall[] };

export class GroqError extends Error {
  constructor(public status: number, body: string) {
    super(`Groq API ${status}: ${body.slice(0, 500)}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function buildBody(opts: ChatOptions, stream: boolean) {
  const body: Record<string, unknown> = {
    model: MODEL,
    messages: opts.messages,
    temperature: opts.temperature ?? 0.4,
    max_completion_tokens: opts.maxTokens ?? 2048,
    stream,
  };
  if (opts.tools?.length) {
    body.tools = opts.tools;
    body.tool_choice = opts.toolChoice ?? "auto";
  }
  return body;
}

/** Ruwe aanroep met een zelf samengestelde body (bv. voor built-in tools). */
export async function groqRequest(body: Record<string, unknown>): Promise<any> {
  const res = await post(body);
  return res.json();
}

/** Limiet van Groq bereikt (bv. tokens per dag). retryAfterMs = hoe lang wachten. */
export class RateLimitError extends Error {
  constructor(public retryAfterMs: number, public model: string) {
    super(
      `Groq-limiet bereikt voor ${model}. Probeer het over ${Math.max(1, Math.ceil(retryAfterMs / 60_000))} min opnieuw` +
        ` (of verhoog je limiet op console.groq.com).`,
    );
  }
}

/**
 * Dit model is nu niet bruikbaar: ongeldige tool-call, of het model bestaat niet (meer) / is
 * niet beschikbaar voor dit account. Probeer het volgende model.
 */
class SkipModelError extends GroqError {}

// Uitwijkmodellen hebben op Groq elk een eigen daglimiet. Het primaire model staat er ook in,
// zodat een onbruikbare GROQ_MODEL (bv. een Enterprise-only Llama) altijd terugvalt op gpt-oss.
const FALLBACK_MODELS = (process.env.GROQ_FALLBACK_MODELS ?? "openai/gpt-oss-20b,openai/gpt-oss-120b")
  .split(",").map((s) => s.trim()).filter(Boolean);

// Per serverless-instantie onthouden welk model tot wanneer op slot zit.
const exhaustedUntil = new Map<string, number>();

/** Leest de wachttijd uit de header of uit "Please try again in 22m54.6s". */
function retryAfterMs(res: Response, text: string) {
  const header = Number(res.headers.get("retry-after"));
  if (Number.isFinite(header) && header > 0) return header * 1000;
  const m = text.match(/try again in (?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?/);
  if (m && (m[1] || m[2] || m[3])) {
    return ((Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0)) * 1000;
  }
  return 5_000;
}

async function postOnce(body: Record<string, unknown>, model: string): Promise<Response> {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error("GROQ_API_KEY ontbreekt");

  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, model }),
    });
    if (res.ok) return res;

    if (res.status === 429) {
      const text = await res.text();
      const wait = retryAfterMs(res, text);
      // Korte limiet (per minuut): even wachten. Lange limiet (per dag): direct opgeven → uitwijkmodel.
      if (wait <= 10_000 && attempt < 2) {
        await sleep(wait);
        continue;
      }
      throw new RateLimitError(wait, model);
    }
    if (res.status >= 500 && attempt < 2) {
      await sleep(2000);
      continue;
    }
    const text = await res.text();
    if (
      (res.status === 400 && /tool_use_failed|model_decommissioned/.test(text)) ||
      ((res.status === 404 || res.status === 403) && /model/.test(text))
    ) {
      throw new SkipModelError(res.status, text);
    }
    throw new GroqError(res.status, text);
  }
  throw new Error("Groq: te veel pogingen");
}

/** Probeert het gevraagde model en valt bij een limiet terug op de uitwijkmodellen. */
async function post(body: Record<string, unknown>): Promise<Response> {
  const primary = String(body.model);
  const chain = [primary, ...FALLBACK_MODELS.filter((m) => m !== primary)];
  const available = chain.filter((m) => (exhaustedUntil.get(m) ?? 0) < Date.now());

  let lastLimit: RateLimitError | null = null;
  let lastSkip: SkipModelError | null = null;
  for (const model of available) {
    try {
      return await postOnce(body, model);
    } catch (e) {
      if (e instanceof SkipModelError) {
        console.warn(`groq: model ${model} overgeslagen (${e.message.slice(0, 160)})`);
        lastSkip = e;
        continue;
      }
      if (!(e instanceof RateLimitError)) throw e;
      exhaustedUntil.set(model, Date.now() + e.retryAfterMs);
      lastLimit = e;
    }
  }
  if (lastLimit) throw lastLimit;
  if (lastSkip) throw lastSkip;
  // Alles staat nog op slot uit een eerdere aanroep.
  const soonest = Math.min(...chain.map((m) => exhaustedUntil.get(m) ?? Date.now()));
  throw new RateLimitError(Math.max(soonest - Date.now(), 1000), primary);
}

function normalizeCalls(calls: ToolCall[]): ToolCall[] {
  return calls
    .filter((c) => c && c.function.name)
    .map((c, i) => ({ ...c, id: c.id || `call_${Date.now()}_${i}` }));
}

/** Eén (niet-streaming) chat completion. */
export async function chat(opts: ChatOptions): Promise<ChatResult> {
  const res = await post(buildBody(opts, false));
  const json = await res.json();
  const msg = json?.choices?.[0]?.message ?? {};
  return {
    content: typeof msg.content === "string" ? msg.content : "",
    toolCalls: normalizeCalls(Array.isArray(msg.tool_calls) ? msg.tool_calls : []),
  };
}

/** Streaming chat completion. Tekst gaat live naar onText; tool calls worden verzameld. */
export async function chatStream(opts: ChatOptions, onText: (delta: string) => void): Promise<ChatResult> {
  const res = await post(buildBody(opts, true));
  if (!res.body) throw new Error("Groq: lege stream");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  const calls: ToolCall[] = [];

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;

      let json: any;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      if (json.error) throw new GroqError(500, JSON.stringify(json.error));

      const delta = json.choices?.[0]?.delta;
      if (!delta) continue;

      if (typeof delta.content === "string" && delta.content) {
        content += delta.content;
        onText(delta.content);
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const i: number = typeof tc.index === "number" ? tc.index : calls.length;
          if (!calls[i]) calls[i] = { id: "", type: "function", function: { name: "", arguments: "" } };
          if (tc.id) calls[i].id = tc.id;
          if (tc.function?.name && !calls[i].function.name) calls[i].function.name = tc.function.name;
          if (tc.function?.arguments) calls[i].function.arguments += tc.function.arguments;
        }
      }
    }
  }

  return { content, toolCalls: normalizeCalls(calls) };
}
