-- The voice's label exactly as the provider names it ("Ray -
-- Conversationalist"). voices.name becomes the clean display/spoken name
-- ("Ray") derived from it by the backend's voice catalog normalization
-- (apps/backend/src/services/voiceCatalog.ts), so it can always be
-- re-derived without losing the provider's original label.
alter table public.voices add column if not exists provider_name text;
update public.voices set provider_name = name where provider_name is null;
