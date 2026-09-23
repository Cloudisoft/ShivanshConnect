-- Voice cloning failures (e.g. a provider rejecting the sample, an
-- expired API key, insufficient credits) were only ever logged
-- server-side (req.log.error in routes/voices.ts's async clone hand-off)
-- and then silently discarded - clone_status flipped to 'failed' with no
-- way for the org to see why. clone_error stores the real provider/adapter
-- error message so it can be shown in the UI instead of a dead end.
alter table voices add column if not exists clone_error text;
