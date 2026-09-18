-- Phase 14: generalize Phase 9's background export engine (spec sections
-- 64/65) to Leads, Lead Lists, SMS campaign messages and Email campaign
-- messages, on top of the existing CDR export types. Purely additive -
-- no new tables, the same `exports` job table now just accepts more
-- `type` values and an optional structured pointer to the entity the
-- export was scoped to.

alter table public.exports drop constraint if exists exports_type_check;
alter table public.exports add constraint exports_type_check check (type in (
  'cdr_csv', 'cdr_xlsx',
  'leads_csv', 'leads_xlsx',
  'sms_messages_csv', 'sms_messages_xlsx',
  'email_messages_csv', 'email_messages_xlsx'
));

-- `filters` already stores the arbitrary query-shape filters an export
-- was queued with (date range, status, etc) - reused as-is. This adds a
-- small, separate `entity_reference` pointer for exports that are scoped
-- to one specific entity (e.g. { "leadListId": "..." } or
-- { "smsCampaignId": "..." }), which is a different concept from a query
-- filter and is what the unified Export History view uses to link an
-- export row back to the list/campaign it came from without parsing
-- `filters`.
alter table public.exports add column if not exists entity_reference jsonb not null default '{}'::jsonb;

-- Phase 9's exports RLS policies gated select/insert on `cdr.export`
-- only, since CDR was the only export type. Now that leads.view and
-- messaging.manage can also legitimately queue/read export rows (see
-- routes/leads.ts, routes/leadLists.ts, routes/smsCampaigns.ts,
-- routes/emailCampaigns.ts, routes/exports.ts), the RLS policy is
-- widened to match the application-layer permission check exactly -
-- real defense in depth, not RLS silently being stricter than the app
-- logic it's supposed to back up. (The backend's actual queries run
-- through the service-role client, which bypasses RLS entirely, but
-- these policies are what would apply to a direct/future anon-key
-- client and are kept honest regardless.)
drop policy if exists exports_select on public.exports;
create policy exports_select on public.exports
  for select
  using (
    organization_id = public.current_user_organization_id()
    and (
      public.current_user_has_permission('cdr.export')
      or public.current_user_has_permission('leads.view')
      or public.current_user_has_permission('messaging.manage')
    )
  );

drop policy if exists exports_insert on public.exports;
create policy exports_insert on public.exports
  for insert
  with check (
    organization_id = public.current_user_organization_id()
    and (
      public.current_user_has_permission('cdr.export')
      or public.current_user_has_permission('leads.view')
      or public.current_user_has_permission('messaging.manage')
    )
  );
