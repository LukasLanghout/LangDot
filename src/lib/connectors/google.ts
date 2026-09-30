// Google OAuth 2.0 (Authorization Code + PKCE). Alleen serverside.
// Env: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, optioneel GOOGLE_REDIRECT_URI.

import { ConnectorError } from "./errors";

export const GMAIL_SCOPES = {
  send: "https://www.googleapis.com/auth/gmail.send",
  compose: "https://www.googleapis.com/auth/gmail.compose",
  readonly: "https://www.googleapis.com/auth/gmail.readonly",
};

/** Scopes per provider. openid + email alleen om het e-mailadres van het account te tonen. */
export const GOOGLE_PROVIDER_SCOPES: Record<string, string[]> = {
  gmail: ["openid", "email", GMAIL_SCOPES.send, GMAIL_SCOPES.compose, GMAIL_SCOPES.readonly],
};

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

function credentials() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new ConnectorError("config", "GOOGLE_CLIENT_ID/SECRET ontbreken");
  return { clientId, clientSecret };
}

export function redirectUri(origin: string) {
  return process.env.GOOGLE_REDIRECT_URI || `${origin}/api/connectors/google/callback`;
}

export function buildAuthUrl(opts: { provider: string; state: string; challenge: string; redirectUri: string }) {
  const scopes = GOOGLE_PROVIDER_SCOPES[opts.provider];
  if (!scopes) throw new ConnectorError("config", `onbekende provider ${opts.provider}`);
  const url = new URL(AUTH_URL);
  url.searchParams.set("client_id", credentials().clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "false");
  url.searchParams.set("state", opts.state);
  url.searchParams.set("code_challenge", opts.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export type GoogleTokens = {
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date;
  scopes: string[];
  idToken?: string;
};

async function tokenRequest(form: Record<string, string>): Promise<any> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Nooit tokens loggen: alleen de foutcode van Google.
    const code = String(json?.error ?? res.status);
    if (code === "invalid_grant") throw new ConnectorError("needs_reauth", "invalid_grant");
    throw new ConnectorError("provider_error", `token endpoint: ${code}`);
  }
  return json;
}

function toTokens(json: any): GoogleTokens {
  return {
    accessToken: String(json.access_token),
    refreshToken: json.refresh_token ? String(json.refresh_token) : undefined,
    expiresAt: new Date(Date.now() + Number(json.expires_in ?? 3600) * 1000),
    scopes: String(json.scope ?? "").split(" ").filter(Boolean),
    idToken: json.id_token ? String(json.id_token) : undefined,
  };
}

export async function exchangeCode(code: string, verifier: string, redirect: string) {
  const { clientId, clientSecret } = credentials();
  return toTokens(await tokenRequest({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirect,
    grant_type: "authorization_code",
    code_verifier: verifier,
  }));
}

export async function refreshAccessToken(refreshToken: string) {
  const { clientId, clientSecret } = credentials();
  return toTokens(await tokenRequest({
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
  }));
}

export async function revokeToken(token: string) {
  const res = await fetch(REVOKE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }).toString(),
  });
  // 400 = token was al ongeldig; voor ons doel (ontkoppelen) is dat ook goed.
  if (!res.ok && res.status !== 400) throw new ConnectorError("provider_error", `revoke: ${res.status}`);
}

/**
 * E-mailadres van het account. Het id_token komt rechtstreeks van Google's token-endpoint over
 * TLS, dus volgens Google's richtlijnen hoeft de handtekening dan niet apart gecontroleerd te worden.
 */
export async function accountEmail(tokens: GoogleTokens): Promise<string | null> {
  if (tokens.idToken) {
    try {
      const payload = JSON.parse(Buffer.from(tokens.idToken.split(".")[1], "base64url").toString("utf8"));
      if (typeof payload.email === "string") return payload.email;
    } catch {
      /* val terug op Gmail-profiel */
    }
  }
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
    headers: { Authorization: `Bearer ${tokens.accessToken}` },
  });
  if (!res.ok) return null;
  const json = await res.json();
  return typeof json.emailAddress === "string" ? json.emailAddress : null;
}
