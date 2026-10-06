# LangDot

Een **always-on persoonlijke agent**: één persistente "dot" met een eigen naam en uiterlijk.
Je geeft opdrachten, de dot werkt ze op de achtergrond af, onthoudt context, en benadert je alleen
als er een beslissing van jou nodig is. Geïnspireerd op [ChatGPT dots](https://learn.chatgpt.com/docs/dots).

**Stack:** Next.js 15 (App Router) · TypeScript · Tailwind v4 · Supabase (Postgres, Auth, Realtime, pg_cron) ·
GonkaRouter (OpenAI-compatibel, via het `openai`-pakket) · Gmail API · Vercel

---

## Features

| # | Feature | Waar |
|---|---------|------|
| 1 | **Dot aanmaken**: naam, vorm, kleur, ogen, accessoire (SVG). Handle `@naam-dot`. Later aanpasbaar. | `/create` |
| 2 | **Chat** met streaming en Markdown (tabellen, lijsten, links). Antwoorden hangen vast aan hun vraag. | midden |
| 3 | **Taken**: achtergrondtaken (plan → stappen) én chatbeurten met zoek- of mailwerk verschijnen live in Activity. | Activity |
| 4 | **Goedkeuring**: mails gaan alleen weg na een klik op *Versturen* op een goedkeuringskaart. In code afgedwongen. | chat + Activity |
| 5 | **Geheugen**: de dot schrijft zelf notities en volgt je voorkeuren; jij kunt ze inzien, bewerken, verwijderen. | Geheugen |
| 6 | **Geplande check-ins**: "check elke werkdag om 9:00 Amsterdam tijd …" | Gepland |
| 7 | **Controls**: pauzeren, taken annuleren, audit-log, tokenbudget en stappenlimiet. | links + Audit-log |
| 8 | **Verbindingen**: koppel je eigen Gmail en Google Agenda (OAuth, PKCE, versleutelde tokens). Drive volgt. | `/connections` |
| 9 | **Push-meldingen**: seintje bij een goedkeuring, een vraag, een klare of mislukte taak, of een verlopen verbinding. | 🔔 links |
| 10 | **Documenten**: elk bestand meesturen in de chat of uploaden; de dot leest PDF, Word, Excel, PowerPoint, tekst, code en afbeeldingen (OCR), kan ze vastzetten als achtergrond en als bijlage mailen. | 📎 + Documenten |
| 11 | **Diagnose**: één knop die instellingen, migraties en verbindingen controleert en zegt hoe je iets oplost. | Verbindingen |

---

## Architectuur

```
 Browser                                   Vercel (Next.js server)                           GonkaRouter
 ┌──────────────────────┐ POST /api/chat  ┌──────────────────────────────────┐ lib/llm.ts ┌────────────┐
 │ Chat (NDJSON stream) │ ──────────────▶ │ runChat(): tool-loop              │ ─────────▶ │ GONKA_MODEL│
 │ Activity / Geheugen  │                 │  web_*, memory_*, create_task,    │ ◀───────── │ (gepind)   │
 │ Gepland / Audit      │                 │  gmail_create_draft …             │            └────────────┘
 │ Goedkeuringskaart ───┼─ POST /api/actions/:id/approve ─▶ executePendingAction() ──▶ Gmail API
 │ /connections ────────┼─ /api/connectors/google/start ─▶ Google OAuth ─▶ /callback
 │ Supabase Realtime ◀──┼───┐             │ runWorker(): claim → plan → stap → samenvatting
 └──────────────────────┘   │             └──────────────▲───────────────────┘
                            │                            │ POST /api/worker/tick (elke minuut, pg_cron)
                  ┌─────────┴────────────────────────────┴───────────────┐
                  │ Supabase Postgres (RLS op alles)                      │
                  │ dot_profiles dot_tasks dot_messages dot_memories      │
                  │ dot_schedules dot_audit dot_usage                      │
                  │ connectors (tokens AES-256-GCM) pending_actions        │
                  └──────────────────────────────────────────────────────┘
```

### Provider-laag (`src/lib/llm.ts`)

De hele app praat alleen met `complete({ messages, tools, toolChoice, onText, userId })`.

- **Provider:** GonkaRouter via het officiële `openai`-pakket met `baseURL`. Wisselen = alleen dit bestand.
- **Model vastgepind:** uitsluitend `GONKA_MODEL`; een uitwijkmodel alleen als jij `GONKA_FALLBACK_MODELS` zet
  (standaard leeg). Bij het opstarten (`src/instrumentation.ts`) en bij de eerste aanroep controleert `GET /models`
  dat het model bestaat; anders een duidelijke fout in de serverlog en een nette melding aan de gebruiker.
  **Strikt:** antwoorden waarvan het geserveerde model (`model`-veld) afwijkt, worden geweigerd.
- **Fouten:** retry met exponentiële backoff bij 429, 5xx en timeouts (max 3 keer). De gebruiker ziet nooit
  ruwe API-fouten of modelnamen (`LlmError.message` is altijd een nette tekst); details alleen in de serverlog.
- **Streaming:** ja, inclusief tool-calls in delta's en `usage` aan het eind (`stream_options.include_usage`).
- **Redenering verbergen:** `<think>`-blokken worden weggefilterd, ook tijdens streaming (zie hieronder).
- **Budget:** per gebruiker per dag (`DAILY_TOKEN_BUDGET`), bijgehouden met de `usage`-velden in `dot_usage`.
  Per achtergrondtaak maximaal `MAX_TASK_STEPS` LLM-aanroepen.

#### Testresultaat GonkaRouter (30-09-2026)

| Check | Resultaat |
|---|---|
| `GET /models` | `zai-org/GLM-5.3-Flash`, `MiniMaxAI/MiniMax-M2.7`, `deepseek-ai/DeepSeek-V4-Flash-0731` |
| Tool calling (3×) | ✅ OpenAI-vorm (`tool_calls` in `choices[0].message`), geldige JSON-argumenten |
| Tool-resultaat terug → antwoord | ✅ |
| Geforceerde `tool_choice` | ✅ |
| Streaming (ook met tools) + `usage` | ✅ |
| **Model-routing** | ⚠ `zai-org/GLM-5.3-Flash` wordt geserveerd door `MiniMaxAI/MiniMax-M2.7`. Daarom is `GONKA_MODEL=MiniMaxAI/MiniMax-M2.7` met strikte controle. |
| **Redenering in content** | ⚠ zonder tools `<think>…</think>`; mét tools ontbreekt `</think>` en scheiden 3 regelovergangen redenering en antwoord. Het filter vangt beide. |
| Hallucinatie (verzonnen bedrijf, zoeken levert niets op) | ✅ model zoekt, zegt eerlijk dat het niets vond, noemt geen adres/telefoon/omzet |

Zelf opnieuw draaien (Windows, zonder Node): `scripts/test-tool-calling.ps1`, `scripts/test-streaming.ps1`,
`scripts/check-served-model.ps1`, `scripts/test-hallucination.ps1`, `scripts/inspect-think.ps1`.
Ze lezen `.env.local` en printen de key nooit.

### Achtergrondwerk

1. **Postgres is de queue.** Taken in `dot_tasks`, geclaimd met een conditionele update op `locked_until`.
2. **Supabase `pg_cron` + `pg_net`** roept elke minuut `POST /api/worker/tick` aan (werkt op Vercel Hobby).
3. **`after()`** trapt de worker meteen af na een nieuwe taak, een antwoord, een goedkeuring of "hervatten".
4. **Vangnet:** zolang de app open staat, pingt de browser elke minuut `/api/worker/kick`.

Chatbeurten met zoek- of mailwerk worden als taak met `source = 'chat_turn'` in Activity getoond; de worker
voert die nooit uit.

### Goedkeuring (in code afgedwongen)

```
agent: gmail_create_draft ─▶ pending_actions (status pending) ─▶ goedkeuringskaart (chat + Activity)
                                                                     │ klik "Versturen" (ingelogde eigenaar)
                                                                     ▼
                       approveAction(): pending → approved   (enige plek, alleen via /api/actions/:id/approve)
                                                                     ▼
                       executePendingAction(): eigenaar? approved? niet al verstuurd? daglimiet? ontvangers?
                         claimt atomisch approved → executed, verstuurt, logt ontvanger + onderwerp + tijd
```

- `gmail_send` roept dezelfde `executePendingAction()` aan. Het model kan dus niets versturen door te beweren
  dat de gebruiker "ja" zei: de status moet `approved` zijn, en dat kan alleen een klik.
- De kaart laat je aan, onderwerp en tekst bewerken; wat je goedkeurt is wat verstuurd wordt.
- Mislukt versturen na goedkeuring (bv. verbinding verlopen), dan blijft de actie `approved` met een
  "Opnieuw proberen"-knop. Concepten die 7 dagen niet beoordeeld zijn, verlopen.
- Limieten: `MAX_EMAILS_PER_DAY` (20) en `MAX_RECIPIENTS_PER_EMAIL` (5).
- Zonder actieve Gmail-verbinding of bij `needs_reauth` krijgt het model de mail-tools niet; alleen
  `request_connection`, dat een knop "Gmail verbinden" in de chat zet.

### Veiligheid

- Web-, mail- en documentinhoud gaat als `<untrusted_web_content>` het model in; de systeemprompt verbiedt
  het opvolgen van instructies daarin. Zie de test "prompt-injectie".
- Hallucinatieregel in de systeemprompt: geen bron = geen feitelijk antwoord, nooit namen/adressen/cijfers verzinnen.
- Tokens van connectors: AES-256-GCM (`CONNECTOR_ENCRYPTION_KEY`), alleen serverside ontsleuteld. Nooit in logs,
  frontend of prompt. De browser mag tabel `connectors` alleen zonder tokenkolommen lezen (kolomrechten + RLS).
- RLS op alle tabellen. `pending_actions` is voor de browser alleen-lezen; statuswijzigingen gaan via routes.
- Audit-log van elke tool-call, elke gebruikersactie, verbinden/ontkoppelen en elke verstuurde mail.

---

## Mapstructuur

```
supabase/
  migrations/0001_langdot.sql          schema, RLS, realtime
  migrations/0002_caura.sql            caura_id op geheugennotities
  migrations/0003_gonka_connectors.sql tokenbudget, connectors, pending_actions, reply_to, step_count
  migrations/0004_push_calendar.sql    push-abonnementen, actietype calendar_create_event
  migrations/0005_documents.sql        documenten-tabel en privé opslag-bucket
  migrations/0006_auto_send.sql        staande toestemming: schema's die automatisch naar jezelf mailen
  migrations/0007_task_scratch.sql     tussenstand van taakstappen (hervatten tussen ticks)
  migrations/0008_schedule_delete.sql  actietype schedule_delete (goedkeuringskaart)
  migrations/0009_dedupe.sql           documenten ontdubbelen op hash, verstuurde nieuwslinks
  cron.sql                             pg_cron heartbeat
src/
  instrumentation.ts                   modelcontrole bij opstarten
  app/
    page.tsx  login/  create/  connections/
    api/chat                           streaming chat
    api/actions/[id]/approve|reject|execute   goedkeuringskaart
    api/connectors/google/start|callback|disconnect   OAuth
    api/tasks/[id]/answer|cancel  api/dot/pause  api/memories  api/worker/tick|kick
  lib/
    llm.ts  llm-errors.ts  budget.ts   provider-laag, fouten, tokenbudget
    actions.ts  actions-store.ts       pending actions + afgedwongen goedkeuring
    crypto.ts                          AES-256-GCM
    connectors/                        registry, oauth-state (PKCE), google, gmail, store
    agent/                             prompts, tools, mail-tools, chat, worker, approval-flow
    web.ts  schedule.ts  caura.ts  audit.ts  types.ts  supabase/
  components/                          AppShell, Chat, ApprovalCard, ActivityPanel, ConnectionsView, …
tests/                                 vitest
scripts/                               PowerShell-checks tegen GonkaRouter
.github/workflows/ci.yml               typecheck + tests + build bij elke push
```

---

## Setup

### 1. Supabase

Voer in de **SQL Editor** in volgorde uit: `0001_langdot.sql`, `0002_caura.sql`, `0003_gonka_connectors.sql`, `0004_push_calendar.sql`, `0005_documents.sql`, `0006_auto_send.sql`, `0007_task_scratch.sql`, `0008_schedule_delete.sql`, `0009_dedupe.sql`.
Zet onder **Authentication → URL Configuration** je Vercel-URL als Site URL en voeg
`https://<jouw-app>/auth/callback` toe aan de Redirect URLs.

### 2. Environment variables

Zie `.env.example` (alle waarden leeg). Lokaal: kopieer naar `.env.local`. Op Vercel: Settings → Environment Variables.

| Variabele | Verplicht | Opmerking |
|-----------|:--:|-----------|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ✓ | publiek; RLS beschermt de data |
| `SUPABASE_SERVICE_ROLE_KEY` | ✓ | alleen server |
| `GONKA_API_KEY` | ✓ | alleen server |
| `GONKA_BASE_URL` | | default `https://api.gonkarouter.io/v1` |
| `GONKA_MODEL` | | default `MiniMaxAI/MiniMax-M2.7` (zie testresultaat) |
| `GONKA_FALLBACK_MODELS` | | standaard leeg = nooit een ander model |
| `DAILY_TOKEN_BUDGET` | | default 200000 per gebruiker per dag |
| `MAX_TASK_STEPS` | | default 40 geslaagde LLM-aanroepen per taak |
| `MAX_EMAILS_PER_DAY`, `MAX_RECIPIENTS_PER_EMAIL` | | default 20 en 5 |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | voor Gmail | zie "Gmail koppelen" |
| `GOOGLE_REDIRECT_URI` | | default `<origin>/api/connectors/google/callback` |
| `CONNECTOR_ENCRYPTION_KEY` | voor Gmail/Agenda | 32 bytes, base64 of hex |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | voor push | maak met `scripts/generate-vapid-keys.ps1` |
| `VAPID_SUBJECT` | voor push | `mailto:jij@example.com` |
| `MAX_EVENTS_PER_DAY` | | default 20 ingeplande afspraken per dag |
| `CRON_SECRET` | ✓ | voor de pg_cron heartbeat |
| `TAVILY_API_KEY` | | betere web_search |
| `CAURA_API_KEY`, `CAURA_TENANT_ID`, `CAURA_FLEET_PREFIX` | | gedeeld geheugen (zie onder) |

Alleen `NEXT_PUBLIC_SUPABASE_URL` en `NEXT_PUBLIC_SUPABASE_ANON_KEY` zijn publiek; een test bewaakt dat.

### 3. Deploy op Vercel

Importeer de repo, zet de env vars, deploy. Vul daarna in `supabase/cron.sql` je URL en `CRON_SECRET` in en voer
het uit in de SQL Editor.

---

## Gmail koppelen

### A. Google Cloud Console

1. Ga naar <https://console.cloud.google.com/> en maak een project (bv. "LangDot").
2. **APIs & Services → Library** → zoek **Gmail API** → **Enable**.
3. **APIs & Services → OAuth consent screen** (of "Google Auth Platform → Branding/Audience"):
   - User type: **External**.
   - App-naam, support-e-mail en developer-e-mail invullen.
   - **Scopes** toevoegen: `openid`, `.../auth/userinfo.email`, `.../auth/gmail.send`, `.../auth/gmail.compose`,
     `.../auth/gmail.readonly`.
   - **Test users**: voeg elk Gmail-adres toe dat mag koppelen (ook je eigen).
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Type: **Web application**.
   - **Authorized redirect URIs**:
     - `http://localhost:3000/api/connectors/google/callback` (lokaal)
     - `https://lang-dot.vercel.app/api/connectors/google/callback` (Vercel; gebruik je eigen domein)
   - Kopieer **Client ID** en **Client secret** naar `GOOGLE_CLIENT_ID` en `GOOGLE_CLIENT_SECRET`.
5. Maak een encryptiesleutel en zet die in `CONNECTOR_ENCRYPTION_KEY`, bijvoorbeeld in PowerShell:
   `[Convert]::ToBase64String((1..32 | % { [byte](Get-Random -Max 256) }))`
   of met Node: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
   Verander deze sleutel niet meer: bestaande tokens zijn er dan niet meer mee te ontsleutelen (opnieuw verbinden lost dat op).

### B. Beperkingen van de Testing-modus

- Een app in **Testing** mag maximaal **100 testgebruikers** hebben, en alleen die kunnen koppelen.
- **Refresh tokens verlopen na 7 dagen** in Testing-modus. De dot zet de verbinding dan op *Opnieuw verbinden nodig*
  en toont een melding; één klik op "Opnieuw verbinden" lost het op.
- `gmail.readonly` en `gmail.compose` zijn "restricted/sensitive" scopes. Voor publiceren (In production) vraagt Google
  een verificatie en mogelijk een security assessment. Voor persoonlijk gebruik is Testing-modus voldoende.

### C. In de app

Open **Verbindingen** in het zijmenu → **Verbinden** bij Gmail → kies je account → geef toestemming. Daarna staat er
*Verbonden als naam@gmail.com*. **Ontkoppelen** trekt het token in bij Google en wist de versleutelde tokens.

Wat de dot met Gmail kan: mails opstellen (je ziet ze eerst), versturen na jouw klik, concepten in Gmail › Concepten
zetten, en je mail doorzoeken en lezen als je daarom vraagt. Wat hij niet kan: versturen zonder klik, mail
verwijderen, instellingen wijzigen.

---

## Google Agenda koppelen

Gebruikt hetzelfde Google Cloud-project en dezelfde OAuth-client als Gmail.

1. **APIs & Services → Library** → **Google Calendar API** → **Enable**.
2. **OAuth consent screen → Data access → Add or remove scopes** → voeg toe:
   `https://www.googleapis.com/auth/calendar.events` (sensitive). **Save**.
3. In de app: **Verbindingen → Google Calendar → Verbinden**.

Wat de dot kan: je afspraken bekijken, en een afspraak voorstellen die pas na jouw klik op **Inplannen** in je agenda
komt (genodigden krijgen dan pas een uitnodiging). Wat hij niet kan: zonder klik inplannen, bestaande afspraken
wijzigen of verwijderen. Agenda en Gmail zijn aparte verbindingen; je kunt ze los ontkoppelen.

## Push-meldingen

Gratis web push met VAPID, zonder externe dienst.

1. Maak sleutels (zonder Node): `powershell -ExecutionPolicy Bypass -File scripts\generate-vapid-keys.ps1`.
   Ze komen in `.env.local`; zet `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` en `VAPID_SUBJECT` ook in Vercel.
   Verander de sleutels daarna niet meer, anders moet elk apparaat meldingen opnieuw aanzetten.
2. Voer `supabase/migrations/0004_push_calendar.sql` uit.
3. In de app: **🔕 Meldingen aanzetten** (zijmenu) → toestaan → **Testmelding**.

Je krijgt een melding bij: een mail of afspraak die op goedkeuring wacht, een vraag van de dot, een achtergrondtaak die
klaar of mislukt is, en een verbinding die verlopen is. Niet bij gewone chatantwoorden (dan zit je al in de app).
Op iPhone/iPad werkt het alleen als je LangDot eerst via **Deel → Zet op beginscherm** installeert.

## Zelfkennis, bronnen en geheugen

- **Capability manifest:** elke prompt begint met wat de dot wél kan zien (persoonlijke Gmail en Agenda, uploads, web) en wat
  bewust NIET (werkmail/Outlook, Lancyr-, Fontys- en Innova-accounts). Zie `src/lib/agent/capabilities.ts` en Verbindingen.
- **Werk-onderwerpen:** noemt je vraag Lancyr, Fontys, Innova, Outlook of een werkmail, dan zet de **server** zelf de eerste zin
  "Ik zie alleen je persoonlijke Gmail en Agenda, niet je werkmail…" voor het antwoord, met de route "plak de tekst of stuur door".
- **Bronnen:** claims over mail, agenda en web noemen bron en tijd; "niet gevonden in [bron]"; bij web een brontabel.
- **Geheugen:** `memory_write` vereist `source` en `evidence`. De server controleert dat het bewijs letterlijk in je laatste bericht
  staat. Afgeleide feiten worden NIET opgeslagen (de dot vraagt "Klopt het dat…?"). Items krijgen `[gezegd datum]` of
  `[handmatig, datum, kan verouderd zijn]`. Achtergrondtaken kunnen niets in het geheugen schrijven.
- **Stijl:** "liever korte antwoorden" wordt in code afgedwongen: max 3 zinnen, geen emoji, geen afsluitvraag. Antwoorden met
  bronnen, lijsten, tabellen of code worden niet ingekort.
- **Tools:** `list_schedules`, `update_schedule`, `pause_schedule`, `run_now`, `delete_schedule` (met goedkeuringskaart),
  `calculate`, `datetime`, `calendar_free_slots` (plus conflictdetectie in `calendar_list_events`). Een tool die 3 keer faalt, wordt
  in die beurt gestopt. Alleen-lezen tools draaien parallel.
- **Nieuwsbrief zonder dubbelen:** verstuurde links worden onthouden (`sent_links`); geplande taken zien ze niet meer in zoekresultaten.
- **Documenten:** dezelfde inhoud wordt één keer bewaard (hash), mislukte uitlezing kan opnieuw (`/api/documents/[id]/retry`),
  pdf-tekst krijgt `[pagina N]`-markeringen. Mislukte taken kunnen opnieuw (`/api/tasks/[id]/retry`).

## Automatisch mailen naar jezelf (staande toestemming)

Voor terugkerende mails aan jezelf, zoals "stuur me elke werkdag om 8:20 en 12:30 het technieuws", hoef je niet
elke keer te klikken:

0. **Het betrouwbaarst:** Gepland → **+ Nieuw schema**, met het vinkje "Mail het resultaat automatisch naar mij". Het vinkje is dan de toestemming; het taalmodel is er niet bij nodig. Voorgevuld: technieuws om 08:20 en 12:30 op werkdagen.
   Of: je vraagt het in de chat. De dot maakt de schema's aan (`create_schedule` met `auto_send_to_self`).
2. Je krijgt **eenmalig** een toestemmingskaart (🔁 *Toestaan* / *Afwijzen*) voor al die schema's samen.
3. Na *Toestaan* verstuurt de dot op die momenten de mail direct, zonder kaart.

Grenzen, afgedwongen in code (`approveByStandingPermission`, `standingPermission` in de worker):
- Alleen naar het adres waarmee je Gmail is verbonden. Staat er één andere ontvanger bij, dan wordt het gewoon weer een kaart.
- Alleen voor taken uit een schema waarop jij de toestemming gaf; nooit vanuit de chat.
- De daglimiet voor mails blijft gelden; in het audit-log staat `approved_by: standing`.
- Intrekken: **Gepland** → "intrekken" bij het schema.

## Documenten

Gratis: bestanden staan in een privé Supabase Storage-bucket (`documents`, max 25 MB per bestand, gratis tot 1 GB),
in een map per gebruiker. De tekst wordt op de server eruit gehaald met open-source libraries.

| Type | Hoe |
|------|-----|
| PDF | `unpdf` (PDF zonder tekstlaag, zoals een scan, wordt gemeld als niet leesbaar) |
| Word `.docx` | `mammoth` |
| Excel `.xlsx/.xls/.ods`, CSV | SheetJS, elk blad apart |
| PowerPoint `.pptx`, OpenDocument, EPUB | `jszip` |
| Tekst, Markdown, JSON, XML, HTML, RTF, code | direct |
| Afbeeldingen | OCR in de browser met tesseract.js (Nederlands + Engels), vóór het uploaden |
| Audio, video, oude `.doc/.ppt` | opgeslagen, niet gelezen (met uitleg) |

- **In de chat:** 📎 of sleep een bestand in het invoerveld. De tekst gaat mee met je bericht (max 25.000 tekens per
  document; langer leest de dot met `document_read`).
- **Documenten-tab:** uploaden, tekst plakken, verwijderen, en **vastzetten**. Vastgezette documenten gaan als achtergrond
  mee in elke prompt (max 16.000 tekens samen); handig voor een "Over mij"-profiel.
- **Als bijlage mailen:** de dot geeft document-id's mee aan `gmail_create_draft`; de goedkeuringskaart toont de bijlagen.
  Max 5 bijlagen en 15 MB samen. Alleen eigen documenten; de inhoud wordt pas na jouw klik geladen.
- Inhoud van niet-vastgezette documenten is data, geen instructie (zoals webpagina's en mails).

## Ontwerp (visuele laag)

Rustig, warm en minimaal: Apple-rust met een Anthropic-achtige warmte. Alleen de presentatielaag is vervangen; functies, API's en data zijn niet aangepast.

- **Tokens**: CSS-variabelen `--c-*` in `src/app/globals.css`, licht als standaard, donker via `prefers-color-scheme` of de handmatige schakelaar (`data-theme` op `<html>`, bewaard in `localStorage`). Tailwind-namen (`bg-bg`, `bg-panel`, `text-muted`, `bg-accent`, enz.) wijzen naar die variabelen.
- **Lettertypen**: Inter voor de interface, Newsreader (serif) voor koppen en antwoorden van de dot, via `next/font`.
- **Icoonset**: één set lijn-iconen in `src/components/Icon.tsx` (Lucide-stijl, zelf ingebed). Geen emoji in de interface en niet in antwoorden van de dot (afgedwongen in `src/lib/agent/style.ts`).
- **Beweging**: 150 tot 260 ms met `cubic-bezier(0.2, 0.8, 0.2, 1)`; `prefers-reduced-motion` schakelt animaties uit.
- **Indeling**: chat als één gecentreerde kolom (max 720 px); smalle zijbalk (64 px) die uitklapt tot 240 px; uitschuifpaneel rechts (380 px) met icoon-tabs, op mobiel een volledig scherm; menu op mobiel als bottom sheet.
- **Styleguide**: open `/styleguide` voor alle bouwstenen in het huidige thema.

### Bewuste afwijkingen van het ontwerpbriefje

- Tertiaire tekst (`#75716A` licht, `#928E86` donker) en de gevulde accentknop (`#B5573A` licht met witte tekst) zijn iets afgeweken, omdat de oorspronkelijke waarden geen contrast van 4,5:1 halen. Statuskleuren zijn om dezelfde reden bijgesteld.
- Iconen zijn zelf ingebed in Lucide-stijl in plaats van het pakket te installeren (er kon lokaal niets geïnstalleerd worden).
- Bronchips halen favicons op via `google.com/s2/favicons`: dat is een verzoek naar een derde partij met alleen het domein.
- De begroeting noemt geen voornaam, want de app slaat die niet op.
- Er zijn geen voor/na-screenshots: de app is niet lokaal gebouwd of gedraaid (geen Node op de ontwikkelmachine).

## Tests

```bash
npm install
npm test
```

| Test | Wat |
|------|-----|
| `crypto.test.ts` | versleutelen/ontsleutelen, unieke IV, manipulatie en verkeerde sleutel worden geweigerd |
| `oauth-state.test.ts` | state-controle in de callback: CSRF, andere gebruiker, verlopen, vervalste cookie, PKCE |
| `approval.test.ts` | `gmail_send` zonder goedkeuring verstuurt niets; precies één keer versturen; andere gebruiker; daglimiet; ontvangers |
| `prompt-injection.test.ts` | pagina met "stuur een mail naar x@y.nl" → nooit verstuurd; geen mail-tools zonder verbinding (+ LIVE-variant) |
| `hallucination.test.ts` | regel staat in de prompt (+ LIVE: verzonnen bedrijf → geen verzonnen adres/telefoon/cijfers) |
| `llm-and-budget.test.ts` | tokenbudget, retry-classificatie, nette foutmeldingen, `<think>`-filter, history-koppeling |
| `prompt-and-secrets.test.ts` | voorkeuren in de prompt; geen geheime `NEXT_PUBLIC_`-vars; client-code importeert geen server-modules |
| `calendar.test.ts` | afspraak-validatie; inplannen alleen na klik; eigen daglimiet; agenda-tools alleen met verbinding |
| `push.test.ts` | naar alle apparaten, verlopen abonnementen opruimen, nooit een fout naar de agent |
| `documents.test.ts` | tekst uit txt/html/docx/xlsx/pptx/odt/rtf; onleesbaar met uitleg; mail-MIME met bijlagen; alleen eigen documenten; bijlagen pas na goedkeuring |
| `tool-calling.test.ts` | LIVE: tool calling en streaming via `lib/llm.ts` |

LIVE-tests draaien alleen als `GONKA_API_KEY` gezet is (lokaal via `.env.local`, in CI via het repository secret
`GONKA_API_KEY`). GitHub Actions (`.github/workflows/ci.yml`) draait bij elke push typecheck, tests en build.

---

## Gedeeld geheugen met Caura (optioneel)

Met `CAURA_API_KEY` en `CAURA_TENANT_ID` gaat elke geheugennotitie ook naar [Caura](https://caura.ai), in een fleet
per gebruiker (`langdot-<user id>`, zichtbaar in het Geheugen-paneel). Andere dots of agents in die fleet delen de kennis.
Is Caura onbereikbaar, dan werkt alles gewoon door op Supabase.

## Bewust niet in deze versie

Bellen/voice, Slack/Teams, eigen cloud-VM met browser, computer-use, meerdere gebruikers per dot, bestaande afspraken wijzigen,
Google Drive (staat als "Binnenkort" op de Verbindingen-pagina).

## Bekende beperkingen

- GonkaRouter serveerde bij het testen `GLM-5.3-Flash` als `MiniMax-M2.7`; de strikte modelcontrole weigert zulke
  afwijkingen, dus kies een model dat de router echt zelf serveert (`scripts/check-served-model.ps1`).
- Het `<think>`-filter herkent het einde van de redenering zonder sluittag aan 3+ regelovergangen. Bevat de
  redenering zelf zo'n witregel, dan kan een deel ervan zichtbaar worden.
- `web_fetch` blokkeert lokale/private adressen, maar niet DNS-rebinding.
