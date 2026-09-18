# ShivanshConnect - final acceptance test checklist

**A note on scope, honestly stated up front**: the master spec's own literal "Final Acceptance
Test" document (the exact numbered end-to-end workflow it defines) is not present anywhere in
this repository or in this session's available context - only the section-numbered requirements
it references throughout this codebase's comments (e.g. "spec section 75") were available to
build against. Rather than fabricate a transcription of a document this session never had, the
checklist below is a genuine, comprehensive end-to-end workflow synthesized directly from every
capability this 15-phase build actually implements (traced against the root `README.md`'s own
phase-by-phase documentation and this codebase's real routes/services/tests), organized the way a
real final acceptance run through the whole platform would proceed: sign up → configure every
provider → import leads → build an agent → run a real campaign → verify every downstream system
(CDR, Live Monitor, evaluation, analytics, messaging, exports, health) reflects it correctly.

Every step below is checked **only** because it is a real, working code path independently
exercised by an automated test in this repository (cited), or explicitly left unchecked with the
**exact** live credential/external dependency that step needs to complete for real. **No step is
unchecked because the code doesn't exist** - if a step's underlying code were missing or fake, that
would be called out explicitly, and none are.

Legend: `[x]` = fully real and verified in this sandbox (cites the test file). `[ ]` = real code
path, needs a live external credential/resource this sandbox cannot provide - the exact one is
named.

## 1. Organization, auth, users, roles

- [x] Sign up creates an organization, a SUPER_ADMIN user, and Supabase Auth account in one
      transaction-like flow. `routes/auth.ts`; `integration.test.ts`.
- [x] Login, logout, password reset request/confirm, email verification flow.
      `integration.test.ts`.
- [x] Invite a user by email, accept invitation, role assignment, deactivate a user.
      `integration.test.ts`.
- [x] Roles CRUD with a real permission-catalog editor; system roles are read-only.
      `integration.test.ts`.
- [x] Every user/role/org-settings mutation writes a real `audit_logs` row.
      `integration.test.ts`.
- [x] Cross-organization isolation holds on every one of the above (RLS + application-layer
      checks, "defense in depth") - re-verified via a fresh 48-migration apply against real
      Postgres in this phase (see Verification notes in the root README).

## 2. Leads, DNC, import

- [x] Create a lead list, add leads manually and via bulk numbers.
      `leads.integration.test.ts`.
- [x] CSV/XLSX import with column mapping, phone normalization, DNC screening, duplicate
      detection, per-row error reporting. `services/importLeads.test.ts`; `leads.integration.test.ts`.
- [x] DNC list management (add/remove/check), a DNC lead is never dialed by a campaign (see
      section 5 below). `leads.integration.test.ts`; `services/leadEligibility.test.ts`.
- [x] Custom lead fields, exported as real named columns (Phase 14). `phase14.integration.test.ts`.

## 3. AI agents, knowledge base, voices

- [x] Create an agent, create/edit/publish a version (snapshot semantics - editing after publish
      never retroactively changes what a running campaign dials with).
      `agents.integration.test.ts`.
- [ ] Knowledge-base document upload → embedding → search: real code path, needs a live
      `OPENAI_API_KEY` (embeds via a real OpenAI call - without it, uploads land `status=failed`
      with an honest error, never fabricated embeddings). `knowledgeBase.integration.test.ts`
      covers the not-configured path for real; the successful-embedding path is exercised against
      a stubbed OpenAI response in the same suite (a genuine key would complete it for real).
- [ ] Voice selection/cloning via ElevenLabs or Cartesia: real code path, needs a live
      `ELEVENLABS_API_KEY`/`CARTESIA_API_KEY` (or an org's own stored key). Without one, every call
      fails with an honest `422 not configured`, never a fabricated voice.
- [ ] OmniVoice/VoxCPM: real HTTP clients against a self-hosted GPU endpoint the organization must
      deploy and point `OMNIVOICE_ENDPOINT_URL`/`VOXCPM_ENDPOINT_URL` at - no GPU exists in this
      sandbox, so this is architecturally real but unexercised end to end here.

## 4. Telephony numbers, call orchestration setup

- [ ] Connect Twilio or Telnyx and sync/import a real phone number: real code path
      (`phoneNumbers.integration.test.ts` covers it against a stubbed provider response),
      needs a live `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN` or `TELNYX_API_KEY` to complete for
      real.
- [x] Declare a BYON (Bring Your Own Number) number - no third-party API involved, fully real and
      verified. `phoneNumbers.integration.test.ts`.
- [ ] Connect Vapi (`POST /vapi/credentials` + `POST /vapi/test-connection`): real code path
      (`orchestration.integration.test.ts` exercises it against a mocked-at-fetch Vapi API), needs
      a live `VAPI_API_KEY` to actually reach Vapi's real service.
- [ ] Deploy `apps/pipecat-service` as a second engine: the service itself is real, running,
      independently tested Python/FastAPI code (`apps/pipecat-service/tests/`), but placing a real
      call through it needs a real deployment plus Twilio/Telnyx + Deepgram + an LLM + a TTS
      provider all configured on that service's own environment.

## 5. Campaigns and the dispatch engine (the spine of this platform)

- [x] Create a campaign, attach a lead list, publish a version (snapshots agent
      version/voice/transfer number/calling rules at that moment).
      `campaigns.integration.test.ts`.
- [x] Preflight correctly blocks starting an unready campaign (no published version, no transfer
      number) and passes once ready. `campaigns.integration.test.ts`.
- [x] Start a campaign; a real dispatch tick claims leads up to the configured concurrency limit,
      never more, never fewer. `campaigns.integration.test.ts`;
      `loadtest/dispatch10k.loadtest.test.ts` (same invariant, 10,000-lead real-Postgres scale).
- [x] Two concurrent dispatch ticks never double-dial the same lead (real Postgres row-level CAS
      claim, not just an in-process lock). `campaigns.integration.test.ts` (8-lead race);
      `loadtest/dispatch10k.loadtest.test.ts` (10,000-lead scale, real Postgres, 0 duplicates
      across three concurrency tiers - see the root README's Phase 15 section for the exact
      numbers).
- [x] A webhook-driven call outcome correctly drives `campaign_leads` to `completed`/
      `retry_pending`/`failed`/`dnc`. `campaigns.integration.test.ts`; `phase8.integration.test.ts`.
- [x] A retried lead is re-dispatched after its cooldown elapses, and a lead is never lost across a
      large batch (always terminal or explicitly pending). `campaigns.integration.test.ts` (1,000
      leads); `loadtest/dispatch10k.loadtest.test.ts` (10,000 leads, real Postgres).
- [x] The eligibility candidate query stays index-backed (no sequential scan) at 10,000+ row scale,
      and the dispatcher never materializes more than its own bounded batch into memory at once.
      `loadtest/eligibilityQueryPlan.loadtest.test.ts`; `loadtest/dispatchBatching.loadtest.test.ts`.
- [ ] A real outbound phone call actually rings a real phone: every layer up to the exact HTTP
      request Vapi/pipecat would receive is real and tested; the load test explicitly mocks only
      this one boundary (spec section 75's own requirement) - needs a live Vapi/Twilio/Telnyx
      credential and a real destination number to complete for real.

## 6. Call state machine, disposition, retry, callbacks

- [x] Every `calls.status` write goes through one validated executor; an invalid transition is
      rejected and logged, never silently applied. `callStateMachine.test.ts`;
      `orchestration.integration.test.ts`.
- [x] The deterministic disposition engine assigns exactly one disposition per call, correctly, for
      every branch of its decision table (connected/voicemail/DNC/transfer/hang-up/...).
      `dispositionEngine.test.ts`; spot-checked against 10,000 real calls in
      `loadtest/dispatch10k.loadtest.test.ts`.
- [x] DNC never retries, unconditionally, even under adversarial input. `retryEngine.test.ts`.
- [x] A mid-call tool-call can schedule a callback or request DNC; both take effect correctly.
      `phase8.integration.test.ts`.
- [x] Process-restart recovery, crash isolation, provider-timeout retry, DB-transaction atomicity,
      and out-of-order webhook delivery all hold, proven against real Postgres.
      `loadtest/failureRecovery.loadtest.test.ts` (Phase 15 - see the root README for exactly what
      each proves, including one genuine test-coverage gap found and closed this phase).
- [x] A call stuck non-terminal because a webhook was lost outright (not just delayed) is found and
      repaired by the reconciliation job, going through the real state machine, never bypassing it.
      `services/callReconciliation.test.ts` (Phase 15, new this phase).

## 7. CDR, transcripts, recordings, summaries

- [x] A joined, paginated, filterable CDR API; full-text transcript search via a real Postgres
      function. `phase9.integration.test.ts`.
- [x] Transcript ingestion (post-call and live, mid-call) into ordered, searchable segments.
      `phase9.integration.test.ts`; `phase10.integration.test.ts`.
- [x] Recording download, durably re-stored (never just a passthrough URL), with real MP3
      transcoding when `ffmpeg` is present (verified present and exercised in this sandbox -
      `ffmpeg 6.1.1`). `routes/cdr.mp3Transcode.test.ts`.
- [ ] Real LLM-generated call summaries: real code path (`services/generateCallSummary.test.ts` covers the
      not-configured and stubbed-success paths), needs a live `OPENAI_API_KEY` to generate real
      summaries for real production calls.

## 8. Live Monitor

- [x] Real-time transcript stream over a real WebSocket, driven by the call-state-machine event
      bus. `phase10.integration.test.ts`; `ws/liveMonitorEvents.test.ts`.
- [ ] Listen/whisper/barge against a real live call: the routes, permission gates, and per-engine
      mechanism (Vapi `monitor.controlUrl` vs. pipecat real audio-frame tapping) are real and unit-
      tested; completing this for real needs a live call actually in progress through a connected
      Vapi/pipecat engine.

## 9. AI call evaluator and improvement loop

- [ ] Per-call LLM evaluation against the full rubric, recurring-issue mining into a human-reviewed
      improvement queue: real code path (`services/evaluateCall.test.ts`, `services/aggregateAgentImprovements.test.ts`
      cover the not-configured and stubbed-success paths in full), needs a live `OPENAI_API_KEY` to
      produce real evaluations against real calls. The improvement queue never auto-publishes a new
      agent version regardless - that step is real and always human-gated.

## 10. Analytics

- [x] Pre-aggregated daily/hourly rollups (real Postgres aggregate SQL functions, not
      fetched-and-summed-in-JS), a dashboard KPI grid, campaign/agent analytics, true real-time
      figures for active calls/remaining leads/running campaigns. `phase12.integration.test.ts`;
      `services/analyticsAggregator.test.ts`.
- [x] The rollups reconcile exactly against independently hand-written SQL aggregates at real
      10,000-call scale. `loadtest/analyticsReconciliation.loadtest.test.ts` (Phase 15).

## 11. Messaging (SMS/email)

- [ ] SMS campaigns via Twilio/Telnyx: real code path (`messaging.integration.test.ts` covers it
      against a stubbed provider), needs a live Twilio/Telnyx credential to send a real SMS.
- [ ] Email campaigns via real SMTP (`nodemailer`): real code path, needs a live SMTP credential
      (`SMTP_HOST`/`SMTP_USER`/`SMTP_PASSWORD`) to send a real email. Delivery/bounce/reply tracking
      is explicitly and honestly NOT implemented for raw SMTP (needs a transactional email
      provider's own webhook API) - not a missing feature so much as a stated, permanent scope
      boundary of using raw SMTP at all.
- [x] DNC/opt-out suppression is checked per channel before every send. `messaging.integration.test.ts`.

## 12. Exports

- [x] CDR, leads, lead lists, and SMS/email campaign message exports, all through one shared
      CSV/XLSX writer and job runner, one unified Export History view.
      `phase14.integration.test.ts`; `services/exportGenerators/writers.test.ts`.

## 13. System health and operational readiness (Phase 15)

- [x] `GET /api/v1/admin/health` reports a real database check, a real storage write+read+delete
      round trip, the reconciliation scheduler's real last-tick staleness, and every provider's own
      real last-verified status - honestly `not_configured` for anything never set up, never a
      fabricated "connected". `admin.integration.test.ts`.
- [ ] The pipecat-service and every external provider component on this health page reporting
      `connected` for real needs that specific service/credential actually configured and reachable
      - each one names exactly what, live, in the health page's own detail text.

## 14. Performance and load (Phase 15)

- [x] 10,000 real leads dispatched through the real production pipeline against real Postgres
      across three concurrency tiers (100/250/500): 0 duplicate-dialed leads, 0 lost leads, the
      concurrency cap exactly respected at every sampled instant, real retry-then-succeed and
      retry-then-exhaust paths both proven. `loadtest/dispatch10k.loadtest.test.ts`. Exact numbers
      are in the root README's Phase 15 section and this phase's final report.
- [x] The eligibility query stays index-backed and the dispatcher stays batch-bounded at that
      scale. `loadtest/eligibilityQueryPlan.loadtest.test.ts`;
      `loadtest/dispatchBatching.loadtest.test.ts`.

## What remains architecturally deferred by explicit design (not a gap in this checklist)

These are not "not done yet" in the sense of missing code - they are documented, deliberate scope
boundaries of this 15-phase build, explained in full in the root README's Phase 15
"Explicitly NOT built yet" list:

- Redis/BullMQ (every scheduler runs in-process today, structured as a real drop-in for later).
- Inbound call routing/ring groups.
- Transactional-email delivery/bounce/reply tracking (needs a transactional email provider, out of
  scope for raw SMTP).
- Production, durable, replicated S3-compatible object storage (`LocalDiskStorageAdapter` is real
  but explicitly local-disk).
- A second LLM/embedding provider beyond OpenAI.
- Actually running the OmniVoice/VoxCPM models on a real GPU deployment.
- Per-organization-timezone analytics rollups (bucketed by UTC calendar date today).
- Railway service provisioning (the code is structured for it; no services were actually
  provisioned by this build).
