-- Data repair for the 30 Sep 2026 outage, 16:54-17:08 UTC: every campaign
-- call failed at Vapi before dialing (400 "voicemailDetection.
-- beepMaxAwaitSeconds must not be greater than 30", fixed in #146). No lead
-- was actually called. Idempotent: everything below matches only rows
-- carrying that exact error, and each step clears or removes it.

create temporary table beep_outage_calls on commit drop as
  select id, campaign_id, lead_id
    from public.calls
   where status = 'failed'
     and vapi_call_id is null
     and answered_at is null
     and ended_reason like '%beepMaxAwaitSeconds must not be greater than 30%';

-- 1) Campaign leads: give back every lost attempt (up to 3 per lead - the
--    dialer kept retrying) and put them back in line now.
update public.campaign_leads cl
   set attempt_count = greatest(cl.attempt_count - o.n, 0),
       status = case when cl.attempt_count - o.n <= 0 then 'pending' else 'retry_pending' end,
       final_disposition = null,
       next_eligible_at = null
  from (
    select campaign_id, lead_id, count(*)::int n
      from beep_outage_calls
     group by campaign_id, lead_id
  ) o
 where cl.campaign_id = o.campaign_id
   and cl.lead_id = o.lead_id
   and cl.final_disposition like '%beepMaxAwaitSeconds must not be greater than 30%'
   and cl.status in ('retry_pending', 'failed');

-- 2) Remove the failed call records (approved by the client). They never
--    reached Vapi: no provider call id, never answered.
update public.campaign_leads cl
   set last_call_id = null
  from beep_outage_calls oc
 where cl.last_call_id = oc.id;

delete from public.calls c
 using beep_outage_calls oc
 where c.id = oc.id;

-- 3) Leads: recount attempts and last called time from the calls that
--    remain, and a lead with no real call left goes back from CALLED to NEW.
update public.leads l
   set attempts = coalesce(s.n, 0),
       last_called_at = s.last_at,
       status = case when s.n is null and l.status = 'CALLED' then 'NEW' else l.status end
  from (select distinct lead_id from beep_outage_calls where lead_id is not null) affected
  left join (
    select lead_id, count(*)::int as n, max(created_at) as last_at
      from public.calls
     where lead_id is not null and direction = 'outbound'
     group by lead_id
  ) s on s.lead_id = affected.lead_id
 where l.id = affected.lead_id;
