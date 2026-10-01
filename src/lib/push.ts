// Web push (VAPID) — gratis, zonder externe dienst. Alleen serverside.
// Env: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:… of https://…).
// notifyUser() gooit nooit: een melding mag de agent niet laten falen.

import webpush from "web-push";
import { createAdminClient } from "@/lib/supabase/admin";

export type PushPayload = { title: string; body: string; url?: string; tag?: string };
export type PushSub = { id: string; endpoint: string; p256dh: string; auth: string };

export interface PushDeps {
  list(userId: string): Promise<PushSub[]>;
  remove(id: string): Promise<void>;
  touch(id: string): Promise<void>;
  send(sub: PushSub, payload: string): Promise<void>;
}

export function pushConfigured() {
  return !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

export function supabasePushDeps(): PushDeps {
  const db = createAdminClient();
  return {
    async list(userId) {
      const { data } = await db.from("push_subscriptions").select("id, endpoint, p256dh, auth").eq("user_id", userId);
      return (data ?? []) as PushSub[];
    },
    async remove(id) {
      await db.from("push_subscriptions").delete().eq("id", id);
    },
    async touch(id) {
      await db.from("push_subscriptions").update({ last_used_at: new Date().toISOString() }).eq("id", id);
    },
    async send(sub, payload) {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
        {
          TTL: 6 * 3600,
          urgency: "high",
          vapidDetails: {
            subject: process.env.VAPID_SUBJECT || "mailto:langdot@example.com",
            publicKey: process.env.VAPID_PUBLIC_KEY!,
            privateKey: process.env.VAPID_PRIVATE_KEY!,
          },
        },
      );
    },
  };
}

/** Stuurt naar alle apparaten van de gebruiker; verlopen abonnementen (404/410) worden opgeruimd. */
export async function sendPush(userId: string, payload: PushPayload, deps: PushDeps) {
  const subs = await deps.list(userId);
  const body = JSON.stringify({
    title: payload.title.slice(0, 80),
    body: payload.body.slice(0, 200),
    url: payload.url ?? "/",
    tag: payload.tag,
  });
  let sent = 0;
  let removed = 0;
  for (const sub of subs) {
    try {
      await deps.send(sub, body);
      await deps.touch(sub.id);
      sent++;
    } catch (e) {
      const status = (e as { statusCode?: number })?.statusCode;
      if (status === 404 || status === 410) {
        await deps.remove(sub.id);
        removed++;
      } else {
        console.warn(`[push] versturen mislukt (${status ?? "?"})`);
      }
    }
  }
  return { sent, removed };
}

export async function notifyUser(userId: string, payload: PushPayload, deps?: PushDeps) {
  if (!deps && !pushConfigured()) return { sent: 0, removed: 0 };
  try {
    return await sendPush(userId, payload, deps ?? supabasePushDeps());
  } catch (e) {
    console.warn("[push] melding mislukt:", e instanceof Error ? e.message : e);
    return { sent: 0, removed: 0 };
  }
}
