-- Adds two system dispositions the deterministic engine
-- (apps/backend/src/services/dispositionEngine.ts) previously lumped
-- together under the generic DISCONNECTED code: NO_ANSWER (the phone rang
-- but nobody picked up) and NOT_IN_SERVICE (the destination number itself
-- is invalid/disconnected) - both are real, distinct outcomes a
-- supervisor needs to tell apart in reporting, not the same thing as a
-- disconnected/failed call.

insert into public.dispositions (organization_id, code, name, is_system) values
  (null, 'NO_ANSWER', 'No Answer', true),
  (null, 'NOT_IN_SERVICE', 'Not in Service', true)
on conflict do nothing;
