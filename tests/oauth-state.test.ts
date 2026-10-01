import { beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { createOAuthState, verifyOAuthState } from "@/lib/connectors/oauth-state";

beforeAll(() => {
  process.env.CONNECTOR_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});

describe("OAuth-callback: state-controle", () => {
  it("accepteert de juiste state van dezelfde gebruiker", () => {
    const { payload, cookie } = createOAuthState("user-1", "gmail");
    const r = verifyOAuthState({ cookie, state: payload.state, userId: "user-1", provider: "gmail" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload.verifier).toBe(payload.verifier);
  });

  it("PKCE-challenge is S256 van de verifier", () => {
    const { payload, challenge } = createOAuthState("user-1", "gmail");
    expect(challenge).toBe(createHash("sha256").update(payload.verifier).digest("base64url"));
  });

  it("weigert een andere state (CSRF)", () => {
    const { cookie } = createOAuthState("user-1", "gmail");
    expect(verifyOAuthState({ cookie, state: "verzonnen", userId: "user-1", provider: "gmail" })).toEqual({ ok: false, reason: "state_mismatch" });
  });

  it("weigert als een andere gebruiker de callback opent", () => {
    const { payload, cookie } = createOAuthState("user-1", "gmail");
    expect(verifyOAuthState({ cookie, state: payload.state, userId: "user-2", provider: "gmail" })).toEqual({ ok: false, reason: "user_mismatch" });
  });

  it("weigert zonder sessie, zonder cookie of zonder state", () => {
    const { payload, cookie } = createOAuthState("user-1", "gmail");
    expect(verifyOAuthState({ cookie, state: payload.state, userId: null, provider: "gmail" }).ok).toBe(false);
    expect(verifyOAuthState({ cookie: undefined, state: payload.state, userId: "user-1", provider: "gmail" }).ok).toBe(false);
    expect(verifyOAuthState({ cookie, state: null, userId: "user-1", provider: "gmail" }).ok).toBe(false);
  });

  it("weigert een verlopen state", () => {
    const { payload, cookie } = createOAuthState("user-1", "gmail", Date.now() - 11 * 60_000);
    expect(verifyOAuthState({ cookie, state: payload.state, userId: "user-1", provider: "gmail" })).toEqual({ ok: false, reason: "expired" });
  });

  it("weigert een vervalste of gemanipuleerde cookie", () => {
    const { payload } = createOAuthState("user-1", "gmail");
    const forged = Buffer.from(JSON.stringify({ ...payload, userId: "attacker" })).toString("base64url");
    expect(verifyOAuthState({ cookie: forged, state: payload.state, userId: "attacker", provider: "gmail" })).toEqual({ ok: false, reason: "bad_cookie" });
  });

  it("accepteert de provider uit de state als die in de toegestane lijst staat", () => {
    const { payload, cookie } = createOAuthState("user-1", "google_calendar");
    const r = verifyOAuthState({ cookie, state: payload.state, userId: "user-1", provider: ["gmail", "google_calendar"] });
    expect(r.ok && r.payload.provider).toBe("google_calendar");
    expect(verifyOAuthState({ cookie, state: payload.state, userId: "user-1", provider: ["gmail"] }).ok).toBe(false);
  });

  it("weigert een andere provider", () => {
    const { payload, cookie } = createOAuthState("user-1", "gmail");
    expect(verifyOAuthState({ cookie, state: payload.state, userId: "user-1", provider: "google_drive" })).toEqual({ ok: false, reason: "provider_mismatch" });
  });
});
