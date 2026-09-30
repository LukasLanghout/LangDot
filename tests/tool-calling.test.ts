import { describe, expect, it } from "vitest";
import { complete, llmConfig, verifyModels, type ToolDef } from "@/lib/llm";
import { liveModel } from "./helpers";

// LIVE: controleert dat GONKA_MODEL tool calling doet in OpenAI-vorm, via onze eigen provider-laag.
const weather: ToolDef = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Geeft het actuele weer voor een stad.",
    parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  },
};

describe.skipIf(!liveModel)("LIVE: tool calling van GONKA_MODEL", () => {
  it("het model bestaat in GET /models", async () => {
    await expect(verifyModels()).resolves.toBeUndefined();
  });

  it("roept de dummy-tool aan met geldige JSON (niet-streaming)", async () => {
    const r = await complete({ messages: [{ role: "user", content: "Wat is het weer in Utrecht? Gebruik de tool." }], tools: [weather] });
    expect(r.model.toLowerCase()).toBe(llmConfig().model.toLowerCase());
    expect(r.toolCalls[0]?.function.name).toBe("get_weather");
    expect(JSON.parse(r.toolCalls[0].function.arguments).city).toMatch(/utrecht/i);
    expect(r.usage.totalTokens).toBeGreaterThan(0);
  });

  it("idem met streaming, en er lekt geen <think> naar de tekst", async () => {
    let streamed = "";
    const r = await complete({
      messages: [{ role: "user", content: "Wat is het weer in Utrecht? Gebruik de tool." }],
      tools: [weather],
      onText: (d) => (streamed += d),
    });
    expect(r.toolCalls[0]?.function.name).toBe("get_weather");
    expect(streamed).not.toContain("<think>");
  });
});
