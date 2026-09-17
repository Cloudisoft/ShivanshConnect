-- Phase 6: phone_numbers.vapi_phone_number_id
--
-- Vapi's phone-number-import step (VapiProvider.importPhoneNumber(),
-- POST /phone-number on Vapi's own API) assigns its OWN id to an
-- imported/linked number - distinct from phone_numbers.provider_number_id
-- (the Twilio SID / Telnyx id / null-for-BYON already stored there from
-- Phase 5). A number must be imported into Vapi exactly once before
-- VapiProvider.createCall() can use it; this column caches that mapping so
-- routes/calls.ts only imports a given number into Vapi the first time it
-- is used for an outbound Vapi call, not on every call.

alter table public.phone_numbers
  add column if not exists vapi_phone_number_id text;

create unique index if not exists phone_numbers_vapi_phone_number_id_key
  on public.phone_numbers (vapi_phone_number_id)
  where vapi_phone_number_id is not null;
