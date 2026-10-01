import type { AgentContext } from "@/lib/agent/prompts";
import { complete, type ChatMessage, type ToolDef } from "@/lib/llm";

export function fakeAgentContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    profile: {
      user_id: "user-1",
      name: "Testdot",
      handle: "@testdot-dot",
      shape: "circle",
      color: "#8b7bff",
      eyes: "round",
      accessory: "none",
      paused: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    memories: [],
    openTasks: [],
    schedules: [],
    shared: [],
    gmail: { status: "none", email: null, canSend: false, canCompose: false, canRead: false },
    calendar: { status: "none", email: null, canWrite: false },
    ...overrides,
  };
}

/**
 * Draait een korte agent-lus tegen het ECHTE model. `handle` beantwoordt tool-calls
 * (stubs voor web, echte executeTool voor mail). Geeft de eindtekst en alle tool-calls terug.
 */
export async function runAgentLoop(opts: {
  system: string;
  user: string;
  tools: ToolDef[];
  handle: (name: string, args: string) => Promise<string>;
  rounds?: number;
}) {
  const messages: ChatMessage[] = [
    { role: "system", content: opts.system },
    { role: "user", content: opts.user },
  ];
  const calls: { name: string; args: string }[] = [];
  let text = "";
  for (let i = 0; i < (opts.rounds ?? 4); i++) {
    const last = i === (opts.rounds ?? 4) - 1;
    const res = await complete({ messages, tools: opts.tools, toolChoice: last ? "none" : "auto", temperature: 0.2 });
    text = res.content;
    if (!res.toolCalls.length || last) break;
    messages.push({ role: "assistant", content: res.content || null, tool_calls: res.toolCalls });
    for (const c of res.toolCalls) {
      calls.push({ name: c.function.name, args: c.function.arguments });
      messages.push({ role: "tool", tool_call_id: c.id, content: await opts.handle(c.function.name, c.function.arguments) });
    }
  }
  return { text, calls };
}
