-- CDR: delete call log entries (per client request). A new permission so
-- deleting stays separate from viewing and exporting; granted to the same
-- roles that run campaigns (SUPER_ADMIN, ADMIN, MANAGER), never to AGENT
-- or VIEWER. Custom roles get it through the Roles settings page.
insert into public.permissions (key, description, category)
values ('cdr.delete', 'Delete call detail records', 'cdr')
on conflict (key) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
  from public.roles r
 cross join public.permissions p
 where r.is_system_role
   and r.name in ('SUPER_ADMIN', 'ADMIN', 'MANAGER')
   and p.key = 'cdr.delete'
on conflict do nothing;
