-- Phase 1: seed the 5 system roles and the full permission catalog.
-- Idempotent: safe to re-run (used by both `supabase db push` on a fresh
-- database and local `supabase db reset`).

insert into public.roles (organization_id, name, is_system_role)
values
  (null, 'SUPER_ADMIN', true),
  (null, 'ADMIN', true),
  (null, 'MANAGER', true),
  (null, 'AGENT', true),
  (null, 'VIEWER', true)
on conflict (name) where is_system_role do nothing;

insert into public.permissions (key, description, category)
values
  ('dashboard.view', 'View the dashboard', 'dashboard'),

  ('campaigns.view', 'View campaigns', 'campaigns'),
  ('campaigns.create', 'Create campaigns', 'campaigns'),
  ('campaigns.edit', 'Edit campaigns', 'campaigns'),
  ('campaigns.start', 'Start campaigns', 'campaigns'),
  ('campaigns.pause', 'Pause campaigns', 'campaigns'),
  ('campaigns.delete', 'Delete campaigns', 'campaigns'),

  ('leads.view', 'View leads', 'leads'),
  ('leads.create', 'Create leads', 'leads'),
  ('leads.edit', 'Edit leads', 'leads'),
  ('leads.delete', 'Delete leads', 'leads'),
  ('leads.import', 'Import leads', 'leads'),

  ('live_monitor.view', 'View live monitor', 'live_monitor'),
  ('live_monitor.listen', 'Listen to live calls', 'live_monitor'),
  ('live_monitor.barge', 'Barge into live calls', 'live_monitor'),
  ('live_monitor.whisper', 'Whisper to agents on live calls', 'live_monitor'),

  ('cdr.view', 'View call detail records', 'cdr'),
  ('cdr.export', 'Export call detail records', 'cdr'),

  ('agents.manage', 'Manage AI agents', 'agents'),
  ('voices.manage', 'Manage voices', 'voices'),
  ('numbers.manage', 'Manage phone numbers (DIDs)', 'numbers'),

  ('users.manage', 'Manage organization users', 'users'),
  ('settings.manage', 'Manage organization settings', 'settings'),
  ('messaging.manage', 'Manage messaging', 'messaging'),
  ('analytics.view', 'View analytics', 'analytics'),
  ('roles.manage', 'Manage roles and permissions', 'roles'),
  ('audit.view', 'View audit logs', 'audit')
on conflict (key) do nothing;

-- Role -> permission mapping for the 5 system roles.
-- SUPER_ADMIN and ADMIN: every permission in the catalog.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.is_system_role and r.name in ('SUPER_ADMIN', 'ADMIN')
on conflict do nothing;

-- MANAGER: everything except role/user/settings/org-level administration.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.is_system_role and r.name = 'MANAGER'
  and p.key not in ('roles.manage', 'users.manage', 'settings.manage')
on conflict do nothing;

-- AGENT: day-to-day operational permissions only.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.is_system_role and r.name = 'AGENT'
  and p.key in (
    'dashboard.view',
    'campaigns.view',
    'leads.view', 'leads.create', 'leads.edit',
    'live_monitor.view',
    'cdr.view',
    'messaging.manage'
  )
on conflict do nothing;

-- VIEWER: read-only across the board.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.is_system_role and r.name = 'VIEWER'
  and p.key in (
    'dashboard.view',
    'campaigns.view',
    'leads.view',
    'live_monitor.view',
    'cdr.view',
    'analytics.view',
    'audit.view'
  )
on conflict do nothing;
