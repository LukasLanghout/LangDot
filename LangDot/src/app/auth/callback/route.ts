import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Bevestigingslink uit de aanmeldmail komt hier binnen.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  if (code) {
    const supabase = await createClient();
    await supabase.auth.exchangeCodeForSession(code);
  }
  return NextResponse.redirect(new URL("/", url.origin));
}
