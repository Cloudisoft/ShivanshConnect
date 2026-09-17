-- Phase 5: phone_number_providers, phone_number_provider_credentials, phone_numbers
--
-- Master spec sections 32/33. Three telephony number providers exist as a
-- fixed catalog: two real carrier APIs (Twilio, Telnyx) and one
-- non-API "provider" (BYON - Bring Your Own Number), which is a manual
-- declaration flow for a number the org already controls (e.g. through its
-- own SIP trunk or a number ported via its own carrier) rather than a
-- third-party integration - see apps/backend/src/lib/telephony/byon.ts for
-- exactly what that means and why it has no "sync from provider" step.
--
-- phone_number_provider_credentials reuses Phase 4's exact AES-256-GCM
-- encryption helper (apps/backend/src/lib/crypto/credentials.ts) for
-- Twilio's Account SID + Auth Token and Telnyx's API key. BYON never has a
-- row here - it has no credentials to store, only per-number manual entry
-- (see routes/phoneNumberProviders.ts).
--
-- phone_numbers holds the org's registered DIDs - either synced from a
-- connected Twilio/Telnyx account (POST /phone-numbers/sync/:providerKey)
-- or manually declared for BYON (POST /phone-numbers/import). Every number
-- is normalized to strict E.164 via the same lib/phone.ts helper Phase 2's
-- leads/DNC data uses, and is unique per organization regardless of which
-- provider it came from - see the two unique indexes below, matching
-- master spec section 57's explicit uniqueness rules.
--
-- assigned_campaign_id is a bare, unvalidated uuid column for now -
-- campaigns doesn't exist until Phase 7. A real FK is added then, the same
-- deferred-FK pattern Phase 3/4 used for ai_agent_versions.voice_id.

create table if not exists public.phone_number_providers (
  id uuid primary key default gen_random_uuid(),
  key text not null unique check (key in ('twilio', 'telnyx', 'byon')),
  display_name text not null,
  created_at timestamptz not null default now()
);

insert into public.phone_number_providers (key, display_name)
values
  ('twilio', 'Twilio'),
  ('telnyx', 'Telnyx'),
  ('byon', 'Bring Your Own Number (BYON)')
on conflict (key) do nothing;

create table if not exists public.phone_number_provider_credentials (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  provider_key text not null references public.phone_number_providers (key),

  -- { iv: base64, authTag: base64, ciphertext: base64 } - AES-256-GCM, see
  -- lib/crypto/credentials.ts. Plaintext shape: twilio -> { account_sid,
  -- auth_token }, telnyx -> { api_key }. BYON never has a row here.
  encrypted_credentials jsonb not null,

  status text not null default 'not_connected' check (status in ('not_connected', 'connected', 'error')),
  last_synced_at timestamptz,
  last_error text,

  created_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists phone_number_provider_credentials_org_provider_key
  on public.phone_number_provider_credentials (organization_id, provider_key);
create index if not exists phone_number_provider_credentials_organization_id_idx
  on public.phone_number_provider_credentials (organization_id);

drop trigger if exists phone_number_provider_credentials_set_updated_at on public.phone_number_provider_credentials;
create trigger phone_number_provider_credentials_set_updated_at
  before update on public.phone_number_provider_credentials
  for each row execute function public.set_updated_at();

alter table public.phone_number_providers enable row level security;
alter table public.phone_number_provider_credentials enable row level security;

create table if not exists public.phone_numbers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  provider_key text not null references public.phone_number_providers (key),
  -- Twilio SID / Telnyx id. Null for BYON - there is no provider-assigned
  -- identifier, only the org's own declaration of the number.
  provider_number_id text,

  phone_number text not null,
  friendly_name text,
  -- { voice_inbound: bool, voice_outbound: bool, sms: bool }
  capabilities jsonb not null default '{"voice_inbound": true, "voice_outbound": true, "sms": false}'::jsonb,

  status text not null default 'active' check (status in ('active', 'inactive', 'releasing')),

  assigned_agent_id uuid references public.ai_agents (id) on delete set null,
  -- Deferred FK - campaigns doesn't exist until Phase 7.
  assigned_campaign_id uuid,

  -- BYON only: { host, username, encrypted_password: EncryptedEnvelope } -
  -- the password field is itself AES-256-GCM encrypted via the same
  -- credentials helper before being nested in here. Null for Twilio/Telnyx.
  sip_trunk_metadata jsonb,

  created_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A given provider's number id must be unique per org, but only when it
-- has one (BYON rows are always null here and are governed solely by the
-- phone_number uniqueness below).
create unique index if not exists phone_numbers_org_provider_number_id_key
  on public.phone_numbers (organization_id, provider_key, provider_number_id)
  where provider_number_id is not null;

-- E.164-normalized number is unique per org regardless of provider - this
-- is what actually prevents format-variant duplicates (Phase 2's
-- lib/phone.ts normalization is what guarantees every stored value here is
-- already in the one canonical E.164 form before this constraint ever
-- sees it).
create unique index if not exists phone_numbers_org_phone_number_key
  on public.phone_numbers (organization_id, phone_number);

create index if not exists phone_numbers_organization_id_idx on public.phone_numbers (organization_id);
create index if not exists phone_numbers_provider_key_idx on public.phone_numbers (provider_key);
create index if not exists phone_numbers_status_idx on public.phone_numbers (status);
create index if not exists phone_numbers_assigned_agent_id_idx on public.phone_numbers (assigned_agent_id);
create index if not exists phone_numbers_created_at_idx on public.phone_numbers (created_at);

drop trigger if exists phone_numbers_set_updated_at on public.phone_numbers;
create trigger phone_numbers_set_updated_at
  before update on public.phone_numbers
  for each row execute function public.set_updated_at();

alter table public.phone_numbers enable row level security;
