-- Campaign-level send stats pulled from Instantly's analytics API by
-- scraper-2/src/instantly-check-replies.js. One row per Instantly campaign,
-- overwritten on every check run; the dashboard reads these instead of
-- calling Instantly live.

create table if not exists instantly_campaign_stats (
  instantly_campaign_id text primary key,
  campaign text not null,
  leads_count integer not null default 0,
  contacted_count integer not null default 0,
  emails_sent_count integer not null default 0,
  bounced_count integer not null default 0,
  reply_count integer not null default 0,
  fetched_at timestamptz not null default now()
);

create index if not exists instantly_campaign_stats_campaign_idx
  on instantly_campaign_stats (campaign);

alter table instantly_campaign_stats enable row level security;
