-- CRM email response tracking: inbound replies pulled from Instantly.ai
-- campaigns by scraper-2/src/instantly-check-replies.js.
-- 016 is reserved by the dashboard-perf branch, 017 by the
-- ugc_creators_email campaign branch.

-- creator_id/campaign are nullable: a reply whose sender isn't in
-- instantly_sync yet is still stored, and attribution is filled in on a
-- later run once the lead mapping exists.
create table if not exists email_responses (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid references creators(id) on delete cascade,
  campaign text,
  instantly_campaign_id text not null,
  lead_email text not null,
  instantly_email_id text not null,
  thread_id text,
  subject text,
  body_text text,
  from_address text,
  received_at timestamptz,
  scraped_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (instantly_email_id)
);

create index if not exists email_responses_campaign_scraped_idx
  on email_responses (campaign, scraped_at desc);

create index if not exists email_responses_creator_campaign_idx
  on email_responses (creator_id, campaign);

create index if not exists email_responses_instantly_campaign_idx
  on email_responses (instantly_campaign_id, received_at desc);

alter table email_responses enable row level security;
