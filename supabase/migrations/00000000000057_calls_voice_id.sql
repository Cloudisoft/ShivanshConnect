-- Fix: CDR and Live Monitor showed the AI agent version's own DEFAULT
-- voice, never the voice actually used for a given call - wrong for any
-- campaign whose selected voice overrides the agent's default (or any
-- one-off call with a manual voice override), reported as "Live monitor
-- still shows Tina in voice name instead of Mitchell". There was never
-- anywhere to record which voice a call actually used; both
-- liveMonitorQuery.ts and cdrQuery.ts could only ever re-derive it from
-- ai_agent_versions.voice_id, which is the wrong source whenever an
-- override was in play.
--
-- Nullable and with no backfill: a call placed before this migration
-- genuinely has no recorded "actual voice" to backfill from (the
-- override, if any, was never persisted anywhere) - showing nothing
-- for those older rows is honest, not a regression.
alter table public.calls add column if not exists voice_id uuid references public.voices (id) on delete set null;
create index if not exists calls_voice_id_idx on public.calls (voice_id);
