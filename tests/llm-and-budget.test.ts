import { afterEach, describe, expect, it } from "vitest";
import { checkBudget, recordUsage, type UsageStore } from "@/lib/budget";
import { LlmError, userSafeMessage } from "@/lib/llm-errors";
import { classify, collapseRepeat, llmConfig, safeArguments, stripThink, ThinkFilter } from "@/lib/llm";
import { toHistory, unverifiedClaimWarning } from "@/lib/agent/chat";

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

  it("losse sluittag zonder opening: alleen de tekst erna is het antwoord", () => {
    expect(stripThink("Top. De schema's draaien.</think>\n\nTop. De schema's draaien.")).toBe("Top. De schema's draaien.");
  });

  it("vangnet: een letterlijk herhaald antwoord wordt één keer getoond", () => {
    const a = "Top. De nieuwe schema's draaien nu. Eerste mailtjes komen morgenochtend om 08:20. 👍";
    expect(collapseRepeat(`${a} ${a}`)).toBe(a);
    expect(collapseRepeat(`${a}\n\n${a}`)).toBe(a);
    expect(collapseRepeat("Ja. Nee.")).toBe("Ja. Nee.");
    expect(collapseRepeat(`${a} En nog iets anders.`)).toBe(`${a} En nog iets anders.`);
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

describe("vangnet tegen verzonnen bevestigingen", () => {
  it("waarschuwt als een schema wordt bevestigd zonder create_schedule", () => {
    const w = unverifiedClaimWarning("Staat. ✅ Werkdagen 08:20 en 12:30. De nieuwe schema's draaien nu.", new Set());
    expect(w).toContain("géén schema aangemaakt");
  });

  it("zegt niets als create_schedule echt is aangeroepen", () => {
    expect(unverifiedClaimWarning("Het schema staat klaar: werkdagen 08:20.", new Set(["create_schedule"]))).toBe("");
  });

  it("waarschuwt bij 'is verstuurd' zonder mail-tool, maar niet bij een toekomstige mail", () => {
    expect(unverifiedClaimWarning("De mail is verstuurd.", new Set())).toContain("géén mail verstuurd");
    expect(unverifiedClaimWarning("De mail wordt morgen verstuurd.", new Set())).toBe("");
    expect(unverifiedClaimWarning("De mail is verstuurd.", new Set(["gmail_create_draft"]))).toBe("");
  });
});
describe("kapotte tool-argumenten komen nooit in de geschiedenis", () => {
  it("geldige JSON blijft ongewijzigd, leeg wordt {}", () => {
    expect(safeArguments('{"to":["a@b.nl"]}')).toBe('{"to":["a@b.nl"]}');
    expect(safeArguments("")).toBe("{}");
  });

  it("afgekapte JSON (lange mail bij max_tokens) wordt een onschadelijke marker, en blijft geldige JSON", () => {
    const broken = '{"to":["ljlanghout@gmail.com"],"subject":"Technieuws","body":"1. OpenAI lanceert';
    const safe = safeArguments(broken);
    expect(() => JSON.parse(safe)).not.toThrow();
    expect(JSON.parse(safe).__invalid).toBe(true);
  });

  it("executeTool meldt het model dat de aanroep ongeldig was (en voert niets uit)", async () => {
    const { executeTool } = await import("@/lib/agent/tools");
    const { mailDeps, memoryStore, toolCtx } = await import("./helpers");
    const store = memoryStore();
    const ctx = toolCtx({ mailDeps: mailDeps(store) });
    const out = JSON.parse(await executeTool(ctx, "gmail_create_draft", safeArguments('{"to":["a@b.nl"],"body":"afgekapt')));
    expect(out.error).toMatch(/ongeldig of afgekapt/);
    expect(store.rows).toHaveLength(0);
  });
});