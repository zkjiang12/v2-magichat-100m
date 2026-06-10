-- CRM response tracking: inbound DM messages scraped from sender inboxes,
-- plus the manually-set lead status per creator per campaign.

create table if not exists dm_responses (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references creators(id) on delete cascade,
  sender_account_id uuid references sender_accounts(id),
  campaign text not null default 'day_in_life_creators',
  counterpart_username text not null,
  ig_thread_id text not null,
  ig_item_id text not null,
  message_text text not null,
  responded_at timestamptz,
  scraped_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (ig_thread_id, ig_item_id)
);

create table if not exists lead_statuses (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references creators(id) on delete cascade,
  campaign text not null default 'day_in_life_creators',
  status text not null check (status in ('needs_reply', 'interested', 'closed', 'churned')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (creator_id, campaign)
);

create index if not exists dm_responses_campaign_scraped_idx
  on dm_responses (campaign, scraped_at desc);

create index if not exists dm_responses_creator_campaign_idx
  on dm_responses (creator_id, campaign);

alter table dm_responses enable row level security;
alter table lead_statuses enable row level security;
