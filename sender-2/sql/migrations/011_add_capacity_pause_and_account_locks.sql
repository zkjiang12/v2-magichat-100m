-- Capacity-aware pausing + per-account worker locks.
--
-- sender_runs.pause_reason distinguishes an automatic capacity pause
-- (resumable by the drain worker) from a manual pause (left alone).
-- sender_accounts.locked_by/locked_at let exactly one worker lane drive
-- an Instagram account at a time; locks expire after 10 minutes so a
-- crashed worker never strands an account.

alter table sender_runs
  add column if not exists pause_reason text;

alter table sender_accounts
  add column if not exists locked_by text,
  add column if not exists locked_at timestamptz;
