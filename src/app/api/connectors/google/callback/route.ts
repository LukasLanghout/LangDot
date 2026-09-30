import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { STATE_COOKIE, verifyOAuthState } from "@/lib/connectors/oauth-state";
import { accountEmail, exchangeCode, GMAIL_SCOPES, redirectUri } from "@/lib/connectors/google";
import { saveConnection } from "@/lib/connectors/store";
import { ConnectorError } from "@/lib/connectors/errors";
import { logAudit } from "@/lib/audit";

export const runtime = "nodejs";

// Google stuurt de gebruiker hierheen terug. We controleren de state (gekoppeld aan de sessie),
// wisselen de code in met de PKCE-verifier en slaan de tokens versleuteld op.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const back = (q: string) => {
    const res = NextResponse.redirect(new URL(`/connections?${q}`, url.origin));
    res.cookies.set(STATE_COOKIE, "", { path: "/api/connectors/google", maxAge: 0 });
    return res;
  };

  const user = await getUser();
  const cookieStore = await cookies();
  const check = verifyOAuthState({
    cookie: cookieStore.get(STATE_COOKIE)?.value,
    state: url.searchParams.get("state"),
    userId: user?.id,
    provider: "gmail",
  });
  if (!check.ok) {
    console.warn(`[oauth] callback geweigerd: ${check.reason}`);
    return back("error=state");
  }

  if (url.searchParams.get("error")) return back("error=denied");
  const code = url.searchParams.get("code");
  if (!code) return back("error=denied");

  const db = createAdminClient();
  try {
    const tokens = await exchangeCode(code, check.payload.verifier, redirectUri(url.origin));
    if (!tokens.scopes.includes(GMAIL_SCOPES.send) && !tokens.scopes.includes(GMAIL_SCOPES.compose)) {
      // Gebruiker heeft in het toestemmingsscherm het versturen uitgevinkt.
      return back("error=scopes");
    }
    const email = await accountEmail(tokens);
    await saveConnection({
      userId: check.payload.userId,
      provider: "gmail",
      email,
      scopes: tokens.scopes,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
    }, db);
    await logAudit(db, {
      userId: check.payload.userId, actor: "user", action: "connector_connected",
      input: { provider: "gmail", account: email, scopes: tokens.scopes },
    });
    return back("connected=gmail");
  } catch (e) {
    console.error("[oauth] callback mislukt:", e instanceof ConnectorError ? `${e.code} ${e.detail}` : e instanceof Error ? e.message : e);
    return back("error=exchange");
  }
}
