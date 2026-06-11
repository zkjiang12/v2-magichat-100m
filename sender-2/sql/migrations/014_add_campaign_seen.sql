-- Campaign-wide seen-set: one row per (campaign, handle) the scraper has ever
-- discovered. Replaces the per-run `seen` map previously stored inside
-- scraper_runs.state and provides cross-run dedup within a campaign.
-- Status values mirror the crawler's in-memory record statuses:
-- seed, queued, accepted, rejected, failed,
-- filtered_private, filtered_unverified, filtered_followers, filtered_hard_no.
create table if not exists campaign_seen (
  campaign text not null,
  handle text not null,
  status text not null,
  source_seed text,
  run_id uuid,
  discovered_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (campaign, handle)
);

alter table campaign_seen enable row level security;

-- Backfill from the seen maps stored inside existing scraper_runs.state blobs
-- (completed/stopped runs are never claimed again, so the crawler's
-- claim-time backfill would miss them). Latest run's view of a handle wins.
insert into campaign_seen (campaign, handle, status, source_seed, run_id)
select distinct on (r.campaign, e.key)
  r.campaign,
  e.key,
  case when e.value->>'status' = 'processing' then 'queued' else e.value->>'status' end,
  e.value->>'sourceSeed',
  r.id
from scraper_runs r
cross join lateral jsonb_each(
  case
    when jsonb_typeof(r.state -> 'seen') = 'object' then r.state -> 'seen'
    else '{}'::jsonb
  end
) e
where coalesce(e.value->>'status', '') <> ''
order by r.campaign, e.key, r.created_at desc
on conflict (campaign, handle) do nothing;
