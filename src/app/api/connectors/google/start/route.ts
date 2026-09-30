import { NextResponse } from "next/server";
import { getUser } from "@/lib/supabase/server";
import { createOAuthState, STATE_COOKIE } from "@/lib/connectors/oauth-state";
import { buildAuthUrl, GOOGLE_PROVIDER_SCOPES, redirectUri } from "@/lib/connectors/google";
import { ConnectorError } from "@/lib/connectors/errors";

export const runtime = "nodejs";

// Start van "Verbinden": state + PKCE aanmaken, in een httpOnly-cookie zetten, doorsturen naar Google.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const user = await getUser();
  if (!user) return NextResponse.redirect(new URL("/login", url.origin));

  const provider = url.searchParams.get("provider") || "gmail";
  if (!GOOGLE_PROVIDER_SCOPES[provider]) return NextResponse.redirect(new URL("/connections?error=unknown_provider", url.origin));

  try {
    const { payload, challenge, cookie } = createOAuthState(user.id, provider);
    const target = buildAuthUrl({ provider, state: payload.state, challenge, redirectUri: redirectUri(url.origin) });
    const res = NextResponse.redirect(target);
    res.cookies.set(STATE_COOKIE, cookie, {
      httpOnly: true,
      secure: url.protocol === "https:",
      sameSite: "lax", // nodig: Google stuurt de gebruiker via een top-level redirect terug
      path: "/api/connectors/google",
      maxAge: 600,
    });
    return res;
  } catch (e) {
    console.error("[oauth] start mislukt:", e instanceof ConnectorError ? e.detail : e instanceof Error ? e.message : e);
    return NextResponse.redirect(new URL("/connections?error=config", url.origin));
  }
}
