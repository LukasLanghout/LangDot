// Opslag van connector-tokens (versleuteld) en het ophalen van een geldig access token.
// Alleen serverside. Tokens verlaten deze module nooit richting frontend, logs of LLM.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt, encrypt } from "@/lib/crypto";
import { logAudit } from "@/lib/audit";
import { ConnectorError } from "./errors";
import { GMAIL_SCOPES, refreshAccessToken, revokeToken } from "./google";

/** Kolommen die veilig naar de UI mogen. */
export const PUBLIC_COLUMNS = "id, user_id, provider, account_email, scopes, expires_at, status, last_used_at, created_at, updated_at";

export type PublicConnector = {
  id: string;
  user_id: string;
  provider: string;
  account_email: string | null;
  scopes: string[];
  expires_at: string | null;
  status: "active" | "needs_reauth" | "revoked";
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
};

export async function listConnectors(userId: string, db: SupabaseClient = createAdminClient()): Promise<PublicConnector[]> {
  const { data } = await db.from("connectors").select(PUBLIC_COLUMNS).eq("user_id", userId);
  return (data ?? []) as PublicConnector[];
}

export async function getConnector(userId: string, provider: string, db: SupabaseClient = createAdminClient()) {
  const { data } = await db.from("connectors").select(PUBLIC_COLUMNS).eq("user_id", userId).eq("provider", provider).maybeSingle();
  return (data as PublicConnector | null) ?? null;
}

export type GmailCapabilities = { status: "active" | "needs_reauth" | "none"; email: string | null; canSend: boolean; canCompose: boolean; canRead: boolean };

export async function gmailCapabilities(userId: string, db: SupabaseClient = createAdminClient()): Promise<GmailCapabilities> {
  const c = await getConnector(userId, "gmail", db);
  if (!c || c.status === "revoked") return { status: "none", email: null, canSend: false, canCompose: false, canRead: false };
  const scopes = c.scopes ?? [];
  return {
    status: c.status === "active" ? "active" : "needs_reauth",
    email: c.account_email,
    canSend: scopes.includes(GMAIL_SCOPES.send) || scopes.includes(GMAIL_SCOPES.compose),
    canCompose: scopes.includes(GMAIL_SCOPES.compose),
    canRead: scopes.includes(GMAIL_SCOPES.readonly),
  };
}

export async function saveConnection(p: {
  userId: string;
  provider: string;
  email: string | null;
  scopes: string[];
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date;
}, db: SupabaseClient = createAdminClient()) {
  const row: Record<string, unknown> = {
    user_id: p.userId,
    provider: p.provider,
    account_email: p.email,
    scopes: p.scopes,
    encrypted_access_token: encrypt(p.accessToken),
    expires_at: p.expiresAt.toISOString(),
    status: "active",
    updated_at: new Date().toISOString(),
  };
  // Google stuurt niet altijd opnieuw een refresh token; dan de bestaande behouden.
  if (p.refreshToken) row.encrypted_refresh_token = encrypt(p.refreshToken);
  const { error } = await db.from("connectors").upsert(row, { onConflict: "user_id,provider" });
  if (error) throw new ConnectorError("provider_error", `save: ${error.message}`);
}

/** Geeft een geldig access token; ververst automatisch. Bij mislukken: status needs_reauth. */
export async function getAccessToken(userId: string, provider: string, db: SupabaseClient = createAdminClient()): Promise<string> {
  const { data: row } = await db.from("connectors")
    .select("id, status, encrypted_access_token, encrypted_refresh_token, expires_at")
    .eq("user_id", userId).eq("provider", provider).maybeSingle();

  if (!row || row.status === "revoked") throw new ConnectorError("not_connected");
  if (row.status === "needs_reauth") throw new ConnectorError("needs_reauth");

  const valid = row.encrypted_access_token && row.expires_at && new Date(row.expires_at).getTime() > Date.now() + 60_000;
  if (valid) {
    await db.from("connectors").update({ last_used_at: new Date().toISOString() }).eq("id", row.id);
    return decrypt(row.encrypted_access_token);
  }

  if (!row.encrypted_refresh_token) {
    await markNeedsReauth(db, userId, row.id, provider, "geen refresh token");
    throw new ConnectorError("needs_reauth");
  }
  try {
    const t = await refreshAccessToken(decrypt(row.encrypted_refresh_token));
    await db.from("connectors").update({
      encrypted_access_token: encrypt(t.accessToken),
      ...(t.refreshToken ? { encrypted_refresh_token: encrypt(t.refreshToken) } : {}),
      expires_at: t.expiresAt.toISOString(),
      last_used_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("id", row.id);
    return t.accessToken;
  } catch (e) {
    const reason = e instanceof ConnectorError ? e.detail || e.code : "refresh mislukt";
    await markNeedsReauth(db, userId, row.id, provider, reason);
    throw new ConnectorError("needs_reauth", reason);
  }
}

async function markNeedsReauth(db: SupabaseClient, userId: string, id: string, provider: string, reason: string) {
  console.warn(`[connectors] ${provider} voor ${userId}: needs_reauth (${reason})`);
  await db.from("connectors").update({ status: "needs_reauth", updated_at: new Date().toISOString() }).eq("id", id);
  await logAudit(db, { userId, actor: "system", action: "connector_needs_reauth", input: { provider }, output: { reason } });
}

/** Ontkoppelen: token intrekken bij Google, versleutelde tokens wissen, status revoked. */
export async function disconnect(userId: string, provider: string, db: SupabaseClient = createAdminClient()) {
  const { data: row } = await db.from("connectors")
    .select("id, account_email, encrypted_access_token, encrypted_refresh_token")
    .eq("user_id", userId).eq("provider", provider).maybeSingle();
  if (!row) return null;

  let revoked = false;
  const token = row.encrypted_refresh_token ?? row.encrypted_access_token;
  if (token) {
    try {
      await revokeToken(decrypt(token));
      revoked = true;
    } catch (e) {
      console.warn(`[connectors] revoke ${provider} mislukt: ${e instanceof ConnectorError ? e.detail : "onbekend"}`);
    }
  }
  await db.from("connectors").update({
    encrypted_access_token: null,
    encrypted_refresh_token: null,
    expires_at: null,
    status: "revoked",
    updated_at: new Date().toISOString(),
  }).eq("id", row.id);
  await logAudit(db, {
    userId, actor: "user", action: "connector_disconnected",
    input: { provider, account: row.account_email }, output: { revoked_at_google: revoked },
  });
  return { email: row.account_email as string | null, revoked };
}
