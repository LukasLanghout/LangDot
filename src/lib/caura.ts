// Optionele koppeling met Caura (https://caura.ai): gedeeld geheugen voor meerdere agents.
// Supabase blijft de bron voor het Geheugen-paneel; notities worden daarnaast naar Caura geschreven,
// in één "fleet" per gebruiker. Andere dots/agents die in dezelfde fleet schrijven, delen zo hun kennis.
// API: https://caura.ai/docs/api-reference/  (routes onder /api/v1, header X-API-Key)

const BASE = (process.env.CAURA_BASE_URL || "https://caura.ai").replace(/\/$/, "");

export function cauraEnabled() {
  return !!(process.env.CAURA_API_KEY && process.env.CAURA_TENANT_ID);
}

/** Eén fleet per gebruiker, zodat notities van verschillende gebruikers nooit mengen. */
export function fleetFor(userId: string) {
  return `${process.env.CAURA_FLEET_PREFIX || "langdot"}-${userId}`;
}

export type CauraMemory = {
  id: string;
  content: string;
  memory_type?: string | null;
  agent_id?: string | null;
  metadata?: Record<string, unknown> | null;
  created_at?: string;
};

async function call(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  opts: { query?: Record<string, string | number | undefined>; body?: unknown; timeoutMs?: number } = {},
): Promise<any> {
  const url = new URL(`${BASE}/api/v1${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 6000);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        "X-API-Key": process.env.CAURA_API_KEY!,
        "X-Tenant-ID": process.env.CAURA_TENANT_ID!,
        "Content-Type": "application/json",
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Caura ${method} ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res.status === 204 ? null : res.json();
  } finally {
    clearTimeout(timer);
  }
}

const tenant = () => process.env.CAURA_TENANT_ID!;

/** LangDot-soorten → Caura memory_type (Caura kent geen "work"; gezien als HTTP 422 in de logs). */
export function cauraType(kind: string) {
  return ({ preference: "preference", decision: "decision", fact: "fact", work: "task" } as Record<string, string>)[kind] ?? "fact";
}

/** Schrijft een notitie naar Caura en geeft het Caura-id terug (of null bij een fout). */
export async function cauraWrite(p: { userId: string; agentId: string; content: string; kind: string; localId: string }) {
  if (!cauraEnabled()) return null;
  try {
    const out = await call("POST", "/memories", {
      body: {
        tenant_id: tenant(),
        fleet_id: fleetFor(p.userId),
        agent_id: p.agentId,
        content: p.content,
        memory_type: cauraType(p.kind),
        visibility: "scope_team", // gedeeld binnen de fleet
        metadata: { source: "langdot", langdot_id: p.localId },
      },
    });
    return typeof out?.id === "string" ? out.id : null;
  } catch (e) {
    console.error("caura write failed", e);
    return null;
  }
}

export async function cauraUpdate(p: { agentId: string; cauraId: string; content: string; kind: string }) {
  if (!cauraEnabled()) return;
  try {
    await call("PATCH", `/memories/${encodeURIComponent(p.cauraId)}`, {
      query: { tenant_id: tenant(), agent_id: p.agentId },
      body: { content: p.content, memory_type: cauraType(p.kind) },
    });
  } catch (e) {
    console.error("caura update failed", e);
  }
}

export async function cauraDelete(p: { agentId: string; cauraId: string }) {
  if (!cauraEnabled()) return;
  try {
    await call("DELETE", `/memories/${encodeURIComponent(p.cauraId)}`, {
      query: { tenant_id: tenant(), agent_id: p.agentId },
    });
  } catch (e) {
    console.error("caura delete failed", e);
  }
}

/** Zoekt in het gedeelde fleet-geheugen (semantisch + keyword). */
export async function cauraSearch(p: { userId: string; agentId: string; query: string; k?: number }): Promise<CauraMemory[]> {
  if (!cauraEnabled()) return [];
  const out = await call("POST", "/search", {
    body: {
      tenant_id: tenant(),
      fleet_id: fleetFor(p.userId),
      agent_id: p.agentId,
      query: p.query,
      scope: "fleet",
      k: p.k ?? 8,
    },
  });
  return Array.isArray(out?.results) ? out.results : [];
}

/** Recente notities uit de hele fleet (voor de prompt-context). Snel en faalt stil. */
export async function cauraList(p: { userId: string; agentId: string; limit?: number }): Promise<CauraMemory[]> {
  if (!cauraEnabled()) return [];
  try {
    const out = await call("GET", "/memories", {
      query: { tenant_id: tenant(), fleet_id: fleetFor(p.userId), agent_id: p.agentId, scope: "fleet", limit: p.limit ?? 30 },
      timeoutMs: 3000,
    });
    return Array.isArray(out?.items) ? out.items : [];
  } catch (e) {
    console.error("caura list failed", e);
    return [];
  }
}
