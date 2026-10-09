-- Per client request: phone numbers must not show the call engine's vendor
-- name. 12 Telnyx numbers were saved with the name "Vapi", shown after the
-- number across the dashboard; clear it (the number itself is what's shown
-- then). Idempotent.
update public.phone_numbers
   set friendly_name = null
 where friendly_name ilike 'vapi';
