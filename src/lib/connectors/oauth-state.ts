// State + PKCE voor de OAuth-flow. De state zit versleuteld in een httpOnly-cookie en is
// gekoppeld aan de ingelogde gebruiker; de callback controleert alles met verifyOAuthState().

import { createHash, timingSafeEqual } from "node:crypto";
import { decrypt, encrypt, randomToken } from "@/lib/crypto";

export const STATE_COOKIE = "langdot_oauth";
const TTL_MS = 10 * 60_000;

export type OAuthState = { state: string; verifier: string; userId: string; provider: string; exp: number };

export function createOAuthState(userId: string, provider: string, now = Date.now()) {
  const payload: OAuthState = { state: randomToken(24), verifier: randomToken(48), userId, provider, exp: now + TTL_MS };
  const challenge = createHash("sha256").update(payload.verifier).digest("base64url");
  return { payload, challenge, cookie: encrypt(JSON.stringify(payload)) };
}

export type StateCheck = { ok: true; payload: OAuthState } | { ok: false; reason: string };

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Controleert cookie ↔ state-parameter ↔ ingelogde gebruiker ↔ provider ↔ geldigheid. */
export function verifyOAuthState(opts: {
  cookie: string | undefined;
  state: string | null;
  userId: string | null | undefined;
  /** Eén provider, of een lijst toegestane providers (de callback leest dan de provider uit de state). */
  provider: string | string[];
  now?: number;
  decryptFn?: (s: string) => string;
}): StateCheck {
  if (!opts.cookie) return { ok: false, reason: "missing_cookie" };
  if (!opts.state) return { ok: false, reason: "missing_state" };
  if (!opts.userId) return { ok: false, reason: "not_logged_in" };

  let payload: OAuthState;
  try {
    payload = JSON.parse((opts.decryptFn ?? decrypt)(opts.cookie));
  } catch {
    return { ok: false, reason: "bad_cookie" };
  }
  if (!payload?.state || !safeEqual(payload.state, opts.state)) return { ok: false, reason: "state_mismatch" };
  if (payload.userId !== opts.userId) return { ok: false, reason: "user_mismatch" };
  const allowed = Array.isArray(opts.provider) ? opts.provider : [opts.provider];
  if (!allowed.includes(payload.provider)) return { ok: false, reason: "provider_mismatch" };
  if (!(payload.exp > (opts.now ?? Date.now()))) return { ok: false, reason: "expired" };
  return { ok: true, payload };
}
