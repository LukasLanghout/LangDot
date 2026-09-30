# LangDot

Een MVP van een **always-on persoonlijke agent**: één persistente "dot" met een eigen naam en uiterlijk.
Je geeft opdrachten, de dot werkt ze op de achtergrond af, onthoudt context, en benadert je alleen
als er een beslissing van jou nodig is. Geïnspireerd op het idee van
[ChatGPT dots](https://learn.chatgpt.com/docs/dots), maar met **Groq** als model-provider (geen OpenAI-key).

**Stack:** Next.js 15 (App Router) · TypeScript · Tailwind v4 · Supabase (Postgres, Auth, Realtime, pg_cron) · Groq API · Vercel

---

## Features

| # | Feature | Waar |
|---|---------|------|
| 1 | **Dot aanmaken**: naam, vorm, kleur, ogen, accessoire (SVG). Handle `@naam-dot`. Later aanpasbaar. | `/create` |
| 2 | **Chat** met streaming. Werkt ook terwijl de dot aan taken werkt. | midden |
| 3 | **Achtergrondtaken**: plan → stappen → uitvoeren. Live status (pending, running, needs_input, done). | Activity |
| 4 | **Beslismomenten**: `ask_user` zet de taak op `needs_input` met opties. Zonder "ja" geen bijwerkingen. | chat + Activity |
| 5 | **Geheugen**: de dot schrijft zelf notities; jij kunt ze inzien, bewerken, verwijderen. | Geheugen |
| 6 | **Geplande check-ins**: "check elke werkdag om 9:00 Amsterdam tijd …" | Gepland |
| 7 | **Controls**: pauzeren/hervatten, taken annuleren, audit-log van alle acties. | links + Audit-log |

---

## Architectuur

```
 Browser (Next.js client)                     Vercel (Next.js server)                      Groq
 ┌─────────────────────────┐   POST /api/chat  ┌────────────────────────────┐  tool use  ┌─────────┐
 │ Chat (NDJSON stream)    │ ────────────────▶ │ runChat(): tool-loop        │ ─────────▶ │ LLM     │
 │ Activity / Geheugen /   │                   │  create_task, memory_*,     │ ◀───────── │         │
 │ Gepland / Audit         │                   │  create_schedule, web_*     │            └─────────┘
 │                         │                   │         │ after()                ▲
 │  Supabase Realtime  ◀───┼──────┐            │         ▼                        │
 └─────────────────────────┘      │            │ runWorker(): claim → plan →      │
                                  │            │   stap uitvoeren → ask_user /    ─┘
                                  │            │   complete_step → samenvatting  │
                                  │            └──────────────▲──────────────────┘
                                  │                           │ POST /api/worker/tick (elke minuut)
                        ┌─────────┴───────────────────────────┴──────┐
                        │ Supabase Postgres                           │
                        │ dot_profiles  dot_tasks  dot_messages       │
                        │ dot_memories  dot_schedules  dot_drafts     │
                        │ dot_audit     + RLS + Realtime + pg_cron    │
                        └─────────────────────────────────────────────┘
```

### Achtergrondwerk: waarom zo?

Simpelste opzet die écht blijft doorlopen zonder eigen server:

1. **Postgres is de queue.** Taken staan in `dot_tasks`. Een worker claimt een taak met een
   conditionele update op `locked_until` (lock van 2 min), doet één stap, en geeft de lock vrij.
   Zo kunnen meerdere aanroepen tegelijk draaien zonder dubbel werk.
2. **Supabase `pg_cron` + `pg_net`** roept elke minuut `POST /api/worker/tick` aan (heartbeat).
   Dat werkt op het gratis Vercel-plan (Vercel Cron op Hobby mag maar 1×/dag).
3. **`after()`** (Next.js) trapt de worker meteen af na een chatbericht dat een taak maakt, na een
   antwoord op een beslisvraag en na "hervatten", zodat je niet op de volgende minuut hoeft te wachten.
4. **Vangnet:** zolang de app open staat, pingt de browser elke minuut `/api/worker/kick`
   (handig bij lokaal ontwikkelen, waar pg_cron je laptop niet kan bereiken).

Elke worker-aanroep heeft een tijdsbudget (~50 s) en doet stappen tot dat op is; de rest gaat in de volgende tick.
Supabase Edge Functions waren een alternatief, maar dan leeft de agent-code op twee plekken (Deno + Node).

### Agent-loop

```
nieuwe taak (pending)
   │ claim
   ▼
planTask  ── set_plan (geforceerde tool call) ──▶ 1–6 stappen
   │
   ▼
executeStep(i)  ── tool-loop (max 8 rondes) ──┬─ complete_step → stap i klaar → volgende stap
   ▲                                          ├─ ask_user → needs_input + vraag in chat (lock vrij)
   │ antwoord via /api/tasks/:id/answer ──────┘
   ▼
finalizeTask ── samenvatting ──▶ bericht in chat, status done
```

Tussen elke tool-ronde checkt de worker of de taak geannuleerd of gepauzeerd is.
Mislukt een stap, dan volgt een retry na 60 s; na 3 pogingen gaat de taak op `failed` en krijg je een bericht.

### Tools

| Tool | Chat | Worker | Effect |
|------|:----:|:------:|--------|
| `web_search`, `web_fetch` | ✓ | ✓ | alleen lezen; output verpakt als `<untrusted_web_content>` |
| `memory_read`, `memory_write` | ✓ | ✓ | eigen geheugen-tabel |
| `create_task`, `cancel_task` | ✓ | | taakqueue |
| `create_schedule` | ✓ | | schema's |
| `draft_message` | ✓ | ✓ | **alleen concept**, verstuurt nooit |
| `update_task` | | ✓ | voortgangsnotitie |
| `ask_user` | | ✓ | beslisvraag, pauzeert de taak |
| `complete_step` | | ✓ | rondt stap af |

### Veiligheid

- **Geen tools met extern effect.** Er is geen verzend-, verwijder- of betaaltool. `draft_message` maakt een concept.
- **Goedkeuring** loopt via `ask_user`. Alleen een klik op een optie met `approves: true` telt als "ja";
  vrije tekst nooit. Een goedgekeurd concept krijgt status *goedgekeurd — verstuur zelf* (er is in deze
  versie bewust geen verzendkoppeling). Een latere koppeling hoort precies op dat punt in
  `/api/tasks/[id]/answer` te komen.
- **Prompt injection:** web-inhoud gaat als data het model in, gemarkeerd als onbetrouwbaar, en de
  systeemprompt verbiedt het opvolgen van instructies daarin. `web_fetch` blokkeert lokale/private adressen
  en volgt redirects handmatig.
- **Audit:** elke tool-call (input + output, afgekapt) en elke gebruikersactie gaat naar `dot_audit`.
  Gebruikers kunnen het log lezen en aanvullen, niet wijzigen of wissen (RLS).
- **RLS** op alle tabellen: de browser ziet alleen eigen rijen. De server gebruikt de service-role key en
  filtert altijd expliciet op `user_id`.

---

## Mapstructuur

```
supabase/
  migrations/0001_langdot.sql   schema, RLS, realtime
  cron.sql                      pg_cron heartbeat (na deploy draaien)
src/
  middleware.ts                 Supabase-sessie verversen
  app/
    page.tsx                    hoofdapp (server: data laden → AppShell)
    login/  create/             inloggen, dot maken/aanpassen
    auth/callback/              e-mailbevestiging
    api/chat                    streaming chat + tool-loop
    api/worker/tick             cron-heartbeat (Bearer CRON_SECRET)
    api/worker/kick             aftrap vanuit open app
    api/tasks/[id]/answer       beslisvraag beantwoorden (+ goedkeuring)
    api/tasks/[id]/cancel       taak annuleren
    api/dot/pause               pauzeren / hervatten
  lib/
    groq.ts                     Groq client (fetch, streaming, tool calls)
    agent/                      prompts, tools, chat-loop, worker
    web.ts                      web_search / web_fetch
    schedule.ts                 volgende uitvoertijd (luxon, tijdzones/DST)
    audit.ts  types.ts  supabase/
  components/                   AppShell, Chat, ActivityPanel, MemoryPanel, SchedulePanel, AuditPanel, DotAvatar, DotEditor
```

---

## Setup

### 1. Supabase

1. Maak een project (of gebruik een bestaand project: alle tabellen hebben prefix `dot_`).
2. Plak `supabase/migrations/0001_langdot.sql` in de **SQL Editor** en voer uit.
3. **Authentication → Providers → Email**: aan. Voor snel testen kun je "Confirm email" uitzetten;
   laat je het aan, zet dan onder **URL Configuration** je Vercel-URL als Site URL en voeg
   `https://<jouw-app>/auth/callback` toe aan de Redirect URLs.

### 2. Groq

Maak een key op <https://console.groq.com/keys>. Standaardmodel: `llama-3.3-70b-versatile`, met
`openai/gpt-oss-120b` en `openai/gpt-oss-20b` als uitwijk. Aanpasbaar via `GROQ_MODEL` en `GROQ_FALLBACK_MODELS`.

### 3. Environment variables

Zie `.env.example`. Lokaal: kopieer naar `.env.local`. Op Vercel: Project → Settings → Environment Variables.

| Variabele | Waar vandaan | Opmerking |
|-----------|--------------|-----------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Settings → API | |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | idem (anon of `sb_publishable_…`) | publiek, RLS beschermt |
| `SUPABASE_SERVICE_ROLE_KEY` | idem (service_role / `sb_secret_…`) | **alleen server** |
| `GROQ_API_KEY` | console.groq.com | |
| `GROQ_MODEL` | optioneel | default `llama-3.3-70b-versatile` |
| `CRON_SECRET` | zelf verzinnen | lange random string |
| `GROQ_FALLBACK_MODELS` | optioneel | uitwijkmodellen bij een limiet of mislukte tool-call, default `openai/gpt-oss-120b,openai/gpt-oss-20b` |
| `GROQ_SEARCH_MODEL` | optioneel | model voor Groq `browser_search`, default `openai/gpt-oss-120b` |
| `TAVILY_API_KEY` | optioneel | krijgt voorrang bij zoeken; anders Groq `browser_search` |
| `CAURA_API_KEY` + `CAURA_TENANT_ID` | optioneel, caura.ai | gedeeld geheugen tussen dots/agents (zie hieronder) |
| `CAURA_FLEET_PREFIX` | optioneel | fleet = `<prefix>-<user id>`, default `langdot` |

### 4. Lokaal draaien

```bash
npm install
npm run dev
```

Open <http://localhost:3000>, maak een account, maak je dot. Lokaal loopt het achtergrondwerk via `after()`
en de kick vanuit de open app.

### 5. Deploy op Vercel

1. Push naar GitHub en importeer de repo in Vercel (framework: Next.js, geen extra instellingen).
2. Zet de env vars (stap 3) en deploy.
3. Open `supabase/cron.sql`, vervang `<APP_URL>` en `<CRON_SECRET>`, en voer het uit in de SQL Editor.
   Vanaf nu werkt je dot ook door als de app dicht is.

Controleren of de heartbeat loopt:

```sql
select status, return_message, start_time from cron.job_run_details order by start_time desc limit 5;
select status_code, created from net._http_response order by created desc limit 5;
```

---

## Gedeeld geheugen met Caura (optioneel)

Met `CAURA_API_KEY` en `CAURA_TENANT_ID` gezet, gaat elke geheugennotitie ook naar [Caura](https://caura.ai):

- **Schrijven:** `memory_write` en het Geheugen-paneel schrijven naar Supabase én naar Caura
  (`POST /api/v1/memories`, `visibility: scope_team`, `agent_id` = de handle van de dot).
  Bewerken en verwijderen in het paneel lopen via `/api/memories` en synchroniseren mee (`caura_id` per notitie).
- **Lezen:** in elke prompt komen, naast de eigen notities, recente notities uit de fleet die andere dots of agents
  schreven (`GET /api/v1/memories?scope=fleet`). `memory_read` met een zoekterm doorzoekt Caura ook semantisch
  (`POST /api/v1/search`).
- **Fleet:** één per gebruiker, `langdot-<user id>`. Het Geheugen-paneel toont de exacte naam. Laat een andere dot of
  agent (bv. via Caura's MCP-server in Claude of Cursor) in diezelfde fleet schrijven, en ze leren van elkaar.
- Is Caura onbereikbaar, dan werkt alles gewoon door op Supabase; fouten komen alleen in de serverlog.

Voer hiervoor ook `supabase/migrations/0002_caura.sql` uit.

## Uitproberen

- *"Zoek 3 goede Italiaanse restaurants in Utrecht en maak een shortlist"* → taak met stappen in Activity.
- *"Schrijf een mail aan jan@example.com dat ik vrijdag later ben, en vraag of ik hem mag versturen"* →
  concept + beslisvraag met knoppen. Geen "ja" = er gebeurt niets.
- *"Check elke werkdag om 9:00 Amsterdam tijd het tech-nieuws voor me"* → schema in Gepland.
- *"Onthoud dat ik liever korte antwoorden krijg"* → notitie in Geheugen.
- Klik **Pauzeren** terwijl een taak loopt → de worker stopt na de huidige tool-ronde.

## Bewust niet in deze versie

Bellen/voice, Slack/Teams, eigen cloud-VM met browser, computer-use, meerdere gebruikers per dot,
en een echte verzendkoppeling voor mail.

## Bekende beperkingen

- `web_search` probeert: Tavily (als er een key is) → Groq `browser_search` (zelfde Groq-key) → DuckDuckGo HTML. Levert geen van drieën bronnen op, dan krijgt de agent een harde fout plus de instructie niets te verzinnen.
- De SSRF-bescherming van `web_fetch` controleert hostnamen/IP's, maar niet DNS-rebinding.
- Groq free tier: ca. 200k tokens per dag per model. Bij een korte limiet wacht de client even; bij een daglimiet wijkt hij uit naar `GROQ_FALLBACK_MODELS`. Zijn die ook op, dan wachten achtergrondtaken tot de limiet voorbij is (zonder als mislukt te tellen) en meldt de chat hoe lang het nog duurt.
