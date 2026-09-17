# ShivanshConnect

A multi-tenant AI voice contact-center platform. This repository is being built in phases; **this
build covers Phases 1-9** (organizations, auth, users, roles/permissions, audit logs, the overall
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
CDR API with Postgres full-text transcript search, and background CSV/XLSX export jobs). Later
phases (live monitoring, messaging, analytics, and more) are deliberately **not** implemented yet -
see [Phase plan status](#phase-plan-status) below.

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
  bytes, transcoded to MP3 via a real `ffmpeg` child process when one is on `PATH`; **this
  sandbox's runtime has no ffmpeg installed**, so it serves the real source format as-is with an
  honest `Content-Type` instead of faking a conversion (see the environment-requirements note
  below). `GET /cdr/search-transcript` - full-text search via `search_call_transcripts()`.
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
requires an `ffmpeg` binary on the backend process's `PATH`; **this sandbox's runtime does not have
ffmpeg installed**, so that route currently serves each recording's real source format (whatever
the orchestration provider originally returned) with an honest `Content-Type` rather than faking a
conversion - installing `ffmpeg` (e.g. `apt install ffmpeg` on Debian/Ubuntu, or the Railway
service's own buildpack equivalent) is a deployment-time addition with zero code changes needed.
Recording/export "signed download URL" per spec section 22 is, in this build, an authenticated
`GET /api/v1/cdr/:callId/recording/download` / `GET /api/v1/exports/:id/download` route rather
than a bearer-token-free temporary link - a real signed-URL mechanism needs production S3-
compatible or Supabase Storage (still Phase 4's documented `LocalDiskStorageAdapter` limitation),
which is not live in this sandbox.

**Explicitly NOT built yet** (deferred to later phases):

- Redis/BullMQ - Phase 7's campaign dispatcher runs today as a documented in-process `setInterval`
  drop-in (see above); migrating it to a real queue is Phase 15 infra work, not a logic change
- Live Monitor (listen/barge/whisper on live calls) - Vapi's real `monitor.listenUrl`/`controlUrl`
  are already relayed by `getLiveMonitorUrls()`, but the UI to actually use them is Phase 10
- Inbound Routes, Queues (inbound call routing, ring groups)
- Messaging
- Analytics (the Phase 1 Dashboard is intentionally a shell with no metrics, real or fake)
- SMTP-backed email delivery
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
service's own README for exactly what it does and doesn't verify. Same for Phase 8's tool-call
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
MP3 transcoding via `ffmpeg` is written but **not exercised** in this sandbox since no `ffmpeg`
binary is installed here (`maybeTranscodeToMp3()`'s ENOENT fallback path is what actually runs in
every test and in this deployment) - see the Phase 9 environment-requirements note above.

If you have reliable Docker registry access, `supabase start` followed by `supabase db reset` will
run the same migrations against the full local stack, and `supabase db push` will apply them to a
real hosted project - nothing about the migrations themselves depends on this sandbox's
workaround.
