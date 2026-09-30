import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { DotEditor } from "@/components/DotEditor";
import type { Profile } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function CreatePage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data } = await supabase.from("dot_profiles").select("*").eq("user_id", user.id).maybeSingle();
  return <DotEditor userId={user.id} existing={(data as Profile | null) ?? null} />;
}
