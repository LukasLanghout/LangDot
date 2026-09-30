import { afterEach, describe, expect, it } from "vitest";
import { checkBudget, recordUsage, type UsageStore } from "@/lib/budget";
import { LlmError, userSafeMessage } from "@/lib/llm-errors";
import { classify, llmConfig, stripThink, ThinkFilter } from "@/lib/llm";
import { toHistory } from "@/lib/agent/chat";

function usageStore(): UsageStore & { map: Map<string, number> } {
  const map = new Map<string, number>();
  return {
    map,
    async get(u, d) { return map.get(`${u}:${d}`) ?? 0; },
    async add(u, d, usage) { map.set(`${u}:${d}`, (map.get(`${u}:${d}`) ?? 0) + usage.totalTokens); },
  };
}

afterEach(() => {
  delete process.env.DAILY_TOKEN_BUDGET;
  delete process.env.GONKA_FALLBACK_MODELS;
});

describe("dagelijks tokenbudget", () => {
  it("blokkeert zodra het budget op is, per gebruiker", async () => {
    process.env.DAILY_TOKEN_BUDGET = "1000";
    const store = usageStore();
    await expect(checkBudget("u1", store)).resolves.toBe(0);
    await recordUsage("u1", { promptTokens: 700, completionTokens: 300, totalTokens: 1000 }, store);
    await expect(checkBudget("u1", store)).rejects.toMatchObject({ kind: "budget" });
    await expect(checkBudget("u2", store)).resolves.toBe(0);
  });

  it("de gebruiker ziet een nette melding, geen interne details", () => {
    const e = new LlmError("budget", "user u1 used 1000 of 1000 tokens");
    expect(userSafeMessage(e)).not.toContain("1000");
    expect(userSafeMessage(new Error("Upstream API 429 model xyz"))).toBe("Er ging iets mis. Probeer het zo nog eens.");
  });
});

describe("modelpinning en foutclassificatie", () => {
  it("gebruikt alleen GONKA_MODEL, fallbacks alleen als ze expliciet gezet zijn", () => {
    expect(llmConfig().fallbacks).toEqual([]);
    process.env.GONKA_FALLBACK_MODELS = "a/b, c/d";
    expect(llmConfig().fallbacks).toEqual(["a/b", "c/d"]);
  });

  it("retry alleen bij 429, 5xx en timeouts", () => {
    expect(classify({ status: 429 }).retryable).toBe(true);
    expect(classify({ status: 503 }).retryable).toBe(true);
    expect(classify({ name: "APIConnectionTimeoutError" }).retryable).toBe(true);
    expect(classify({ status: 400 }).retryable).toBe(false);
    expect(classify({ status: 401 }).kind).toBe("config");
  });

  it("gebruikersmeldingen bevatten nooit een modelnaam", () => {
    for (const kind of ["rate_limit", "unavailable", "budget", "config", "model_mismatch", "bad_request"] as const) {
      expect(new LlmError(kind, "MiniMaxAI/MiniMax-M2.7").message).not.toMatch(/minimax|glm|gonka/i);
    }
  });
});

describe("<think>-blokken komen nooit bij de gebruiker", () => {
  it("strip bij een volledig antwoord", () => {
    expect(stripThink("<think>eerst nadenken</think>\n\nHallo!")).toBe("Hallo!");
    expect(stripThink("<think>afgebroken")).toBe("");
  });

  it("filtert ook als tags over stream-chunks verdeeld zijn", () => {
    const f = new ThinkFilter();
    const out = ["<th", "ink>De gebruiker", " wil…</thi", "nk>\n\nHet ", "antwoord is 4."].map((c) => f.push(c)).join("") + f.flush();
    expect(out).toBe("Het antwoord is 4.");
  });

  // Live gezien bij MiniMax-M2.7 met tools: geen sluittag, 3 regelovergangen als scheiding.
  const NO_CLOSE = "<think>De zoekopdracht leverde niets op. Ik moet eerlijk zijn.\n\n\nIk kon geen betrouwbare informatie vinden.\n\nWil je dat ik opnieuw zoek?";

  it("strip een think-blok zonder sluittag (niet-streaming)", () => {
    expect(stripThink(NO_CLOSE)).toBe("Ik kon geen betrouwbare informatie vinden.\n\nWil je dat ik opnieuw zoek?");
  });

  it("strip een think-blok zonder sluittag (streaming, willekeurige chunks)", () => {
    for (const size of [1, 2, 3, 5, 8, 13]) {
      const f = new ThinkFilter();
      let out = "";
      for (let i = 0; i < NO_CLOSE.length; i += size) out += f.push(NO_CLOSE.slice(i, i + size));
      out += f.flush();
      expect(out).toBe("Ik kon geen betrouwbare informatie vinden.\n\nWil je dat ik opnieuw zoek?");
    }
  });

  it("gewone alinea's (2 regelovergangen) in het antwoord blijven intact", () => {
    const f = new ThinkFilter();
    const text = "<think>kort</think>\n\nAlinea 1.\n\nAlinea 2.";
    let out = "";
    for (const ch of text) out += f.push(ch);
    expect(out + f.flush()).toBe("Alinea 1.\n\nAlinea 2.");
  });
});

describe("antwoorden horen bij het juiste bericht", () => {
  it("een onbeantwoord oud verzoek wordt als afgehandeld gemarkeerd", () => {
    const h = toHistory([
      { role: "user", content: "Zoek restaurants" },
      { role: "user", content: "Zoek restaurants" },
      { role: "assistant", content: "Hier zijn ze" },
    ]);
    expect(h.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(String(h[1].content)).toMatch(/geen antwoord/);
  });
});
