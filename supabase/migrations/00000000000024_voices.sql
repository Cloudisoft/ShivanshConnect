-- Phase 4: voice_providers, voice_provider_credentials, voices
--
-- Master spec sections 27/28/29. Four voice providers exist as a fixed
-- catalog: two managed SaaS APIs (ElevenLabs, Cartesia) and two
-- self-hosted open-source models that must be served behind a serverless
-- GPU endpoint the org brings itself (OmniVoice/k2-fsa, VoxCPM/OpenBMB -
-- see apps/backend/src/lib/voice/omnivoice.ts and voxcpm.ts for exactly
-- what "self-hosted" means here and how to stand one up). requires_
-- external_hosting flags that distinction so the frontend never implies
-- the self-hosted two work out of the box.
--
-- voice_provider_credentials stores each org's own API key (ElevenLabs/
-- Cartesia) or endpoint URL + token (OmniVoice/VoxCPM), AES-256-GCM
-- encrypted at rest via apps/backend/src/lib/crypto/credentials.ts using
-- CREDENTIAL_ENCRYPTION_KEY - the same helper later phases (5/6/13)
-- reuse for Twilio/Telnyx/Vapi/SMTP credentials. Raw secrets are never
-- selected back to the frontend by application code (see
-- routes/voiceProviders.ts) - encrypted_credentials is jsonb containing
-- only ciphertext/iv/authTag, never plaintext.
--
-- voices holds the org's own registered voices - either synced from a
-- provider's voice catalog (POST /voices/sync/:providerKey) or created
-- via cloning (POST /voices/clone). ai_agent_versions.voice_id was left
-- as a bare, unvalidated text column in Phase 3 (00000000000018) because
-- this table didn't exist yet; this migration adds the deferred FK now.

create table if not exists public.voice_providers (
  id uuid primary key default gen_random_uuid(),
  -- Provider *definitions* are platform-level (organization_id is always
  -- null for the 4 seeded rows) - what's org-scoped is the credential
  -- slot in voice_provider_credentials below, not the catalog entry
  -- itself.
  organization_id uuid references public.organizations (id) on delete cascade,
  key text not null unique check (key in ('elevenlabs', 'cartesia', 'omnivoice', 'voxcpm')),
  display_name text not null,
  requires_external_hosting boolean not null default false,
  created_at timestamptz not null default now()
);

insert into public.voice_providers (key, display_name, requires_external_hosting)
values
  ('elevenlabs', 'ElevenLabs', false),
  ('cartesia', 'Cartesia', false),
  ('omnivoice', 'OmniVoice (k2-fsa)', true),
  ('voxcpm', 'VoxCPM (OpenBMB)', true)
on conflict (key) do nothing;

create table if not exists public.voice_provider_credentials (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  provider_key text not null references public.voice_providers (key),

  -- { iv: base64, authTag: base64, ciphertext: base64 } - AES-256-GCM,
  -- see lib/crypto/credentials.ts. Plaintext shape varies by provider:
  -- ElevenLabs/Cartesia -> { api_key }, OmniVoice/VoxCPM -> { endpoint_url, api_key }.
  encrypted_credentials jsonb not null,

  status text not null default 'not_connected' check (status in ('not_connected', 'connected', 'error')),
  last_verified_at timestamptz,
  last_error text,

  created_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists voice_provider_credentials_org_provider_key
  on public.voice_provider_credentials (organization_id, provider_key);
create index if not exists voice_provider_credentials_organization_id_idx
  on public.voice_provider_credentials (organization_id);

drop trigger if exists voice_provider_credentials_set_updated_at on public.voice_provider_credentials;
create trigger voice_provider_credentials_set_updated_at
  before update on public.voice_provider_credentials
  for each row execute function public.set_updated_at();

alter table public.voice_providers enable row level security;
alter table public.voice_provider_credentials enable row level security;

create table if not exists public.voices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  provider_key text not null references public.voice_providers (key),
  provider_voice_id text not null,

  name text not null check (char_length(name) between 1 and 200),
  gender text check (gender in ('male', 'female', 'neutral', 'unknown')),
  language text,
  accent text,
  description text,

  status text not null default 'active' check (status in ('active', 'inactive')),

  is_cloned boolean not null default false,
  source_sample_storage_path text,
  clone_status text check (clone_status in ('n/a', 'pending', 'processing', 'ready', 'failed')),
  consent_confirmed boolean not null default false,

  created_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists voices_org_provider_voice_key
  on public.voices (organization_id, provider_key, provider_voice_id);
create index if not exists voices_organization_id_idx on public.voices (organization_id);
create index if not exists voices_provider_key_idx on public.voices (provider_key);
create index if not exists voices_status_idx on public.voices (status);
create index if not exists voices_created_at_idx on public.voices (created_at);

drop trigger if exists voices_set_updated_at on public.voices;
create trigger voices_set_updated_at
  before update on public.voices
  for each row execute function public.set_updated_at();

alter table public.voices enable row level security;

-- Deferred FK from Phase 3 - now that voices exists, validate agent
-- version voice selections against it. ai_agent_versions.voice_id was
-- created as bare `text` in 00000000000018 (voices.id didn't exist to
-- reference yet); convert it to uuid first. Any pre-existing value that
-- isn't a well-formed uuid (impossible via the app's own Zod validation,
-- but defensive for hand-seeded/dev data) is nulled out rather than
-- failing the migration - it was never a valid FK target anyway.
alter table public.ai_agent_versions
  alter column voice_id type uuid using (
    case
      when voice_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then voice_id::uuid
      else null
    end
  );

-- ON DELETE SET NULL: deleting a voice must not cascade-delete/break an
-- agent version, it just clears the (now-invalid) selection for the
-- frontend to prompt a re-pick.
alter table public.ai_agent_versions
  drop constraint if exists ai_agent_versions_voice_id_fkey;
alter table public.ai_agent_versions
  add constraint ai_agent_versions_voice_id_fkey
  foreign key (voice_id) references public.voices (id) on delete set null;
