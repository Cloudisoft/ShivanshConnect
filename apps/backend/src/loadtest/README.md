# Phase 15 load test

Real, runnable, checked-in load/failure-recovery tests for the campaign
dispatch pipeline at 10,000-lead scale (master spec section 75), run
against a **real local PostgreSQL 16 database** with every migration in
`supabase/migrations/*.sql` applied - never the in-memory `fakeSupabase`
fixture the rest of this repo's fast suite uses. The only thing mocked is
the outbound network call to Vapi's REST API (`fetch` boundary) - no real
phone call is ever placed.

## One-time setup: create the load-test database

```bash
sudo -u postgres psql -c "CREATE ROLE shivansh LOGIN PASSWORD 'shivansh' SUPERUSER;"   # if it doesn't exist yet
sudo -u postgres psql -c "CREATE DATABASE shivanshconnect_loadtest OWNER shivansh;"

# auth.users/auth.uid() stub - this schema normally exists on a real
# Supabase project; migrations FK against it and RLS policies call
# auth.uid(). The load test never authenticates through Supabase Auth (it
# calls dispatcher/state-machine code directly - see seed.ts's header), so
# the stub only needs to satisfy the schema, not behave correctly.
PGPASSWORD=shivansh psql -h localhost -U shivansh -d shivanshconnect_loadtest <<'SQL'
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key default gen_random_uuid(), email text);
create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
create extension if not exists pgcrypto;
SQL

# Apply every migration, in order.
cd supabase/migrations
for f in $(ls *.sql | sort); do
  PGPASSWORD=shivansh psql -h localhost -U shivansh -d shivanshconnect_loadtest -v ON_ERROR_STOP=1 -f "$f"
done
```

Set `LOADTEST_DATABASE_URL` if your connection details differ from the
default `postgresql://shivansh:shivansh@localhost:5432/shivanshconnect_loadtest`.

## Running

```bash
pnpm run loadtest              # from the repo root, or
pnpm --filter @shivanshconnect/backend run loadtest
```

Excluded from the default fast `pnpm run test` suite (see
`vitest.config.ts`'s `exclude` and `vitest.loadtest.config.ts`) - it seeds
and dispatches real leads through real Postgres across three concurrency
tiers and takes minutes, not milliseconds.

Optional env overrides: `LOADTEST_LEAD_COUNT` (default `10000`).

## What's real vs. what's a deliberate scope choice

- **Real**: the dispatcher tick loop (`processCampaign()`), the eligibility
  query and its index usage, the CAS lead claim, call origination request
  shaping, the call state machine, the terminal handler, the disposition
  engine, campaign_leads retry/disposition bookkeeping, the analytics
  rollup SQL functions - every one of these is the actual production
  module, unmodified, running against actual Postgres tables.
- **Mocked**: only `fetch` calls to `https://api.vapi.ai/*` (see
  `mockVapiFetch.ts`) - spec section 75's explicit requirement that no real
  phone call is ever placed.
- **Scope choice**: seeding and the bulk 10k-lead outcome resolution go
  directly through service functions / `pgSupabaseAdapter.ts` rather than
  through the full HTTP/auth layer or the webhook HTTP route for every one
  of ~11,500 simulated call endings - see `seed.ts`'s and
  `resolveOutcomes.ts`'s header comments for exactly why, and
  `failureRecovery.loadtest.test.ts` for where the real HTTP webhook route
  (idempotency, duplicate delivery, out-of-order delivery) is separately
  exercised at a scale appropriate to that concern.

## Files

- `pgSupabaseAdapter.ts` - the real-Postgres-backed stand-in for the
  supabase-js chainable query builder (see its own header comment).
- `seed.ts` - org/agent/campaign/lead seeding helpers.
- `mockVapiFetch.ts` - the fetch-boundary mock.
- `resolveOutcomes.ts` - drives an in-flight call to a terminal outcome via
  the real state machine.
- `dispatch10k.loadtest.test.ts` - the main 10,000-lead, 3-concurrency-tier
  load test (throughput, concurrency-cap, zero-lost/zero-duplicate,
  retry, disposition correctness).
- `eligibilityQueryPlan.loadtest.test.ts` - `EXPLAIN ANALYZE` against the
  real eligibility query at 10k scale (index-backed, no sequential scan).
- `dispatchBatching.loadtest.test.ts` - proves the dispatcher never
  materializes all leads into memory at once (LIMIT-bounded, batch by
  batch).
- `analyticsReconciliation.loadtest.test.ts` - runs the real analytics
  rollup SQL functions against the 10k-lead dataset and reconciles the
  result against a hand-computed SQL ground truth.
- `failureRecovery.loadtest.test.ts` - process-restart, crash-isolation,
  webhook idempotency/duplicate/out-of-order aggregation, provider-timeout
  retry, and DB-transaction-atomicity tests (spec sections 72/73).
- `callReconciliation.loadtest.test.ts` - tests services/
  callReconciliation.ts (built in this phase - see its own header).
