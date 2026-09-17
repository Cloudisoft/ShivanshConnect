# ShivanshConnect

A multi-tenant AI voice contact-center platform. This repository is being built in phases; **this
build covers Phases 1-3** (organizations, auth, users, roles/permissions, audit logs, the overall
app shell; leads/lead lists/phone normalization/DNC/CSV-XLSX import; and now AI agents/agent
versioning/prompt system/knowledge base (RAG)/scripts). Later phases (campaigns, dialing, live
monitoring, voices, telephony numbers, messaging, analytics, and more) are deliberately **not**
implemented yet - see [Phase plan status](#phase-plan-status) below.

## Architecture overview

```
apps/backend    Fastify + TypeScript REST API, under /api/v1/*
apps/frontend   React + TypeScript + Vite + Tailwind CSS
apps/worker     Placeholder package for a future background worker (no real queues in Phase 1)
packages/shared Shared TypeScript types used by both backend and frontend
supabase/       SQL migrations + seed data (Supabase Postgres, Row Level Security)
```

- **Database**: Supabase Postgres. Every tenant-scoped table has Row Level Security enabled.
  RLS policies use `current_user_organization_id()` and `current_user_has_permission()` helper
  functions resolved from `auth.uid()`. See `supabase/migrations/00000000000008_rls_policies.sql`
  for the full policy set and its documented threat model.
- **Backend**: Fastify + TypeScript. Every route under `/api/v1/*` returns a consistent envelope:
  `{ success, data, error, message, pagination?, request_id }`. The `authenticate` middleware
  verifies the caller's Supabase JWT **server-side** (never trusts the client), and every handler
  that touches another organization's data is checked in application code in addition to relying
  on RLS - this is "defense in depth," not either/or.
- **Frontend**: React + Vite + Tailwind, React Router, React Query. Supabase Auth's own
  `@supabase/supabase-js` client owns the browser session (sign in/out, password updates);
  organization/user provisioning that must be transactional (signup, invitation acceptance) goes
  through the backend, which then hydrates the browser session via `supabase.auth.setSession()`.
- **Auth**: Supabase Auth, email + password, with Supabase's built-in email verification and
  password reset flows. The backend independently re-verifies every JWT via
  `supabase.auth.getUser(token)` before trusting `organization_id` or permissions from it.
- **Deployment target (Railway)**: three services map 1:1 to `apps/backend`, `apps/frontend`,
  `apps/worker`, all pointed at the same Supabase project. No Railway services were provisioned by
  this build - the code is structured so wiring them up later is mechanical:
  - `shivanshconnect-backend` - Node service running `apps/backend` (`pnpm --filter backend start`
    after `build`), needs `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
    `FRONTEND_URL`, `PORT`.
  - `shivanshconnect-frontend` - static/Node service serving the Vite build of `apps/frontend`,
    needs `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_API_BASE_URL`.
  - `shivanshconnect-worker` - Node service running `apps/worker`; currently a no-op placeholder,
    real job consumers land with the queue/Redis phase.

## Phase plan status

**Phase 1 (this build) - done:**

- Database schema: `organizations`, `organization_settings`, `users`, `roles`, `permissions`,
  `role_permissions`, `user_roles`, `audit_logs`, `user_invitations`, all with RLS, indexes and FKs.
- Seeded system roles (`SUPER_ADMIN`, `ADMIN`, `MANAGER`, `AGENT`, `VIEWER`) and the full 27-key
  permission catalog.
- Backend API: signup (creates org + first SUPER_ADMIN user), login, logout, password reset
  request/confirm, accept-invitation; users list/invite/edit/role-change/deactivate; roles CRUD
  (system roles read-only) with a permission-catalog editor; audit log read API; organization
  settings read/update; `/me` for resolved permissions.
- Every user/role/org-settings mutation writes an `audit_logs` row via a shared
  `writeAuditLog()` helper.
- Frontend: full sidebar IA (all 18 modules from the reference screenshots, gold active-state),
  auth pages, a working Dashboard shell, and fully wired Users + Settings (Organization, Profile,
  Security, Users, Roles) pages. Every module not built yet routes to an honest "scheduled for a
  later build phase" empty state - never fake data or a "Coming soon" button.
- Backend unit + integration tests (23 passing) and RLS verified against a real local
  PostgreSQL 16 instance (see [Verification notes](#verification-notes)).

Phase 1 shipped an `EmailService` interface with a console-log implementation only (invite/reset
links are logged and also returned in API responses in dev) - real SMTP delivery is still
deferred, see the full up-to-date deferred list below.

Every permission key for modules not yet built (e.g. `campaigns.view`, `live_monitor.barge`,
`voices.manage`) is already seeded into the `permissions` table so later phases only need to wire
up real enforcement, not another migration.

**Phase 2 (this build) - done:**

- Database schema: `lead_lists`, `leads` (seeds the full Phase 51 lead state machine now, even
  though nothing drives a lead through most of it until the dialer phases), `lead_list_members`
  (many-to-many list membership - a lead can belong to more than one list), `lead_custom_fields`
  (per-org custom field catalog used by import), `dnc_entries` (org-scoped or global suppression,
  independent of any single lead record) and `import_jobs` + `import_job_rows` (async import),
  all with RLS and indexes following the same pattern as Phase 1.
- Phone normalization (`apps/backend/src/lib/phone.ts`, `libphonenumber-js`): any US/Canada format
  is normalized to strict E.164; invalid or non-NANP numbers are flagged, never guessed. Covered by
  unit tests for every format in the spec plus invalid inputs.
- Backend API: `/lead-lists` (CRUD + `POST /:id/import`), `/leads` (paginated/filterable/sortable
  list with real server-side pagination, single add, `/bulk` paste-numbers, `/bulk-actions` with
  either literal ids or a filter - "select all matching" never requires the frontend to enumerate
  10k+ ids - get/patch/delete), `/lead-custom-fields`, `/dnc` (add/list/remove; adding an entry
  flags matching existing leads), `/import-jobs` (poll status, list preview rows, adjust column
  mapping, commit, download error rows as CSV).
- Async CSV/XLSX import (`apps/backend/src/services/importLeads.ts`): there is no queue/worker
  infra yet (Redis/BullMQ is Phase 15/deployment), so a job is processed via `setImmediate` on the
  same backend process right after upload. Every exported function in that file takes plain
  arguments and does its own Supabase reads/writes - no Fastify request/reply object - so a future
  BullMQ worker can call the same functions unchanged; only what invokes them (and where the file
  bytes come from) needs to change. Uploaded rows are always persisted with their original
  header-keyed values in `import_job_rows.raw_data`, so adjusting the column mapping re-validates
  from already-stored data and never re-reads the original file.
- Frontend: full Lead Lists and Leads pages (replacing the Phase 1 placeholders), a virtualized
  (`@tanstack/react-virtual`) leads data table on top of real server-side pagination, bulk
  selection and bulk action bar, Add Lead / Paste Numbers / Import modals (upload -> column mapping
  -> preview with counts -> commit -> progress polling -> summary with an error-rows download), a
  lead detail page with honest empty states for Call History / Campaign History / Recordings /
  Transcripts (each captioned with the phase that adds it), and a Settings > Compliance page for Do
  Not Call management.
- Backend tests: phone normalization, DNC eligibility (org-scoped/global/cross-org), duplicate-phone
  detection, import column-mapping inference and row validation/classification, the bulk-action
  "select all matching filter" pagination helper, and one full integration test (create a lead
  list -> upload a CSV with 2 valid/1 duplicate/1 invalid/1 DNC row via a real multipart request ->
  poll the async job -> commit -> verify the final lead count, job summary and error-report CSV,
  plus cross-tenant isolation on lists/leads/import jobs).

**Phase 3 (this build) - done:**

- Database schema: `ai_agents` + `ai_agent_versions` (every configuration change creates a new,
  immutable version - draft -> published -> archived on the next publish - never mutating history;
  `current_version_id` points at whichever version is live), `ai_agent_improvements` (table only,
  stays empty until Phase 11's call evaluator populates it - no fake data or stub evaluator),
  `scripts` (`{{variable}}` call scripts, optionally attached to an agent), and the unified document
  pipeline `knowledge_bases` / `knowledge_documents` / `knowledge_chunks`. Adds
  `CREATE EXTENSION vector` (pgvector) and an ivfflat cosine-similarity index on
  `knowledge_chunks.embedding vector(1536)` - 1536 dims matches OpenAI's `text-embedding-3-small`,
  the only embedding model this build wires up. `ai_agent_versions.voice_id` is a bare column for
  now (its FK to a future `voices` table is deferred to Phase 4, same pattern as `scripts`/
  `knowledge_bases.campaign_id` deferring to Phase 7). RLS on all 7 new tables, same pattern as
  Phase 1/2. `agents.manage` was already in the Phase 1 permission catalog, granted to
  SUPER_ADMIN/ADMIN/MANAGER - no new seed migration needed.
- `apps/backend/src/lib/llm/`: an `LLMProviderAdapter` interface (`generateText`, `embedText`) with
  one real implementation, `OpenAIProvider`, calling the OpenAI API directly via `fetch` using
  `OPENAI_API_KEY` from the environment - no second provider in this build. If the key is unset,
  every call throws a typed `LlmNotConfiguredError` immediately; the central error handler maps that
  to a `422 LLM_NOT_CONFIGURED` response with an honest, specific message - **knowledge-base
  embedding and agent preview never fabricate output when no provider is configured.**
- Backend API: `/agents` (CRUD, `agents.manage` + explicit org checks + Zod validation + audit log
  on every mutation), `/agents/:id/versions` (create draft / edit draft / publish - archives any
  previously-published version and flips `ai_agents.current_version_id` - / list for compare /
  restore-as-new-draft, which never mutates the version it restores from), `/agents/:id/improvements`
  (reads the empty `ai_agent_improvements` table honestly), `/agents/:id/preview` (renders the
  published system prompt/greeting against a sample lead payload, then calls the LLM provider),
  `/agents/:id/knowledge/search` (embeds the query, then `supabase.rpc('match_knowledge_chunks', ...)`
  for real pgvector cosine search with `organization_id` baked into the SQL function itself),
  `/scripts` (CRUD, `GET /scripts/templates` for the 3 starter templates, template-clone on create,
  file upload parsed through the same doc-extraction pipeline as knowledge-base ingestion), and
  `/knowledge-bases` (create scoped to an agent, list/get, list documents, multipart upload ->
  `knowledge_documents` row (`status=uploaded`) -> async processing, delete a document (cascades its
  chunks), reprocess).
- Knowledge-base ingestion pipeline (`apps/backend/src/services/processKnowledgeDocument.ts`),
  deliberately following Phase 2's `services/importLeads.ts` shape: no queue/worker infra yet
  (Redis/BullMQ is Phase 15), so a freshly-uploaded document is processed via `setImmediate` on the
  same backend process right after upload. Extracts text (`pdf-parse` for PDF, `mammoth` for DOCX,
  plain UTF-8 decode for TXT/MD, CSV-to-text flattening for CSV) -> chunks it (~500-800 tokens with
  overlap, `apps/backend/src/lib/chunking.ts`) -> embeds each chunk through the LLM provider adapter
  -> stores `knowledge_chunks` -> marks the document `ready`. No embedding provider configured ->
  `status=failed` with a clear `error_message`, never a fabricated embedding. Every exported function
  takes plain arguments and does its own Supabase reads/writes, ready for a future BullMQ worker to
  call unchanged.
- Frontend: replaces the "AI Agents" sidebar placeholder with a real module - agent list, a create
  wizard (name/role/description), and an agent detail page with 6 tabs (Configuration - personality
  presets as toggle pills, prompt/greeting editors with a visible `{{variable}}` palette, transfer
  and call-ending rules, LLM settings, save-draft/publish-with-confirmation; Versions - list,
  two-way field comparison, publish, restore; Scripts - attach/create, template-clone; Knowledge Base
  - upload/status/delete/reprocess with a live "Test retrieval" box against the real search endpoint;
  Preview - chat-style UI against the real preview endpoint with an honest "no LLM configured" empty
  state; Improvements - honest empty state naming Phase 11). A standalone Scripts page
  (list/create/edit/upload/template-clone) is reachable from the Agents module.
- Backend tests: agent version lifecycle (create draft -> publish -> archive-on-republish -> restore
  never mutates the source version) as a full integration test verifying `current_version_id` +
  status flip + an `agent_version.published` audit log row; personality/tone/behavior/LLM-setting
  schema validation; the chunk-splitting function (including a forward-progress guard so
  overlap >= target chunk size can't loop or walk backward); the LLM provider adapter's
  not-configured error paths (unit) and a real successful/failed OpenAI call against a stubbed
  `fetch` (unit); a knowledge-document integration test that uploads a small TXT file, processes it
  for real (chunking, storage) with only the OpenAI embedding call mocked at the provider-adapter
  boundary (documented as test-only, never shipped app behavior), verifies chunks + `status=ready`,
  and retrieves the right chunk by similarity; and a **cross-org retrieval isolation test** - a
  second, legitimately authenticated organization with its own agent asks the identical query and
  gets zero results, and is separately rejected outright (404) addressing the first organization's
  agent id directly.

**Phase 4 (this build) - done:**

- Database schema: `voice_providers` (fixed 4-provider catalog - `elevenlabs`, `cartesia`,
  `omnivoice`, `voxcpm` - seeded, `requires_external_hosting` flags the self-hosted two),
  `voice_provider_credentials` (org-scoped, AES-256-GCM encrypted API key / endpoint+key per
  provider), `voices` (the org's own registered voices - synced from a provider's catalog or
  created by cloning; `is_cloned`/`clone_status`/`consent_confirmed`/`source_sample_storage_path`).
  Adds the FK Phase 3 deferred: `ai_agent_versions.voice_id` (a bare `text` column since
  `00000000000018`) is converted to `uuid` and given a real `references voices(id) on delete set
  null` constraint. RLS on all 3 new tables, same pattern as Phases 1-3.
- `apps/backend/src/lib/voice/`: a `VoiceProviderAdapter` interface (`listVoices`, `getVoice`,
  `previewVoice`, `validateVoice`, optional `createVoice`/`deleteVoice` for cloning) mirroring
  Phase 3's `LLMProviderAdapter` shape, with **four real adapters**:
  - `ElevenLabsProvider` / `CartesiaProvider` - real REST calls against each vendor's actual
    documented managed-API endpoints (voice list/get, text-to-speech, multipart voice-cloning
    upload, delete), auth via `xi-api-key` / `X-API-Key`+`Cartesia-Version` respectively.
  - `OmniVoiceProvider` (k2-fsa, Apache-2.0, open-source voice cloning/design) and `VoxCPMProvider`
    (OpenBMB, Apache-2.0, open-source 48kHz diffusion TTS) are **not run in this codebase** - no
    GPU exists here. Each is an HTTP client against a **serverless GPU inference endpoint the
    organization deploys and configures itself**, per org, under Voice Providers:
    - **OmniVoice -> a Replicate custom model deployment.** Chosen because Replicate's HTTP API has
      the clearest documented *generic* invocation pattern of the real serverless-GPU options
      considered (Replicate custom deployments / Modal / RunPod Serverless / HF Inference
      Endpoints): every model is invoked the same way - `POST {input: {...}}` with a bearer token,
      then poll the returned `urls.get` until `status` settles. `OmniVoiceProvider` implements
      exactly that create -> poll contract. Full deploy steps (package the model as a Cog model,
      push it, create a Deployment, set `OMNIVOICE_ENDPOINT_URL`/`OMNIVOICE_API_KEY`) are documented
      in `lib/voice/omnivoice.ts`'s header comment.
    - **VoxCPM -> its own official vLLM-Omni integration**, which serves it behind an
      **OpenAI-compatible `/v1/audio/speech` endpoint** (`vllm serve openbmb/VoxCPM2 --omni`) - the
      real, documented way to serve this model without writing custom inference glue.
      `VoxCPMProvider` is simply an OpenAI-TTS-shaped client against that endpoint, using VoxCPM's
      documented `ref_audio` extension for cloned voices. Deploy steps are documented in
      `lib/voice/voxcpm.ts`'s header comment.
    - Both self-hosted adapters carry `requiresExternalHosting: true` on every `VoiceInfo` they
      return, and every method throws a typed `VoiceProviderNotConfiguredError` (mapped to a
      `422 VOICE_PROVIDER_NOT_CONFIGURED` response) until the org sets its endpoint URL + key -
      **never fabricated voices or audio.** Neither has a built-in voice catalog (they're raw
      synthesis/cloning models, not managed APIs with a voices list), so `listVoices()` honestly
      returns an empty list once configured; every OmniVoice/VoxCPM voice in this build comes from
      cloning.
- `apps/backend/src/lib/crypto/credentials.ts`: AES-256-GCM encrypt/decrypt using
  `CREDENTIAL_ENCRYPTION_KEY`, plus a `maskSecret()` helper for safe frontend display - built fresh
  here (no prior phase needed it) and explicitly the pattern Phase 5 (Twilio/Telnyx), Phase 6
  (Vapi) and Phase 13 (SMTP) are expected to reuse for their own credentials rather than each
  rolling their own.
- `apps/backend/src/lib/storage/`: a `StorageAdapter` interface with **one real implementation**,
  `LocalDiskStorageAdapter` - the first phase that needs to durably write bytes it later serves
  back (generated voice-preview audio, cloning reference samples). This is real, working local-disk
  storage (served back by a new unauthenticated `GET /voice-previews/:key` route, keyed by
  server-generated random UUIDs only) but is explicitly documented as **not production object
  storage** - master spec section 22's real S3-compatible storage is still deferred; the interface
  exists precisely so that swap is mechanical later, same as the LLM/voice adapter pattern.
- Backend API: `/voice-providers` (catalog + this org's connection status, masked credentials
  only), `POST /voice-providers/:key/credentials` (encrypts before storing), `POST
  /voice-providers/:key/test-connection` (a real adapter call - `listVoices()` for the managed
  providers, since there's no other reachability check for the self-hosted two, a tiny
  `previewVoice()` call - persists real status/`last_verified_at`/`last_error`); `/voices`
  (paginated, provider/language/gender/status filters), `POST /voices/sync/:providerKey`
  (`listVoices()` -> upsert deduped on org+provider+provider_voice_id), `POST /voices/:id/preview`
  (`previewVoice()` -> saved via `StorageAdapter` -> returns a URL), `POST /voices/clone`
  (multipart upload, **hard-rejects a request with no explicit `consent_confirmed: true`** per the
  spec's compliance rule, creates a `pending` voice row, then a `setImmediate` hand-off - same
  pattern as Phase 2/3's async jobs - calls the provider's real `createVoice()` and transitions
  `clone_status` to `ready`/`failed`), `DELETE /voices/:id`. Every route requires
  `voices.manage` (already in the Phase 1 permission catalog, granted to
  SUPER_ADMIN/ADMIN/MANAGER), scopes every query to the caller's `organization_id`, validates with
  Zod, and audit-logs credential saves/connection tests/syncs/clones/deletes.
- Frontend: replaces the "Voices" sidebar placeholder with a real module at `/voices` (3 tabs -
  Voices: table with a real Play preview button per voice and "Self-hosted - endpoint required" vs
  "Managed" badges; Provider Connections: per-provider credential form with a masked existing
  value, a real Test Connection button, deploy instructions inline for the two self-hosted
  providers; Clone Voice: upload + a required, cannot-submit-without-it consent checkbox + clone
  status polling). Wires the agent Configuration tab's `voice_id` field (a bare text input since
  Phase 3) to a real picker pulling the org's registered voices with its own preview button.
- Backend tests: credential encryption round-trip/tamper-detection/not-configured (unit); each
  adapter's request-shaping against fetch mocks, asserting on the exact documented URLs/headers/
  payloads (unit, all 4 providers); the self-hosted providers' not-configured error paths with no
  endpoint env vars set (unit); and a full integration test - connect ElevenLabs (HTTP mocked only
  at the fetch boundary), a real test-connection call, sync, and a voice list scoped to the
  connecting org only (a second org's list/provider status stays untouched even after the first
  org's sync) - plus voice cloning rejecting a request with no consent and completing one with
  consent once the (mocked) provider call resolves.

**Explicitly NOT built yet** (deferred to later phases):

- Campaigns, Dialing Settings, Callbacks, Dispositions - campaign/dialer management
- Live Monitor (listen/barge/whisper on live calls)
- CDR (call detail records), call history/recordings/transcripts on the lead detail page
- Vapi / real telephony (Twilio/Telnyx) integration for actually placing/receiving calls with a
  chosen voice - Phase 4 only builds voice *management* (providers, credentials, the org's voice
  catalog, cloning, preview); wiring a voice into a live call is Phase 5/6.
- DIDs, Inbound Routes, Queues (Twilio/Telnyx number management, inbound call routing)
- Messaging
- Analytics (the Phase 1 Dashboard is intentionally a shell with no metrics, real or fake)
- SMTP-backed email delivery
- Background job queues / Redis (the async import in Phase 2, the Phase 3 knowledge-document
  pipeline and Phase 4's voice cloning all use `setImmediate` on the backend process itself - see
  above - specifically so this later migration is mechanical for all three)
- Real, production S3-compatible object storage (master spec section 22) - Phase 4 adds the first
  real implementation (`LocalDiskStorageAdapter`, see above) for voice-preview audio and cloning
  samples, but it is explicitly local-disk, not durable/replicated production storage; uploaded
  import files and knowledge-base documents from Phases 2-3 still use the synthetic
  `memory:<...>` locator and are never persisted - this is also why knowledge-document "reprocess"
  in this build resets status and asks for a fresh upload rather than fabricating a re-embed from
  bytes that were never persisted
- A second LLM/embedding provider - only `OpenAIProvider` is implemented; `LLMProviderAdapter` is
  provider-agnostic so a second one can be added without touching call sites
- Actually deploying/running the OmniVoice or VoxCPM models on any GPU, serverless or otherwise -
  Phase 4 ships real, working HTTP clients against endpoints the organization must stand up itself
  (see `lib/voice/omnivoice.ts` / `voxcpm.ts` for exact steps); no GPU exists in this build/sandbox
- Railway service provisioning

### Phase 3 environment requirements

Knowledge-base document processing, knowledge search and agent preview all require a real
`OPENAI_API_KEY` set in the backend environment (`apps/backend/.env` / Railway service variables).
Without it, uploads land in `status=failed` with an honest `error_message`, and the preview/search
endpoints return a `422 LLM_NOT_CONFIGURED` response - never fabricated output. The database
requires the `pgvector` Postgres extension (`CREATE EXTENSION vector`, migration
`00000000000021_knowledge_base.sql`); a hosted Supabase project has this available already, and a
self-managed Postgres needs the `pgvector` extension package installed first (e.g.
`apt install postgresql-16-pgvector` on Debian/Ubuntu, matching the server's major version).

### Phase 4 environment requirements

`CREDENTIAL_ENCRYPTION_KEY` must be set for `POST /voice-providers/:key/credentials` to work at
all (a 64-hex-char or 32-byte-base64 key - generate one with `openssl rand -hex 32`); without it
every credential save fails with an honest `422 CREDENTIAL_ENCRYPTION_NOT_CONFIGURED`. Each voice
provider is otherwise opt-in per organization, via Voice Providers in the app, not a required
startup variable - `ELEVENLABS_API_KEY`/`CARTESIA_API_KEY` (and `OMNIVOICE_ENDPOINT_URL`/
`OMNIVOICE_API_KEY`, `VOXCPM_ENDPOINT_URL`/`VOXCPM_API_KEY`) in the backend env only act as a
platform-level default an org's own stored credential overrides. `STORAGE_LOCAL_DIR` controls
where generated voice-preview audio and cloning reference samples are written
(`LocalDiskStorageAdapter`); it defaults to `apps/backend/.data/voice-storage` and needs no other
configuration to work, but see the storage bullet above for why this isn't production storage.

## Running locally

### Prerequisites

- Node.js 20+
- pnpm (`corepack enable` or `npm install -g pnpm`)
- A Supabase project (cloud) **or** the Supabase CLI for local Postgres via Docker
- Docker, if using the Supabase CLI's local stack

### 1. Install dependencies

```bash
pnpm install
```

### 2. Start Supabase and apply migrations

With the Supabase CLI and Docker available:

```bash
npx supabase start     # or: pnpm run supabase:start
npx supabase db reset  # applies every migration in supabase/migrations, then supabase/seed.sql
```

This prints local `API URL`, `anon key` and `service_role key` values - use them below.

Against a hosted Supabase project instead:

```bash
npx supabase link --project-ref <your-project-ref>
npx supabase db push
```

### 3. Configure environment variables

Copy `.env.example` to `.env` at the repo root, and/or per app
(`apps/backend/.env`, `apps/frontend/.env`), filling in your Supabase URL/keys. Never commit a
real `.env` file - only `.env.example` files are tracked.

### 4. Run the apps

```bash
pnpm run dev:backend    # Fastify API on http://localhost:4000
pnpm run dev:frontend   # Vite dev server on http://localhost:5173
pnpm run dev:worker     # Phase 1 placeholder - logs and exits
```

Or all at once: `pnpm run dev`.

Visit `http://localhost:5173/signup` to create the first organization and admin account.

### Running tests

```bash
pnpm run test           # runs every app's test suite (currently apps/backend)
pnpm --filter @shivanshconnect/backend run test   # backend only
```

### Building for production

```bash
pnpm run build           # builds packages/shared, then every app
pnpm run lint             # ESLint across every workspace
pnpm run typecheck        # TypeScript project references, no emit
```

## Verification notes

This sandbox has no reliable outbound access to the container registries the Supabase CLI's local
Docker stack pulls images from - in the Phase 1 session both ghcr.io and Docker Hub returned `403
Forbidden`; in the Phase 2 session the Docker daemon itself was reachable but Docker Hub responded
`429 Too Many Requests` on every pull. Either way, the full `supabase start` stack (Postgres +
GoTrue + PostgREST + Studio, etc.) could not be started here in either session. The same two things
were verified for real in both:

1. **Every SQL migration was applied, in order, to a real local PostgreSQL 16 instance**
   (installed directly via `apt`, not Docker), including a minimal `auth.users` table and
   `auth.uid()` stub so the RLS-dependent helper functions could be created.
   - Phase 1: all 9 migrations applied cleanly; RLS confirmed enabled on all 9 tenant tables; the
     seed produced 27 permissions and the expected per-role permission counts
     (`SUPER_ADMIN`/`ADMIN`: 27, `MANAGER`: 24, `AGENT`: 8, `VIEWER`: 7).
   - Phase 2: all 16 migrations (the original 9 plus the 7 new Phase 2 ones) applied cleanly on top,
     in order, to a fresh database; RLS confirmed enabled on all 16 tables including the 7 new ones
     (`lead_lists`, `leads`, `lead_list_members`, `lead_custom_fields`, `dnc_entries`,
     `import_jobs`, `import_job_rows`).
   - Phase 3: all 23 migrations (the original 16 plus the 7 new Phase 3 ones) applied cleanly, in
     order, to a fresh database, including `CREATE EXTENSION vector` (pgvector 0.6.0, installed via
     `apt install postgresql-16-pgvector` in this sandbox) and the `match_knowledge_chunks` pgvector
     cosine-similarity SQL function; RLS confirmed enabled on all 23 tables including the 7 new ones
     (`ai_agents`, `ai_agent_versions`, `ai_agent_improvements`, `scripts`, `knowledge_bases`,
     `knowledge_documents`, `knowledge_chunks`); the permission catalog seed still produces exactly
     27 permissions including `agents.manage`. `match_knowledge_chunks` was also exercised directly
     with real vector literals: a query scoped to the real organization returns its chunk, and the
     same query with a different (non-existent) `organization_id` returns zero rows.
2. **Backend integration tests** exercise the real Fastify route handlers end-to-end over HTTP
   (`app.inject()`) against an in-memory fake of the Supabase client
   (`apps/backend/src/test/fakeSupabase.ts`), since no live Supabase project or local PostgREST was
   reachable either. This is the documented "mock at the DB-client boundary" fallback, not a
   substitute for RLS verification (covered by point 1).
   - Phase 1: `apps/backend/src/integration.test.ts` - signup, invite, accept invitation, role
     change, audit log read, and a cross-tenant rejection.
   - Phase 2: `apps/backend/src/leads.integration.test.ts` - create a lead list, upload a CSV via a
     real multipart request, poll the async import job to completion, commit, and verify the final
     lead count, import job summary and error-report CSV, plus cross-tenant isolation on
     lists/leads/import jobs.
   - Phase 3: `apps/backend/src/agents.integration.test.ts` - agent create -> draft version ->
     publish -> `current_version_id` + status + audit log verified -> published version rejects
     direct edits -> restore creates a new draft without mutating the published one -> versions list
     order -> honest empty Improvements -> honest "not configured" preview, plus a cross-tenant 404.
     `apps/backend/src/knowledgeBase.integration.test.ts` - upload a small TXT document, process it
     for real (only the OpenAI embedding call mocked at the LLM provider adapter boundary, documented
     as test-only), verify chunks + `status=ready`, retrieve by similarity, and the cross-org
     retrieval isolation test (a second organization's identical query returns zero results; a
     guessed agent id from another org is rejected with 404), plus a no-provider-configured ->
     `status=failed` case.
   - Phase 4: `apps/backend/src/voices.integration.test.ts` - connect ElevenLabs credentials (HTTP
     mocked only at the fetch boundary, real route/adapter code unmocked), verify the raw API key
     never appears in the save response, a real test-connection call, sync voices, and a voice list
     scoped to the connecting org only (a second org's list and provider status stay untouched);
     voice cloning rejects a request with no `consent_confirmed` (no voice row created) and
     completes one with consent once the mocked provider response arrives (`clone_status`
     pending -> ready with the real `provider_voice_id`).
   - Phase 4 added 2 new migrations (25 total: the original 23 plus
     `00000000000024_voices.sql`/`00000000000025_phase4_rls_policies.sql`), applied cleanly in
     order to a fresh database; RLS confirmed enabled on all 26 tables including the 3 new ones
     (`voice_providers`, `voice_provider_credentials`, `voices`); the permission catalog seed still
     produces exactly 27 permissions (`voices.manage` was already seeded in Phase 1, granted to
     SUPER_ADMIN/ADMIN/MANAGER - no new permission row needed); the `voice_providers` catalog seed
     produces exactly the 4 expected providers with `requires_external_hosting` correctly set
     (`false` for `elevenlabs`/`cartesia`, `true` for `omnivoice`/`voxcpm`); and the deferred
     `ai_agent_versions.voice_id -> voices.id` foreign key is confirmed in place after converting
     the column from `text` to `uuid`.

**Not independently verifiable in this sandbox:** the exact real-world request/response shapes of
ElevenLabs' and Cartesia's APIs (no live network access to either vendor here; every adapter's
request URL/headers/payload is built from each provider's current public API documentation, and
their unit tests assert on those exact shapes against a mocked `fetch`), and OmniVoice/VoxCPM
end-to-end synthesis/cloning, which requires an organization to actually deploy a serverless GPU
endpoint first (no GPU exists in this build/sandbox) - both adapters' "not configured" and
request-shaping logic are unit-tested instead.

If you have reliable Docker registry access, `supabase start` followed by `supabase db reset` will
run the same migrations against the full local stack, and `supabase db push` will apply them to a
real hosted project - nothing about the migrations themselves depends on this sandbox's
workaround.
