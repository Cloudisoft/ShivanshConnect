-- The name the AI introduces itself with on a campaign's calls ("this is
-- Ashton from Motor Vehicle Accident Helpline"). Empty = the campaign's own
-- name (without "(copy)" markers).
alter table public.campaigns
  add column if not exists intro_name text check (intro_name is null or char_length(intro_name) <= 200);

-- "MVA" stands for Motor Vehicle Accident Helpline (explicit request):
-- campaigns named MVA (incl. copies like "MVA (copy)", "Copy of MVA",
-- "MVA copy 2") introduce themselves with the full name.
update public.campaigns
   set intro_name = 'Motor Vehicle Accident Helpline'
 where intro_name is null
   and name ~* '\mmva\M';
