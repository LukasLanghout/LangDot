import { afterEach, describe, expect, it } from "vitest";
import { approveAction, createEmailAction, executePendingAction, rejectAction, validateEmailPayload } from "@/lib/actions";
import { gmailSend } from "@/lib/agent/mail-tools";
import { execDeps, mailDeps, memoryStore } from "./helpers";

const mail = { to: ["jan@example.com"], subject: "Vrijdag", body: "Ik ben vrijdag iets later." };

afterEach(() => {
  delete process.env.MAX_EMAILS_PER_DAY;
  delete process.env.MAX_RECIPIENTS_PER_EMAIL;
});

async function newAction(store = memoryStore(), userId = "user-1") {
  const r = await createEmailAction(store, { userId, taskId: null, payload: mail });
  if (!r.ok) throw new Error(r.error);
  return { store, action: r.action };
}

describe("goedkeuring wordt in code afgedwongen", () => {
  it("gmail_send verstuurt NIETS zolang de gebruiker niet heeft goedgekeurd", async () => {
    const { store, action } = await newAction();
    const sent: any[] = [];
    const r = await gmailSend(mailDeps(store, sent), "user-1", { pending_action_id: action.id });
    expect(r).toMatchObject({ ok: false, sent: false, code: "not_approved" });
    expect(sent).toHaveLength(0);
    expect(store.rows[0].status).toBe("pending");
  });

  it("verstuurt na goedkeuring precies één keer", async () => {
    const { store, action } = await newAction();
    const sent: any[] = [];
    expect((await approveAction(store, "user-1", action.id)).ok).toBe(true);
    const first = await executePendingAction(execDeps(store, sent), "user-1", action.id);
    const second = await executePendingAction(execDeps(store, sent), "user-1", action.id);
    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: false, code: "already_executed" });
    expect(sent).toHaveLength(1);
    expect(store.rows[0].status).toBe("executed");
  });

  it("gelijktijdige verzendpogingen versturen maar één keer", async () => {
    const { store, action } = await newAction();
    const sent: any[] = [];
    await approveAction(store, "user-1", action.id);
    const results = await Promise.all([1, 2, 3].map(() => executePendingAction(execDeps(store, sent), "user-1", action.id)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  it("een andere gebruiker kan de actie niet goedkeuren of versturen", async () => {
    const { store, action } = await newAction();
    const sent: any[] = [];
    expect((await approveAction(store, "user-2", action.id)).ok).toBe(false);
    await approveAction(store, "user-1", action.id);
    const r = await executePendingAction(execDeps(store, sent), "user-2", action.id);
    expect(r).toMatchObject({ ok: false, code: "not_found" });
    expect(sent).toHaveLength(0);
  });

  it("een afgewezen mail kan nooit meer verstuurd of goedgekeurd worden", async () => {
    const { store, action } = await newAction();
    const sent: any[] = [];
    expect((await rejectAction(store, "user-1", action.id)).ok).toBe(true);
    expect((await approveAction(store, "user-1", action.id)).ok).toBe(false);
    expect((await executePendingAction(execDeps(store, sent), "user-1", action.id)).ok).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("bewerkte tekst bij goedkeuren is wat verstuurd wordt", async () => {
    const { store, action } = await newAction();
    const sent: any[] = [];
    await approveAction(store, "user-1", action.id, { subject: "Aangepast", to: "piet@example.com" });
    await executePendingAction(execDeps(store, sent), "user-1", action.id);
    expect(sent[0]).toMatchObject({ to: ["piet@example.com"], subject: "Aangepast" });
  });

  it("bij een verzendfout blijft de actie goedgekeurd zodat opnieuw proberen kan", async () => {
    const { store, action } = await newAction();
    await approveAction(store, "user-1", action.id);
    const deps = { ...execDeps(store), send: async () => { throw new Error("netwerk"); } };
    const r = await executePendingAction(deps, "user-1", action.id);
    expect(r).toMatchObject({ ok: false, code: "send_failed" });
    expect(store.rows[0].status).toBe("approved");
    expect(store.rows[0].error).toBeTruthy();
  });
});

describe("limieten", () => {
  it("maximaal N verstuurde mails per dag", async () => {
    process.env.MAX_EMAILS_PER_DAY = "2";
    const store = memoryStore();
    const sent: any[] = [];
    const results = [];
    for (let i = 0; i < 3; i++) {
      const r = await createEmailAction(store, { userId: "user-1", taskId: null, payload: mail });
      if (!r.ok) throw new Error(r.error);
      await approveAction(store, "user-1", r.action.id);
      results.push(await executePendingAction(execDeps(store, sent), "user-1", r.action.id));
    }
    expect(results.map((r) => r.ok)).toEqual([true, true, false]);
    expect(results[2]).toMatchObject({ code: "daily_limit" });
    expect(sent).toHaveLength(2);
  });

  it("de daglimiet telt per gebruiker", async () => {
    process.env.MAX_EMAILS_PER_DAY = "1";
    const store = memoryStore();
    const sent: any[] = [];
    for (const user of ["user-1", "user-2"]) {
      const r = await createEmailAction(store, { userId: user, taskId: null, payload: mail });
      if (!r.ok) throw new Error(r.error);
      await approveAction(store, user, r.action.id);
      expect((await executePendingAction(execDeps(store, sent), user, r.action.id)).ok).toBe(true);
    }
  });

  it("maximaal N ontvangers per mail", () => {
    process.env.MAX_RECIPIENTS_PER_EMAIL = "5";
    const six = Array.from({ length: 6 }, (_, i) => `p${i}@example.com`);
    expect(validateEmailPayload({ ...mail, to: six }).ok).toBe(false);
    expect(validateEmailPayload({ ...mail, to: six.slice(0, 5) }).ok).toBe(true);
  });

  it("weigert ongeldige adressen en header-injectie in het onderwerp", () => {
    expect(validateEmailPayload({ ...mail, to: ["geen-adres"] }).ok).toBe(false);
    expect(validateEmailPayload({ ...mail, subject: "Hoi\r\nBcc: x@y.nl" }).ok).toBe(false);
  });
});
