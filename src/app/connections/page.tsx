import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { listConnectors } from "@/lib/connectors/store";
import { ConnectionsView } from "@/components/ConnectionsView";
import type { ConnectorRow } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function ConnectionsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const params = await searchParams;
  // Alleen publieke kolommen: tokens gaan nooit naar de browser.
  const connectors: ConnectorRow[] = (await listConnectors(user.id)).map((c) => ({
    id: c.id,
    provider: c.provider,
    account_email: c.account_email,
    scopes: c.scopes,
    status: c.status,
    last_used_at: c.last_used_at,
    created_at: c.created_at,
  }));

  return <ConnectionsView connectors={connectors} connected={params.connected ?? null} error={params.error ?? null} />;
}
