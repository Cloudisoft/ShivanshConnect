-- Phase 13: smtp_settings (master spec section 39).
--
-- One row per organization (UNIQUE organization_id). Reuses Phase 4's
-- exact AES-256-GCM credential encryption helper
-- (apps/backend/src/lib/crypto/credentials.ts) for the SMTP password -
-- never stored or returned in plaintext. services/smtpProvider.ts
-- decrypts the password only in-memory at send time and never logs it.

create table if not exists public.smtp_settings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,

  host text not null,
  port integer not null check (port between 1 and 65535),
  username text not null,
  -- { iv: base64, authTag: base64, ciphertext: base64 } - AES-256-GCM,
  -- see lib/crypto/credentials.ts. Plaintext shape: { password }.
  encrypted_password jsonb not null,
  encryption text not null default 'tls' check (encryption in ('tls', 'ssl', 'none')),
  from_name text not null default '',
  from_email citext not null,

  status text not null default 'not_configured' check (status in ('not_configured', 'connected', 'error')),
  last_tested_at timestamptz,
  last_error text,

  created_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists smtp_settings_organization_id_key on public.smtp_settings (organization_id);

drop trigger if exists smtp_settings_set_updated_at on public.smtp_settings;
create trigger smtp_settings_set_updated_at
  before update on public.smtp_settings
  for each row execute function public.set_updated_at();

alter table public.smtp_settings enable row level security;
