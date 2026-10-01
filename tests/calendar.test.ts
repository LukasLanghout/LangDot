import { afterEach, describe, expect, it } from "vitest";
import { approveAction, createAction, executePendingAction, rejectAction, validateEventPayload } from "@/lib/actions";
import { chatTools, executeTool } from "@/lib/agent/tools";
import { chatSystemPrompt } from "@/lib/agent/prompts";
import { execDeps, mailDeps, memoryStore, toolCtx } from "./helpers";
import { fakeAgentContext } from "./agent-fixtures";

const event = { summary: "Overleg Jan", start: "2026-10-02T14:00", end: "2026-10-02T15:00", attendees: ["jan@example.com"] };
const CAL_ON = { status: "active" as const, email: "me@example.com", canWrite: true };

afterEach(() => {
  delete process.env.MAX_EVENTS_PER_DAY;
});

describe("afspraak-validatie", () => {
  it("normaliseert tijden naar ISO met offset in Europe/Amsterdam", () => {
    const v = validateEventPayload(event);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.payload.start).toBe("2026-10-02T14:00:00.000+02:00");
      expect(v.payload.time_zone).toBe("Europe/Amsterdam");
    }
  });

  it("weigert eind vóór start, onbekende tijdzone, lege titel en ongeldige genodigden", () => {
    expect(validateEventPayload({ ...event, end: "2026-10-02T13:00" }).ok).toBe(false);
    expect(validateEventPayload({ ...event, time_zone: "Mars/Olympus" }).ok).toBe(false);
    expect(validateEventPayload({ ...event, summary: " " }).ok).toBe(false);
    expect(validateEventPayload({ ...event, attendees: ["geen-adres"] }).ok).toBe(false);
  });
});

describe("afspraak inplannen vereist een klik van de gebruiker", () => {
  async function newEvent(store = memoryStore()) {
    const r = await createAction(store, { userId: "user-1", taskId: null, type: "calendar_create_event", payload: event });
    if (!r.ok) throw new Error(r.error);
    return { store, action: r.action };
  }

  it("zonder goedkeuring wordt er niets ingepland (en geen uitnodiging verstuurd)", async () => {
    const { store, action } = await newEvent();
    const events: any[] = [];
    const r = await executePendingAction(execDeps(store, [], events), "user-1", action.id);
    expect(r).toMatchObject({ ok: false, code: "not_approved" });
    expect(events).toHaveLength(0);
  });

  it("na goedkeuring precies één keer, met het agenda-token", async () => {
    const { store, action } = await newEvent();
    const events: any[] = [];
    await approveAction(store, "user-1", action.id, { summary: "Overleg Jan (verzet)" });
    expect((await executePendingAction(execDeps(store, [], events), "user-1", action.id)).ok).toBe(true);
    expect((await executePendingAction(execDeps(store, [], events), "user-1", action.id)).ok).toBe(false);
    expect(events).toEqual([{ token: "token-google_calendar", summary: "Overleg Jan (verzet)", attendees: ["jan@example.com"] }]);
  });

  it("afgewezen afspraken kunnen niet meer ingepland worden", async () => {
    const { store, action } = await newEvent();
    const events: any[] = [];
    await rejectAction(store, "user-1", action.id);
    expect((await executePendingAction(execDeps(store, [], events), "user-1", action.id)).ok).toBe(false);
    expect(events).toHaveLength(0);
  });

  it("het daglimiet voor afspraken staat los van dat voor mails", async () => {
    process.env.MAX_EVENTS_PER_DAY = "1";
    const store = memoryStore();
    const events: any[] = [];
    const results = [];
    for (let i = 0; i < 2; i++) {
      const r = await createAction(store, { userId: "user-1", taskId: null, type: "calendar_create_event", payload: event });
      if (!r.ok) throw new Error(r.error);
      await approveAction(store, "user-1", r.action.id);
      results.push(await executePendingAction(execDeps(store, [], events), "user-1", r.action.id));
    }
    expect(results.map((r) => r.ok)).toEqual([true, false]);
    expect(results[1]).toMatchObject({ code: "daily_limit" });
  });
});

describe("agenda-tools voor het model", () => {
  it("zonder agenda-verbinding geen agenda-tools, wel request_connection", () => {
    const names = chatTools(toolCtx({ mailDeps: mailDeps(memoryStore()) })).map((t) => t.function.name);
    expect(names).not.toContain("calendar_create_event");
    expect(names).not.toContain("calendar_list_events");
    expect(names).toContain("request_connection");
  });

  it("calendar_create_event maakt alleen een voorstel; een injectie in de agenda verstuurt niets", async () => {
    const store = memoryStore();
    const events: any[] = [];
    const sent: any[] = [];
    const ctx = toolCtx({ mailDeps: mailDeps(store, sent, events), calendar: CAL_ON });

    const created = JSON.parse(await executeTool(ctx, "calendar_create_event", JSON.stringify(event)));
    expect(created.status).toBe("pending");
    expect(ctx.createdActionIds).toEqual([created.pending_action_id]);

    // Het model probeert het voorstel zelf uit te voeren via gmail_send (de generieke executor).
    const attempt = JSON.parse(await executeTool(ctx, "gmail_send", JSON.stringify({ pending_action_id: created.pending_action_id })));
    expect(attempt).toMatchObject({ ok: false, code: "not_approved" });
    expect(events).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("calendar_list_events levert de agenda als onbetrouwbare data", async () => {
    const ctx = toolCtx({ mailDeps: mailDeps(memoryStore()), calendar: CAL_ON });
    const out = await executeTool(ctx, "calendar_list_events", JSON.stringify({}));
    expect(out).toContain("<untrusted_web_content");
    expect(out).toContain("Tandarts");
  });

  it("de prompt vertelt hoe agenda-voorstellen werken als de agenda verbonden is", () => {
    const prompt = chatSystemPrompt(fakeAgentContext({ calendar: CAL_ON }));
    expect(prompt).toContain("calendar_create_event");
    expect(prompt).toContain("NIET dat hij al ingepland is");
  });
});
