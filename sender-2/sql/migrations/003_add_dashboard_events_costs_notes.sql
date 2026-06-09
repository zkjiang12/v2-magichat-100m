create table if not exists scrape_events (
  id uuid primary key default gen_random_uuid(),
  campaign text not null default 'day_in_life_creators',
  creator_id uuid references creators(id) on delete cascade,
  handle text,
  event_type text not null check (
    event_type in ('seen', 'processed', 'accepted', 'rejected', 'failed')
  ),
  source_seed text,
  event_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  external_key text,
  created_at timestamptz not null default now(),
  unique (campaign, external_key)
);

create table if not exists cost_events (
  id uuid primary key default gen_random_uuid(),
  campaign text not null default 'day_in_life_creators',
  provider text not null check (provider in ('apify', 'openai', 'combined')),
  purpose text not null,
  amount_usd numeric(12, 6) not null default 0,
  input_tokens integer,
  cached_input_tokens integer,
  output_tokens integer,
  profiles_processed integer,
  accepted_creators integer,
  external_run_id text,
  event_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (campaign, provider, purpose, external_run_id)
);

create table if not exists campaign_notes (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid references creators(id) on delete cascade,
  campaign text not null default 'day_in_life_creators',
  note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (creator_id, campaign)
);

create index if not exists scrape_events_campaign_type_at_idx
  on scrape_events (campaign, event_type, event_at);

create index if not exists cost_events_campaign_at_idx
  on cost_events (campaign, event_at);

alter table scrape_events enable row level security;
alter table cost_events enable row level security;
alter table campaign_notes enable row level security;
