// Minimale Groq-client (OpenAI-compatibele chat completions API) via fetch.
// Bewust zonder SDK: minder dependencies, en we hebben alleen chat + tool calls + streaming nodig.

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

export const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";

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

async function post(body: Record<string, unknown>): Promise<Response> {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error("GROQ_API_KEY ontbreekt");

  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return res;

    // Rate limit / tijdelijke fout: kort wachten en opnieuw.
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      const retryAfter = Number(res.headers.get("retry-after"));
      await sleep(Math.min((Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 2) * 1000, 8000));
      continue;
    }
    throw new GroqError(res.status, await res.text());
  }
  throw new Error("Groq: te veel pogingen");
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
