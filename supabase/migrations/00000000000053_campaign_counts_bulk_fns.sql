-- Performance fix: GET /campaigns (the campaigns list page) still called
-- computeCampaignCounts() once PER campaign row - 2 round trips each
-- (00000000000051's grouped-count RPC + an active-calls count), so a page
-- of 20 campaigns fired 40 concurrent DB round trips just to render the
-- list. These two bulk variants take an array of campaign ids and return
-- every campaign's counts in one round trip each - 2 round trips total
-- for the whole page, regardless of how many campaigns are on it.
create or replace function public.campaign_lead_status_counts_bulk(p_campaign_ids uuid[])
returns table (campaign_id uuid, status text, count bigint)
language sql
stable
as $$
  select campaign_id, status, count(*) as count
  from public.campaign_leads
  where campaign_id = any(p_campaign_ids)
  group by campaign_id, status;
$$;

create or replace function public.campaign_active_call_counts_bulk(p_campaign_ids uuid[])
returns table (campaign_id uuid, count bigint)
language sql
stable
as $$
  select campaign_id, count(*) as count
  from public.calls
  where campaign_id = any(p_campaign_ids)
    and status in ('queued', 'dialing', 'ringing', 'answered', 'in_progress', 'voicemail', 'answering_machine', 'transfer_pending', 'transferring')
  group by campaign_id;
$$;
