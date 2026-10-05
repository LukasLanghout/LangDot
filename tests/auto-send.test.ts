import { describe, expect, it } from "vitest";
import { approveAction, approveByStandingPermission, createAction, executePendingAction, validateAutoSendPayload } from "@/lib/actions";
import { gmailCreateDraft } from "@/lib/agent/mail-tools";
import { chatTools, executeTool } from "@/lib/agent/tools";
import { execDeps, mailDeps, memoryStore, toolCtx } from "./helpers";

const ME = "lukas@example.com";
const SCHEDULE = { id: "2f1c7a3e-1b2c-4d5e-8f90-123456789abc", title: "Technieuws ochtend", days: [1, 2, 3, 4, 5], time_of_day: "08:20", timezone: "Europe/Amsterdam" };
const ctx = (standing: { scheduleId: string; to: string } | null) => ({
  userId: "user-1", taskId: "task-1", canCompose: false, createdActionIds: [] as string[], standing,
});

describe("staande toestemming: automatisch mailen naar jezelf", () => {
  it("met toestemming gaat een mail aan het eigen adres direct weg, zonder kaart", async () => {
    const store = memoryStore();
    const sent: any[] = [];
    const c = ctx({ scheduleId: SCHEDULE.id, to: ME });
    const r = await gmailCreateDraft(mailDeps(store, sent), c, { to: [ME.toUpperCase()], subject: "Technieuws", body: "..." });
    expect(r).toMatchObject({ sent: true, auto: true });
    expect(sent).toHaveLength(1);
    expect(c.createdActionIds).toEqual([]);
    expect(store.rows[0]).toMatchObject({ status: "executed", approved_by: "standing" });
  });

  it("een mail aan iemand anders blijft altijd wachten op een klik, ook met toestemming", async () => {
    const store = memoryStore();
    const sent: any[] = [];
    for (const to of [["x@y.nl"], [ME, "x@y.nl"]]) {
      const c = ctx({ scheduleId: SCHEDULE.id, to: ME });
      const r = await gmailCreateDraft(mailDeps(store, sent), c, { to, subject: "a", body: "b" });
      expect(r).toMatchObject({ status: "pending" });
      expect(c.createdActionIds).toHaveLength(1);
    }
    expect(sent).toHaveLength(0);
  });

  it("zonder toestemming (chat of schema zonder auto_send) altijd een kaart", async () => {
    const store = memoryStore();
    const sent: any[] = [];
    const r = await gmailCreateDraft(mailDeps(store, sent), ctx(null), { to: [ME], subject: "a", body: "b" });
    expect(r).toMatchObject({ status: "pending" });
    expect(sent).toHaveLength(0);
  });

  it("de daglimiet geldt ook voor automatische mails", async () => {
    process.env.MAX_EMAILS_PER_DAY = "1";
    try {
      const store = memoryStore();
      const sent: any[] = [];
      const c = ctx({ scheduleId: SCHEDULE.id, to: ME });
      await gmailCreateDraft(mailDeps(store, sent), c, { to: [ME], subject: "1", body: "b" });
      const second = await gmailCreateDraft(mailDeps(store, sent), c, { to: [ME], subject: "2", body: "b" });
      expect(second).toMatchObject({ sent: false, code: "daily_limit" });
      expect(sent).toHaveLength(1);
    } finally {
      delete process.env.MAX_EMAILS_PER_DAY;
    }
  });

  it("approveByStandingPermission weigert agenda-acties en al afgehandelde acties", async () => {
    const store = memoryStore();
    const ev = await createAction(store, {
      userId: "user-1", taskId: null, type: "calendar_create_event",
      payload: { summary: "x", start: "2026-10-06T10:00", end: "2026-10-06T11:00" },
    });
    if (!ev.ok) throw new Error(ev.error);
    expect(await approveByStandingPermission(store, "user-1", ev.action.id, ME)).toBe(false);
  });
});

describe("de eenmalige toestemmingskaart", () => {
  it("zet auto_send pas aan na de klik van de gebruiker", async () => {
    const store = memoryStore();
    const granted: any[] = [];
    const deps = { ...execDeps(store), grantAutoSend: async (_u: string, p: any) => (granted.push(p), p.schedules.length) };
    const consent = await createAction(store, { userId: "user-1", taskId: null, type: "schedule_auto_send", payload: { to: ME, schedules: [SCHEDULE] } });
    if (!consent.ok) throw new Error(consent.error);

    expect((await executePendingAction(deps, "user-1", consent.action.id)).ok).toBe(false); // zonder klik: niets
    expect(granted).toHaveLength(0);
    await approveAction(store, "user-1", consent.action.id); // de klik
    expect((await executePendingAction(deps, "user-1", consent.action.id)).ok).toBe(true);
    expect(granted[0].to).toBe(ME);
  });

  it("valideert adres en schema-id's", () => {
    expect(validateAutoSendPayload({ to: "geen-adres", schedules: [SCHEDULE] }).ok).toBe(false);
    expect(validateAutoSendPayload({ to: ME, schedules: [{ ...SCHEDULE, id: "niet-een-uuid" }] }).ok).toBe(false);
    expect(validateAutoSendPayload({ to: ME, schedules: [SCHEDULE] }).ok).toBe(true);
  });

  it("create_schedule met auto_send_to_self vraagt alleen toestemming als Gmail verbonden is", async () => {
    const offered = chatTools(toolCtx({ mailDeps: mailDeps(memoryStore()) })).find((t) => t.function.name === "create_schedule");
    expect(JSON.stringify(offered)).toContain("auto_send_to_self");

    const inserted: any[] = [];
    const db = {
      from: (table: string) => ({
        insert: (row: any) => {
          if (table === "dot_schedules") inserted.push(row);
          return { select: () => ({ single: async () => ({ data: { id: SCHEDULE.id }, error: null }) }), then: (r: any) => r({ error: null }) };
        },
      }),
    } as any;
    const c = toolCtx({ mailDeps: mailDeps(memoryStore()), db, gmail: { status: "active", email: ME, canSend: true, canCompose: false, canRead: false } });
    const out = JSON.parse(await executeTool(c, "create_schedule", JSON.stringify({
      title: "Technieuws", prompt: "Technieuws met bronnen naar mij mailen", days: [1, 2, 3, 4, 5], time: "08:20", auto_send_to_self: true,
    })));
    expect(out.auto_send).toContain("toestemmingskaart");
    expect(c.autoSendSchedules?.[0]).toMatchObject({ id: SCHEDULE.id, time_of_day: "08:20" });
    expect(inserted[0].auto_send).toBeUndefined(); // het schema zelf staat NIET al op automatisch
  });
});
