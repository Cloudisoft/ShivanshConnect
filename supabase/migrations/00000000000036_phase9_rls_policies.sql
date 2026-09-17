-- Phase 9: Row Level Security policies for call_transcripts,
-- call_transcript_segments, call_recordings, call_summaries, exports. Same
-- defense-in-depth approach as every prior phase: the backend does its
-- real reads/writes with the service-role key and enforces org-scoping +
-- the relevant permission explicitly in application code
-- (routes/cdr.ts, routes/exports.ts, services/processCallArtifacts.ts,
-- services/generateCallSummary.ts) - these policies are the second line
-- of defense for any code path that ever queries with a user's own JWT.

drop policy if exists call_transcripts_select on public.call_transcripts;
create policy call_transcripts_select on public.call_transcripts
  for select
  using (organization_id = public.current_user_organization_id() and public.current_user_has_permission('cdr.view'));

drop policy if exists call_transcripts_insert on public.call_transcripts;
create policy call_transcripts_insert on public.call_transcripts
  for insert
  with check (organization_id = public.current_user_organization_id());

drop policy if exists call_transcripts_update on public.call_transcripts;
create policy call_transcripts_update on public.call_transcripts
  for update
  using (organization_id = public.current_user_organization_id())
  with check (organization_id = public.current_user_organization_id());

drop policy if exists call_transcript_segments_select on public.call_transcript_segments;
create policy call_transcript_segments_select on public.call_transcript_segments
  for select
  using (organization_id = public.current_user_organization_id() and public.current_user_has_permission('cdr.view'));

drop policy if exists call_transcript_segments_insert on public.call_transcript_segments;
create policy call_transcript_segments_insert on public.call_transcript_segments
  for insert
  with check (organization_id = public.current_user_organization_id());

drop policy if exists call_recordings_select on public.call_recordings;
create policy call_recordings_select on public.call_recordings
  for select
  using (organization_id = public.current_user_organization_id() and public.current_user_has_permission('cdr.view'));

drop policy if exists call_recordings_insert on public.call_recordings;
create policy call_recordings_insert on public.call_recordings
  for insert
  with check (organization_id = public.current_user_organization_id());

drop policy if exists call_recordings_update on public.call_recordings;
create policy call_recordings_update on public.call_recordings
  for update
  using (organization_id = public.current_user_organization_id())
  with check (organization_id = public.current_user_organization_id());

drop policy if exists call_summaries_select on public.call_summaries;
create policy call_summaries_select on public.call_summaries
  for select
  using (organization_id = public.current_user_organization_id() and public.current_user_has_permission('cdr.view'));

drop policy if exists call_summaries_insert on public.call_summaries;
create policy call_summaries_insert on public.call_summaries
  for insert
  with check (organization_id = public.current_user_organization_id());

drop policy if exists exports_select on public.exports;
create policy exports_select on public.exports
  for select
  using (organization_id = public.current_user_organization_id() and public.current_user_has_permission('cdr.export'));

drop policy if exists exports_insert on public.exports;
create policy exports_insert on public.exports
  for insert
  with check (
    organization_id = public.current_user_organization_id()
    and public.current_user_has_permission('cdr.export')
  );

drop policy if exists exports_update on public.exports;
create policy exports_update on public.exports
  for update
  using (organization_id = public.current_user_organization_id())
  with check (organization_id = public.current_user_organization_id());
