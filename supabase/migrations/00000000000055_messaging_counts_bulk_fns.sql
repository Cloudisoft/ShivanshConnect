-- Performance fix: GET /sms-campaigns and GET /email-campaigns (the
-- Messaging page) computed each campaign row's per-status message counts
-- with 5 separate COUNT queries PER campaign (one per status), so a page
-- of 20 campaigns fired 100 concurrent round trips just to render the
-- list - the same N+1 pattern already fixed for the Campaigns and Leads
-- pages (00000000000053/00000000000054). These grouped-count RPCs return
-- every campaign's per-status counts in ONE round trip each.
create or replace function public.sms_campaign_message_status_counts_bulk(p_campaign_ids uuid[])
returns table (sms_campaign_id uuid, status text, count bigint)
language sql
stable
as $$
  select sms_campaign_id, status, count(*) as count
  from public.sms_messages
  where sms_campaign_id = any(p_campaign_ids)
  group by sms_campaign_id, status;
$$;

create or replace function public.email_campaign_message_status_counts_bulk(p_campaign_ids uuid[])
returns table (email_campaign_id uuid, status text, count bigint)
language sql
stable
as $$
  select email_campaign_id, status, count(*) as count
  from public.email_messages
  where email_campaign_id = any(p_campaign_ids)
  group by email_campaign_id, status;
$$;
