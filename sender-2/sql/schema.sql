create extension if not exists pgcrypto;

create table if not exists creators (
  id uuid primary key default gen_random_uuid(),
  handle text not null unique,
  profile_url text,
  display_name text,
  followers_count integer,
  following_count integer,
  is_private boolean,
  is_verified boolean,
  source_seed text,
  discovered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists creator_evaluations (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references creators(id) on delete cascade,
  recipient_handle text,
  sender_handle text,
  campaign text not null default 'day_in_life_creators',
  fit_score integer not null check (fit_score between 1 and 4),
  list text,
  reasoning text,
  review_path text,
  raw_record jsonb not null default '{}'::jsonb,
  evaluated_at timestamptz,
  created_at timestamptz not null default now(),
  unique (creator_id, campaign)
);

create table if not exists sender_accounts (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  status text not null default 'active' check (status in ('active', 'paused', 'blocked')),
  daily_send_limit integer not null default 25,
  sends_today integer not null default 0,
  last_sent_at timestamptz,
  cooldown_until timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists send_queue (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references creators(id) on delete cascade,
  campaign text not null default 'day_in_life_creators',
  status text not null default 'queued' check (
    status in ('ready_for_review', 'queued', 'claimed', 'dry_run', 'sent', 'failed_retryable', 'failed_final', 'skipped')
  ),
  priority integer not null default 100,
  attempt_count integer not null default 0,
  max_attempts integer not null default 3,
  claimed_by text,
  claimed_at timestamptz,
  retry_after timestamptz,
  sender_account_id uuid references sender_accounts(id),
  last_error text,
  message text,
  queued_at timestamptz not null default now(),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (creator_id, campaign)
);

create table if not exists send_attempts (
  id uuid primary key default gen_random_uuid(),
  send_queue_id uuid not null references send_queue(id) on delete cascade,
  sender_account_id uuid references sender_accounts(id),
  sender_run_id uuid,
  worker_id text,
  provider text not null,
  status text not null check (status in ('dry_run', 'sent', 'skipped', 'failed_retryable', 'failed_final')),
  message text,
  error text,
  provider_response jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

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

create table if not exists scraper_runs (
  id uuid primary key default gen_random_uuid(),
  campaign text not null default 'day_in_life_creators',
  status text not null default 'requested' check (
    status in ('requested', 'running', 'pause_requested', 'paused', 'stop_requested', 'stopped', 'completed', 'failed')
  ),
  seed_handles text[] not null default '{}'::text[],
  max_accepted integer not null default 1000,
  following_limit integer,
  qualification_workers integer not null default 32,
  state jsonb not null default '{}'::jsonb,
  counters jsonb not null default '{}'::jsonb,
  error text,
  requested_by text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists sender_runs (
  id uuid primary key default gen_random_uuid(),
  campaign text not null default 'day_in_life_creators',
  status text not null default 'requested' check (
    status in ('requested', 'running', 'pause_requested', 'paused', 'stop_requested', 'stopped', 'completed', 'failed')
  ),
  account_usernames text[] not null default '{}'::text[],
  max_sends integer,
  config jsonb not null default '{}'::jsonb,
  counters jsonb not null default '{}'::jsonb,
  error text,
  requested_by text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists run_commands (
  id uuid primary key default gen_random_uuid(),
  campaign text not null default 'day_in_life_creators',
  run_type text not null check (run_type in ('scraper', 'sender')),
  run_id uuid not null,
  command text not null check (command in ('pause', 'resume', 'stop')),
  status text not null default 'pending' check (status in ('pending', 'applied', 'failed')),
  payload jsonb not null default '{}'::jsonb,
  error text,
  created_at timestamptz not null default now(),
  applied_at timestamptz
);

create index if not exists send_queue_claim_idx
  on send_queue (status, retry_after, priority, queued_at);

create index if not exists creator_evaluations_campaign_score_idx
  on creator_evaluations (campaign, fit_score);

create index if not exists send_queue_dry_run_idx
  on send_queue (campaign, status, queued_at);

create index if not exists scrape_events_campaign_type_at_idx
  on scrape_events (campaign, event_type, event_at);

create index if not exists cost_events_campaign_at_idx
  on cost_events (campaign, event_at);

create index if not exists scraper_runs_campaign_status_idx
  on scraper_runs (campaign, status, created_at desc);

create index if not exists sender_runs_campaign_status_idx
  on sender_runs (campaign, status, created_at desc);

create index if not exists run_commands_pending_idx
  on run_commands (run_type, run_id, status, created_at);

create index if not exists send_attempts_sender_run_id_idx
  on send_attempts (sender_run_id, created_at);

alter table creators enable row level security;
alter table creator_evaluations enable row level security;
alter table sender_accounts enable row level security;
alter table send_queue enable row level security;
alter table send_attempts enable row level security;
alter table scrape_events enable row level security;
alter table cost_events enable row level security;
alter table campaign_notes enable row level security;
alter table scraper_runs enable row level security;
alter table sender_runs enable row level security;
alter table run_commands enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'send_attempts_sender_run_id_fkey'
  ) then
    alter table send_attempts
      add constraint send_attempts_sender_run_id_fkey
      foreign key (sender_run_id) references sender_runs(id) on delete set null;
  end if;
end $$;
