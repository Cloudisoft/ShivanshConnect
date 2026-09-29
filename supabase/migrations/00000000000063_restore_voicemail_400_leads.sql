-- Data repair for the 29 Sep 2026 18:18-18:35 UTC outage: every campaign
-- call failed at Vapi before dialing (400 "voicemailDetection.backoffPlan.
-- frequencySeconds must not be less than 2.5", fixed in #133). No lead was
-- actually called, but each one lost an attempt and was set to
-- retry_pending, or failed once it reached its campaign's max attempts.
-- Give those attempts back and put the leads back in line to be dialed.
-- Idempotent: final_disposition is cleared, so a re-run matches nothing.
update public.campaign_leads
   set attempt_count = greatest(attempt_count - 1, 0),
       status = case when attempt_count - 1 <= 0 then 'pending' else 'retry_pending' end,
       final_disposition = null
 where final_disposition like '%frequencySeconds must not be less than 2.5%'
   and status in ('retry_pending', 'failed');
