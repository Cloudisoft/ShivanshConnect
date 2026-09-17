# ShivanshConnect

A multi-tenant AI voice contact-center platform. This repository is being built in phases; **this
build covers Phase 1 only** (organizations, auth, users, roles/permissions, audit logs, and the
overall app shell). Later phases (campaigns, dialing, leads, live monitoring, AI agents, voices,
telephony numbers, messaging, analytics, and more) are deliberately **not** implemented yet - see
[Phase plan status](#phase-plan-status) below.

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

**Explicitly NOT built yet** (deferred to later phases, to be built and reviewed in subsequent
sessions):

- Campaigns, Dialing Settings, Callbacks, Dispositions - campaign/dialer management
- Leads, Lead Lists (import, phone normalization, DNC)
- Live Monitor (listen/barge/whisper on live calls)
- CDR (call detail records)
- AI Agents, Voices (Vapi / ElevenLabs / Cartesia integration)
- DIDs, Inbound Routes, Queues (Twilio/Telnyx number management, inbound call routing)
- Messaging
- Analytics (the Phase 1 Dashboard is intentionally a shell with no metrics, real or fake)
- SMTP-backed email delivery (Phase 1 ships an `EmailService` interface with a console-log
  implementation only; invite/reset links are logged and also returned in API responses in dev)
- Background job queues / Redis (the `apps/worker` package is a structural placeholder only)
- Railway service provisioning (documented above, not actually created)

Every permission key for these future modules (e.g. `campaigns.view`, `live_monitor.barge`,
`voices.manage`) is already seeded into the `permissions` table so later phases only need to wire
up real enforcement, not another migration.

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

This sandbox had no outbound access to the container registries the Supabase CLI's local Docker
stack pulls images from (ghcr.io and Docker Hub both returned `403 Forbidden` through the
environment's network proxy), so the full `supabase start` stack (Postgres + GoTrue + PostgREST +
Studio, etc.) could not be started here. Two things were still verified for real:

1. **Every SQL migration was applied, in order, to a real local PostgreSQL 16 instance**
   (installed directly via `apt`, not Docker), including a minimal `auth.users` table and
   `auth.uid()` stub so the RLS-dependent helper functions could be created. All 9 migrations
   applied cleanly; RLS was confirmed enabled on all 9 tenant tables; the seed produced 27
   permissions and the expected per-role permission counts (`SUPER_ADMIN`/`ADMIN`: 27,
   `MANAGER`: 24, `AGENT`: 8, `VIEWER`: 7).
2. **The backend integration test** (`apps/backend/src/integration.test.ts`) exercises the real
   Fastify route handlers end-to-end over HTTP (`app.inject()`) - signup, invite, accept
   invitation, role change, audit log read, and a cross-tenant rejection - against an in-memory
   fake of the Supabase client (`apps/backend/src/test/fakeSupabase.ts`), since no live
   Supabase project or local PostgREST was reachable either. This is the documented "mock at the
   DB-client boundary" fallback, not a substitute for RLS verification (covered by point 1).

If you have Docker access to ghcr.io/Docker Hub, `supabase start` followed by
`supabase db reset` will run the same migrations against the full local stack, and
`supabase db push` will apply them to a real hosted project - nothing about the migrations
themselves depends on this sandbox's workaround.
