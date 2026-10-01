import { describe, expect, it } from "vitest";
import { notifyUser, sendPush, type PushDeps, type PushSub } from "@/lib/push";

function deps(subs: PushSub[], failures: Record<string, number> = {}) {
  const removed: string[] = [];
  const delivered: { id: string; payload: any }[] = [];
  const d: PushDeps = {
    list: async () => subs.filter((s) => !removed.includes(s.id)),
    remove: async (id) => void removed.push(id),
    touch: async () => {},
    send: async (sub, payload) => {
      if (failures[sub.id]) throw Object.assign(new Error("push failed"), { statusCode: failures[sub.id] });
      delivered.push({ id: sub.id, payload: JSON.parse(payload) });
    },
  };
  return { d, removed, delivered };
}

const sub = (id: string): PushSub => ({ id, endpoint: `https://push.example/${id}`, p256dh: "k", auth: "a" });

describe("push-meldingen", () => {
  it("stuurt naar alle apparaten en ruimt verlopen abonnementen (404/410) op", async () => {
    const { d, removed, delivered } = deps([sub("laptop"), sub("oude-telefoon"), sub("tablet")], { "oude-telefoon": 410, tablet: 500 });
    const r = await sendPush("user-1", { title: "Goedkeuring nodig", body: "Mail aan jan@example.com" }, d);
    expect(r).toEqual({ sent: 1, removed: 1 });
    expect(removed).toEqual(["oude-telefoon"]); // 500 = tijdelijk, blijft staan
    expect(delivered[0].payload).toMatchObject({ title: "Goedkeuring nodig", url: "/" });
  });

  it("kort lange teksten in", async () => {
    const { d, delivered } = deps([sub("a")]);
    await sendPush("user-1", { title: "x".repeat(200), body: "y".repeat(1000) }, d);
    expect(delivered[0].payload.title.length).toBeLessThanOrEqual(80);
    expect(delivered[0].payload.body.length).toBeLessThanOrEqual(200);
  });

  it("notifyUser gooit nooit, ook niet als de opslag faalt", async () => {
    const broken: PushDeps = {
      list: async () => { throw new Error("db weg"); },
      remove: async () => {},
      touch: async () => {},
      send: async () => {},
    };
    await expect(notifyUser("user-1", { title: "t", body: "b" }, broken)).resolves.toEqual({ sent: 0, removed: 0 });
  });

  it("doet niets zonder VAPID-sleutels", async () => {
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    await expect(notifyUser("user-1", { title: "t", body: "b" })).resolves.toEqual({ sent: 0, removed: 0 });
  });
});
