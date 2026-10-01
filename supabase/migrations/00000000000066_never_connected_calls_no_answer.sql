-- Data repair (approved by the client, 1 Oct 2026): outbound calls Vapi
-- ended with "did-not-receive-customer-audio" that never connected (never
-- answered, no in-progress transition) were disposed HUNG_UP - or, before
-- an earlier fix, CALL_CONNECTED - and their leads completed, so they were
-- never retried. Since #150 such calls are NO_ANSWER and retried; this
-- brings the past ones in line. Idempotent: every step only touches rows
-- still carrying the old outcome.

create temporary table never_connected_calls on commit drop as
  select c.id, c.lead_id
    from public.calls c
   where c.ended_reason = 'call.in-progress.error-assistant-did-not-receive-customer-audio'
     and c.direction = 'outbound'
     and c.answered_at is null
     and not exists (
       select 1 from public.call_events e
        where e.call_id = c.id
          and e.event_type in ('call.transitioned.in_progress', 'call.transitioned.answered')
     );

-- 1) Dispositions: NO_ANSWER. Only engine-assigned ones - a supervisor's
--    manual disposition is never overwritten.
update public.call_dispositions cd
   set disposition_id = d.id,
       disposition_confidence = 0.85,
       disposition_reason = 'The call never connected - no answer and no audio from the other side.'
  from public.dispositions d, never_connected_calls n
 where d.organization_id is null
   and d.code = 'NO_ANSWER'
   and cd.call_id = n.id
   and cd.disposition_source = 'engine'
   and cd.disposition_id <> d.id;

-- 2) Campaign leads whose last call was one of these: back in line for
--    their remaining attempts (max 3, the campaigns' setting), recorded as
--    NO_ANSWER. A lead already at its max attempts stays completed, with
--    the corrected outcome.
update public.campaign_leads cl
   set status = case when cl.attempt_count < 3 then 'retry_pending' else cl.status end,
       next_eligible_at = case when cl.attempt_count < 3 then now() else cl.next_eligible_at end,
       final_disposition = 'NO_ANSWER'
  from never_connected_calls n
 where cl.last_call_id = n.id
   and cl.status = 'completed'
   and cl.final_disposition in ('HUNG_UP', 'CALL_CONNECTED');

-- 3) Leads whose most recent outbound call was one of these: shown as No
--    Answer instead of Connected / Hung Up.
update public.leads l
   set status = 'NO_ANSWER',
       last_disposition = 'No Answer'
  from (
    select distinct on (c.lead_id) c.lead_id, c.id
      from public.calls c
     where c.lead_id is not null and c.direction = 'outbound'
     order by c.lead_id, c.created_at desc
  ) latest
  join never_connected_calls n on n.id = latest.id
 where l.id = latest.lead_id
   and l.status = 'CONNECTED'
   and l.last_disposition in ('Hung Up', 'Call Connected');
