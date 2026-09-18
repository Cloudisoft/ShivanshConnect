# ShivanshConnect

A multi-tenant AI voice contact-center platform. This repository is being built in phases; **this
build covers Phases 1-13** (organizations, auth, users, roles/permissions, audit logs, the overall
app shell; leads/lead lists/phone normalization/DNC/CSV-XLSX import; AI agents/agent versioning/
prompt system/knowledge base (RAG)/scripts; voice providers/cloning; telephony number providers -
Twilio, Telnyx, Bring Your Own Number - and the org's phone number (DID) registry; call
orchestration - Vapi (managed) plus pipecat (a real, self-hosted second engine running as its own
Python service, `apps/pipecat-service`), the one authoritative `calls` record regardless of engine,
and idempotent webhook ingestion; campaigns and the real campaign execution engine - snapshot-on-
publish configuration versioning, a genuine queue-based dispatcher (not a `for each lead` loop)
with race-safe lead claiming, real eligibility/preflight/retry/rotate logic, and org-level dialing
defaults; the explicit call state machine, the deterministic disposition engine, the
formalized retry engine, and the callback scheduler - a single `transitionCallState()` executor
every call-status write goes through (validated, logged-and-rejected on an invalid transition, real
in-process eventing), a real rules-based disposition engine (never randomized, never LLM-based)
that is the single source of truth for both `call_dispositions` and `campaign_leads.
final_disposition`, a hard DNC-never-retry invariant, and end-to-end tool-call webhook handling so
the AI can schedule a callback or recognize a DNC request mid-call; and now **real CDR (call
detail records), transcripts, recordings and AI call summaries** - a real terminal-transition-
triggered ingestion pipeline that fetches each call's actual transcript (parsed into ordered,
searchable per-utterance segments) and actual recording bytes (downloaded and durably re-stored,
never just a passthrough of the provider's own possibly-ephemeral URL) through the existing Phase
6 orchestration adapters and Phase 4 `StorageAdapter`, a real LLM-generated call summary when an
LLM provider is configured (never a fabricated one otherwise), a fully joined/paginated/filterable
CDR API with Postgres full-text transcript search, and background CSV/XLSX export jobs); and now
**Live Monitor** - real-time listen/whisper/barge/transfer/end supervisor controls over a real
WebSocket stream (`WS /api/v1/live-monitor/stream`), driven directly by Phase 8's call-state-machine
event bus and a new live (mid-call, not just post-call) transcript-segment ingestion path, with
listen/whisper/barge implemented genuinely differently for Vapi (the real, honestly-limited
`listenUrl`/`controlUrl` mechanism) versus pipecat (real audio-frame tapping/injection/mixing in
our own pipeline) - see [Phase 10](#phase-10-this-build---done) below for the full writeup; and now
**the AI call evaluator/improvement loop** (Phase 11 - a real per-call LLM evaluation against the
full spec section 24 rubric, recurring-issue mining into a human-reviewed improvement queue that only
ever produces a new draft agent-prompt version, never an auto-publish) and **Analytics** (Phase 12 -
pre-aggregated daily/hourly rollup tables per spec section 89, a real dashboard KPI grid and chart
set, and campaign/agent analytics per spec section 42, with the true real-time figures - active
calls, remaining leads, campaigns running, agents active - always live, never rollups); and now
**Messaging** (Phase 13 - real SMTP email sending via `nodemailer`, real SMS sending via Twilio/
Telnyx reusing Phase 5's exact stored credentials rather than a second credential store, SMS and
email campaigns dispatched by the same queue-based/throttled architecture as Phase 7's call
dispatcher, real DNC/opt-out suppression checks per channel, and an explicit, honestly-stated limit
that raw SMTP cannot report delivery/bounce/reply without a transactional email provider - see
[Phase 13](#phase-13-this-build---done) below); and now **generalized exports** (Phase 14 - Phase
9's background CSV/XLSX export engine extended, not rebuilt, to Leads, Lead Lists, and SMS/Email
campaign messages, a real shared `writeCsv`/`writeXlsx` file-writing layer and job runner every
export type now goes through, a unified Export History view spanning every module in one place, and
this build's real, re-verified `ffmpeg` MP3 transcoding on call recording downloads - see
[Phase 14](#phase-14-this-build---done) below). Later phases (inbound routing, queues, further
performance/load testing, and more) are deliberately **not** implemented yet - see
[Phase plan status](#phase-plan-status) below.

## Architecture overview

```
apps/backend         Fastify + TypeScript REST API, under /api/v1/*
apps/frontend        React + TypeScript + Vite + Tailwind CSS
apps/worker          Placeholder package for a future background worker (no real queues in Phase 1)
apps/pipecat-service Phase 6 - Python/FastAPI service, the self-hosted call orchestration engine.
                     A SEPARATE process/deployment from apps/backend - see its own README.
packages/shared      Shared TypeScript types used by both backend and frontend
supabase/            SQL migrations + seed data (Supabase Postgres, Row Level Security)
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
  - `shivanshconnect-pipecat-service` (Phase 6) - a **fourth** Railway service, Python/uvicorn
    running `apps/pipecat-service`, its own domain and environment variables. See that service's
    README for its exact start command and variable list.

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
  `current_version_id` points at whichever version is live), `ai_agent_improvements` (table only at
  the time, stays empty until Phase 11's call evaluator populates it for real - see the Phase 11
  section below; no fake data or stub evaluator in this phase),
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

**Phase 5 (this build) - done:**

- Database schema: `phone_number_providers` (fixed 3-provider catalog - `twilio`, `telnyx`, `byon`
  - seeded), `phone_number_provider_credentials` (org-scoped, AES-256-GCM encrypted Twilio Account
  SID+Auth Token / Telnyx API key - reuses Phase 4's exact `lib/crypto/credentials.ts` helper; BYON
  never has a row here, it has no credentials), `phone_numbers` (the org's registered DIDs - synced
  from Twilio/Telnyx or declared via BYON; E.164-normalized with Phase 2's `lib/phone.ts`, unique
  per org on `(provider_key, provider_number_id)` when present and unconditionally unique on
  `phone_number`, per spec section 57; `assigned_agent_id` FK to `ai_agents`, `assigned_campaign_id`
  a deferred bare `uuid` with no FK until Phase 7's `campaigns` table exists, same pattern as Phase
  3/4's other deferred FKs). RLS on all 3 new tables, same pattern as Phases 1-4.
- `apps/backend/src/lib/telephony/`: a `TelephonyNumberProviderAdapter` interface (`connect`,
  `disconnect`, `listNumbers`, `importNumber`, `validateNumber`, `getNumberStatus`) mirroring Phase
  4's `VoiceProviderAdapter` shape, with **three real adapters**:
  - `TwilioProvider` - real Twilio REST API over HTTP Basic Auth (Account SID + Auth Token) against
    the actual documented endpoints: `Accounts/{sid}.json` (credential check), `IncomingPhoneNumbers`
    list/get, and Lookup v2 (`validateNumber`).
  - `TelnyxProvider` - real Telnyx REST API over a Bearer API key against `/v2/phone_numbers`
    list/get and `/v2/number_lookup` (`validateNumber`).
  - `BYONProvider` ("Bring Your Own Number") is **explicitly not a third-party API integration** -
    there is no BYON company or endpoint anywhere. It is a manual-declaration flow for a number the
    org already controls (its own SIP trunk, or a number ported through its own carrier outside this
    platform). `connect`/`disconnect`/`listNumbers`/`getNumberStatus` all throw a typed
    `TelephonyProviderNotSupportedError` (documented in the class header, never called by any BYON
    route path); only `importNumber()` (validates the declared E.164 via Phase 2's `lib/phone.ts`,
    no external call) and `validateNumber()` (the same local format check) do real work.
  - Neither Twilio's nor Telnyx's adapter ever releases a real phone number: `disconnect()` is a
    documented no-op (Twilio/Telnyx's REST APIs are stateless - there is no session to tear down),
    and `DELETE /phone-numbers/:id` removes the row from ShivanshConnect's own registry only, never
    the carrier account (see the route's response message and code comment).
- Backend API: `/phone-number-providers` (3-provider catalog + this org's connection status, masked
  credentials only; BYON always shown as `is_manual_only`), `POST
  /phone-number-providers/:key/credentials` (Twilio/Telnyx only - BYON returns a clear "use Import
  instead" `422`), `POST /phone-number-providers/:key/test-connection` (a real `adapter.connect()`
  call, persists genuine `status`/`last_error`); `/phone-numbers` (paginated, provider/status/
  assignment filters), `POST /phone-numbers/sync/:providerKey` (`listNumbers()` -> upsert deduped on
  `provider_number_id`, and a remote E.164 already registered under a different provider is skipped,
  never duplicated), `POST /phone-numbers/import` (BYON manual declaration - bad E.164/missing
  capabilities map to a client `422`, not a provider `502`; a duplicate E.164 within the same org is
  rejected with `409`; an optional SIP trunk password is encrypted and never echoed back even
  encrypted; also supports a single Twilio/Telnyx number import by provider id), `PATCH
  /phone-numbers/:id` (assign/unassign to an agent - a cross-org agent id is rejected -, rename,
  activate/deactivate), `DELETE /phone-numbers/:id` (local-registry-only release, see above). Every
  route requires `numbers.manage` (already in the Phase 1 permission catalog, granted to
  SUPER_ADMIN/ADMIN/MANAGER), scopes every query to the caller's `organization_id`, validates with
  Zod, and audit-logs credential saves/connection tests/syncs/imports/assignments/deletes.
- Frontend: replaces the "DIDs" sidebar placeholder with a real module at `/dids` (Phone Numbers
  tab: table with per-row assign-to-agent select, activate/deactivate, and a delete confirmation
  that explicitly warns a Twilio/Telnyx delete never releases the real carrier number; an Import
  modal offering either "Sync from a connected provider" with live created/updated counts, or a
  "Bring Your Own Number" form with E.164 + capability checkboxes + optional SIP trunk fields;
  Provider Connections tab: Twilio/Telnyx credential cards with a masked existing value and a real
  Test Connection button, and a BYON card explaining it has no connection step at all).
- Backend tests: each adapter's real request shape against fetch mocks, asserting on the exact
  documented URLs/headers/payloads (unit, Twilio + Telnyx); BYON's manual-import validation (rejects
  an invalid E.164 or a number with no declared capability, accepts a valid one, and makes zero
  network calls - unit); plus a full integration test - connect Twilio (HTTP mocked only at the
  fetch boundary), a real test-connection call, sync, a number list scoped to the connecting org
  only (a second org's list/provider status stays untouched, and a re-sync updates rather than
  duplicates), a BYON import with zero fetch calls and the SIP password never returned even
  encrypted, a duplicate-E.164 import rejected with `409`, and assigning a number to an agent
  writing an `audit_logs` row.

**Phase 6 (this build) - done:**

- Database schema: `calls` - the ONE authoritative internal call record regardless of engine (spec
  section 101 - a provider id is a property of a call, never a separate identity space): `engine`
  (`vapi`/`pipecat`), `vapi_call_id`/`pipecat_call_id` (each globally unique when set), FKs to
  `ai_agents`/`ai_agent_versions`/`phone_numbers`/`leads`, a deferred bare `campaign_id` uuid
  (Phase 7, same deferred-FK pattern as every prior phase), the full Phase 50 call-state-machine
  `status` enum, and `transfer_destination_e164` (only ever server-written, never client-supplied -
  see below). `call_events` (append-only raw per-call event log, either engine). `webhook_events`
  (the idempotent inbound-webhook ledger - `UNIQUE (provider, event_id)` is the actual guarantee a
  replayed delivery is never double-processed) and `webhook_failures` (dead-letter tracking, spec
  section 31). `vapi_credentials` (org-scoped, AES-256-GCM, reusing Phase 4's exact credential
  helper). Two new permissions (`calls.manage`, `webhooks.manage` - `cdr.view`/`cdr.export` are
  reserved for Phase 9's actual call-detail-record UI, so call origination and the webhook admin
  log get their own narrower keys instead of overloading those). RLS on all 5 new tables, same
  pattern as every prior phase.
- **Two-engine architecture** - `apps/backend/src/lib/orchestration/` defines a
  `CallOrchestrationProvider` interface (`createAssistant`, `updateAssistant`, `createCall`,
  `getCall`, `endCall`, `transferCall`, `getArtifacts`/`getTranscript`/`getRecording`,
  `getLiveMonitorUrls`, `registerWebhook`) mirroring the LLM/Voice/Telephony adapter pattern
  exactly, with two real implementations:
  - **`VapiProvider`** (managed engine) - real Vapi REST API: assistant create/update (maps an
    `ai_agent_versions` row's prompt/personality/voice/LLM/transfer config into Vapi's documented
    payload shape, storing `vapi_assistant_id`), phone-number import (`POST /phone-number`, linking
    a Twilio/Telnyx number by credentials, or a BYON SIP trunk), call create/get/hangup, transfer
    via the call's real `monitor.controlUrl` (refuses a non-E.164 destination before ever touching
    the network), artifact/transcript/recording retrieval, `monitor.listenUrl`/`controlUrl` relay
    for live monitoring, and account-wide webhook registration.
  - **`PipecatProvider`** (self-hosted engine, the explicit second-engine ask) - a thin TypeScript
    HTTP client against `apps/pipecat-service`, a **separate Python/FastAPI process** running the
    real `pipecat-ai` framework. See "Two orchestration engines" below for the full architecture,
    including exactly how call origination is split between Node and Python and why.
  - Both adapters follow the same "never fabricate" rule as every prior phase: no credentials/
    service configured -> a typed `OrchestrationProviderNotConfiguredError` -> an honest `422`,
    never a simulated call.
- Backend API: `GET`/`POST /vapi/credentials` + `POST /vapi/test-connection` (masked, encrypted,
  real connection check via a lightweight `GET /assistant?limit=1`). `POST /calls` - the internal
  call-origination endpoint (used directly now, and by Phase 7's campaign engine later): resolves
  the agent's published version, its voice, the phone number, and the transfer destination (read
  **only** from `ai_agent_versions.transfer_rules.transfer_to`, never from the request body - the
  spec 19/8L hard rule that the AI/caller can never invent a transfer target, enforced at both the
  route and the adapter layer); creates the local `calls` row in `queued` status **before** calling
  the provider (documented ordering-based failure-recovery guarantee, since `supabase-js`/PostgREST
  has no client-side transaction API and no route in this codebase uses one - see the handler's own
  comment for the full reasoning) and marks it `failed` with the real error on any provider failure
  rather than leaving it orphaned; lazily creates the Vapi assistant and lazily imports the phone
  number into Vapi on first use. `GET /calls`/`GET /calls/:id` (with its `call_events`).
  `POST /webhooks/vapi` and `POST /webhooks/pipecat` - unauthenticated receivers (idempotent via
  the `UNIQUE (provider, event_id)` constraint - a duplicate delivery is caught and reported
  `deduplicated: true`, never reprocessed; organization is resolved from the payload's own
  `vapi_call_id`/`pipecat_call_id` lookup, **never** trusted from the payload directly; status
  transitions only ever apply through `isValidCallTransition()`, an invalid/out-of-order transition
  is logged and dropped, never force-applied). `GET /webhook-events` (`cdr.view`) + `POST
  /webhook-events/:id/replay` (`webhooks.manage`, audited) - replay re-dispatches the exact stored
  payload through the same receiver route (`app.inject`), so there is no second processing path to
  drift from the original.
- Frontend: Settings > Integrations gets a real Vapi credentials card (masked, Save, real Test
  Connection - identical pattern to Phase 5's Twilio/Telnyx cards) and a Default Call Engine picker
  (Vapi vs Pipecat, backed by the existing generic `organization_settings` jsonb merge - no new
  endpoint needed). A new Settings > Webhook Events tab: a filterable table of the webhook log with
  a working Replay button on failed deliveries.
- Backend tests: adapter request-shaping against mocked `fetch` for both engines (Vapi's assistant/
  call/transfer/webhook payload shapes; pipecat's HTTP client contract, including its `422 -> 
  OrchestrationProviderNotConfiguredError` mapping), the call-state-machine's valid-transition table
  (unit), plus a full integration test - originate a call via `VapiProvider` (HTTP mocked only at
  the fetch boundary) -> local `calls` row created -> a simulated Vapi webhook sequence
  (`status-update` -> `end-of-call-report`) drives real state transitions -> replaying the identical
  webhook payload hits the unique constraint and is reported deduplicated with zero new rows (the
  idempotency guarantee the task explicitly called out as critical) -> a webhook resolving to org
  A's call can never touch org B's calls -> `POST /webhook-events/:id/replay` round-trips a stored
  event back through the real receiver.
- `apps/pipecat-service` - see its own README for full detail, summarized in "Two orchestration
  engines" below.

### Two orchestration engines: Vapi (managed) vs pipecat (self-hosted)

Every call and every published agent version resolves to exactly **one** internal record
(`calls`/`ai_agent_versions`) regardless of which engine handled it - `engine` is a column, not a
different kind of row (spec section 101). An org picks a default engine (Settings > Integrations),
and any `POST /calls` call can request the other engine explicitly.

**Vapi** is a fully managed API - `VapiProvider` calls it directly over HTTPS from the Node
backend, no extra infrastructure.

**Pipecat** is a Python framework, so it runs as `apps/pipecat-service` - **its own separate
process and, in production, its own Railway service**, never a route inside the Node backend.
`PipecatProvider` (TypeScript) is a thin HTTP client against it. The architectural question the
task brief posed - does pipecat-service call back to Node for credentials, or does Node originate
the call and hand pipecat-service only the media stream - is answered as a variant of the first
option: `routes/calls.ts` resolves and decrypts the org's already-stored Twilio/Telnyx credentials
using Phase 5's **existing** tables/adapters (nothing new is ever persisted anywhere) and forwards
them once, transiently, inside the single `POST /calls` request to pipecat-service; pipecat-service
uses them synchronously to place the real outbound call via the carrier's own REST API and never
stores them. pipecat-service then builds a real `pipecat-ai` pipeline (Deepgram STT -> OpenAI LLM
-> ElevenLabs/Cartesia TTS) once the carrier's Media Streams WebSocket connects, and posts call
lifecycle + transcript events back to Node's `POST /api/v1/webhooks/pipecat` - the exact same
idempotent `webhook_events`/`call_events` pipeline Vapi calls flow through. If pipecat-service has
no LLM/STT/TTS key or no public media-stream URL configured, or an org has no Twilio/Telnyx
connected, every call attempt fails with a clear `422`-shaped "not configured: missing X" error -
never a simulated call, in both the TypeScript and Python code. See
`apps/pipecat-service/README.md` for exactly how to run and deploy it (its own venv, its own
`requirements.txt`, its own environment variables) and what could not be verified live in this
sandbox (no real phone calls are placed anywhere in this build).

**Phase 7 - done:**

- Database schema: `campaigns` (calling window/days, concurrency/calls-per-minute limits, transfer
  number, voicemail config, lead cooldown, background noise), `campaign_versions` (the immutable
  publish-time **snapshot** per spec 84/85 - `ai_agent_version_id`/`voice_id`/
  `knowledge_base_ids`/`transfer_number_e164`/`calling_rules`/`disposition_rules` are all locked in
  at publish time and never re-resolved from the live agent/voice/knowledge-base tables afterward),
  `campaign_leads` (the per-lead campaign state machine from spec section 11, with a
  dispatch-critical composite index on `(campaign_id, status, next_eligible_at)` so the dispatcher's
  eligibility query stays index-backed even at 10k+ leads), `campaign_lead_skip_log` (every
  ineligibility reason is written here, so a lead is never silently dropped from consideration),
  `campaign_settings` (free-form per-campaign dialing overrides) and `dialing_settings` (org-level
  defaults). Wires up the deferred FKs from Phase 5 (`phone_numbers.assigned_campaign_id`) and Phase
  6 (`calls.campaign_id`). RLS on all 6 new tables, same pattern as every prior phase.
  `campaigns.view/create/edit/start/pause/delete` permissions already existed in the Phase 1 seed
  catalog - no new permission rows needed.
- **The campaign execution engine** (`services/campaignDispatcher.ts`) - the queue-based
  architecture the spec explicitly requires (Campaign -> Eligibility Queue -> Dial Queue -> Worker
  Pool -> Vapi/pipecat -> Webhook Events -> Event Processor -> Call State -> Disposition ->
  Analytics), **not** a `for each lead: makeCall()` loop. Redis/BullMQ isn't wired up until Phase
  15, so this runs today as an in-process `setInterval` tick (default every 3s, `tickInFlight`-
  guarded against overlap) deliberately structured as a documented drop-in for a real queue later -
  `runDispatchTick()` is what a repeatable BullMQ job would call, `processCampaign()` is what a
  per-campaign job processor would become. Per running campaign, each tick: computes **effective
  concurrency** via the spec's exact `minimum(campaign.concurrency_limit, org dialing_settings.
  max_concurrency, WORKER_POOL_CAPACITY)` formula (`services/leadEligibility.ts`), counts active
  calls, pulls the next eligible batch ordered by `next_eligible_at` and bounded by remaining
  capacity **and** a rolling per-minute dispatch counter, re-checks full eligibility per candidate
  (DNC, terminal/in-flight status, max attempts, cooldown, IANA-timezone-aware calling-window/day
  checks via `Intl`, another active call already in progress for the same lead), then **atomically
  claims** each eligible lead via a conditional `UPDATE campaign_leads SET status = 'dialing' ...
  WHERE status = <expected>` (the actual no-double-dial guarantee - Postgres serializes concurrent
  claims of the same row; a lost race is simply skipped, never double-dialed) before calling the
  exact same origination logic Phase 6 built.
- **`services/callOrigination.ts`** - Phase 6's `POST /calls` origination logic (queued-row-first
  ordering, Vapi assistant/phone-number import, pipecat credential handoff, audit logging) was
  extracted out of the route handler into `originateCall()`, which now also accepts a campaign
  snapshot's transfer-number/voice overrides. `routes/calls.ts`'s POST handler and the campaign
  dispatcher both call this one function - never duplicated, per the task's explicit requirement.
- **`services/leadEligibility.ts`** - the full spec-16/51/52 exclusion list as a pure, DB-free
  decision function with a reason code for every exclusion (`campaign_not_running`, `lead_dnc`,
  `already_terminal`, `cooldown_active`, `max_attempts_reached`, `outside_calling_window`,
  `outside_calling_days`, `lead_already_in_progress`), plus linear (fixed-delay) retry/cooldown
  scheduling math - deliberately the documented simplification of "retry with backoff"; exponential
  backoff is a follow-up, not a stub (something real ships today).
- **`services/campaignLeadDisposition.ts`** extends (never duplicates) Phase 6's webhook event
  processor: when a call reaches a terminal status, it drives the matching `campaign_leads` row to
  `retry_pending` (with a real computed `next_eligible_at`) or a terminal state per the campaign
  version's own snapshotted `disposition_rules` - DNC/successful-transfer/completed are never
  retried; a retryable outcome under `max_attempts` always is.
- **`services/campaignPreflight.ts`** (spec section 9) - real, DB-backed checks: agent
  active+published version, that version's voice active with its provider connected, phone number
  active with its telephony provider connected, attached knowledge base documents `ready`, a valid
  E.164 transfer number, a valid calling window/days, at least one eligible lead, the orchestration
  engine actually configured, and concurrency within a reasonable org cap - with exact, actionable
  error messages ("Campaign cannot start because no eligible leads remain.", etc.).
- **`services/campaignRotate.ts`** - the explicit lead-list rotation/reuse requirement: a pure
  filter that excludes leads whose last outcome was a genuine terminal disposition (completed/
  transferred/DNC/not-interested/hung-up/disconnected) and includes only never-attempted or
  retryable-outcome leads, never a lead currently mid-call.
- Backend API (`routes/campaigns.ts`, `routes/dialingSettings.ts`): full campaign CRUD (create as
  draft), `POST /campaigns/:id/versions` + `POST /campaigns/:id/versions/:versionId/publish` (the
  snapshot step), `GET /campaigns/:id/preflight`, `POST /campaigns/:id/{start,pause,resume,stop,
  archive,duplicate}`, `PATCH /campaigns/:id/concurrency` (audited "changed from X to Y" per spec
  59's explicit example), `GET /campaigns/:id` with real-time `COUNT() ... GROUP BY status`
  aggregate live counts (never stale cached counters), bulk lead attach (`lead_ids` or an entire
  `lead_list_id`, batched inserts so 10k+ leads never go row-by-row, DNC leads never queued),
  `GET /campaigns/:id/leads`, `POST /campaigns/:id/leads/rotate` (dry-run preview + confirm), and
  `GET/PATCH /dialing-settings` (org defaults, lazily created) + `GET/POST /campaigns/:id/settings`
  (per-campaign overrides). Every route: `authenticate`, `requirePermission`, org-scoped, Zod
  validated, audited on every lifecycle/config-changing action.
- Frontend: Campaigns list (status badge, progress bar, called/remaining/connected/failed/DNC
  counts, concurrency, calls-per-minute, start/pause/resume/stop/duplicate/archive); Campaign
  detail with Overview (live stat tiles, a live concurrency editor), Configuration (prompt editor
  with a `{{variable}}` insertion palette, agent/voice/script pickers, a knowledge-base checklist
  scoped to the selected agent, transfer-number/voicemail/cooldown-preset/background-noise/calling-
  window/calling-days fields, save-draft-then-explicit-publish), Leads (attach a lead list, a
  paginated/filterable table of `campaign_leads`, and the Rotate/Reuse flow with a real preview of
  exactly which leads will be re-queued vs excluded and why before a separate confirm step), and
  Settings (per-campaign dialing overrides); a pre-launch confirmation modal (spec section 67) that
  only enables Start once the real preflight reports ready; and a Dialing Settings page for the org
  defaults. Replaces the "Campaigns"/"Dialing Settings" sidebar placeholders.
- Tests: unit coverage for the effective-concurrency formula, every eligibility exclusion reason
  (including a genuinely timezone-sensitive calling-window case), retry/cooldown scheduling math,
  and the rotate filter's exact inclusion/exclusion per disposition; a full fake-Supabase
  integration suite covering create -> attach 55 leads -> publish (snapshot) -> preflight fail
  without a transfer number -> preflight pass -> start -> a real dispatcher tick claiming exactly
  `concurrency_limit` leads and originating mocked-at-fetch Vapi calls -> simulated webhook
  end-of-call events driving `retry_pending`/terminal outcomes with a real future
  `next_eligible_at` -> a DNC lead attached mid-campaign never dialed -> rotate correctly filtering;
  a dedicated test proving the publish-time snapshot is unchanged after the underlying agent is
  re-published; a dedicated concurrent-dispatch-tick test proving no lead is ever claimed twice
  (`Promise.all` racing `processCampaign()` against the same in-memory tables); cross-org isolation;
  and a 1000-synthetic-lead batch proving the dispatch stays concurrency-bounded (never "claim
  everything at once") and every one of the 1000 `campaign_leads` rows ends terminal, explicitly
  pending, or in-flight - never silently lost.

**Phase 8 (this build) - done:**

- Database schema: `dispositions` (system defaults seeded per spec section 20 - Call Connected,
  Disconnected, DNC, Answering Machine, Voicemail, Not Interested, Hung Up, Transferred, Call
  Disconnected in Transfer - plus per-org custom dispositions), `call_dispositions` (a `UNIQUE
  (call_id)` constraint enforcing exactly one primary disposition per call at the DB level, not
  just in application code; `disposition_source` engine/manual, `disposition_confidence`,
  `disposition_reason`, `assigned_by` for a manual override's audit trail), and `callbacks`
  (`scheduled_at`/`timezone`, `assigned_to` - a user id or the literal `'ai'` - `source_call_id`
  back-reference, a dispatch-friendly `(organization_id, status, scheduled_at)` composite index). A
  new `callbacks.manage` permission, seeded and granted to `SUPER_ADMIN`/`ADMIN`/`MANAGER`/`AGENT`.
- **The call state machine's executor** (`apps/backend/src/lib/callStateMachine.ts`) - Phase 6's
  pure transition table (`lib/orchestration/callStateMachine.ts`) is now enforced through exactly
  one function, `transitionCallState()`: every webhook handler and `services/callOrigination.ts`'s
  own status writes go through it. It validates the transition, **rejects and logs (never silently
  applies)** an invalid one, persists the new status, and emits a real in-process `EventEmitter`
  event (`callEventBus`) - documented as the seam Phase 54's broader real-time event architecture
  will attach to later, not a full pub/sub rewrite. A terminal transition additionally **awaits** a
  registered terminal-call handler synchronously, so disposition assignment and the
  `campaign_leads` update it drives are guaranteed to have happened by the time the triggering
  webhook request returns. `lib/orchestration/callStateMachine.ts`'s transition table is extended
  so `dnc` is reachable from every in-call, non-terminal state (spec section 60 - a caller can ask
  to be put on the Do Not Call list at any point during a live call, not only before dialing).
- **The deterministic disposition engine** (`services/dispositionEngine.ts`) - a real, explicit,
  table-driven rules engine, never randomized and never LLM-based. `decideDisposition()` is a pure
  function over a well-typed `CallOutcomeSignals` struct (terminal status, ended reason, duration,
  AMD/transfer signals, an explicit DNC-requested flag), evaluated in a fixed order: DNC always
  wins; AMD-detected voicemail/answering-machine; a successful vs. failed/disconnected transfer;
  human-answered-with-a-real-conversation vs. an early/immediate hangup with no interaction vs. a
  mid-conversation hang-up. `assignDispositionForCall()` is the one impure wrapper - called
  automatically from the state machine's terminal-transition handler, **never manually invoked by
  the UI**. `PATCH /api/v1/calls/:id/disposition` is the one legitimate manual-override path for a
  supervisor correcting the engine's own occasional mistake - it writes `disposition_source =
  'manual'` and an audit log entry, and the engine never clobbers a manual override afterward.
- **The retry engine, formalized** (`services/retryEngine.ts`) - Phase 7's inline retry math is now
  a table of explicitly named rules (no-answer/busy/temporary-provider-failure retry within
  `max_attempts`, a successful transfer never auto-retries, `max_attempts` reached blocks retry,
  a connected/completed call follows the campaign's own manual-rotation rules rather than
  auto-retrying) with **one hard, unconditional invariant checked first, always**: a DNC lead never
  retries, full stop, even under adversarial input that tries to force it (a generous
  `retryOnOverride`, a low attempt count, a non-DNC disposition code - `isDnc` alone still blocks
  it). `services/campaignLeadDisposition.ts` was rewritten to consume this engine's decision plus
  the disposition engine's assigned code as its **single source of truth** - `campaign_leads.
  final_disposition` is now exactly the same code `call_dispositions` holds, never a second,
  divergent derivation from the raw `ended_reason` string.
- **The callback scheduler** (`services/callbackScheduler.ts`, `routes/callbacks.ts`) - one
  creation path used by both `POST /api/v1/callbacks` (manual, from the lead detail/CDR UI) and the
  AI's own tool-call webhook event, so a human- and an AI-scheduled callback are indistinguishable
  downstream. Scheduling a callback **overrides normal cooldown** (spec section 53) by writing the
  callback's `scheduled_at` directly onto the linked `campaign_leads.next_eligible_at` and
  resetting its status to `pending` - never a parallel dial path - so Phase 7's exact claim/dispatch
  machinery (`services/campaignDispatcher.ts`) picks the lead back up once the time arrives, with
  the same no-double-dial guarantee already proven there. A callback created **while its call is
  still active** (the common case - the AI recognizes the request mid-call, before the terminal
  webhook fires) defers this override to `services/campaignLeadDisposition.ts`'s own terminal-call
  handling, so the override always wins regardless of event ordering. `GET/PATCH
  /api/v1/callbacks` support calendar-friendly date-range/status/campaign/lead filtering and
  reschedule/cancel.
- **Real tool-call/function-call webhook handling** (`services/toolCallHandler.ts`,
  `services/dncToolHandler.ts`) - both the Vapi (`message.type === 'tool-calls'`,
  `toolCallList`/`toolCalls`, stringified-or-object `arguments`) and pipecat-service
  (`event_type === 'tool-calls'`, `tool_calls`) webhook payload shapes are parsed into a normalized
  `{ name, arguments }` list; two real, deterministic intents are wired end to end - never a UI
  mockup: `schedule_callback` creates a real `callbacks` row via the scheduler above, and
  `request_dnc` reuses Phase 2's existing DNC infrastructure completely (inserts a real
  `dnc_entries` row, flags the matching lead's `is_dnc = true`, transitions the call to `dnc`
  through the real state machine, which in turn assigns the `DNC` disposition and marks the
  `campaign_leads` row `dnc` - never eligible for retry again, even if the lead is later manually
  re-added to a brand-new campaign). An unrecognized tool name or malformed arguments is logged to
  `call_events` and skipped - never crashes the webhook.
- Frontend: real Dispositions module (`pages/DispositionsPage.tsx` - system defaults shown
  read-only, full CRUD on an org's own custom dispositions) and Callbacks module
  (`pages/CallbacksPage.tsx` - a filterable/sortable list view with status badges, a lead-search
  create form with an optional campaign attachment for auto-dial, reschedule/cancel), replacing
  both sidebar placeholders. `CampaignDetailPage.tsx`'s attached-leads table gains a Disposition
  column (reusing the existing `Badge` component - full CDR UI is Phase 9, not built here).
- Tests: unit coverage for every `decideDisposition()` branch, every named `retryEngine` rule
  including an adversarial DNC-never-retry test, `transitionCallState()`'s valid/invalid/no-op
  transitions (an invalid one is proven logged, never applied), and tool-call payload parsing; a
  dedicated integration suite (`phase8.integration.test.ts`, same fake-Supabase harness as Phase
  7's) proving: exactly one `call_dispositions` row with `campaign_leads.final_disposition` kept in
  sync; a manual override writing `disposition_source = 'manual'` plus an audit log entry without
  duplicating the row; a real tool-call DNC request flipping `is_dnc`/inserting `dnc_entries`/
  transitioning the call, with a regression test proving the same lead is never dialed again even
  after being manually re-added to a new campaign; a real tool-call `schedule_callback` event
  creating a callback and its cooldown override surviving regardless of whether it's applied before
  or after the call's own terminal webhook; a manually-created callback overriding an active
  cooldown and being picked up by the exact same dispatcher claim/dial path once due; and cross-org
  isolation for custom dispositions and callbacks.

**Phase 9 (this build) - done:**

- Database schema: `call_transcripts` (`full_text` for search plus a generated `tsvector` column +
  GIN index - real Postgres full-text search, not an app-side substring scan), `call_transcript_
  segments` (real per-utterance rows - `speaker`/`segment_index`/`start_ms`/`end_ms`/`text`, its
  own GIN-indexed `tsvector` too), `call_recordings` (`provider_recording_url` for the source vs.
  `storage_path` for our own durably-restored copy - never the same thing), `call_summaries` (spec
  section 23's exact field list: `summary`, `key_points`, `customer_intent`, `objections`,
  `questions`, `next_action`, `outcome`, plus which LLM produced it and when), and `exports`
  (background CDR export jobs - `type`/`filters`/`status`/`file_storage_path`/`row_count`). RLS on
  all five. `search_call_transcripts()` is a real `ts_rank`-ranked, org-scoped Postgres function
  alongside Phase 3's `match_knowledge_chunks`. `cdr.view`/`cdr.export` permissions already existed
  in the Phase 1 seed catalog - nothing new to seed there.
- **Real artifact ingestion** (`services/processCallArtifacts.ts`) - triggered (`setImmediate`,
  the same fire-and-forget-but-scheduled async pattern every prior phase's ingestion uses) from
  `callTerminalHandler.ts` on every terminal call except `cancelled` (a cancelled call never
  actually took place). Resolves the real orchestration provider for the call's own engine
  (decrypting the org's Vapi credential exactly like `callOrigination.ts` does) and calls its real
  `getArtifacts()`:
  - **Transcript**: `CallArtifacts` gained an optional `segments` field, now populated by
    `VapiProvider` from Vapi's own `call.messages`/`secondsFromStart` (real per-message timing)
    and by `PipecatProvider` from an optional `segments` field on pipecat-service's artifacts
    response. When an engine only returns a flat transcript string, `parseFlatTranscript()` splits
    it by speaker prefix (`AI:`/`User:`/etc.) into ordered segments with **honestly unfabricated**
    timing (`start_ms`/`end_ms` left at 0/null - never invented spacing) unless the call's own real
    `duration_seconds` lets the UI's "00:00 / 00:04 / ..." format spread them out
    proportionally, which is documented as an estimate, never claimed as measured. A call with no
    transcript at all gets an honest `status = 'failed'` row with a real reason - never skipped
    silently and never a placeholder.
  - **Recording**: actually **downloads** the provider's recording bytes and re-stores them via
    the existing Phase 4 `StorageAdapter` (`storage_path`) - the provider's own URL is kept only
    as `provider_recording_url` for reference, never treated as the permanent reference itself,
    per spec section 22's signed-temporary-URL intent. Real `size_bytes`/`format` are recorded; no
    recording available is an honest `failed` row, never fabricated.
  - **AI call summary** (`services/generateCallSummary.ts`, spec section 24-partial - summaries
    only, the full evaluator/scoring is Phase 11): once a transcript is ready, if `OPENAI_API_KEY`
    is configured, sends the real transcript text to `lib/llm` with a structured-JSON prompt for
    spec 23's exact fields, retries once on a malformed response, and **never creates a
    `call_summaries` row at all** when no LLM is configured or parsing still fails after retry -
    never a fabricated summary. The CDR UI shows an honest "Summary requires an LLM provider to be
    configured" state instead.
- **CDR API** (`routes/cdr.ts`, spec section 21): `GET /cdr` - real server-side-paginated,
  filtered (date range, campaign, agent, disposition, phone, lead, status) list, joined via
  `services/cdrQuery.ts`'s `buildCdrRows()` - a fixed small number of batched `IN (...)` lookups
  per page (campaigns/leads/agents/agent versions/voices/phone numbers/dispositions/artifact-
  existence), **never** one query per call regardless of page size. `GET /cdr/:callId` - full CDR
  fields + ordered transcript segments + a recording reference + summary, or the honest per-field
  empty state when an artifact isn't ready. `GET /cdr/:callId/recording/download` - real audio
  bytes, transcoded to MP3 via a real `ffmpeg` child process when one is on `PATH`, with an honest
  passthrough-of-the-real-source-format fallback when it isn't (see Phase 14's note below for this
  build's current, re-verified ffmpeg availability). `GET /cdr/search-transcript` - full-text
  search via `search_call_transcripts()`.
  `POST /cdr/export` - queues a background job and returns immediately with a job id, **never**
  generates synchronously (spec 21/65). `services/cdrExport.ts` runs the exact same
  `iterateAllCdrRows()` query the list endpoint uses, streamed page-by-page (never the whole
  result set loaded as one query), and writes a real CSV (RFC4180-escaped) or real `.xlsx` (via
  `exceljs`) file through the existing `StorageAdapter`. `routes/exports.ts`: `GET /exports`
  (history), `GET /exports/:id` (poll status + a download link once ready), `GET
  /exports/:id/download` (real file bytes) - all org-scoped and `cdr.view`/`cdr.export`-gated.
- Frontend: replaces the CDR sidebar placeholder with a real module - `pages/CdrPage.tsx` (server-
  paginated/filterable table, an Export button queuing a real background job, an Export History
  modal polling job status to a real download), `components/cdr/CallDetailDrawer.tsx` (full CDR
  fields, a transcript viewer with speaker + `mm:ss` timestamp + text and an in-panel search box,
  a recording player that loads the authenticated audio blob on demand for real play/pause/seek/
  download, and the AI summary panel or the honest "requires an LLM provider" empty state).
  `apiClient.ts` gained `getBlob()` for these authenticated binary downloads (neither an
  `<audio>`/`<a>` tag nor the JSON-envelope helper can attach the bearer token or handle a
  non-JSON body).
- Tests: unit coverage for `parseFlatTranscript()` against a realistic multi-turn transcript
  (alternate speaker labels, unlabeled continuation lines, no-invented-timing), `parseSummary
  Response()`'s malformed-JSON/markdown-fence/missing-field handling, `cdrQuery`'s filter-building
  and batched-join correctness (including cross-org isolation) against a seeded `fakeSupabase`
  fixture, and `rowsToCsv()`/`rowsToXlsxBuffer()` producing real, byte-correct files from a small
  fixture set (the XLSX test loads its own output back through `exceljs` and asserts real cell
  values). A dedicated integration suite (`phase9.integration.test.ts`) drives a real campaign
  call to a terminal state and proves the whole pipeline end to end (mocking only the
  orchestration provider's outbound Vapi REST calls, the recording download URL, and the OpenAI
  chat-completions call - documented test-only mocks): real segmented transcript rows, a real
  downloaded-and-restored recording, and a real generated summary all land correctly; `GET /cdr`
  and `GET /cdr/:callId` reflect them; the recording download route returns the actual bytes;
  transcript search finds the call; `POST /cdr/export` queues a background job (never processes
  synchronously) producing a real CSV with the correct row count and an audit log entry; and
  cross-org isolation holds for CDR list/detail, recording download, and export status/download/
  history, even via a guessed export id.

### Phase 9 environment requirements

No new required variables - reuses `OPENAI_API_KEY` (Phase 3) for summaries, purely optional (no
summary row is ever created without it) and the existing `StorageAdapter`/orchestration-provider
plumbing for everything else. Real MP3 transcoding on `GET /cdr/:callId/recording/download`
requires an `ffmpeg` binary on the backend process's `PATH`; this build's sandbox did not have one
installed at the time (installing `ffmpeg`, e.g. `apt install ffmpeg` on Debian/Ubuntu, or the
Railway service's own buildpack equivalent, was documented as a zero-code-change deployment-time
addition). **Phase 14 re-checked this in a fresh sandbox session and ffmpeg 6.1.1 is now installed
and on `PATH`** - see Phase 14's section below for the up-to-date state and the test that proves
real transcoding now actually engages.
Recording/export "signed download URL" per spec section 22 is, in this build, an authenticated
`GET /api/v1/cdr/:callId/recording/download` / `GET /api/v1/exports/:id/download` route rather
than a bearer-token-free temporary link - a real signed-URL mechanism needs production S3-
compatible or Supabase Storage (still Phase 4's documented `LocalDiskStorageAdapter` limitation),
which is not live in this sandbox.

**Phase 10 (this build) - done:**

- **Real-time transport** (`apps/backend/src/ws/`): `WS /api/v1/live-monitor/stream`, registered via
  `@fastify/websocket`, authenticated with the exact same Supabase JWT `authenticate()` middleware
  every REST route uses (as an ordinary Fastify `preHandler` that runs before the HTTP connection is
  ever upgraded - an invalid/missing token gets a plain HTTP 401 and the upgrade never happens), plus
  `live_monitor.view`. A browser `WebSocket` cannot set an `Authorization` header on its handshake, so
  the token is also accepted as `?token=`. On connect: one `{ type: 'SNAPSHOT', calls: [...] }`
  message (the caller's org's currently-active calls, `LIVE_MONITOR_ACTIVE_STATUSES` in
  `packages/shared/src/liveMonitor.ts`), then real push events for as long as the socket stays open.
  **No interval polling anywhere in this path** - `ws/liveMonitorBroadcaster.ts` subscribes directly
  to Phase 8's `callEventBus` (`'call.transitioned'`) and a new `transcriptEventBus` (`'segment'`),
  filters strictly by `organizationId` (the hard cross-org-isolation requirement - see Tests below),
  and `ws/liveMonitorEvents.ts` is a pure, unit-tested mapping from a status transition to exactly the
  spec's event-type strings: `CALL_STARTED`, `CALL_RINGING`, `CALL_CONNECTED`, `TRANSCRIPT_UPDATED`,
  `CALL_TRANSFER_STARTED`/`CALL_TRANSFER_CONNECTED`/`CALL_TRANSFER_FAILED`, `CALL_ENDED`.
- **Live (mid-call) transcript ingestion** (`services/liveTranscriptIngestion.ts`): both webhook
  receivers now write real `call_transcript_segments` rows as an engine delivers each utterance
  *during* the call, not only from the Phase 9 post-call fetch. Vapi's `transcript` webhook message
  carries a `transcriptType` of `'partial'` or `'final'` - only `'final'` is ever persisted, so a
  stream of in-progress deltas for one utterance never produces more than one segment. pipecat's own
  pipeline (below) posts one `transcript` event per genuinely completed utterance by construction.
  Each write emits on `transcriptEventBus` so the WS stream pushes `TRANSCRIPT_UPDATED` immediately,
  reusing Phase 9's existing `(transcript_id, segment_index)` unique index as the dedupe key. Phase
  9's `processCallArtifacts.ts` post-call fetch is now **reconciliation, not the source of truth**:
  if live segments already exist for a call it never re-inserts or duplicates them, and only runs the
  full historical parse-and-insert path when live ingestion produced nothing at all for that call
  (e.g. a very short/failed call, or a delivery that never arrived).
- **Supervisor actions** (`routes/liveMonitor.ts`, mounted under `/calls`): `POST /calls/:id/listen`,
  `/whisper`, `/barge`, `/transfer`, `/end` - each requires `live_monitor.listen`/`whisper`/`barge`
  respectively (already seeded in Phase 1's catalog: MANAGER+ get all three, AGENT gets
  `live_monitor.view` only), asserts the call belongs to the caller's own organization (a mismatched
  org 404s exactly like a nonexistent call - never leaks existence), and writes a real audit log entry
  naming who did what to which call and when. Transfer reuses Phase 6's `transferCall()`/
  `transitionCallState()` unchanged, refuses any destination that isn't byte-for-byte the call's own
  server-resolved `transfer_destination_e164` (never a freely-supplied number), and records the new
  `calls.transfer_initiated_by = 'supervisor'` column (migration `00000000000037`) so it's
  distinguishable from the AI-initiated flow. End calls the orchestration provider's real `endCall()`.
  **Listen/whisper/barge are realized genuinely differently per engine, and this is documented in code
  (`routes/liveMonitor.ts`'s header comment), not glossed over:**
  - **Vapi** (managed - we don't run it): `listen` relays the real `call.monitor.listenUrl` verbatim
    (a WSS PCM stream `getLiveMonitorUrls()` already exposed since Phase 6). `whisper` posts a real
    `'say'` control message to `call.monitor.controlUrl` (new `VapiProvider.say()`) - **Vapi's public
    API has no distinct silent whisper-only-to-the-agent channel**, because the "agent" on a Vapi call
    is Vapi's own AI, not a human on a separate leg; the text becomes real synthesized speech, audible
    on the live call, exactly as documented rather than pretended otherwise. `barge` is therefore
    implemented as the **honest composition** the task explicitly calls for when a real distinct
    primitive doesn't exist: the same real `listenUrl` opened alongside the same real `'say'`
    mechanism - never a fabricated third capability.
  - **pipecat** (self-hosted - we own the whole pipeline, so real audio-frame manipulation is
    genuinely achievable): a new WS `/supervisor/{pipecat_call_id}/{action}` endpoint in
    `apps/pipecat-service`, authorized by a short-lived, call-and-action-scoped HMAC token
    (`lib/pipecatSupervisorToken.ts` on the Node side, `app/supervisor_auth.py` on the Python side -
    same shared `PIPECAT_SERVICE_TOKEN` secret, no new credential to manage). `app/supervisor_hub.py`
    is the real per-call coupling point to two actual pipecat `FrameProcessor`s wired directly into
    the live `Pipeline` (`app/pipeline.py`): `SupervisorTapProcessor` mirrors real `AudioRawFrame`s
    (both the caller leg and the AI/TTS leg) out to connected listen/barge sockets - genuine tapped
    audio, not a stub; `SupervisorInjectProcessor` drains queued whisper/barge PCM audio and pushes a
    real `OutputAudioRawFrame` into the outbound (caller-facing) leg - genuine injection. `barge` opens
    the same real two-way channel (tap **and** inject at once) for actual three-way mixing; a
    `CallerTranscriptEmitter`/`AssistantTranscriptEmitter` pair feeds the live transcript ingestion
    above the moment an utterance completes.
- Frontend (`pages/LiveMonitorPage.tsx`, replacing the sidebar placeholder): an active-calls table
  (Call/Campaign/Lead/Phone/AI Agent/Voice/live-ticking Duration/State/Started) driven entirely by
  `hooks/useLiveMonitor.ts`'s WebSocket connection (auto-reconnect with backoff, zero polling); a
  click opens `components/liveMonitor/CallDetailPanel.tsx` - an auto-scrolling, speaker-labeled live
  transcript in the spec's exact `AI: .../Caller: ...` format, the five state indicators (Connected/
  Listening/Whispering/Barged In/Transferring/Disconnected), and real Listen/Whisper/Barge/Transfer/
  End controls. `lib/pcmAudio.ts` is real Web Audio playback (`PcmStreamPlayer`, gapless scheduled
  `AudioBufferSourceNode`s) and microphone capture (`startMicPcmCapture`, real `getUserMedia` + PCM16
  framing) for the raw-PCM WebSocket streams neither Vapi's `listenUrl` nor pipecat's supervisor
  endpoint expose as a plain HTTP media URL an `<audio>` tag could consume directly. Transfer shows
  the call's own server-resolved `transfer_destination_e164` for confirmation only - never editable.
- Tests: `ws/liveMonitorEvents.test.ts` (pure transition-to-event-type mapping), `ws/
  liveMonitorBroadcaster.test.ts` (**the explicit cross-org isolation test** - org B's subscriber
  receives zero events from org A's call transitions and zero from org A's transcript segments -
  plus unsubscribe-stops-delivery and the full started->ringing->connected->transferring->transferred
  sequence arriving in order), `services/liveTranscriptIngestion.test.ts` (sequential `segment_index`
  assignment, one `call_transcripts` row per call, the unique-index dedupe safety net, blank-utterance
  rejection), and `phase10.integration.test.ts` (real route handlers via `app.inject()`: an AGENT is
  rejected on all five actions, a MANAGER - invited into the same org via the real invite/accept flow
  and promoted by the org owner's own never-downgraded token - succeeds with an audit log entry each;
  supervisor transfer validation reused correctly from Phase 6; cross-org 404s). Python:
  `test_supervisor_auth.py` (HMAC token verification/tamper/expiry/scope rejection),
  `test_supervisor_hub.py` (queue priority/isolation/broadcast/dead-socket cleanup in full isolation),
  `test_supervisor_ws.py` (the WS endpoint's real auth/call-id validation and correct wiring into the
  hub via `TestClient.websocket_connect`) - each file documents plainly what is/isn't provable without
  pipecat-ai installed and a live call (see below).

### Phase 10 environment requirements

No new required variables - reuses the existing `PIPECAT_SERVICE_TOKEN` (Phase 6) as the HMAC key for
the new short-lived pipecat supervisor tokens (`lib/pipecatSupervisorToken.ts` /
`app/supervisor_auth.py`), unset in local/dev exactly like every other Phase 6 default (both sides
then skip verification, matching the existing documented posture). `@fastify/websocket`/`ws` are new
Node dependencies; no new Python dependency was needed. **pipecat-ai itself is not installed in this
sandbox** (see `apps/pipecat-service/app/pipeline.py`'s own long-standing header comment on why every
pipecat-ai import there is lazy) - `SupervisorTapProcessor`/`SupervisorInjectProcessor`/the transcript
emitters are real code written directly against pipecat-ai's actual documented `FrameProcessor`/
`AudioRawFrame`/`TranscriptionFrame`/`LLMFullResponse*Frame` APIs, but exercising them against the
genuine package (and a real or staged call) needs an environment with pipecat-ai installed - the
Python tests added this phase prove everything on the WS/auth/hub side of that boundary instead (see
each test file's own header comment for the exact line).

**Phase 11 (this build) - done:**

- **AI call evaluator** (`services/evaluateCall.ts`): triggered from the exact same seam as Phase 9's
  summary generation (`processCallArtifacts.ts`, immediately after a call's transcript is confirmed
  ready) rather than a new trigger - a second, independent `setImmediate` step so a summary or
  evaluation failure never blocks the other. Sends the real transcript, the call's own agent
  *version's* `system_prompt`/`greeting_template` (spec section 88's reproducibility intent - judged
  against the configuration that actually ran the call, not whatever the agent's live config has since
  become), and real metadata (disposition, duration, ended reason) to Phase 3's `LLMProviderAdapter`
  with a structured-JSON prompt covering the full spec section 24 rubric (all 17 sub-scores: opening,
  introduction, listening, understanding, accuracy, knowledge_usage, objection_handling, tone,
  empathy, professionalism, script_adherence, sop_adherence, compliance, call_control,
  transfer_handling, closing, disposition_accuracy). Same malformed-JSON-retries-once-then-honestly-
  fails pattern as `generateCallSummary.ts` - never a fabricated score. A call with no ready transcript
  (failed/very short/cancelled) or no disposition yet is a structural no-op, not a fake row. Stored in
  the new `call_evaluations` table (migration `00000000000038`).
- **Improvement mining** (`services/aggregateAgentImprovements.ts`): runs immediately after each
  evaluation rather than as a periodic batch job - justified in the file's own header comment (this
  codebase has no scheduler/worker infra to add a periodic pass to; every other cross-call
  aggregation here, disposition assignment, campaign-lead outcomes, live-monitor events, is likewise
  triggered off a single call's own terminal event). Mines `missed_opportunities`/
  `incorrect_statements`/`what_went_poorly` for recurring issues per agent via a deliberately simple
  category + Jaccard word-overlap text match (no ML clustering) against that agent's existing
  `detected`/`under_review` rows in Phase 3's `ai_agent_improvements` table (built empty in Phase 3,
  populated for real for the first time here): a match increments `frequency` and appends real
  evidence (call id + evaluation id + excerpt); a genuinely new issue gets one extra, clearly separate
  LLM call to draft a `suggested_change` + `confidence` - explicitly a SUGGESTION only, per the spec's
  "do not automatically rewrite the production AI prompt after every call" rule - and is dropped
  entirely (never a fabricated suggestion) if that call fails or no LLM is configured. Migration
  `00000000000039` adds `source_call_id`/`source_evaluation_id` (fast pointers to the latest
  contributing call/evaluation - full history lives in `evidence.occurrences`) and `updated_at` to the
  existing table; `00000000000040` adds the insert/update RLS policies it never had (was read-only);
  `00000000000041` adds `agent_evaluation_summary()`, a real Postgres `GROUP BY`/`AVG` aggregate
  (overall + per-category averages, org+agent+since-scoped) mirroring `match_knowledge_chunks`'s
  structurally-safe org-scoped RPC pattern.
- **Human-in-the-loop workflow** (`routes/agentImprovements.ts`, new `/api/v1/agent-improvements`
  prefix): `PATCH /:id` enforces `detected -> under_review -> approved/rejected` as an explicit
  allow-list (skipping a step, or moving backwards, is a `422`), audit logged
  (`agent_improvement.status_changed`). `POST /:id/apply` only from `approved` - appends the
  suggested change as its own clearly-labeled section onto the agent's *currently published* version's
  `system_prompt` (a concrete, auditable text diff, not a silent rewrite of the existing body), and
  creates a genuinely new **draft** version via a shared helper (`routes/agents.ts`'s
  `createDraftVersionFromSource()`, extracted so both `restore()` and `apply()` share the one place a
  draft is ever created from an existing version - never a duplicated code path). The improvement row
  is marked `applied` with `affected_version_id` pointing at that new draft; the draft is **never
  auto-published** - a human still explicitly publishes it via Phase 3's existing
  `POST /agents/:id/versions/:versionId/publish`, and the previously published version's own row is
  left completely untouched (proven directly in `phase11.integration.test.ts` - see Tests below).
  `GET /calls/:id/evaluation` (new route on `routes/calls.ts`) and `GET /agents/:id/improvements`
  (now real, filterable by `?status=`, replacing Phase 3's honest empty-state stub) round out the API;
  `GET /agents/:id/evaluation-summary` serves the aggregate above.
- Frontend: the Agent detail page's **Improvements tab** (`pages/agent/ImprovementsTab.tsx`) is now
  real - status filter chips, Review/Approve/Reject/Apply actions (gated on `agents.manage`), an
  evidence excerpt with a deep link to the source call's own CDR detail (`pages/CdrPage.tsx` now reads
  a `?call=` query param to auto-open that call's drawer), and an explicit "draft created - go publish
  it" confirmation after Apply, never an auto-publish. Phase 9's CDR call-detail drawer gets a new
  **AI Evaluation panel** (overall score, a simple bar-list sub-score breakdown, qualitative findings,
  recommended improvement, or an honest not-evaluated/skipped state). The agent Configuration tab gets
  an **evaluation-summary widget** (average overall score + per-category averages, last 30 days, from
  the real aggregate endpoint - never client-computed from a full row dump).
- Tests: `services/evaluateCall.test.ts` (`parseEvaluationResponse` unit coverage - valid full rubric,
  markdown-fenced, clamped/defaulted out-of-range scores, malformed JSON, missing required fields -
  plus `evaluateCall()` against a fake LLM provider proving the retry-once-then-succeed path, the
  fail-cleanly-with-no-row-written path after two malformed attempts, and the honest structural-skip
  paths, all without ever fabricating a score), `services/aggregateAgentImprovements.test.ts`
  (`normalizeForMatch`/`jaccardSimilarity` behavior, `extractCandidates` category-capping, and the
  real create-then-increment dedup flow: a new issue creates one row, a recurring issue on a second
  call increments frequency and appends evidence without duplicating and without re-calling the
  suggestion LLM, a genuinely different issue creates a separate row, and no LLM configured means no
  fabricated suggestion), and `phase11.integration.test.ts` (real route handlers via `app.inject()` -
  a call with a real transcript+disposition gets evaluated with the full 17-field rubric; a call with
  no ready transcript is honestly "skipped" even for a made-up call id; a second call surfacing the
  same recurring issue increments the existing improvement's frequency instead of duplicating; the
  status-transition allow-list rejects skipping straight to `approved` and rejects applying before
  approval; **apply creates a genuinely separate DRAFT version while the original PUBLISHED version's
  `system_prompt` is proven byte-for-byte unchanged and the agent's own `current_version_id` still
  points at it** - the explicit snapshot-immutability regression guard the task brief calls for,
  proving Phase 7's same guarantee holds here too; applying twice is refused; the audit log carries
  the real old/new prompt diff; and cross-org isolation across evaluations/improvements/
  evaluation-summary/PATCH all `404` for a second organization).

### Phase 11 environment requirements

No new required variables - reuses Phase 3's existing `OPENAI_API_KEY`/`LLMProviderAdapter` for both
the evaluator and the improvement-suggestion LLM calls (`CALL_EVALUATION_MODEL`/
`AGENT_IMPROVEMENT_MODEL` optionally override the default `gpt-4o-mini` for each, independently of
`CALL_SUMMARY_MODEL`). Without an LLM configured, evaluation and improvement mining are both honest
structural no-ops - the same posture Phase 9's summaries already established, extended consistently.

**Phase 12 (this build) - done:**

- Database schema: 4 pre-aggregated rollup tables (master spec section 89 - never compute expensive
  historical analytics from raw events at request time) - `analytics_daily_org`, `analytics_daily_
  campaign`, `analytics_daily_agent` (all `primary key (organization_id, ..., date)`) and `analytics_
  hourly_org` (`primary key (organization_id, hour_bucket)`), migration `00000000000042`, RLS in
  `00000000000043` (same defense-in-depth split as every prior phase - the backend's service-role
  reads bypass RLS and enforce `analytics.view` + org-scoping explicitly in application code; these
  policies are the second line of defense). Migration `00000000000044` adds the real SQL aggregate
  functions that compute and upsert them - `recompute_analytics_daily_org/_campaign/_agent(org_id,
  date)` and `recompute_analytics_hourly_org(org_id, hour)`, each a genuine `COUNT`/`AVG`/`GROUP BY`
  query with `ON CONFLICT DO UPDATE`, mirroring Phase 11's `agent_evaluation_summary()` pattern - plus
  `dashboard_disposition_breakdown(org_id, from, to)`, a real-time `GROUP BY` over `call_dispositions`
  for a bounded date range (the one chart the spec explicitly calls out as living on top of the
  rollups rather than inside them). "Connected" is defined consistently everywhere as `answered_at is
  not null`, distinct from "completed" (`status = 'completed'`).
- **`services/analyticsAggregator.ts`** - an in-process `setInterval` job (5 minutes by default,
  `ANALYTICS_AGGREGATION_INTERVAL_MS` overridable), the same documented drop-in-for-a-real-queue
  pattern as Phase 7's campaign dispatcher (`startAnalyticsAggregator()`/`runAggregationTick()`
  mirror `startCampaignDispatcher()`/`runDispatchTick()` exactly). Every tick, per organization:
  **today's row is always wholesale-recomputed** (cheap - one day's calls, real SQL aggregates -
  and can never drift out of sync with the authoritative tables, which a smarter incremental patch
  risks); a **one-time historical backfill** runs the recompute functions once for every distinct
  date/hour that has real `calls` rows older than today, detected by "no historical rollup row exists
  yet" rather than a separate persisted flag - naturally idempotent (a second backfill attempt finds
  the historical row and does nothing) and naturally one-time (the presence check stops finding a
  reason to re-run once any historical row exists). Not started by `buildApp()` itself, same reasoning
  as the dispatcher - the test suite never gets a background timer racing its fake Supabase client.
- **`services/analyticsQuery.ts`** - the one query-building module behind every Phase 12 route
  (mirrors Phase 9's `cdrQuery.ts`: one place, never duplicated). Historical strategy: every date
  strictly before today comes from the rollup tables (summed/weighted-averaged in JS - itself cheap
  arithmetic over already-aggregated numbers, never a second raw-table scan); **today's own
  contribution is always computed live** (one bounded query over today's `calls` rows plus a couple
  of small batched lookups, since the rollup's own "today" row is only as fresh as the last aggregator
  tick - documented explicitly in the file's header as the chosen "mix a live query for the partial
  day with the rollup for prior days" strategy the task brief allowed). Active Calls, Remaining Leads,
  Campaigns Running and AI Agents Active are **always** live queries, in every period, never rollups,
  per spec. All date-range math is UTC-based (a documented simplification, same category as Phase 7's
  fixed-delay retry math - per-org-timezone day boundaries are a following-up refinement, not a stub).
- Backend API: `GET /api/v1/dashboard` (spec section 6's exact metric list - Total/Connected/
  Completed/Failed Calls, Voicemails, Answering Machines, DNC, Not Interested, Transfers, Callbacks,
  Average Call Duration, Average Talk Time, Connection/Transfer/Voicemail/DNC Rate, Calls Per Hour,
  plus the 4 always-live figures), `GET /api/v1/dashboard/charts` (calls by hour - bucketed by
  hour-of-day and summed across the period -, calls by day, connection-rate trend, disposition
  breakdown, campaign performance, AI agent performance, campaign completion, average-duration trend,
  transfer statistics - every series shaped as a clean `{label, value}`/`{date, ...}` array for direct
  charting), `GET /api/v1/analytics/campaigns/:id` (spec section 42 - total leads/calls/connected/
  voicemail/DNC/transfers/callbacks/average duration/completion %/attempts-per-lead, completion and
  attempts always live off `campaign_leads`, never the rollup), `GET /api/v1/analytics/agents` (spec
  42's AI Agent KPI comparison - one array entry per agent so the frontend builds the comparison table
  directly off it; disposition accuracy is a documented practical proxy - `1 - (manual overrides /
  total dispositions)` in the period, since there is no independently-labeled ground-truth disposition
  to compare against and a supervisor's correction is the strongest available signal the engine got
  one wrong; evaluation score/count come from Phase 11's real `agent_evaluation_summary()`). Every
  route: `authenticate`, `requirePermission('analytics.view')` (already seeded since Phase 1, granted
  to `SUPER_ADMIN`/`ADMIN`/`MANAGER`/`VIEWER`), org-scoped, Zod-validated period filters (`today`/
  `yesterday`/`7d`/`30d`/`custom` with a real date-range/ordering check on `custom`).
- Frontend: replaces the Phase 1 Dashboard welcome-shell with a real page - the Today/Yesterday/7
  Days/30 Days/Custom (date-range picker) filter tabs shared by both pages
  (`components/analytics/PeriodFilter.tsx`), the full spec section 6 KPI tile grid
  (`components/analytics/KpiGrid.tsx`, live tiles visually marked), and every named chart via
  `recharts` (newly installed, used consistently everywhere - `components/analytics/charts.tsx`),
  colored with the dataviz skill's validated default palette (sequential blue for single-series bar/
  line charts, the fixed 8-hue categorical order for disposition/campaign/agent breakdowns - never an
  eyeballed or per-chart-invented palette). The **Active Calls** tile reuses Phase 10's existing
  `useLiveMonitorSocket()` WS client directly (no second WebSocket connection anywhere in the app) so
  it visibly updates in real time rather than waiting on the metrics query's 30s polling refetch.
  Replaces the "Analytics" sidebar placeholder with a real `pages/AnalyticsPage.tsx` - a Campaign
  Analytics tab (campaign picker + the full spec 42 metric set + a completion progress bar) and an
  Agent Analytics tab (a sortable, minimum-calls-filterable comparison table across every agent,
  including the real Phase 11 evaluation-score column).
- Tests: `services/analyticsQuery.test.ts` (`resolvePeriod`'s exact date-range math for every period
  value including the "custom range extending past today clamps to now" edge case; every dashboard
  rate formula - connection/transfer/voicemail/DNC rate as %/total - against hand-calculated fixture
  numbers; a zero-calls period proving no rate ever divides by zero; campaign completion/attempts-
  per-lead against live `campaign_leads` fixtures), `services/analyticsAggregator.test.ts` (a real
  `runAggregationTick()` backfills every historical date exactly once, a second tick never duplicates
  a rollup row or changes its already-correct values, and one organization's tick never writes another
  organization's rows), and `phase12.integration.test.ts` (a realistic multi-day/one-campaign/
  one-agent dataset seeded directly into the fake-Supabase tables, a real aggregation tick, then every
  dashboard/analytics endpoint hit through real route handlers via `app.inject()` - 30d/today/
  custom-single-day dashboard totals, chart disposition breakdown + campaign performance/completion,
  the campaign-analytics endpoint's numbers, agent analytics reflecting a real Phase 11 evaluation
  score, full cross-org isolation across every endpoint including a direct-id 404, and an
  unauthenticated request rejected with `401`). The rollup SQL functions themselves (correctness of
  every field's `COUNT`/`AVG`/`GROUP BY` definition, and idempotent upsert behavior on a second run)
  were additionally hand-verified against a real local PostgreSQL 16 instance with hand-calculated
  fixture data - see Verification notes below; this is a stronger proof of the actual SQL than the
  fake-Supabase JS mirror alone could give.

### Phase 12 environment requirements

No new required variables - `ANALYTICS_AGGREGATION_INTERVAL_MS` (milliseconds) optionally overrides
the aggregator's default 5-minute tick interval, same optional-override pattern as Phase 7's
`CAMPAIGN_DISPATCH_INTERVAL_MS`.

**Phase 13 (this build) - done:**

- Database schema: `smtp_settings` (one row per org, AES-256-GCM encrypted password via Phase 4's
  exact `lib/crypto/credentials.ts` helper, `status`/`last_tested_at` reflecting the real last
  test-send outcome, migration `00000000000045`); `sms_campaigns`/`sms_messages` and
  `email_campaigns`/`email_messages` (migration `00000000000046`, RLS in `00000000000047`) -
  messages are **pre-materialized** (one row per lead) the first time a campaign is started, not
  generated lazily per dispatch tick, which is what makes `UNIQUE(campaign_id, lead_id)` an actual
  no-double-send guarantee rather than a best-effort check; `email_suppressions`, the email-channel
  opt-out list, deliberately kept **separate** from Phase 2's `dnc_entries` - an email opt-out never
  suppresses that contact's phone DNC status and vice versa (master spec section 60's opt-out
  handling is per-channel).
- **No separate SMS credential store.** `lib/sms/*` (`SmsProviderAdapter`, `TwilioSmsProvider`,
  `TelnyxSmsProvider`) reuses the exact same encrypted `phone_number_provider_credentials` row
  Phase 5's telephony adapters already store per org - `resolveSmsAdapterForOrg()` is the one place
  that decrypts it and builds the adapter. Both adapters call each provider's real, documented SMS
  endpoint (Twilio's `Messages.json`, Telnyx's `/v2/messages`) - never a simulated send. An SMS
  campaign's phone number must be one of the org's own `phone_numbers` rows with SMS capability,
  checked before a campaign can be created or updated to use it.
- **`services/smtpProvider.ts`** - a real SMTP client via `nodemailer` (newly installed), configured
  per-org from its stored `smtp_settings` row; the password is decrypted only in-memory at send time
  and is never logged. `routes/smtp.ts`: `POST /settings/smtp` saves/updates it (password optional
  on update, never returned in any response, not even masked), `POST /settings/smtp/test` performs a
  **real send** to a caller-supplied recipient and updates `status`/`last_tested_at` from
  nodemailer's actual result, with its real error mapped to a short human-readable message
  (`humanizeSmtpError()`) rather than a leaked stack trace. Both are `settings.manage`-gated and
  audit logged.
- **`services/smsDispatcher.ts` / `services/emailDispatcher.ts`** - mirror
  `campaignDispatcher.ts`'s exact architecture: a queue-based, throttled `setInterval` tick loop
  (`SMS_DISPATCH_INTERVAL_MS` / `EMAIL_DISPATCH_INTERVAL_MS`, both optional overrides, same pattern
  as Phase 7's `CAMPAIGN_DISPATCH_INTERVAL_MS`), the identical rolling per-campaign per-minute
  throttle-counter technique, and a CAS claim (`UPDATE ... WHERE status = 'queued' ...`) so a race
  between ticks/processes never double-sends. `{{variable}}` rendering reuses Phase 3's existing
  `lib/promptVariables.ts` helper unchanged for both SMS bodies and email subject/HTML - it was
  already a standalone, agent-prompt-agnostic function, so nothing needed extracting; it is not
  duplicated a third time. A real DNC check (phone, reusing Phase 2's `dnc_entries` infra) runs
  before every SMS send, and a real `email_suppressions` check runs before every email send - both
  re-checked immediately before sending, not just at materialization time, and kept as genuinely
  separate concepts (see schema note above). **Honesty limit, stated plainly**: raw SMTP gives no
  delivery/bounce/reply signal at all - that requires a transactional email provider's own webhook
  API (SendGrid/Postmark/SES, etc.), which is out of this phase's scope. `email_messages.status` can
  only ever reach `sent` (SMTP server accepted it) or `failed` in this build;
  `delivered`/`bounced`/`replied` remain valid schema values for a future real integration and are
  never written here - the UI says so explicitly rather than faking a delivery checkmark. SMS
  delivery **is** tracked for real, because Twilio/Telnyx push it via webhook (see below).
- `POST /api/v1/webhooks/twilio-sms` and `POST /api/v1/webhooks/telnyx-sms` extend Phase 6's webhook
  infrastructure with the same idempotent `webhook_events` dedup pattern (composite delivery-id key,
  a replayed identical delivery detected and never reprocessed), updating
  `sms_messages.status`/`delivered_at` from each provider's real delivery-receipt payload.
- Backend API: full CRUD + lifecycle (`start`/`pause`/`resume`/`cancel`, mirroring
  `campaigns.ts`'s exact lifecycle shape) for both `/api/v1/sms-campaigns` and
  `/api/v1/email-campaigns`, plus paginated `GET .../:id/messages`; `/api/v1/email-suppressions`
  (add/list/remove, mirroring `routes/dnc.ts`'s shape for the phone equivalent). Every route:
  `authenticate`, `requirePermission('messaging.manage')` (already seeded since Phase 1 - this build
  only wires up real enforcement), org-scoped, Zod-validated, audit logged on every mutation and
  lifecycle action.
- Frontend: replaces the "Messaging" sidebar placeholder with a real `pages/MessagingPage.tsx` - SMS
  Campaigns and Email Campaigns tabs (list, create with a `{{variable}}` palette - extracted into the
  new shared `components/VariablePalette.tsx` so agent prompts/scripts and SMS/email templates all
  use the same click-to-insert chip list instead of four separate copies -, an SMS-capable-only phone
  number picker, lead list picker, throttle, lifecycle action buttons, and a per-message delivery
  status table that is honest wherever a status genuinely isn't tracked). The email composer's HTML
  body field has a live preview pane and a plain-text fallback field, deliberately not a full
  drag-and-drop email builder. Settings > Integrations gets a real SMTP panel (host/port/username/
  password-masked/encryption/from name/from email, a real Test Email button showing nodemailer's
  actual result).
- Tests: Twilio/Telnyx SMS adapter request-shaping against each provider's real documented endpoint
  (mocked `fetch`), `smtpProvider.ts` send success/failure paths via a mocked nodemailer transport
  (including proof the decrypted password never reaches a loggable call argument, and a real-shaped
  `EAUTH` error mapped to a readable message), `lib/promptVariables.ts`'s renderer (tested once,
  reused by three call sites rather than three times), the rolling per-minute throttle counter's
  math, and `messaging.integration.test.ts` end-to-end through real route handlers via
  `app.inject()`: SMTP save (password never in the response) → real test-send → status flips to
  `connected`; SMS campaign create → start (materializes messages, a DNC lead is skipped entirely,
  never even materialized) → a real dispatcher tick sends via mocked Twilio HTTP → messages marked
  `sent` → a real Twilio delivery webhook flips one to `delivered` → replaying the identical webhook
  is deduplicated (asserted via the `webhook_events` row count staying at 1); a race-simulated
  concurrent materialization call never double-inserts a message (the `UNIQUE` constraint holds);
  email campaign create → start (a suppressed address is skipped) → dispatcher sends via a mocked
  SMTP transport → messages marked `sent`; cross-org isolation for email campaigns, SMS campaigns,
  and SMTP settings.

### Phase 13 environment requirements

No new required variables. `nodemailer` needs none (SMTP settings are per-org, stored in the
database, never environment variables); SMS sending needs none beyond the Twilio/Telnyx credentials
an org already connects under Phone Providers (Phase 5). Two optional overrides, same
optional-override pattern as every prior phase's dispatcher: `SMS_DISPATCH_INTERVAL_MS` and
`EMAIL_DISPATCH_INTERVAL_MS` (both in milliseconds).

**Phase 14 (this build) - done:**

- **Generalizes Phase 9's export engine - does not rebuild it.** `services/exportGenerators/
  writers.ts` extracts Phase 9's CDR-specific-but-structurally-generic `{key, header}`-column CSV/
  XLSX writer into shared `writeCsv()`/`writeXlsx()` functions; `services/exportGenerators/
  runner.ts` extracts the queue-a-job/run-it-via-`setImmediate`/write-the-file/upload-through-the-
  existing-`StorageAdapter`/mark-ready-or-failed machinery into a shared `queueExportJob()`/
  `runExportJob()`/`scheduleExportJob()` trio. `cdrExport.ts` now calls into both, and its
  `rowsToCsv()`/`rowsToXlsxBuffer()`/`CDR_EXPORT_COLUMNS` exports keep their exact original
  signatures and behavior - `cdrExport.test.ts` is unchanged and still passes, proving no
  regression on the CDR export path this phase extends.
- **Database**: `exports.type`'s check constraint widened to add `leads_csv`/`leads_xlsx`,
  `sms_messages_csv`/`sms_messages_xlsx`, `email_messages_csv`/`email_messages_xlsx` alongside
  Phase 9's `cdr_csv`/`cdr_xlsx`; a new `entity_reference` jsonb column lets an export point back at
  the one list/campaign it was scoped to (e.g. `{ "leadListId": "..." }`), kept as a genuinely
  separate concept from the existing free-form `filters` column rather than overloading it
  (migration `00000000000048`). The Phase 9 `exports` RLS `select`/`insert` policies, which
  originally gated on `cdr.export` only, are widened to accept `cdr.export` OR `leads.view` OR
  `messaging.manage` - matching the application-layer permission checks below exactly, real defense
  in depth rather than RLS silently being stricter than the app logic it's meant to back up.
- **`services/exportGenerators/leadsExport.ts`** - a real leads export respecting the exact same
  filter shape `GET /leads` supports (`lead_list_id`/`status`/`is_dnc`/`search`), streamed in
  bounded pages (never one unbounded query), with master spec section 15's standard columns plus
  one flattened column per this org's Phase 2 `lead_custom_fields` catalog entry (so a lead's
  `custom_fields` jsonb blob exports as real named columns, not a dumped blob).
  **`services/exportGenerators/smsMessagesExport.ts`** / **`emailMessagesExport.ts`** - per-
  campaign message-level exports (recipient, rendered content, status, timestamps, error - spec
  sections 40/41), honest that `delivered`/`bounced`/`replied` only ever appear if Phase 13's
  dispatcher actually wrote them (it doesn't, for email, without a transactional provider - see
  Phase 13 above).
- New routes, every one queuing via the shared runner and returning immediately (never
  synchronous): `POST /api/v1/leads/export` and `POST /api/v1/lead-lists/:id/export` (both
  `leads.view` - no separate `leads.export` key exists in the Phase 1 permission catalog, so this
  reuses the existing one rather than adding a redundant permission), `POST /api/v1/sms-campaigns/
  :id/messages/export` and `POST /api/v1/email-campaigns/:id/messages/export` (both
  `messaging.manage`). Every route validates the target list/campaign's `organization_id` before
  queuing and audit-logs the new `AUDIT_ACTIONS.LEADS_EXPORT_CREATED` / `SMS_MESSAGES_EXPORT_
  CREATED` / `EMAIL_MESSAGES_EXPORT_CREATED` actions.
- **`routes/exports.ts` generalized** (it was never CDR-specific internally - it only ever queried
  `exports` scoped to `organization_id` - so this was mostly additive): `GET /exports` gains a
  `type` query filter; the download route derives content-type/extension/filename from the type
  string itself (`_csv`/`_xlsx` suffix) uniformly rather than a CDR-only branch, so a future export
  type needs no change here; the permission gate widened to "any of `cdr.export`/`leads.view`/
  `messaging.manage`" since the unified history view spans every entity (queuing a *new* export is
  still separately gated per-entity in each creating route above).
- **Frontend**: `hooks/useExports.ts`'s `useExportHistory()`/`downloadExportFile()` generalize
  Phase 9's CdrPage-only export-history polling/download hook to every export type via the new
  `type` filter; `components/exports/ExportTrigger.tsx` (the format-picker-plus-trigger-button) and
  `ExportHistoryList.tsx` (the status-badge/download-button row renderer) are the one shared UI
  every export surface uses - including `CdrPage.tsx` itself, refactored to use them rather than
  keeping a second copy. Export buttons now appear on the Leads page toolbar (respecting the
  current list/status/DNC/search filters), each Lead List card, and the SMS/Email campaign message
  panels in `MessagingPage.tsx`. A new **Settings > Export History** page/tab
  (`pages/settings/ExportHistorySettingsPage.tsx`) lists every export across every module for the
  org in one place, filterable by type, paginated - the spec's "show export history" requirement
  made complete rather than CDR-only.
- **Recording MP3 download polish (spec section 22)**: Phase 9 wrote `cdr.ts`'s
  `maybeTranscodeToMp3()` correctly, gated on ffmpeg's real availability, but that build's sandbox
  had no `ffmpeg` binary so only its honest fallback path ever ran. **This phase re-checked ffmpeg
  availability fresh and found `ffmpeg 6.1.1` now installed and on `PATH`** - the real-transcode
  branch now genuinely engages. `routes/cdr.mp3Transcode.test.ts` proves it: a real, decodable WAV
  fixture (not a fake byte string) is fed through the actual `ffmpeg` child process the route
  spawns, and the output is independently verified as real MP3 audio by `ffprobe` (a completely
  separate tool from the encoder) - plus regression coverage for the already-mp3 passthrough and
  the ffmpeg-unavailable fallback path (kept for an environment where ffmpeg genuinely isn't
  present).
- Tests: `exportGenerators/writers.test.ts` (the shared CSV/XLSX writer, tested once on a generic
  fixture shape - header/row/RFC4180-escaping/empty-set/null-cell behavior, plus a real `.xlsx`
  round-trip read-back), `phase14.integration.test.ts` (a lead list with a custom-field lead and a
  DNC lead → leads export → CSV reflects both honestly with a real custom-field column → lead list
  export scoped correctly with `entity_reference` recorded → an SMS campaign export via a real
  dispatcher tick → an email campaign export via a real dispatcher tick → `GET /exports?type=`
  filters correctly across every export type for the org → cross-org isolation holds for every
  export type's history/status/download, even via a guessed export id), and
  `cdr.mp3Transcode.test.ts` (above).

### Phase 14 environment requirements

No new required variables. Real MP3 transcoding on `GET /cdr/:callId/recording/download` still
requires an `ffmpeg` binary on the backend process's `PATH` exactly as Phase 9 documented; this
build's sandbox now has one (`ffmpeg 6.1.1`, confirmed via `ffmpeg -version` and exercised by
`cdr.mp3Transcode.test.ts`), so real transcoding is active in this deployment. If a future
deployment target lacks `ffmpeg` on `PATH`, the honest source-format-passthrough fallback
(unchanged since Phase 9) takes over automatically with zero code changes needed.

**Explicitly NOT built yet** (deferred to later phases):

- Redis/BullMQ - Phase 7's campaign dispatcher runs today as a documented in-process `setInterval`
  drop-in (see above); migrating it to a real queue is Phase 15 infra work, not a logic change
- Inbound Routes, Queues (inbound call routing, ring groups)
- Transactional-email delivery/bounce/reply tracking (Phase 13's `email_messages` table reserves
  `delivered`/`bounced`/`replied` states for this, but writing them for real needs a transactional
  email provider's own webhook API, e.g. SendGrid/Postmark/SES - out of scope for raw SMTP)
- Background job queues / Redis (the async import in Phase 2, the Phase 3 knowledge-document
  pipeline and Phase 4's voice cloning all use `setImmediate` on the backend process itself - see
  above - specifically so this later migration is mechanical for all three)
- Real, production S3-compatible object storage (master spec section 22) - Phase 4 adds the first
  real implementation (`LocalDiskStorageAdapter`, see above) for voice-preview audio and cloning
  samples, and Phase 9 reuses it for real call recordings and CDR exports (see its
  environment-requirements note for exactly what that means for "signed download URLs"), but it is
  explicitly local-disk, not durable/replicated production storage; uploaded import files and
  knowledge-base documents from Phases 2-3 still use the synthetic `memory:<...>` locator and are
  never persisted - this is also why knowledge-document "reprocess" in this build resets status and
  asks for a fresh upload rather than fabricating a re-embed from bytes that were never persisted
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

### Phase 5 environment requirements

Reuses the same `CREDENTIAL_ENCRYPTION_KEY` Phase 4 requires - without it, saving Twilio/Telnyx
credentials or a BYON SIP trunk password fails the same honest `422
CREDENTIAL_ENCRYPTION_NOT_CONFIGURED` way voice provider credentials do. `TWILIO_ACCOUNT_SID`/
`TWILIO_AUTH_TOKEN` and `TELNYX_API_KEY` in the backend env are optional platform-level defaults -
each org's own stored credential under Settings > Phone Providers takes precedence, matching Phase
4's pattern exactly. BYON needs none of these variables at all; it has no credentials to configure.

### Phase 6 environment requirements

`VAPI_API_KEY` in the backend env is an optional platform-level default (each org's own stored key
under Settings > Integrations takes precedence, matching every prior provider). `VAPI_WEBHOOK_SECRET`
is optional too - when set, Vapi webhook deliveries are checked against it (`x-vapi-secret` header);
when unset the receiver still works safely (idempotency + payload-resolved org ownership are the
primary defenses either way - see `routes/webhooks.ts`'s header comment for Vapi's real current
signature mechanism). `PIPECAT_SERVICE_URL`/`PIPECAT_SERVICE_TOKEN` point the Node backend at a
separately-running `apps/pipecat-service` deployment - without `PIPECAT_SERVICE_URL` set, selecting
the pipecat engine fails with an honest `422` naming exactly that. `apps/pipecat-service` is
configured entirely through **its own** environment (`apps/pipecat-service/.env`, not the Node
backend's) - see its README for the full list (`OPENAI_API_KEY`, `DEEPGRAM_API_KEY`,
`ELEVENLABS_API_KEY`/`CARTESIA_API_KEY`, `PUBLIC_MEDIA_STREAM_URL`, and the same
`PIPECAT_SERVICE_TOKEN` shared secret).

### Phase 7 environment requirements

No new required variables - the campaign dispatcher reuses every credential Phases 4-6 already
manage per organization. Two optional tuning variables: `WORKER_POOL_CAPACITY` (default `50`) is
the hardcoded/env ceiling in the spec's effective-concurrency `minimum(...)` formula - a
process-wide cap regardless of what any campaign or org configures, so a misconfigured org can
never exceed what this backend process can actually handle. `CAMPAIGN_DISPATCH_INTERVAL_MS`
(default `3000`) controls how often the in-process dispatch loop ticks. The dispatcher is started
only from `main()` (real process boot), never from `buildApp()` itself, so the test suite never has
a background timer racing its fake Supabase client.

### Phase 8 environment requirements

No new required variables - the call state machine, disposition engine, retry engine and callback
scheduler all run in-process against the existing Supabase connection and reuse Phase 6/7's
orchestration/webhook plumbing. Nothing here needs its own credential or feature flag.

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
   - Phase 5: `apps/backend/src/phoneNumbers.integration.test.ts` - connect Twilio credentials (HTTP
     mocked only at the fetch boundary, real route/adapter code unmocked), verify the raw Account
     SID/Auth Token never appear in the save response, a real test-connection call, sync numbers,
     and a number list scoped to the connecting org only (a second org's list/provider status stay
     untouched, and a re-sync updates the same 2 rows rather than duplicating them); a BYON manual
     import creates a number with zero `fetch` calls and never echoes the SIP trunk password back
     even encrypted, an invalid E.164 is rejected with a client `422`, and a duplicate E.164 within
     the same org is rejected with `409`; assigning a number to an agent writes an `audit_logs` row,
     and delete only removes the local registry row.
   - Phase 5 added 2 new migrations (27 total: the original 25 plus
     `00000000000026_phone_numbers.sql`/`00000000000027_phase5_rls_policies.sql`), applied cleanly
     both incrementally on top of the existing Phase 1-4 verification database and from a completely
     fresh database (all 27 migrations, in order, auth stub included) - both runs land on 29 tables,
     every one with RLS enabled and zero without; the `phone_number_providers` catalog seed produces
     exactly the 3 expected providers (`twilio`, `telnyx`, `byon`); the permission catalog seed still
     produces exactly 27 permissions (`numbers.manage` was already seeded in Phase 1, granted to
     SUPER_ADMIN/ADMIN/MANAGER - confirmed by a direct query - no new permission row needed).
   - Phase 6: `apps/backend/src/orchestration.integration.test.ts` - agent create/version/publish,
     Vapi + Twilio credentials, a BYON number import -> `POST /calls` (mocked only at `fetch`)
     creates the local row before the provider call and resolves the transfer destination purely
     from the agent version's own config -> a simulated Vapi webhook sequence (`status-update` ->
     `end-of-call-report`) drives `calls.status` through valid transitions only -> replaying the
     identical webhook payload hits the `UNIQUE (provider, event_id)` constraint and is reported
     `deduplicated: true` with zero new `call_events`/`webhook_events` rows -> a webhook resolving
     to org A's call never touches org B's calls (org B ends the test with zero call rows) and a
     stray/unknown call id is recorded for audit but updates nothing -> `POST /webhook-events/:id/
     replay` round-trips a stored event back through the real receiver route.
   - Phase 6 added 3 new migrations (30 total: the original 27 plus
     `00000000000028_orchestration_calls.sql`/`00000000000029_phase6_rls_policies.sql`/
     `00000000000030_phone_numbers_vapi_id.sql`), applied cleanly both incrementally on top of the
     existing Phase 1-5 verification database and from a completely fresh database (all 30
     migrations, in order, auth stub included) - both runs land on **34 tables, every one with RLS
     enabled and zero without**; the permission catalog now has exactly **29** permissions (the
     original 27 plus the 2 new `calls.manage`/`webhooks.manage` keys this phase adds), each
     confirmed granted to exactly 3 roles (`SUPER_ADMIN`/`ADMIN`/`MANAGER`) by direct query; the
     `webhook_events_provider_event_id_key` unique index is confirmed present.
   - Python: `apps/pipecat-service`'s own `pytest` suite (8 tests) - `/health` always `200`,
     `/readiness` honestly reports `503` with a `missing` list when unconfigured and `200
     {"ready": true}` once every requirement is set, `POST /calls` fails cleanly with a `422 "not
     configured: missing X"` when no engine config exists (the exact scenario the task brief calls
     out), telephony-credential validation, a mocked-Twilio successful call-origination round trip
     asserting the real Twilio Calls API request shape (account SID, TwiML `<Stream>` URL), 404 on
     an unknown call id, and 401 when a configured bearer token is missing/wrong.
   - Phase 7: `apps/backend/src/campaigns.integration.test.ts` (5 tests) plus
     `apps/backend/src/services/leadEligibility.test.ts` (17 unit tests) and
     `apps/backend/src/services/campaignRotate.test.ts` (4 unit tests) - see the "Phase 7" section
     above for exactly what each integration test proves (full lifecycle including a real dispatcher
     tick and simulated webhook outcomes, publish-time snapshot immutability across a
     re-publish of the underlying agent, concurrent-dispatch-tick race safety via `Promise.all`
     against the shared fake tables, cross-org isolation, and a 1000-synthetic-lead no-lost-lead
     batch). Phase 7 added 2 new migrations (32 total: the original 30 plus
     `00000000000031_campaigns.sql`/`00000000000032_phase7_rls_policies.sql`), applied cleanly both
     incrementally on top of the existing Phase 1-6 verification database and from a completely
     fresh database (all 32 migrations, in order, auth stub included) - both runs land on **40
     tables, every one with RLS enabled and zero without**; the permission catalog is unchanged at
     29 (the Phase 1 seed already included every `campaigns.*` key, each confirmed already granted
     to `SUPER_ADMIN`/`ADMIN`, `MANAGER` getting all but role/user/settings admin per that seed's
     existing rule); the `campaign_leads_dispatch_idx` composite index and the deferred
     `calls.campaign_id`/`phone_numbers.assigned_campaign_id` foreign keys are confirmed in place.
     The full monorepo `pnpm run build`/`test`/`lint`/`typecheck` all pass clean after this phase
     (197 backend tests total).
   - Phase 8: `apps/backend/src/phase8.integration.test.ts` (6 tests) plus
     `apps/backend/src/services/dispositionEngine.test.ts` (11 unit tests),
     `apps/backend/src/services/retryEngine.test.ts` (12 unit tests, including the adversarial
     DNC-never-retry case), `apps/backend/src/services/toolCallHandler.test.ts` (5 unit tests) and
     `apps/backend/src/lib/callStateMachine.test.ts` (6 unit tests) - see the "Phase 8" section
     above for exactly what each integration test proves (single-source-of-truth disposition
     assignment, manual override + audit log, the DNC-tool-call-then-never-redialed regression
     against a brand-new campaign, callback-overrides-cooldown surviving event ordering, callback
     dispatch through the exact same claim path, and cross-org isolation). Phase 8 added 2 new
     migrations (34 total: the original 32 plus
     `00000000000033_phase8_dispositions_callbacks.sql`/`00000000000034_phase8_rls_policies.sql`),
     applied cleanly both incrementally on top of the existing Phase 1-7 verification database and
     from a completely fresh database (all 34 migrations, in order, auth stub included) - both runs
     land on **43 tables, every one with RLS enabled and zero without**; the permission catalog
     grew from 29 to **30** (the new `callbacks.manage` key, confirmed granted to exactly
     `SUPER_ADMIN`/`ADMIN`/`MANAGER`/`AGENT`); the 9 system dispositions are confirmed seeded with
     `organization_id null` and the `call_dispositions_call_id_key`/`dispositions_system_code_key`
     unique indexes are confirmed present. While building this phase's test coverage, two latent
     bugs in the shared `fakeSupabase.ts` test harness surfaced and were fixed: a missing
     `.is()`/`.gt()` filter method (already used by unrelated Phase 5 production code, just never
     exercised by an existing test) and an `.or()` clause parser that silently truncated ISO
     timestamp values at their millisecond-separator dot - neither affects the real Postgres/RLS
     verification in point 1 above, only the in-memory test double. The full monorepo `pnpm run
     build`/`test`/`lint`/`typecheck` all pass clean after this phase (240 backend tests total).
   - Phase 9: `apps/backend/src/phase9.integration.test.ts` (6 tests) plus
     `apps/backend/src/services/processCallArtifacts.test.ts` (5 unit tests),
     `apps/backend/src/services/generateCallSummary.test.ts` (5 unit tests),
     `apps/backend/src/services/cdrQuery.test.ts` (8 unit tests) and
     `apps/backend/src/services/cdrExport.test.ts` (4 unit tests) - see the "Phase 9" section above
     for exactly what each integration test proves (real transcript/recording/summary ingestion
     off a real terminal call, CDR list/detail reflecting them, real recording bytes served back,
     transcript search, a real background CSV export with the correct row count and audit log
     entry, and cross-org isolation across CDR/recording/export access, including via a guessed
     export id). Phase 9 added 2 new migrations (36 total: the original 34 plus
     `00000000000035_phase9_cdr.sql`/`00000000000036_phase9_rls_policies.sql`), applied cleanly
     both incrementally on top of the existing Phase 1-8 verification database and from a
     completely fresh database (all 36 migrations, in order, auth stub included) - both runs land
     on **48 tables, every one with RLS enabled except the same pre-existing `users` table gap
     already present since Phase 1** (confirmed identical on both the incremental and fresh runs,
     not a Phase 9 regression); the permission catalog is unchanged at 30 (`cdr.view`/`cdr.export`
     were already seeded in Phase 1); `search_call_transcripts()` is confirmed present alongside
     `match_knowledge_chunks()`. The full monorepo `pnpm run build`/`test`/`lint`/`typecheck` all
     pass clean after this phase (268 backend tests total).
   - Phase 10: `apps/backend/src/phase10.integration.test.ts` (5 tests) plus
     `apps/backend/src/ws/liveMonitorEvents.test.ts` (6 unit tests),
     `apps/backend/src/ws/liveMonitorBroadcaster.test.ts` (5 tests, including the explicit cross-org
     isolation and full-event-sequence-in-order tests) and
     `apps/backend/src/services/liveTranscriptIngestion.test.ts` (5 unit tests) - see the "Phase 10"
     section above for exactly what each proves. Phase 10 added 1 new migration (37 total: the
     original 36 plus `00000000000037_phase10_live_monitor.sql`, adding only
     `calls.transfer_initiated_by` - no new tables were needed, see that section), applied cleanly
     both incrementally on top of the existing Phase 1-9 verification database and from a
     completely fresh database (all 37 migrations, in order, auth stub included) - both runs land
     on **48 tables** (unchanged from Phase 9 - this phase added a column, not a table), RLS
     confirmed still enabled everywhere it was before; the permission catalog is unchanged at 30
     (`live_monitor.view`/`listen`/`barge`/`whisper` were already seeded in Phase 1) and the
     real per-role permission counts now confirm the intended supervisor tier split: MANAGER 27,
     AGENT 9 (gained `live_monitor.view` plus the rest of the day-to-day set), VIEWER 7,
     ADMIN/SUPER_ADMIN 30. The full monorepo `pnpm run build`/`test`/`lint`/`typecheck` all pass
     clean after this phase (289 backend tests total), and the separate `apps/pipecat-service`
     Python suite (`pytest`) passes 31/31, up from 8/8 before this phase.
   - Phase 11: `apps/backend/src/services/evaluateCall.test.ts` (9 tests),
     `apps/backend/src/services/aggregateAgentImprovements.test.ts` (8 tests) and
     `apps/backend/src/phase11.integration.test.ts` (5 tests) - see the "Phase 11" section above for
     exactly what each proves, including the explicit snapshot-immutability regression guard (apply
     creates a new draft while the previously published version's `system_prompt` is asserted
     byte-for-byte unchanged) and cross-org isolation across evaluations/improvements/summary/PATCH.
     Phase 11 added 4 new migrations (41 total: the original 37 plus `00000000000038_phase11_call_
     evaluations.sql`, `00000000000039_phase11_agent_improvements_alter.sql`,
     `00000000000040_phase11_rls_policies.sql`, `00000000000041_phase11_evaluation_summary_fn.sql`),
     applied cleanly both incrementally on top of the existing Phase 1-10 verification database and
     from a completely fresh database (all 41 migrations, in order, auth stub included) - both runs
     land on **49 tables** (up from 48 - the new `call_evaluations` table), RLS confirmed enabled on
     all 49 (including the newly-added insert/update policies on `ai_agent_improvements`, which had
     select-only policies before this phase); the permission catalog is unchanged at 30 (no new
     permission keys needed - every Phase 11 route reuses the existing `agents.manage`) and
     `agent_evaluation_summary()`/`match_knowledge_chunks()`/`search_call_transcripts()` all present.
     The full monorepo `pnpm run build`/`test`/`lint`/`typecheck` all pass clean after this phase
     (311 backend tests total, up from 289).
   - Phase 12: `apps/backend/src/services/analyticsQuery.test.ts` (9 tests),
     `apps/backend/src/services/analyticsAggregator.test.ts` (2 tests) and
     `apps/backend/src/phase12.integration.test.ts` (8 tests) - see the "Phase 12" section above for
     exactly what each proves. **The rollup SQL functions themselves were additionally verified
     directly against a real local PostgreSQL 16 instance** (not just the fake-Supabase JS mirror the
     integration test exercises): a fixture of 4 hand-authored `calls` rows (mixed dispositions,
     durations, campaign leads) was inserted, `recompute_analytics_daily_org/_campaign/_agent()` and
     `recompute_analytics_hourly_org()` were run once, and every resulting field (`total_calls`,
     `calls_connected`, `voicemails`, `transfers`, `avg_call_duration_seconds`, `avg_talk_time_
     seconds`, `leads_called`, `leads_remaining`, ...) matched its hand-calculated expected value
     exactly; running every function a second time produced byte-identical rows with zero duplicates
     (the idempotent-upsert requirement); and a date with genuinely zero calls got a real zeroed row,
     never a gap. Phase 12 added 3 new migrations (44 total: the original 41 plus
     `00000000000042_phase12_analytics_tables.sql`, `00000000000043_phase12_analytics_rls_
     policies.sql`, `00000000000044_phase12_analytics_rollup_fns.sql`), applied cleanly both
     incrementally on top of the existing Phase 1-11 verification database and from a completely
     fresh database (all 44 migrations, in order, auth stub included) - both runs land on **53
     tables** (up from 49 - the 4 new `analytics_*` rollup tables), RLS confirmed enabled on all 53;
     the permission catalog is unchanged at 30 (`analytics.view` was already seeded in Phase 1, this
     phase is the first to actually enforce it); `recompute_analytics_daily_org/_campaign/_agent`,
     `recompute_analytics_hourly_org` and `dashboard_disposition_breakdown` all confirmed present
     alongside `agent_evaluation_summary()`/`match_knowledge_chunks()`/`search_call_transcripts()`.
     The full monorepo `pnpm run build`/`test`/`lint`/`typecheck` all pass clean after this phase
     (330 backend tests total, up from 311).
   - Phase 13: `apps/backend/src/lib/sms/twilioSms.test.ts` (5 tests), `apps/backend/src/lib/sms/
     telnyxSms.test.ts` (5 tests), `apps/backend/src/services/smtpProvider.test.ts` (4 tests),
     `apps/backend/src/lib/promptVariables.test.ts` (5 tests), `apps/backend/src/services/
     smsDispatcher.test.ts` (5 tests) and `apps/backend/src/messaging.integration.test.ts`
     (4 tests) - see the "Phase 13" section above for exactly what each proves, including the
     race-simulated concurrent-materialization test that asserts the `UNIQUE(campaign_id, lead_id)`
     constraint actually prevents a double-send, and the real Twilio delivery webhook -> replay ->
     deduplication sequence. Phase 13 added 3 new migrations (47 total: the original 44 plus
     `00000000000045_phase13_smtp_settings.sql`, `00000000000046_phase13_messaging_campaigns.sql`,
     `00000000000047_phase13_rls_policies.sql`), applied cleanly both incrementally on top of the
     existing Phase 1-12 verification database and from a completely fresh database (all 47
     migrations, in order, auth stub included) - both runs land on **59 tables** (up from 53 - the 6
     new `smtp_settings`/`sms_campaigns`/`sms_messages`/`email_campaigns`/`email_messages`/
     `email_suppressions` tables), RLS confirmed enabled on all 59; the permission catalog is
     unchanged (`messaging.manage` was already seeded in Phase 1, this phase is the first to
     actually enforce it). The full monorepo `pnpm run build`/`test`/`lint`/`typecheck` all pass
     clean after this phase (358 backend tests total, up from 330).
   - Phase 14: `apps/backend/src/services/exportGenerators/writers.test.ts` (5 tests, the shared
     CSV/XLSX writer), `apps/backend/src/routes/cdr.mp3Transcode.test.ts` (4 tests, real ffmpeg
     transcode + ffprobe-verified output + regression coverage for the mp3-passthrough and
     ffmpeg-unavailable fallback paths) and `apps/backend/src/phase14.integration.test.ts`
     (6 tests) - see the "Phase 14" section above for exactly what each proves, including the
     leads export correctly reflecting a DNC lead and a real custom-field column, and the unified
     `GET /exports?type=` history query's cross-org isolation. Phase 14 added 1 new migration
     (48 total: `00000000000048_phase14_exports.sql` - widens `exports.type`'s check constraint,
     adds `entity_reference`, and widens the `exports` RLS `select`/`insert` policies), applied
     cleanly both incrementally on top of the existing Phase 1-13 verification database and from a
     completely fresh database (all 48 migrations, in order, auth stub included) - both runs land
     on the same **59 tables** as Phase 13 (purely additive - no new tables, only an altered
     `exports`), RLS confirmed enabled on all 59, and the `exports` table carries the new column,
     widened type check constraint and updated policies exactly as written. The permission catalog
     is unchanged (no new permission key was needed - `leads.view`/`messaging.manage` already
     existed and now also gate export creation for their own entities). This session also
     re-checked `ffmpeg` availability fresh (`apt-get install -y ffmpeg` succeeded this time,
     unlike Phase 9's session) and confirmed `ffmpeg 6.1.1` is genuinely on `PATH` and produces
     real, `ffprobe`-verified MP3 output. The full monorepo `pnpm run build`/`test`/`lint`/
     `typecheck` all pass clean after this phase (373 backend tests total - 372 passing plus 1
     environment-conditional skip for the ffmpeg-unavailable fallback test, since this sandbox does
     have ffmpeg - up from 358).

**Not independently verifiable in this sandbox:** the exact real-world request/response shapes of
ElevenLabs' and Cartesia's APIs (no live network access to either vendor here; every adapter's
request URL/headers/payload is built from each provider's current public API documentation, and
their unit tests assert on those exact shapes against a mocked `fetch`), and OmniVoice/VoxCPM
end-to-end synthesis/cloning, which requires an organization to actually deploy a serverless GPU
endpoint first (no GPU exists in this build/sandbox) - both adapters' "not configured" and
request-shaping logic are unit-tested instead. Same for Phase 5's Twilio and Telnyx REST APIs (no
live network access to either carrier here; every adapter's request URL/headers/payload is built
from each provider's current public API documentation, and their unit tests assert on those exact
shapes against a mocked `fetch`), and Phase 6's Vapi and pipecat-service integrations - no live
network access to Vapi's real API or to a real Twilio/Telnyx call here, and no real phone call is
placed anywhere in this build; every request shape is built from each provider's current documented
API and asserted against a mocked `fetch`/`httpx` boundary instead. The real `pipecat-ai` pipeline
construction code (`apps/pipecat-service/app/pipeline.py`) is written against pipecat-ai 1.10.0's
documented module layout but never run end-to-end against a live media stream here - see that
service's own README for exactly what it does and doesn't verify. Phase 10 adds to that same gap:
`SupervisorTapProcessor`/`SupervisorInjectProcessor`/`CallerTranscriptEmitter`/
`AssistantTranscriptEmitter` (`app/pipeline.py`) are written directly against pipecat-ai's real,
documented `FrameProcessor`/`AudioRawFrame`/`OutputAudioRawFrame`/`TranscriptionFrame`/
`LLMFullResponseStartFrame`/`LLMFullResponseEndFrame` classes, but pipecat-ai itself could not be
installed in this sandbox (a `pip install pipecat-ai` attempt here timed out fetching from
PyPI/files.pythonhosted.org) and there is no live call to run them against regardless - everything
on THIS side of that boundary (the WS endpoint's auth/call-id validation, `supervisor_hub.py`'s
queueing/broadcast/isolation logic, correct wiring of a WS connection into the hub) is instead
proven directly, for real, in `test_supervisor_auth.py`/`test_supervisor_hub.py`/
`test_supervisor_ws.py`. Same for Phase 8's tool-call
webhook handling: `services/toolCallHandler.ts`'s parsing is built from Vapi's currently documented
`tool-calls` message shape (`toolCallList`/`toolCalls`, `function.name`/`function.arguments`) and
exercised against synthetic fixtures, never a live Vapi assistant actually invoking a configured
function during a real call - no real phone call is placed anywhere in this build. Same for Phase
9's artifact ingestion: `VapiProvider.getArtifacts()`'s real-per-message-timing path
(`call.messages`/`secondsFromStart`) is built from Vapi's currently documented call-object shape
but never exercised against a live Vapi call, and no real audio file was ever downloaded from a
live provider recording URL here - the download/re-store path (`services/
processCallArtifacts.ts`'s `ingestRecording()`) is exercised end to end against a mocked `fetch`
serving real bytes in `phase9.integration.test.ts` (so the actual fetch-then-`StorageAdapter.
putObject()`-then-serve-back code path is real and tested, just not against a live provider URL).
MP3 transcoding via `ffmpeg` was written in Phase 9 but not exercised there since no `ffmpeg` binary
was installed in that build's sandbox. **Phase 14 re-checked this fresh and ffmpeg 6.1.1 is now
installed and on `PATH`** - `cdr.mp3Transcode.test.ts` proves the real transcode branch actually
engages (a real generated WAV fixture, re-encoded by the real `ffmpeg` child process, independently
verified as valid MP3 by `ffprobe`), alongside regression coverage for the already-mp3 passthrough
and the ffmpeg-unavailable fallback (skipped in this run since ffmpeg is present, but still present
in the suite for an environment where it isn't). Same category of gap for Phase 11: the evaluator and improvement-suggestion prompts are real and sent to
the real OpenAI chat completions endpoint shape (`lib/llm/openai.ts`, unchanged from Phase 3), but
this sandbox has no real `OPENAI_API_KEY`/network access, so `phase11.integration.test.ts` mocks the
same `fetch` boundary Phase 9/10's tests already established, returning realistic rubric/suggestion
JSON keyed off which system prompt each request carries - the actual quality of a real LLM's
evaluation judgment (as opposed to the parsing/storage/mining/workflow code around it, which is fully
real and tested) is not something any test in this build claims to verify. Phase 12 has no new
external-vendor gap (it computes everything from data already in this database), but it does carry
two explicitly documented simplifications rather than gaps: all date-range math is UTC-based, not
per-organization-timezone (`services/analyticsQuery.ts`'s header comment), and the agent-analytics
"disposition accuracy" figure is a documented practical proxy (1 - manual-override rate) rather than
a comparison against any independently-labeled ground truth, since none exists in this system.
Phase 13 carries the same category of gap as Phase 5: no live network access to Twilio's or
Telnyx's real SMS-send endpoints here, so `lib/sms/twilioSms.test.ts`/`telnyxSms.test.ts` assert on
the exact request shape (URL, auth header, form/JSON body) against a mocked `fetch`, built from each
provider's current documented Messages API; `messaging.integration.test.ts`'s SMS flow exercises the
real dispatcher/route/webhook code end to end against that same mock. Likewise no real SMTP server
here - `smtpProvider.test.ts` and the integration test inject a fake nodemailer transport (real
`nodemailer` request-building code, real error-humanizing code, just not a real TCP connection to a
real mail server) rather than pretend a real one was reached. This is a documented simplification,
not a gap in scope: no test in this build claims to have sent a real SMS or a real email over the
public internet.

If you have reliable Docker registry access, `supabase start` followed by `supabase db reset` will
run the same migrations against the full local stack, and `supabase db push` will apply them to a
real hosted project - nothing about the migrations themselves depends on this sandbox's
workaround.
