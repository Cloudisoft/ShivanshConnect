-- Data repair for the 29 Sep 2026 outage from 18:18 UTC: every campaign
-- call failed at Vapi before dialing (400 "voicemailDetection.backoffPlan.
-- frequencySeconds must not be less than 2.5", fixed in #133). No lead was
-- actually called. Idempotent: everything below matches only rows carrying
-- that exact error, and each step clears or removes it.

-- 1) Campaign leads: give back the lost attempt and put them back in line
--    (each was set to retry_pending, or failed at its max attempts).
update public.campaign_leads
   set attempt_count = greatest(attempt_count - 1, 0),
       status = case when attempt_count - 1 <= 0 then 'pending' else 'retry_pending' end,
       final_disposition = null
 where final_disposition like '%frequencySeconds must not be less than 2.5%'
   and status in ('retry_pending', 'failed');

-- 2) Remove the failed call records (approved by the client). They never
--    reached Vapi: no provider call id, never answered.
create temporary table outage_calls on commit drop as
  select id, lead_id
    from public.calls
   where status = 'failed'
     and vapi_call_id is null
     and answered_at is null
     and ended_reason like '%frequencySeconds must not be less than 2.5%';

update public.campaign_leads cl
   set last_call_id = null
  from outage_calls oc
 where cl.last_call_id = oc.id;

delete from public.calls c
 using outage_calls oc
 where c.id = oc.id;

-- 3) Leads: recount attempts and last called time from the calls that
--    remain (the counters only ever grow on insert), and a lead with no
--    real call left goes back from CALLED to NEW.
update public.leads l
   set attempts = coalesce(s.n, 0),
       last_called_at = s.last_at,
       status = case when s.n is null and l.status = 'CALLED' then 'NEW' else l.status end
  from (select distinct lead_id from outage_calls where lead_id is not null) affected
  left join (
    select lead_id, count(*)::int as n, max(created_at) as last_at
      from public.calls
     where lead_id is not null and direction = 'outbound'
     group by lead_id
  ) s on s.lead_id = affected.lead_id
 where l.id = affected.lead_id;
